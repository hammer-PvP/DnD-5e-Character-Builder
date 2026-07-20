import { MODULE_ID, SPELL_ACCESS_MODELS, WIZARD_SCHOOLS } from "../constants.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";
import { SourceResolver } from "./source-resolver.mjs";
import { AdvancementChoiceAnnotationService } from "./advancement-choice-annotation-service.mjs";
import { ItemGrantIntegrityService } from "./item-grant-integrity-service.mjs";
import { LevelUpFeatureService } from "./level-up-feature-service.mjs";
import { FeatureSpellOwnershipService } from "./feature-spell-ownership-service.mjs";
import { NativeAdvancementValidationService, StructuralLevelUpError } from "./native-advancement-validation-service.mjs";
import { PactOfTheTomeService } from "./pact-of-the-tome-service.mjs";
import { NativeAdvancementModalGuard } from "./native-advancement-modal-guard.mjs";
import { MetamagicService } from "./metamagic-service.mjs";

export class LevelUpRulesService {
  static async buildContext(sourceActor, draft, registry) {
    const state = LevelUpDraftManager.getState(draft);
    if (!state.nativeComplete) return this.#emptyContext("Complete Class Progression first.");
    const cls = draft.items.get(state.selectedClassId);
    if (!cls) return this.#emptyContext("The advanced Class could not be found.");

    const identifier = cls.system?.identifier;
    const oldClassLevel = Number(state.sourceClassLevel ?? Math.max(0, Number(cls.system?.levels ?? 1) - 1));
    const newClassLevel = Number(state.targetClassLevel ?? cls.system?.levels ?? 1);
    const subclassCaster = LevelUpFeatureService.subclassCaster(draft, identifier);
    const model = subclassCaster ? "limited" : this.#modelFor(cls);
    const progression = subclassCaster ? "third" : (cls.system?.spellcasting?.progression ?? "none");
    const oldMaximumSpellLevel = this.#maximumSpellLevel(progression, oldClassLevel);
    const maximumSpellLevel = this.#maximumSpellLevel(progression, newClassLevel);
    const spellListIdentifier = subclassCaster?.spellList ?? identifier;
    const baseSpellPool = progression === "none" ? [] : await this.#classSpellPool(spellListIdentifier, registry);
    let spellPool = baseSpellPool;
    const magicalSecretsActive = identifier === "bard" && LevelUpFeatureService.magicalSecretsActive(draft, newClassLevel);
    if (magicalSecretsActive) spellPool = await LevelUpFeatureService.magicalSecretsPool(registry);
    const cantripPool = baseSpellPool.filter(option => Number(option.system?.level ?? 0) === 0);
    const leveledPool = spellPool.filter(option => {
      const level = Number(option.system?.level ?? 0);
      return level > 0 && level <= maximumSpellLevel;
    });
    const bardBaseSpellIdentifiers = identifier === "bard"
      ? new Set((await LevelUpFeatureService.bardBasePool(registry)).map(option => option.identifier))
      : new Set();
    if (magicalSecretsActive) {
      for (const option of leveledPool) {
        option.magicalSecretsEligible = !bardBaseSpellIdentifiers.has(option.identifier);
        option.eligibilityBadge = option.magicalSecretsEligible ? "Magical Secrets" : "";
      }
    }
    const existingSpells = draft.items.filter(item => item.type === "spell");
    const existingIdentifiers = new Set(existingSpells
      .filter(item => this.#isNormalClassSpell(item, cls))
      .map(item => item.system?.identifier)
      .filter(Boolean));
    const unavailableChoiceInfo = new Map();
    for (const spell of existingSpells) {
      const spellIdentifier = String(spell.system?.identifier ?? "");
      if (!spellIdentifier || this.#spellClassIdentifier(spell, draft) !== identifier) continue;
      unavailableChoiceInfo.set(spellIdentifier, this.#spellUnavailableReason(draft, spell));
    }
    const stateChoices = state.additionalChoices ?? {};
    const automaticItemGrants = foundry.utils.deepClone(
      state.itemGrantIntegrity?.items ?? state.itemGrantReconciliation?.items ?? []
    ).map(row => ({
      ...row,
      badges: AdvancementChoiceAnnotationService.getBadges(draft.items.get(row.itemId))
    }));
    const automaticAdvancementSummaries = this.#automaticAdvancementSummaries(draft, cls, newClassLevel);
    const selectedCantripSet = new Set(stateChoices.cantrips ?? []);
    const selectedSpellSet = new Set(stateChoices.spells ?? []);
    const selectedSavantSet = new Set(stateChoices.savantSpells ?? []);
    const selectedReplacementIdentifier = stateChoices.spellReplacement?.addIdentifier ?? "";
    const replacementSet = new Set(selectedReplacementIdentifier ? [selectedReplacementIdentifier] : []);

    const oldCantrips = subclassCaster
      ? 0
      : this.#scaleValue(cls, oldClassLevel, { title: "cantrips known" });
    const newCantrips = subclassCaster
      ? 0
      : this.#scaleValue(cls, newClassLevel, { title: "cantrips known" });
    let cantripCount = subclassCaster
      ? LevelUpFeatureService.subclassCasterCantripCount(subclassCaster, oldClassLevel, newClassLevel)
      : Math.max(0, newCantrips - oldCantrips);
    // Primal Order: Magician contributes one additional Druid cantrip through
    // its own exact feature-owned acquisition. Do not count it as one of the
    // normal class cantrip choices when multiclassing into Druid.
    if (identifier === "druid" && oldClassLevel < 1 && newClassLevel >= 1
      && LevelUpFeatureService.hasPrimalOrderMagician(draft)) {
      cantripCount = Math.max(0, cantripCount - 1);
    }
    const cantripOptions = cantripPool
      .map(option => this.#decorateSpellOption(option, selectedCantripSet, new Set(), unavailableChoiceInfo));

    let spellCount = 0;
    let automaticSpells = [];
    if (model === "fullList") {
      automaticSpells = leveledPool.filter(option => !existingIdentifiers.has(option.identifier));
    } else if (model === "limited") {
      if (subclassCaster) {
        spellCount = LevelUpFeatureService.subclassCasterPreparedCount(subclassCaster, oldClassLevel, newClassLevel);
      } else {
        const oldPrepared = this.#scaleValue(cls, oldClassLevel, { identifier: "max-prepared", title: "max prepared" });
        const newPrepared = this.#scaleValue(cls, newClassLevel, { identifier: "max-prepared", title: "max prepared" });
        spellCount = Math.max(0, newPrepared - oldPrepared);
      }
    } else if (model === "spellbook") {
      spellCount = oldClassLevel === 0 ? 6 : 2;
    }

    const spellOptions = leveledPool
      .map(option => this.#decorateSpellOption(
        option,
        selectedSpellSet,
        new Set([...selectedSavantSet, ...replacementSet]),
        unavailableChoiceInfo
      ));

    const savant = await this.#wizardSavantContext(draft, cls, spellPool, existingIdentifiers, {
      oldClassLevel,
      newClassLevel,
      oldMaximumSpellLevel,
      maximumSpellLevel,
      selected: stateChoices.savantSpells ?? []
    });

    for (const group of savant.groups) {
      for (const option of group.items) {
        option.disabled = !option.checked && (selectedSpellSet.has(option.identifier) || replacementSet.has(option.identifier));
        option.disabledReason = option.disabled ? "Already selected through another spell choice." : "";
      }
    }
    savant.levelGroups = this.#groupSpellsByLevel(savant.groups.flatMap(group => group.items), registry);

    const invocations = identifier === "warlock"
      ? await this.#invocationContext(draft, cls, registry, stateChoices, cantripOptions)
      : this.#emptyInvocationContext();
    const metamagic = identifier === "sorcerer"
      ? await MetamagicService.buildContext(draft, cls, registry, {
        oldClassLevel,
        newClassLevel,
        stateChoices
      })
      : MetamagicService.emptyContext();
    const tomeOption = invocations.options.find(option => option.identifier === PactOfTheTomeService.INVOCATION_IDENTIFIER) ?? null;
    const currentTome = PactOfTheTomeService.findInvocation(draft);
    const currentTomeSelection = currentTome ? PactOfTheTomeService.currentSelection(draft, currentTome.id) : null;
    const tomeSelectedInState = Boolean(tomeOption && [
      ...(stateChoices.invocationSelections ?? []).map(row => row.uuid),
      stateChoices.invocationReplacement?.uuid
    ].filter(Boolean).includes(tomeOption.uuid));
    const tomeNeedsInitialConfiguration = Boolean(currentTome
      && ((currentTomeSelection?.cantrips?.length ?? 0) !== PactOfTheTomeService.CANTRIP_COUNT
        || (currentTomeSelection?.rituals?.length ?? 0) !== PactOfTheTomeService.RITUAL_COUNT));
    const pactOfTheTome = identifier === "warlock" && (tomeOption || currentTome)
      ? await PactOfTheTomeService.buildContext(draft, registry, {
        mode: "acquisition",
        forceActive: true,
        invocationOption: tomeOption,
        selectedCantrips: stateChoices.pactOfTheTome?.cantrips ?? [],
        selectedRituals: stateChoices.pactOfTheTome?.rituals ?? [],
        pendingPreparedIdentifiers: [...selectedCantripSet, ...selectedSpellSet],
        transactionId: state.transactionId,
        classItem: cls
      })
      : { active: false, complete: true, cantripGroups: [], ritualGroups: [] };
    pactOfTheTome.visible = Boolean(tomeSelectedInState || tomeNeedsInitialConfiguration);
    pactOfTheTome.selectedInState = tomeSelectedInState;
    pactOfTheTome.needsInitialConfiguration = tomeNeedsInitialConfiguration;
    pactOfTheTome.existingInvocationItemId = currentTome?.id ?? null;

    const replacement = model === "limited" && oldClassLevel > 0
      ? this.#spellReplacementContext(draft, identifier, leveledPool, stateChoices, new Set([...selectedSpellSet, ...selectedSavantSet]), unavailableChoiceInfo)
      : { available: false, existing: [], options: [], removeId: "", addIdentifier: "" };
    const cantripReplacementClasses = new Set(["bard", "sorcerer", "warlock"]);
    const cantripReplacement = oldClassLevel > 0 && (cantripReplacementClasses.has(identifier) || subclassCaster)
      ? this.#cantripReplacementContext(draft, identifier, cantripPool, stateChoices, new Set(selectedCantripSet), {
        excludedIdentifiers: subclassCaster?.identifier === "arcane-trickster" ? new Set(["mage-hand"]) : new Set(),
        unavailableChoiceInfo
      })
      : { available: false, existing: [], options: [], removeId: "", addIdentifier: "" };

    const features = await LevelUpFeatureService.buildContext(draft, cls, registry, {
      oldClassLevel,
      newClassLevel,
      maximumSpellLevel,
      pendingSpellOptions: [...spellOptions, ...savant.groups.flatMap(group => group.items)]
    });

    const automaticGroups = registry.groupOptions(automaticSpells.map(option => ({
      ...option,
      checked: true,
      levelLabel: this.#levelLabel(option.system?.level)
    })));

    const hasChoices = cantripCount > 0 || spellCount > 0 || savant.count > 0 || invocations.count > 0
      || replacement.available || cantripReplacement.available || invocations.replacement.available || features.hasChoices
      || pactOfTheTome.visible || metamagic.active;
    const hasAutomatic = automaticSpells.length > 0 || automaticItemGrants.length > 0
      || automaticAdvancementSummaries.length > 0 || features.hasAutomatic;
    const requiredSpellSelections = cantripCount + spellCount + savant.count;
    const selectedSpellSelections = selectedCantripSet.size + selectedSpellSet.size + selectedSavantSet.size;
    const duplicateSelectionCount = this.#duplicateCount([
      ...selectedCantripSet,
      ...selectedSpellSet,
      ...selectedSavantSet,
      ...(selectedReplacementIdentifier ? [selectedReplacementIdentifier] : []),
      ...(stateChoices.cantripReplacement?.addIdentifier ? [stateChoices.cantripReplacement.addIdentifier] : [])
    ]);
    const baseSelectionComplete = selectedSpellSelections === requiredSpellSelections && duplicateSelectionCount === 0;
    const tomeSelectionComplete = !pactOfTheTome.visible || pactOfTheTome.complete;
    const spellReplacementComplete = Boolean(replacement.removeId) === Boolean(replacement.addIdentifier);
    const cantripReplacementComplete = Boolean(cantripReplacement.removeId) === Boolean(cantripReplacement.addIdentifier);

    return {
      className: cls.name,
      classIdentifier: identifier,
      oldClassLevel,
      newClassLevel,
      characterLevel: Number(state.targetCharacterLevel),
      model,
      progression,
      maximumSpellLevel,
      cantripCount,
      spellCount,
      selectedCantripCount: (stateChoices.cantrips ?? []).length,
      selectedSpellCount: (stateChoices.spells ?? []).length,
      requiredSpellSelections,
      selectedSpellSelections,
      spellSelectionComplete: baseSelectionComplete && spellReplacementComplete && cantripReplacementComplete
        && features.complete && tomeSelectionComplete && metamagic.complete,
      duplicateSelectionCount,
      cantripGroups: registry.groupOptions(cantripOptions),
      cantripLevelGroups: this.#groupSpellsByLevel(cantripOptions, registry),
      spellGroups: registry.groupOptions(spellOptions),
      spellLevelGroups: this.#groupSpellsByLevel(spellOptions, registry),
      automaticGroups,
      automaticCount: automaticSpells.length,
      automaticItemGrants,
      automaticItemGrantCount: automaticItemGrants.length,
      automaticAdvancementSummaries,
      automaticAdvancementSummaryCount: automaticAdvancementSummaries.length,
      savant,
      invocations,
      metamagic,
      pactOfTheTome,
      replacement,
      cantripReplacement,
      features,
      subclassCaster: subclassCaster ? {
        identifier: subclassCaster.identifier,
        name: subclassCaster.subclass?.name,
        itemId: subclassCaster.subclass?.id,
        ability: subclassCaster.ability,
        sourceItem: subclassCaster.sourceItem
      } : null,
      magicalSecrets: {
        active: magicalSecretsActive,
        featureItemId: this.#featureByIdentifier(draft, "magical-secrets")?.id ?? null,
        bardBaseSpellIdentifiers: [...bardBaseSpellIdentifiers]
      },
      hasChoices,
      hasAutomatic,
      complete: Boolean(state.additionalComplete),
      noAdditionalWork: !hasChoices && !hasAutomatic,
      cantripScaling: {
        characterLevel: Number(state.targetCharacterLevel),
        threshold: this.#cantripScalingThreshold(Number(state.targetCharacterLevel)),
        note: `Cantrip damage scaling is validated against total character level ${state.targetCharacterLevel}, not ${cls.name} level ${newClassLevel}.`
      },
      note: this.#ruleNote(model, cls.name, spellCount, automaticSpells.length)
    };
  }

  static async apply(sourceActor, draft, registry, formData) {
    const context = await this.buildContext(sourceActor, draft, registry);
    const state = LevelUpDraftManager.getState(draft);
    if (state.additionalComplete) return { created: 0, deleted: 0 };
    const cls = draft.items.get(state.selectedClassId);
    if (!cls) throw new Error("The advanced Class no longer exists.");
    const rollbackSnapshot = this.#draftSnapshot(draft);

    try {
    const selectedCantrips = [...new Set(formData.getAll("levelUp.cantrips").map(String))];
    const selectedSpells = [...new Set(formData.getAll("levelUp.spells").map(String))];
    const selectedSavant = [...new Set(formData.getAll("levelUp.savantSpells").map(String))];
    const selectedTomeCantrips = [...new Set(formData.getAll("levelUp.pactOfTheTome.cantrips").map(String))];
    const selectedTomeRituals = [...new Set(formData.getAll("levelUp.pactOfTheTome.rituals").map(String))];
    this.#validateExact(selectedCantrips, context.cantripCount, context.cantripGroups, "cantrip");
    this.#validateExact(selectedSpells, context.spellCount, context.spellGroups, "spell");
    this.#validateExact(selectedSavant, context.savant.count, context.savant.groups, `${context.savant.schoolName || "Savant"} spell`);

    const removeSpellId = String(formData.get("levelUp.replaceSpell.remove") ?? "");
    const addReplacementIdentifier = String(formData.get("levelUp.replaceSpell.add") ?? "");
    if (Boolean(removeSpellId) !== Boolean(addReplacementIdentifier)) {
      throw new Error("Choose both sides of the optional spell replacement, or leave both blank.");
    }
    if (removeSpellId && !context.replacement.existing.some(item => item.id === removeSpellId)) {
      throw new Error("The spell selected for replacement is not eligible.");
    }
    if (addReplacementIdentifier && !context.replacement.options.some(item => item.identifier === addReplacementIdentifier)) {
      throw new Error("The replacement spell is not eligible.");
    }

    const removeCantripId = String(formData.get("levelUp.replaceCantrip.remove") ?? "");
    const addCantripIdentifier = String(formData.get("levelUp.replaceCantrip.add") ?? "");
    if (Boolean(removeCantripId) !== Boolean(addCantripIdentifier)) {
      throw new Error("Choose both sides of the optional cantrip replacement, or leave both blank.");
    }
    if (removeCantripId && !context.cantripReplacement.existing.some(item => item.id === removeCantripId)) {
      throw new Error("The cantrip selected for replacement is not eligible.");
    }
    if (addCantripIdentifier && !context.cantripReplacement.options.some(item => item.identifier === addCantripIdentifier)) {
      throw new Error("The replacement cantrip is not eligible.");
    }
    this.#validateUniqueSpellSelections([
      { channel: "cantrip", identifiers: selectedCantrips },
      { channel: "class spell", identifiers: selectedSpells },
      { channel: `${context.savant.schoolName || "Savant"} spell`, identifiers: selectedSavant },
      { channel: "replacement spell", identifiers: addReplacementIdentifier ? [addReplacementIdentifier] : [] },
      { channel: "replacement cantrip", identifiers: addCantripIdentifier ? [addCantripIdentifier] : [] }
    ]);

    const invocationSelections = [];
    for (let index = 0; index < context.invocations.count; index++) {
      const uuid = String(formData.get(`levelUp.invocation.${index}.uuid`) ?? "");
      const targetIdentifier = String(formData.get(`levelUp.invocation.${index}.target`) ?? "");
      if (!uuid) throw new Error(`Choose Eldritch Invocation ${index + 1}.`);
      invocationSelections.push({ uuid, targetIdentifier });
    }
    this.#validateInvocations(context.invocations, invocationSelections);
    this.#validatePendingInvocationTargets(context.invocations, invocationSelections, selectedCantrips);

    const replaceInvocationId = String(formData.get("levelUp.replaceInvocation.remove") ?? "");
    const replaceInvocationUuid = String(formData.get("levelUp.replaceInvocation.add") ?? "");
    const replaceInvocationTarget = String(formData.get("levelUp.replaceInvocation.target") ?? "");
    if (Boolean(replaceInvocationId) !== Boolean(replaceInvocationUuid)) {
      throw new Error("Choose both sides of the optional invocation replacement, or leave both blank.");
    }
    const invocationBeingReplaced = replaceInvocationId
      ? context.invocations.replacement.existing.find(item => item.id === replaceInvocationId)
      : null;
    if (replaceInvocationId && !invocationBeingReplaced) {
      throw new Error("The invocation selected for replacement is not eligible.");
    }
    if (invocationBeingReplaced?.blocked) {
      throw new Error(`${invocationBeingReplaced.name} cannot be replaced because it is required by ${invocationBeingReplaced.dependents.join(", ")}.`);
    }
    const tomeOption = context.invocations.options.find(option => option.identifier === PactOfTheTomeService.INVOCATION_IDENTIFIER) ?? null;
    const tomeSelectedNow = Boolean(tomeOption && [
      ...invocationSelections.map(row => row.uuid),
      replaceInvocationUuid
    ].filter(Boolean).includes(tomeOption.uuid));
    const tomeExistingBefore = PactOfTheTomeService.findInvocation(draft);
    const tomeSelectionBefore = tomeExistingBefore ? PactOfTheTomeService.currentSelection(draft, tomeExistingBefore.id) : null;
    const tomeNeedsInitialConfiguration = Boolean(tomeExistingBefore
      && ((tomeSelectionBefore?.cantrips?.length ?? 0) !== PactOfTheTomeService.CANTRIP_COUNT
        || (tomeSelectionBefore?.rituals?.length ?? 0) !== PactOfTheTomeService.RITUAL_COUNT));

    let invocationReplacementSelection = null;
    if (replaceInvocationUuid) {
      invocationReplacementSelection = { uuid: replaceInvocationUuid, targetIdentifier: replaceInvocationTarget };
      this.#validateInvocations(context.invocations, [invocationReplacementSelection], {
        replacingItemId: replaceInvocationId
      });
      this.#validatePendingInvocationTargets(context.invocations, [invocationReplacementSelection], selectedCantrips);
    }
    this.#validateInvocationTargetSurvival(
      context.invocations,
      [...invocationSelections, ...(invocationReplacementSelection ? [invocationReplacementSelection] : [])],
      { removeInvocationId: replaceInvocationId, removeCantripId }
    );

    const selectedByIdentifier = new Map();
    for (const group of [...context.cantripGroups, ...context.spellGroups, ...context.savant.groups]) {
      for (const option of group.items) selectedByIdentifier.set(option.identifier, option);
    }
    for (const group of context.automaticGroups) {
      for (const option of group.items) selectedByIdentifier.set(option.identifier, option);
    }
    for (const option of context.replacement.options) selectedByIdentifier.set(option.identifier, option);
    for (const option of context.cantripReplacement.options) selectedByIdentifier.set(option.identifier, option);

    const entries = [];
    const spellAccess = context.subclassCaster ? {
      sourceItem: context.subclassCaster.sourceItem,
      ability: context.subclassCaster.ability,
      subclassItemId: context.subclassCaster.itemId,
      accessModel: context.subclassCaster.identifier
    } : {};
    for (const identifier of selectedCantrips) entries.push({
      option: selectedByIdentifier.get(identifier), category: context.subclassCaster?.identifier ?? "cantrip", prepared: 1,
      ...spellAccess
    });
    for (const identifier of selectedSpells) {
      const magicalSecret = context.magicalSecrets.active && !context.magicalSecrets.bardBaseSpellIdentifiers.includes(identifier);
      entries.push({
        option: selectedByIdentifier.get(identifier),
        category: magicalSecret ? "magical-secrets" : (context.subclassCaster?.identifier ?? (context.model === "spellbook" ? "spellbook" : "limited")),
        prepared: context.model === "limited" ? 1 : 0,
        featureItemId: magicalSecret ? context.magicalSecrets.featureItemId : null,
        ...spellAccess
      });
    }
    for (const identifier of selectedSavant) entries.push({
      option: selectedByIdentifier.get(identifier), category: "wizard-savant", prepared: 0,
      featureItemId: context.savant.featureItemId
    });
    for (const group of context.automaticGroups) {
      for (const option of group.items) entries.push({ option, category: "full-list", prepared: 0 });
    }
    if (addReplacementIdentifier) {
      const magicalSecret = context.magicalSecrets.active && !context.magicalSecrets.bardBaseSpellIdentifiers.includes(addReplacementIdentifier);
      entries.push({
        option: selectedByIdentifier.get(addReplacementIdentifier),
        category: magicalSecret ? "magical-secrets" : (context.subclassCaster?.identifier ?? "replacement"),
        prepared: 1,
        featureItemId: magicalSecret ? context.magicalSecrets.featureItemId : null,
        ...spellAccess
      });
    }
    if (addCantripIdentifier) entries.push({
      option: selectedByIdentifier.get(addCantripIdentifier),
      category: context.subclassCaster?.identifier ?? "cantrip-replacement",
      prepared: 1,
      ...spellAccess
    });

    const uniqueEntries = [];
    const entryKeys = new Set();
    for (const entry of entries) {
      if (!entry.option) continue;
      const key = entry.option.identifier;
      if (entryKeys.has(key)) continue;
      entryKeys.add(key);
      uniqueEntries.push(entry);
    }

    const createdSpellIds = await this.#createSpells(draft, cls, uniqueEntries, state);
    let deleted = 0;
    if (removeSpellId) {
      await draft.deleteEmbeddedDocuments("Item", [removeSpellId]);
      deleted++;
    }
    if (removeCantripId) {
      await draft.deleteEmbeddedDocuments("Item", [removeCantripId]);
      deleted++;
    }

    const featureResult = await LevelUpFeatureService.apply(draft, cls, registry, formData, context.features, state);
    deleted += Number(featureResult.deleted ?? 0);

    const metamagicResult = await MetamagicService.apply(
      draft,
      cls,
      registry,
      formData,
      context.metamagic,
      state
    );
    deleted += Number(metamagicResult.deletedItemIds?.length ?? 0);

    const createdInvocationIds = [];
    for (const selection of invocationSelections) {
      const item = await this.#createInvocation(draft, cls, context.invocations, selection, state, registry);
      createdInvocationIds.push(item.id);
    }
    let invocationReplacementRecord = null;
    if (replaceInvocationId) {
      const original = draft.items.get(replaceInvocationId);
      const originalLevel = this.#findAdvancementItemLevel(cls, context.invocations.advancementId, replaceInvocationId);
      const cascadeDeleted = await this.#deleteInvocationCascade(draft, replaceInvocationId);
      deleted += cascadeDeleted.length;
      const item = await this.#createInvocation(draft, cls, context.invocations, {
        uuid: replaceInvocationUuid,
        targetIdentifier: replaceInvocationTarget
      }, state, registry);
      createdInvocationIds.push(item.id);
      invocationReplacementRecord = {
        original: replaceInvocationId,
        originalLevel,
        originalName: original?.name ?? null,
        replacement: item.id
      };
    }

    await this.#writeInvocationAdvancementValue(
      cls,
      context.invocations.advancementId,
      state.targetClassLevel,
      createdInvocationIds,
      invocationReplacementRecord
    );

    let tomeResult = { createdItemIds: [], deletedItemIds: [] };
    if (tomeSelectedNow || tomeNeedsInitialConfiguration) {
      tomeResult = await PactOfTheTomeService.apply(draft, registry, {
        mode: "acquisition",
        selectedCantrips: selectedTomeCantrips,
        selectedRituals: selectedTomeRituals,
        transactionId: state.transactionId,
        characterLevel: state.targetCharacterLevel,
        classLevel: state.targetClassLevel,
        classItem: cls
      });
      createdInvocationIds.push(...(tomeResult.createdItemIds ?? []));
      deleted += Number(tomeResult.deletedItemIds?.length ?? 0);
    }
    await SourceResolver.enforceAllowedSources(draft, registry);
    await this.#refreshCantripAugments(draft);
    const integrityResult = await ItemGrantIntegrityService.reconcile(draft, registry, { context: "levelUp", state });
    await FeatureSpellOwnershipService.reconcile(draft, integrityResult, state);
    await NativeAdvancementValidationService.validate(draft, {
      state,
      beforeItemIds: new Set(rollbackSnapshot.items.map(item => item._id)),
      workflow: "Spells & Features"
    });
    await AdvancementChoiceAnnotationService.refresh(draft, { state: LevelUpDraftManager.getState(draft) });

    const choices = {
      cantrips: selectedCantrips,
      spells: selectedSpells,
      savantSpells: selectedSavant,
      invocationSelections,
      metamagicSelections: metamagicResult.choices.selections,
      metamagicReplacement: metamagicResult.choices.replacement,
      spellReplacement: removeSpellId ? { removeId: removeSpellId, addIdentifier: addReplacementIdentifier } : null,
      cantripReplacement: removeCantripId ? { removeId: removeCantripId, addIdentifier: addCantripIdentifier } : null,
      features: featureResult.featureChoices,
      pactOfTheTome: (tomeSelectedNow || tomeNeedsInitialConfiguration) ? {
        cantrips: selectedTomeCantrips,
        rituals: selectedTomeRituals
      } : null,
      invocationReplacement: replaceInvocationId ? {
        removeId: replaceInvocationId,
        uuid: replaceInvocationUuid,
        targetIdentifier: replaceInvocationTarget
      } : null
    };
    await LevelUpDraftManager.setState(draft, {
      additionalChoices: choices,
      additionalComplete: true,
      commitReady: true,
      createdItemIds: [...new Set([
        ...(state.createdItemIds ?? []),
        ...createdSpellIds,
        ...createdInvocationIds,
        ...featureResult.createdItemIds,
        ...(metamagicResult.createdItemIds ?? [])
      ])],
      step: "review"
    });

    return {
      created: createdSpellIds.length + createdInvocationIds.length + featureResult.createdItemIds.length
        + Number(metamagicResult.createdItemIds?.length ?? 0),
      deleted
    };
    } catch (error) {
      try {
        await this.#restoreDraft(draft, rollbackSnapshot);
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Additional Level Up rule rollback failed.`, rollbackError);
      }
      if (error?.structuralLevelUp) {
        error.returnStep = "choices";
        throw error;
      }
      const message = String(error?.message ?? error ?? "");
      if (/must not have taken|prerequisite|not eligible|advancement was cancelled|cannot be selected/i.test(message)) {
        throw new StructuralLevelUpError("A native feature Advancement could not be applied safely.", {
          reason: message.replace(/^\[[^\]]+\]\s*/, "") || "The selected feature option is invalid.",
          diagnostic: message,
          returnStep: "choices"
        });
      }
      throw error;
    }
  }

  static async autoCompleteIfEmpty(sourceActor, draft, registry) {
    const context = await this.buildContext(sourceActor, draft, registry);
    if (!context.noAdditionalWork) return false;
    await LevelUpDraftManager.setState(draft, {
      additionalChoices: {},
      additionalComplete: true,
      commitReady: true,
      step: "review"
    });
    return true;
  }

  static #modelFor(cls) {
    const identifier = cls.system?.identifier;
    if (SPELL_ACCESS_MODELS.fullList.has(identifier)) return "fullList";
    if (SPELL_ACCESS_MODELS.limited.has(identifier)) return "limited";
    if (SPELL_ACCESS_MODELS.spellbook.has(identifier)) return "spellbook";
    return cls.system?.spellcasting?.progression === "none" ? "none" : "limited";
  }

  static async #classSpellPool(identifier, registry) {
    const spellLists = globalThis.dnd5e?.registry?.spellLists;
    if (!spellLists) throw new Error("The D&D5e spell-list registry is unavailable.");
    for (let attempt = 0; attempt < 20 && !spellLists.ready; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const list = spellLists.forType("class", identifier);
    if (!list) return [];
    const options = new Map();
    for (const index of list.indexes) {
      const spellIdentifier = index.system?.identifier;
      if (!spellIdentifier) continue;
      const preferred = registry.preferredOption("spell", spellIdentifier);
      if (!preferred) continue;
      options.set(spellIdentifier, preferred);
    }
    return [...options.values()].sort((a, b) => {
      const levelDifference = Number(a.system?.level ?? 0) - Number(b.system?.level ?? 0);
      return levelDifference || a.name.localeCompare(b.name, game.i18n.lang);
    });
  }

  static #scaleValue(cls, level, { identifier = null, title = null } = {}) {
    const advancement = this.#advancementData(cls).find(entry => {
      if (entry.type !== "ScaleValue") return false;
      if (identifier && entry.configuration?.identifier === identifier) return true;
      return title && String(entry.title ?? "").toLowerCase().includes(title);
    });
    if (!advancement) return 0;
    const rows = Object.entries(advancement.configuration?.scale ?? {})
      .map(([minimumLevel, value]) => [Number(minimumLevel), Number(value?.value ?? 0)])
      .filter(([minimumLevel]) => minimumLevel <= level)
      .sort((a, b) => a[0] - b[0]);
    return rows.at(-1)?.[1] ?? 0;
  }

  static #advancementData(item) {
    const collection = item?.advancement;
    if (collection?.contents) return collection.contents.map(entry => entry.toObject ? entry.toObject() : foundry.utils.deepClone(entry));
    if (collection?.values) return [...collection.values()].map(entry => entry.toObject ? entry.toObject() : foundry.utils.deepClone(entry));
    return Object.values(item?.toObject?.().system?.advancement ?? item?._source?.system?.advancement ?? item?.system?.advancement ?? {});
  }

  static #maximumSpellLevel(progression, level) {
    if (level <= 0) return 0;
    switch (progression) {
      case "full": return Math.min(9, Math.ceil(level / 2));
      case "half": return Math.min(5, Math.max(1, Math.floor((level + 3) / 4)));
      case "third": return Math.min(4, Math.max(1, Math.floor((level + 2) / 3)));
      case "pact": return Math.min(5, Math.ceil(level / 2));
      default: return 0;
    }
  }

  static async #wizardSavantContext(draft, cls, spellPool, existingIdentifiers, options) {
    if (cls.system?.identifier !== "wizard") return this.#emptySavantContext();
    const feature = draft.items.find(item => item.type === "feat" && / savant$/i.test(item.name));
    if (!feature) return this.#emptySavantContext();
    const schoolName = feature.name.replace(/\s+Savant$/i, "").trim();
    const school = WIZARD_SCHOOLS[schoolName.toLowerCase()];
    if (!school) return this.#emptySavantContext();

    let count = 0;
    if (options.oldClassLevel < 3 && options.newClassLevel >= 3) count = 2;
    else if (options.newClassLevel > 3 && options.maximumSpellLevel > options.oldMaximumSpellLevel) count = 1;
    if (!count) return { ...this.#emptySavantContext(), featureItemId: feature.id, schoolName, school };

    const selected = new Set(options.selected ?? []);
    const candidates = [];
    for (const option of spellPool) {
      const level = Number(option.system?.level ?? 0);
      if (level <= 0 || level > options.maximumSpellLevel || existingIdentifiers.has(option.identifier)) continue;
      let optionSchool = option.system?.school;
      if (!optionSchool) {
        const document = await fromUuid(option.uuid);
        optionSchool = document?.system?.school;
      }
      if (optionSchool !== school) continue;
      candidates.push(this.#decorateSpellOption(option, selected));
    }
    const registry = { groupOptions: rows => {
      const grouped = new Map();
      for (const row of rows) {
        const group = grouped.get(row.sourceId) ?? { id: row.sourceId, label: row.sourceLabel, rank: row.sourceRank, items: [] };
        group.items.push(row);
        grouped.set(row.sourceId, group);
      }
      return [...grouped.values()].sort((a, b) => a.rank - b.rank);
    }};
    return {
      count,
      featureItemId: feature.id,
      schoolName,
      school,
      groups: registry.groupOptions(candidates),
      selectedCount: selected.size,
      note: count === 2
        ? `${feature.name} adds two ${schoolName} Wizard spells when the subclass is gained.`
        : `${feature.name} adds one ${schoolName} Wizard spell because a new Wizard spell-slot level was unlocked.`
    };
  }

  static async #invocationContext(draft, cls, registry, stateChoices, pendingCantripOptions = []) {
    const advancement = this.#advancementData(cls).find(entry =>
      entry.type === "ItemChoice" && String(entry.title ?? "").toLowerCase() === "eldritch invocations"
    );
    if (!advancement) return this.#emptyInvocationContext();
    const state = LevelUpDraftManager.getState(draft);
    const row = advancement.configuration?.choices?.[String(state.targetClassLevel)] ?? {};
    const count = Number(row.count ?? 0) || 0;
    const allowReplacement = Boolean(row.replacement);
    const existing = draft.items.filter(item => this.#isInvocation(item));
    for (const item of existing) {
      if (item.getFlag(MODULE_ID, "invocationInstance")) continue;
      await PactOfTheTomeService.ensureInvocationMetadata(draft, item, {
        transactionId: item.getFlag(MODULE_ID, "creationTransactionId") ?? `creation:${draft.id}`,
        characterLevel: Number(draft.system?.details?.level ?? state.targetCharacterLevel ?? 1),
        classLevel: this.#findAdvancementItemLevel(cls, advancement._id, item.id),
        classItem: cls
      });
    }
    const existingSourceUuids = new Set(existing.map(item =>
      item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource
    ).filter(Boolean));
    const existingIdentifiers = new Set();
    for (const item of existing) {
      if (item.system?.identifier) existingIdentifiers.add(String(item.system.identifier));
      if (item.name) existingIdentifiers.add(this.#slug(item.name));
    }

    const documents = [];
    for (const poolEntry of advancement.configuration?.pool ?? []) {
      const uuid = typeof poolEntry === "string" ? poolEntry : poolEntry?.uuid;
      if (!uuid || !registry.isUuidAllowed(uuid)) continue;
      const document = await fromUuid(uuid);
      if (document) documents.push({ uuid, document });
    }
    const names = new Map(documents.map(({ document }) => [
      String(document.system?.identifier ?? this.#slug(document.name)), document.name
    ]));

    const options = documents.map(({ uuid, document }) => {
      const rawLevel = Number(document.system?.prerequisites?.level ?? 0) || 0;
      const minimumLevel = Math.max(0, rawLevel);
      const repeatable = Boolean(document.system?.prerequisites?.repeatable)
        || /repeatable/i.test(document.system?.description?.value ?? "");
      const identifier = String(document.system?.identifier ?? this.#slug(document.name));
      const prerequisiteIdentifiers = this.#prerequisiteIdentifiers(document);
      const prerequisiteLabels = prerequisiteIdentifiers.map(id => names.get(id) ?? this.#humanizeIdentifier(id));
      const alreadyKnown = !repeatable && (existingSourceUuids.has(uuid) || existingIdentifiers.has(identifier));
      const targetCantrip = this.#invocationTargetsCantrip(document);
      const levelQualified = minimumLevel <= Number(state.targetClassLevel);
      const prerequisiteQualified = !prerequisiteIdentifiers.length
        || prerequisiteIdentifiers.some(id => existingIdentifiers.has(id));
      let disabledReason = "";
      if (!levelQualified) disabledReason = `Requires Warlock Level ${minimumLevel}`;
      else if (!prerequisiteQualified) disabledReason = `Requires ${prerequisiteLabels.join(" or ")}`;
      else if (alreadyKnown) disabledReason = "Already known";
      return {
        uuid,
        name: document.name,
        img: document.img,
        identifier,
        repeatable,
        targetCantrip,
        minimumLevel,
        prerequisiteIdentifiers,
        prerequisiteIdentifiersString: prerequisiteIdentifiers.join("|"),
        prerequisiteLabels,
        prerequisiteLabelsString: prerequisiteLabels.join(" or "),
        alreadyKnown,
        levelQualified,
        prerequisiteQualified,
        disabled: Boolean(disabledReason),
        disabledReason,
        displayLabel: document.name,
        detailMeta: `${minimumLevel > 0 ? `Warlock Level ${minimumLevel}+` : "No Level Prerequisite"} • Eldritch Invocation${prerequisiteLabels.length ? ` • Requires ${prerequisiteLabels.join(" or ")}` : ""}`
      };
    }).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    const targetCantrips = await this.#eligibleWarlockCantrips(
      draft,
      pendingCantripOptions,
      new Set(stateChoices.cantrips ?? [])
    );
    const selected = stateChoices.invocationSelections ?? [];
    const availableIdentifiers = new Set(existingIdentifiers);
    const selectedUuids = new Set();
    const slots = Array.from({ length: count }, (_, index) => {
      const selectedUuid = selected[index]?.uuid ?? "";
      const slotOptions = options.map(option => {
        const levelQualified = option.minimumLevel <= Number(state.targetClassLevel);
        const prerequisiteQualified = !option.prerequisiteIdentifiers.length
          || option.prerequisiteIdentifiers.some(id => availableIdentifiers.has(id));
        const duplicate = selectedUuids.has(option.uuid) && !option.repeatable;
        let disabledReason = "";
        if (!levelQualified) disabledReason = `Requires Warlock Level ${option.minimumLevel}`;
        else if (!prerequisiteQualified) disabledReason = `Requires ${option.prerequisiteLabelsString}`;
        else if (option.alreadyKnown) disabledReason = "Already known";
        else if (duplicate) disabledReason = "Already selected";
        return { ...option, disabled: Boolean(disabledReason), disabledReason };
      });
      const selectedOption = slotOptions.find(option => option.uuid === selectedUuid && !option.disabled);
      if (selectedOption) {
        availableIdentifiers.add(selectedOption.identifier);
        selectedUuids.add(selectedOption.uuid);
      }
      return {
        index,
        selectedUuid,
        selectedTarget: selected[index]?.targetIdentifier ?? "",
        options: slotOptions,
        levelGroups: this.#groupInvocationOptions(slotOptions)
      };
    });

    const replacementOptions = options.map(option => {
      const levelQualified = option.minimumLevel <= Number(state.targetClassLevel);
      const prerequisiteQualified = !option.prerequisiteIdentifiers.length
        || option.prerequisiteIdentifiers.some(id => availableIdentifiers.has(id));
      let disabledReason = "";
      if (!levelQualified) disabledReason = `Requires Warlock Level ${option.minimumLevel}`;
      else if (!prerequisiteQualified) disabledReason = `Requires ${option.prerequisiteLabelsString}`;
      else if (option.alreadyKnown) disabledReason = "Already known";
      return { ...option, disabled: Boolean(disabledReason), disabledReason };
    });

    return {
      advancementId: advancement._id,
      count,
      allowReplacement,
      options,
      levelGroups: this.#groupInvocationOptions(options),
      slots,
      targetCantrips,
      targetClassLevel: Number(state.targetClassLevel),
      existingIdentifiers: [...existingIdentifiers],
      existingIdentifiersString: [...existingIdentifiers].join("|"),
      replacement: {
        available: allowReplacement && existing.length > 0,
        selectedRemoveId: stateChoices.invocationReplacement?.removeId ?? "",
        selectedUuid: stateChoices.invocationReplacement?.uuid ?? "",
        selectedTarget: stateChoices.invocationReplacement?.targetIdentifier ?? "",
        existing: await this.#invocationReplacementRows(existing),
        options: replacementOptions,
        levelGroups: this.#groupInvocationOptions(replacementOptions)
      },
      note: count
        ? `Choose ${count} Eldritch Invocation${count === 1 ? "" : "s"}. Unavailable options remain visible with their prerequisites.`
        : "This Warlock level allows an optional invocation replacement."
    };
  }

  static async #invocationReplacementRows(existing) {
    const nodes = [];
    for (const item of existing) {
      const sourceUuid = item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? null;
      const document = sourceUuid ? await fromUuid(sourceUuid) : item;
      nodes.push({
        item,
        identifier: String(item.system?.identifier ?? document?.system?.identifier ?? this.#slug(item.name)),
        prerequisites: this.#prerequisiteIdentifiers(document ?? item),
        sourceUuid
      });
    }

    const identifierCounts = new Map();
    for (const node of nodes) identifierCounts.set(node.identifier, (identifierCounts.get(node.identifier) ?? 0) + 1);

    return nodes.map(candidate => {
      const counts = new Map(identifierCounts);
      counts.set(candidate.identifier, Math.max(0, (counts.get(candidate.identifier) ?? 0) - 1));
      const active = new Set([...counts.entries()].filter(([, count]) => count > 0).map(([identifier]) => identifier));
      const invalidIds = new Set();
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of nodes) {
          if (node.item.id === candidate.item.id || invalidIds.has(node.item.id)) continue;
          if (!active.has(node.identifier)) continue;
          if (!node.prerequisites.length || node.prerequisites.some(identifier => active.has(identifier))) continue;
          invalidIds.add(node.item.id);
          // Only remove the identifier from the active set when no other valid
          // instance remains. This preserves repeatable invocation instances.
          const otherValid = nodes.some(other => other.item.id !== candidate.item.id
            && other.item.id !== node.item.id
            && !invalidIds.has(other.item.id)
            && other.identifier === node.identifier);
          if (!otherValid) active.delete(node.identifier);
          changed = true;
        }
      }
      const dependents = nodes.filter(node => invalidIds.has(node.item.id)).map(node => node.item.name);
      const instance = candidate.item.getFlag(MODULE_ID, "invocationInstance") ?? {};
      const targetExists = instance.targetCantripItemId ? Boolean(candidate.item.actor?.items?.get(instance.targetCantripItemId)) : true;
      const targetLabel = instance.targetCantripName
        ? (targetExists ? instance.targetCantripName : `Missing Target: ${instance.targetCantripName}`)
        : "";
      return {
        id: candidate.item.id,
        name: targetLabel ? `${candidate.item.name} [${targetLabel}]` : candidate.item.name,
        baseName: candidate.item.name,
        img: candidate.item.img,
        identifier: candidate.identifier,
        sourceUuid: candidate.sourceUuid,
        targetItemId: instance.targetCantripItemId ?? null,
        targetIdentifier: instance.targetCantripIdentifier ?? null,
        targetName: instance.targetCantripName ?? null,
        instanceId: instance.instanceId ?? null,
        advancementId: instance.advancementId ?? null,
        transactionId: instance.transactionId ?? null,
        blocked: dependents.length > 0,
        disabledReason: dependents.length ? `Required by ${dependents.join(", ")}` : "",
        dependents
      };
    });
  }

  static #groupInvocationOptions(options) {
    const groups = new Map();
    for (const option of options ?? []) {
      const level = Number(option.minimumLevel ?? 0);
      const group = groups.get(level) ?? {
        level,
        label: level > 0 ? `Warlock Level ${level}+` : "No Level Prerequisite",
        items: []
      };
      group.items.push(option);
      groups.set(level, group);
    }
    return [...groups.values()]
      .sort((a, b) => a.level - b.level)
      .map(group => ({
        ...group,
        items: group.items.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
      }));
  }

  static #prerequisiteIdentifiers(document) {
    const values = document.system?.prerequisites?.items;
    if (!values) return [];
    const rows = values instanceof Set || values?.values ? [...values.values()] : Array.isArray(values) ? values : [];
    return [...new Set(rows.map(value => {
      if (typeof value === "string") return value;
      return value?.identifier ?? value?.id ?? value?.value ?? "";
    }).map(String).filter(Boolean))];
  }

  static #humanizeIdentifier(identifier) {
    return String(identifier ?? "")
      .split(/[-_]/g)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  static async #eligibleWarlockCantrips(draft, pendingCantripOptions = [], selectedPending = new Set()) {
    const candidates = new Map();
    for (const item of draft.items.filter(item => item.type === "spell" && Number(item.system?.level ?? 0) === 0)) {
      const classIdentifier = this.#spellClassIdentifier(item, draft);
      if (classIdentifier !== "warlock" || !this.#spellDealsDamage(item)) continue;
      const identifier = String(item.system?.identifier ?? "");
      if (!identifier) continue;
      const candidate = candidates.get(identifier) ?? {
        identifier,
        name: item.name,
        pending: false,
        eligible: true,
        acquisitions: []
      };
      candidate.acquisitions.push({
        itemId: item.id,
        providerItemIds: this.#spellProviderItemIds(item)
      });
      candidates.set(identifier, candidate);
    }

    // Only cantrips that can actually be selected during this same Level Up are
    // shown as pending targets. The rest of the Warlock catalogue is excluded.
    for (const option of pendingCantripOptions) {
      if (!option?.identifier || candidates.has(option.identifier)) continue;
      const document = await fromUuid(option.uuid);
      if (!document || !this.#spellDealsDamage(document)) continue;
      candidates.set(option.identifier, {
        identifier: option.identifier,
        name: option.name,
        uuid: option.uuid,
        pending: true,
        eligible: selectedPending.has(option.identifier),
        acquisitions: []
      });
    }

    return [...candidates.values()]
      .map(candidate => ({
        ...candidate,
        acquisitionBindingsString: (candidate.acquisitions ?? [])
          .map(acquisition => `${acquisition.itemId}:${(acquisition.providerItemIds ?? []).join(",")}`)
          .join("|")
      }))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  }

  static #spellProviderItemIds(item) {
    const providers = new Set();
    const add = value => {
      const id = String(value ?? "").trim();
      if (id) providers.add(id);
    };
    add(item.getFlag(MODULE_ID, "pactOfTheTomeSelection")?.invocationItemId);
    add(item.getFlag(MODULE_ID, "featureGrantedSpell")?.featureItemId);
    add(item.getFlag(MODULE_ID, "featureAcquisition")?.featureItemId);
    for (const owner of item.getFlag(MODULE_ID, "featureSpellOwners") ?? []) {
      add(owner?.ownerItemId);
      add(owner?.featureItemId);
    }
    return [...providers];
  }

  static #spellClassIdentifier(item, draft, seen = new Set()) {
    const explicit = item.getFlag(MODULE_ID, "classSpellAccess")?.classIdentifier
      ?? item.getFlag(MODULE_ID, "classIdentifier")
      ?? item.getFlag(MODULE_ID, "levelUpSpell")?.classIdentifier;
    if (explicit) return explicit;

    const sourceItem = String(item.system?.sourceItem ?? "");
    if (sourceItem.startsWith("class:")) return sourceItem.slice("class:".length);
    if (sourceItem.startsWith("subclass:")) {
      const subclassIdentifier = sourceItem.slice("subclass:".length);
      const subclass = draft.items.find(document => document.type === "subclass"
        && document.system?.identifier === subclassIdentifier);
      const parent = subclass?.system?.classIdentifier
        ?? subclass?.system?.class?.identifier
        ?? subclass?.system?.class;
      if (parent) return String(parent);
      if (subclassIdentifier === "eldritch-knight") return "fighter";
      if (["arcane-trickster", "trickster"].includes(subclassIdentifier)) return "rogue";
    }

    const origin = item.getFlag("dnd5e", "advancementRoot")
      ?? item.getFlag("dnd5e", "advancementOrigin");
    const [ownerId] = String(origin ?? "").split(".");
    if (!ownerId || seen.has(ownerId)) return null;
    seen.add(ownerId);
    const owner = draft.items.get(ownerId);
    if (!owner) return null;
    if (owner.type === "class") return owner.system?.identifier ?? null;
    if (owner.type === "subclass") return owner.system?.classIdentifier ?? owner.class?.system?.identifier ?? null;
    return this.#spellClassIdentifier(owner, draft, seen);
  }

  static #spellUnavailableReason(draft, spell) {
    const owners = spell.getFlag(MODULE_ID, "featureSpellOwners") ?? [];
    const owner = owners[0] ?? null;
    if (owner) {
      const subclass = owner.subclassItemId ? draft.items.get(owner.subclassItemId) : null;
      const ownerLabel = subclass?.name ?? owner.label ?? "another Warlock feature";
      return `Already granted by ${ownerLabel}${owner.alwaysPrepared ? " — Always Prepared" : ""}.`;
    }
    const sourceItem = String(spell.system?.sourceItem ?? "");
    if (sourceItem.startsWith("subclass:")) {
      const identifier = sourceItem.slice("subclass:".length);
      const subclass = draft.items.find(item => item.type === "subclass" && item.system?.identifier === identifier);
      return `Already granted by ${subclass?.name ?? "the selected Patron"} — Always Prepared.`;
    }
    if (spell.getFlag(MODULE_ID, "featureGrantedSpell")) return "Already granted by another Warlock feature.";
    return "Already known through Pact Magic.";
  }

  static #isNormalClassSpell(item, cls) {
    if (!item || item.type !== "spell" || !cls) return false;
    if (item.getFlag(MODULE_ID, "featureGrantedSpell")) return false;
    const owners = item.getFlag(MODULE_ID, "featureSpellOwners") ?? [];
    if (owners.length) return false;
    const classAccess = item.getFlag(MODULE_ID, "classSpellAccess");
    if (classAccess && item.getFlag(MODULE_ID, "classItemId") === cls.id) return true;
    const levelUp = item.getFlag(MODULE_ID, "levelUpSpell");
    if (levelUp?.classItemId === cls.id && !levelUp.featureItemId) return true;
    return String(item.system?.sourceItem ?? "") === `class:${cls.system?.identifier}`
      && this.#spellClassIdentifier(item, cls.actor) === cls.system?.identifier;
  }

  static #spellReplacementContext(draft, classIdentifier, leveledPool, stateChoices, blockedIdentifiers = new Set(), unavailableChoiceInfo = new Map()) {
    const existing = draft.items
      .filter(item => item.type === "spell" && Number(item.system?.level ?? 0) > 0)
      .filter(item => this.#spellClassIdentifier(item, draft) === classIdentifier
        && !item.getFlag(MODULE_ID, "featureGrantedSpell"));
    const known = new Set(existing.map(item => item.system?.identifier).filter(Boolean));
    const selectedReplacement = stateChoices.spellReplacement?.addIdentifier ?? "";
    const options = leveledPool.filter(option => !known.has(option.identifier)).map(option => {
      const selectedElsewhere = blockedIdentifiers.has(option.identifier) && selectedReplacement !== option.identifier;
      const unavailableReason = unavailableChoiceInfo.get(option.identifier) ?? "";
      return {
        ...option,
        levelLabel: this.#levelLabel(option.system?.level),
        displayName: option.magicalSecretsEligible ? `${option.name} — Magical Secrets` : option.name,
        disabled: Boolean(selectedElsewhere || unavailableReason),
        disabledReason: unavailableReason || (selectedElsewhere ? "Already selected as a new spell during this Level Up." : "")
      };
    });
    return {
      available: existing.length > 0 && options.length > 0,
      existing: existing.map(item => ({ id: item.id, name: item.name, img: item.img })),
      options,
      removeId: stateChoices.spellReplacement?.removeId ?? "",
      addIdentifier: stateChoices.spellReplacement?.addIdentifier ?? ""
    };
  }

  static #cantripReplacementContext(draft, classIdentifier, cantripPool, stateChoices, blockedIdentifiers = new Set(), { excludedIdentifiers = new Set(), unavailableChoiceInfo = new Map() } = {}) {
    const existing = draft.items
      .filter(item => item.type === "spell" && Number(item.system?.level ?? 0) === 0)
      .filter(item => this.#spellClassIdentifier(item, draft) === classIdentifier
        && !item.getFlag(MODULE_ID, "featureGrantedSpell")
        && !excludedIdentifiers.has(String(item.system?.identifier ?? "")));
    const known = new Set(existing.map(item => item.system?.identifier).filter(Boolean));
    const selectedReplacement = stateChoices.cantripReplacement?.addIdentifier ?? "";
    const options = cantripPool.filter(option => !known.has(option.identifier)).map(option => {
      const selectedElsewhere = blockedIdentifiers.has(option.identifier) && selectedReplacement !== option.identifier;
      const unavailableReason = unavailableChoiceInfo.get(option.identifier) ?? "";
      return {
        ...option,
        levelLabel: "Cantrip",
        disabled: Boolean(selectedElsewhere || unavailableReason),
        disabledReason: unavailableReason || (selectedElsewhere ? "Already selected as a new cantrip during this Level Up." : "")
      };
    });
    return {
      available: existing.length > 0 && options.length > 0,
      existing: existing.map(item => ({ id: item.id, name: item.name, img: item.img })),
      options,
      removeId: stateChoices.cantripReplacement?.removeId ?? "",
      addIdentifier: stateChoices.cantripReplacement?.addIdentifier ?? ""
    };
  }

  static #featureByIdentifier(draft, identifier) {
    return draft.items.find(item => item.type === "feat" && (
      item.system?.identifier === identifier || this.#slug(item.name) === identifier
    ));
  }

  static #decorateSpellOption(option, selected, blocked = new Set(), unavailableChoiceInfo = new Map()) {
    const checked = selected.has(option.identifier);
    const unavailableReason = unavailableChoiceInfo.get(option.identifier) ?? "";
    const disabled = !checked && (blocked.has(option.identifier) || Boolean(unavailableReason));
    return {
      ...option,
      checked,
      disabled,
      disabledReason: unavailableReason || (disabled ? "Already selected through another spell choice." : ""),
      levelLabel: this.#levelLabel(option.system?.level),
      school: option.system?.school ?? ""
    };
  }

  static #groupSpellsByLevel(options, registry) {
    const byLevel = new Map();
    for (const option of options ?? []) {
      const level = Number(option.system?.level ?? 0);
      const rows = byLevel.get(level) ?? [];
      rows.push(option);
      byLevel.set(level, rows);
    }
    return [...byLevel.entries()]
      .sort(([a], [b]) => a - b)
      .map(([level, rows]) => ({
        level,
        label: level === 0 ? "Cantrips — Spell Level 0" : `Spell Level ${level}`,
        groups: registry.groupOptions(rows),
        count: rows.length
      }));
  }

  static #automaticAdvancementSummaries(draft, cls, targetClassLevel) {
    const summaries = [];
    const classIdentifier = cls.system?.identifier;
    for (const owner of draft.items) {
      if (!['class', 'subclass'].includes(owner.type)) continue;
      if (owner.type === 'class' && owner.id !== cls.id) continue;
      if (owner.type === 'subclass') {
        const parent = owner.system?.classIdentifier ?? owner.system?.class?.identifier ?? owner.system?.class;
        if (parent && parent !== classIdentifier) continue;
      }
      const advancements = owner.toObject().system?.advancement ?? {};
      for (const advancement of Object.values(advancements)) {
        if (Number(advancement?.level ?? 0) !== Number(targetClassLevel)) continue;
        const type = String(advancement?.type ?? '');
        if (type === 'ScaleValue') {
          const rows = Object.entries(advancement.configuration?.scale ?? {})
            .map(([minimum, row]) => [Number(minimum), row?.value])
            .filter(([minimum]) => minimum <= Number(targetClassLevel))
            .sort((a, b) => a[0] - b[0]);
          const value = rows.at(-1)?.[1];
          summaries.push({
            ownerName: owner.name,
            ownerUuid: owner.uuid,
            title: advancement.title || advancement.configuration?.identifier || 'Scale Increase',
            type: 'Scale Value',
            detail: value == null ? 'Updated by the native D&D5e Advancement.' : `New value: ${value}`,
            icon: 'fa-solid fa-arrow-trend-up'
          });
          continue;
        }
        if (type === 'Trait') {
          const choices = advancement.configuration?.choices ?? [];
          const grants = advancement.configuration?.grants ?? [];
          if (choices.length || !grants.length) continue;
          summaries.push({
            ownerName: owner.name,
            ownerUuid: owner.uuid,
            title: advancement.title || 'Proficiency or Trait Grant',
            type: 'Trait Grant',
            detail: grants.map(grant => this.#humanize(String(grant).split(':').at(-1))).join(', '),
            icon: 'fa-solid fa-list-check'
          });
        }
      }
    }
    return summaries;
  }

  static #duplicateCount(values) {
    const seen = new Set();
    let duplicates = 0;
    for (const value of values) {
      if (!value) continue;
      if (seen.has(value)) duplicates++;
      else seen.add(value);
    }
    return duplicates;
  }

  static #validateUniqueSpellSelections(channels) {
    const seen = new Map();
    for (const channel of channels) {
      for (const identifier of channel.identifiers ?? []) {
        if (!identifier) continue;
        const previous = seen.get(identifier);
        if (previous) {
          throw new Error(`${identifier} was selected through both ${previous} and ${channel.channel}. Choose a different spell.`);
        }
        seen.set(identifier, channel.channel);
      }
    }
  }

  static #validateExact(selected, expected, groups, label) {
    if (selected.length !== expected) {
      throw new Error(`Choose exactly ${expected} ${label}${expected === 1 ? "" : "s"}.`);
    }
    const valid = new Set((groups ?? []).flatMap(group => group.items).filter(item => !item.disabled || item.checked).map(item => item.identifier));
    const invalid = selected.find(identifier => !valid.has(identifier));
    if (invalid) throw new Error(`A selected ${label} is not available from the enabled prioritized source list.`);
  }

  static #validateInvocations(context, selections, { replacingItemId = null } = {}) {
    const byUuid = new Map(context.options.map(option => [option.uuid, option]));
    const availableIdentifiers = new Set(context.existingIdentifiers ?? []);
    if (replacingItemId) {
      const replacing = context.replacement.existing?.find(item => item.id === replacingItemId);
      if (replacing?.identifier) availableIdentifiers.delete(replacing.identifier);
    }
    const seen = new Map();
    const targets = new Set();
    for (const selection of selections) {
      const option = byUuid.get(selection.uuid);
      if (!option) throw new Error("A selected Eldritch Invocation is not available from the enabled sources.");
      if (option.minimumLevel > Number(context.targetClassLevel ?? Infinity)) {
        throw new Error(`${option.name} requires Warlock level ${option.minimumLevel}.`);
      }
      if (option.prerequisiteIdentifiers?.length
        && !option.prerequisiteIdentifiers.some(identifier => availableIdentifiers.has(identifier))) {
        throw new Error(`${option.name} requires ${option.prerequisiteLabelsString || option.prerequisiteIdentifiers.join(" or ")}.`);
      }
      if (option.alreadyKnown && !option.repeatable) throw new Error(`${option.name} is already known and is not repeatable.`);
      const count = (seen.get(option.uuid) ?? 0) + 1;
      seen.set(option.uuid, count);
      if (count > 1 && !option.repeatable) throw new Error(`${option.name} cannot be selected more than once.`);
      if (option.targetCantrip) {
        if (!selection.targetIdentifier) throw new Error(`Choose the cantrip augmented by ${option.name}.`);
        if (!context.targetCantrips.some(cantrip => cantrip.identifier === selection.targetIdentifier)) {
          throw new Error(`The selected cantrip is not eligible for ${option.name}.`);
        }
        const key = `${option.uuid}:${selection.targetIdentifier}`;
        if (targets.has(key)) throw new Error(`${option.name} must target a different cantrip each time it is selected.`);
        targets.add(key);
      }
      availableIdentifiers.add(option.identifier);
    }
  }

  static #validatePendingInvocationTargets(context, selections, selectedCantrips) {
    const selected = new Set(selectedCantrips ?? []);
    for (const selection of selections) {
      if (!selection.targetIdentifier) continue;
      const target = context.targetCantrips.find(cantrip => cantrip.identifier === selection.targetIdentifier);
      if (target?.pending && !selected.has(target.identifier)) {
        throw new Error(`${target.name} must be selected as a Warlock cantrip during this Level Up before an Eldritch Invocation can augment it.`);
      }
    }
  }

  static #validateInvocationTargetSurvival(context, selections, {
    removeInvocationId = "",
    removeCantripId = ""
  } = {}) {
    if (!removeInvocationId && !removeCantripId) return;
    for (const selection of selections ?? []) {
      if (!selection.targetIdentifier) continue;
      const target = context.targetCantrips.find(cantrip => cantrip.identifier === selection.targetIdentifier);
      if (!target || target.pending) continue;
      const survives = (target.acquisitions ?? []).some(acquisition => {
        if (removeCantripId && acquisition.itemId === removeCantripId) return false;
        return !removeInvocationId || !(acquisition.providerItemIds ?? []).includes(removeInvocationId);
      });
      if (!survives) {
        throw new Error(`${target.name} cannot be targeted because its only eligible acquisition will be removed during this Level Up.`);
      }
    }
  }

  static async #createSpells(draft, cls, entries, state) {
    const existing = new Set(draft.items
      .filter(item => item.type === "spell" && this.#isNormalClassSpell(item, cls))
      .map(item => item.system?.identifier)
      .filter(Boolean));
    const createData = [];
    for (const entry of entries) {
      if (!entry.option || existing.has(entry.option.identifier)) continue;
      const document = await fromUuid(entry.option.uuid);
      if (!document) throw new Error(`Unable to load spell: ${entry.option.name}.`);
      const data = document.toObject();
      delete data._id;
      data.system ??= {};
      data.system.ability = entry.ability ?? cls.system?.spellcasting?.ability ?? data.system.ability ?? "";
      data.system.method = cls.system?.spellcasting?.progression === "pact" ? "pact" : "spell";
      data.system.prepared = entry.prepared;
      data.system.sourceItem = entry.sourceItem ?? `class:${cls.system?.identifier}`;
      data.flags ??= {};
      data.flags.dnd5e ??= {};
      data.flags.dnd5e.sourceId = document.uuid;
      data.flags[MODULE_ID] = {
        ...(data.flags[MODULE_ID] ?? {}),
        levelUpSpell: {
          transactionId: state.transactionId,
          classIdentifier: cls.system?.identifier,
          classItemId: cls.id,
          subclassItemId: entry.subclassItemId ?? null,
          accessModel: entry.accessModel ?? null,
          acquiredAtCharacterLevel: state.targetCharacterLevel,
          acquiredAtClassLevel: state.targetClassLevel,
          category: entry.category,
          featureItemId: entry.featureItemId ?? null,
          sourceUuid: document.uuid
        },
        ...(entry.featureItemId ? {
          featureAcquisition: {
            category: entry.category,
            featureItemId: entry.featureItemId,
            classIdentifier: cls.system?.identifier,
            classItemId: cls.id,
            subclassItemId: entry.subclassItemId ?? null,
            transactionId: state.transactionId,
            acquiredAtCharacterLevel: state.targetCharacterLevel,
            acquiredAtClassLevel: state.targetClassLevel,
            sourceUuid: document.uuid
          }
        } : {})
      };
      createData.push(data);
      existing.add(entry.option.identifier);
    }
    if (!createData.length) return [];
    const created = await draft.createEmbeddedDocuments("Item", createData);
    return created.map(item => item.id);
  }

  static async #createInvocation(draft, cls, context, selection, state, registry) {
    const option = context.options.find(row => row.uuid === selection.uuid);
    if (!option) throw new Error("The selected Eldritch Invocation is no longer available.");
    const document = await fromUuid(option.uuid);
    if (!document) throw new Error(`Unable to load ${option.name}.`);
    document.system?.validatePrerequisites?.(draft, {
      level: Number(state.targetClassLevel),
      showMessage: false,
      throwError: true
    });
    const before = new Set(draft.items.map(item => item.id));
    let data = SourceResolver.filterAdvancementPools(document.toObject(), registry);
    delete data._id;
    const Manager = globalThis.dnd5e?.applications?.advancement?.AdvancementManager;
    if (!Manager) throw new Error("D&D5e AdvancementManager is unavailable.");
    const manager = Manager.forNewItem(draft, data, { automaticApplication: true, showVisualizer: false });
    if (manager.steps.length) {
      const result = await this.#runManager(manager);
      if (!result.completed) throw new Error(`${option.name} Advancement was cancelled.`);
    } else await draft.createEmbeddedDocuments("Item", [data]);
    const item = draft.items.find(candidate => !before.has(candidate.id)
      && candidate.type === document.type
      && candidate.system?.identifier === document.system?.identifier);
    if (!item) throw new Error(`${option.name} was not created on the Level Up draft.`);

    const target = option.targetCantrip
      ? draft.items.find(candidate => candidate.type === "spell" && candidate.system?.identifier === selection.targetIdentifier)
      : null;
    if (option.targetCantrip && !target) {
      throw new Error(`The target cantrip for ${option.name} was not found after spell selections were applied.`);
    }

    await item.update({
      [`flags.dnd5e.sourceId`]: document.uuid,
      [`flags.dnd5e.advancementOrigin`]: `${cls.id}.${context.advancementId}`,
      [`flags.dnd5e.advancementRoot`]: `${cls.id}.${context.advancementId}`,
      [`flags.${MODULE_ID}.invocationInstance`]: {
        instanceId: foundry.utils.randomID(),
        transactionId: state.transactionId,
        classIdentifier: cls.system?.identifier ?? "warlock",
        classItemId: cls.id,
        advancementId: context.advancementId,
        sourceUuid: document.uuid,
        identifier: document.system?.identifier ?? option.identifier,
        acquiredAtCharacterLevel: state.targetCharacterLevel,
        acquiredAtWarlockLevel: state.targetClassLevel,
        targetCantripItemId: target?.id ?? null,
        targetCantripIdentifier: target?.system?.identifier ?? null,
        targetCantripName: target?.name ?? null,
        repeatable: option.repeatable
      }
    });
    return item;
  }

  static async #deleteInvocationCascade(draft, invocationId) {
    const owner = draft.items.get(invocationId);
    if (!owner) return [];
    const beforeIds = new Set(draft.items.map(item => item.id));

    // Character Builder-owned Tome documents are not native Advancement
    // contents, so remove them explicitly before deleting the Invocation.
    await PactOfTheTomeService.cleanup(draft, invocationId);

    // D&D5e Cast activities delete their cached spells from an un-awaited
    // onDelete hook. Removing the cached spell first ensures that hook resolves
    // no document and prevents a second delete request for the same embedded ID.
    const cachedSpellIds = draft.items.filter(item => {
      const cachedFor = String(item.getFlag("dnd5e", "cachedFor") ?? "");
      return cachedFor.includes(`.Item.${invocationId}.`);
    }).map(item => item.id).filter(id => draft.items.get(id));
    if (cachedSpellIds.length) {
      await draft.deleteEmbeddedDocuments("Item", cachedSpellIds, {
        deleteContents: false,
        characterBuilderInvocationCascade: true
      });
    }

    // The cached activity contents are already gone, so delete only the root.
    // `deleteContents` stays false to keep D&D5e from scheduling a competing
    // content deletion while the ItemChoice replacement is being reconciled.
    if (draft.items.get(invocationId)) {
      await draft.deleteEmbeddedDocuments("Item", [invocationId], {
        deleteContents: false,
        characterBuilderInvocationCascade: true
      });
    }

    // Defensive cleanup is limited to explicit Advancement or Character
    // Builder ownership. Cached spells are intentionally excluded because they
    // were handled before the root deletion.
    const leftovers = draft.items.filter(item => {
      const origin = String(item.getFlag("dnd5e", "advancementOrigin") ?? "");
      const root = String(item.getFlag("dnd5e", "advancementRoot") ?? "");
      const featureOwner = item.getFlag(MODULE_ID, "featureAcquisition")?.featureItemId
        ?? item.getFlag(MODULE_ID, "featureGrantedSpell")?.featureItemId
        ?? item.getFlag(MODULE_ID, "pactOfTheTomeSelection")?.invocationItemId
        ?? item.getFlag(MODULE_ID, "pactOfTheTomeBook")?.invocationItemId
        ?? null;
      return origin.startsWith(`${invocationId}.`)
        || root.startsWith(`${invocationId}.`)
        || featureOwner === invocationId;
    }).map(item => item.id).filter(id => draft.items.get(id));
    if (leftovers.length) {
      await draft.deleteEmbeddedDocuments("Item", leftovers, {
        deleteContents: false,
        characterBuilderInvocationCascade: true
      });
    }

    return [...beforeIds].filter(id => !draft.items.get(id));
  }

  static async #writeInvocationAdvancementValue(cls, advancementId, targetLevel, itemIds, replacementRecord = null) {
    if (!advancementId || (!itemIds.length && !replacementRecord)) return;
    const source = cls.toObject();
    const advancement = source.system?.advancement?.[advancementId];
    if (!advancement) return;
    advancement.value ??= { added: {}, replaced: {} };
    advancement.value.added ??= {};
    advancement.value.replaced ??= {};
    advancement.value.added[String(targetLevel)] ??= {};
    for (const id of itemIds) {
      const item = cls.actor.items.get(id);
      const uuid = item?.getFlag("dnd5e", "sourceId") ?? item?._stats?.compendiumSource;
      if (uuid) advancement.value.added[String(targetLevel)][id] = uuid;
    }
    if (replacementRecord) {
      advancement.value.replaced[String(targetLevel)] = {
        level: Number(replacementRecord.originalLevel ?? targetLevel),
        original: replacementRecord.original,
        replacement: replacementRecord.replacement
      };
    }
    await cls.update({
      [`system.advancement.${advancementId}.value`]: advancement.value
    });
  }

  static #findAdvancementItemLevel(cls, advancementId, itemId) {
    const advancement = cls.toObject().system?.advancement?.[advancementId];
    for (const [level, items] of Object.entries(advancement?.value?.added ?? {})) {
      if (Object.prototype.hasOwnProperty.call(items ?? {}, itemId)) return Number(level);
    }
    return Number(cls.system?.levels ?? 1);
  }

  static async #refreshCantripAugments(draft) {
    const invocations = draft.items.filter(item => item.getFlag(MODULE_ID, "invocationInstance"));
    const byCantrip = new Map();
    for (const invocation of invocations) {
      const data = invocation.getFlag(MODULE_ID, "invocationInstance");
      if (!data?.targetCantripItemId) continue;
      const rows = byCantrip.get(data.targetCantripItemId) ?? [];
      rows.push({
        invocationItemId: invocation.id,
        instanceId: data.instanceId ?? null,
        name: invocation.name,
        identifier: data.identifier,
        sourceUuid: data.sourceUuid,
        acquiredAtCharacterLevel: data.acquiredAtCharacterLevel,
        acquiredAtWarlockLevel: data.acquiredAtWarlockLevel
      });
      byCantrip.set(data.targetCantripItemId, rows);
    }
    const updates = [];
    for (const cantrip of draft.items.filter(item => item.type === "spell" && Number(item.system?.level ?? 0) === 0)) {
      updates.push({
        _id: cantrip.id,
        [`flags.${MODULE_ID}.eldritchInvocationAugments`]: byCantrip.get(cantrip.id) ?? []
      });
    }
    if (updates.length) await draft.updateEmbeddedDocuments("Item", updates);
  }

  static #runManager(manager) {
    return NativeAdvancementModalGuard.run(manager);
  }

  static #isInvocation(item) {
    return item.getFlag(MODULE_ID, "invocationInstance")
      || item.system?.type?.subtype === "eldritchInvocation"
      || item.system?.type?.subtype === "eldritchInvocationOption"
      || /invocation/i.test(item.system?.requirements ?? "");
  }

  static #invocationTargetsCantrip(document) {
    const identifier = String(document.system?.identifier ?? this.#slug(document.name));
    return ["agonizing-blast", "repelling-blast"].includes(identifier)
      || /choose one of your known warlock cantrips/i.test(document.system?.description?.value ?? "");
  }

  static #spellDealsDamage(document) {
    const activities = document.system?.activities;
    const rows = activities?.values ? [...activities.values()] : Object.values(activities ?? {});
    if (rows.some(activity => {
      const parts = activity.damage?.parts;
      return (parts?.size ?? parts?.length ?? 0) > 0 || activity.damage?.includeBase;
    })) return true;
    return /\bdamage\b/i.test(document.system?.description?.value ?? "");
  }

  static #cantripScalingThreshold(level) {
    if (level >= 17) return 4;
    if (level >= 11) return 3;
    if (level >= 5) return 2;
    return 1;
  }

  static #levelLabel(level) {
    const value = Number(level ?? 0);
    return value === 0 ? "Cantrip" : `Level ${value}`;
  }

  static #ruleNote(model, className, spellCount, automaticCount) {
    if (model === "fullList") return `${className} automatically receives ${automaticCount} newly accessible class-list spells; only new cantrip choices require input.`;
    if (model === "spellbook") return `${className} adds ${spellCount} Wizard spellbook spells at this class level, before any Savant bonus.`;
    if (model === "limited") return `${className} gains ${spellCount} new prepared spell${spellCount === 1 ? "" : "s"} from the class list at this class level.`;
    return "No class spell selection is required.";
  }

  static #draftSnapshot(draft) {
    return {
      system: foundry.utils.deepClone(draft._source?.system ?? draft.toObject().system ?? {}),
      flags: foundry.utils.deepClone(draft._source?.flags ?? draft.toObject().flags ?? {}),
      items: draft.items.map(item => foundry.utils.deepClone(item._source ?? item.toObject()))
    };
  }

  static async #restoreDraft(draft, snapshot) {
    const update = this.#flattenPlain({ system: snapshot.system, flags: snapshot.flags });
    await draft.update(update, { characterBuilderLevelUpRollback: true });
    const ids = draft.items.map(item => item.id);
    if (ids.length) {
      await draft.deleteEmbeddedDocuments("Item", ids, {
        deleteContents: true,
        characterBuilderLevelUpRollback: true
      });
    }
    if (snapshot.items.length) {
      await draft.createEmbeddedDocuments("Item", foundry.utils.deepClone(snapshot.items), {
        keepId: true,
        characterBuilderLevelUpRollback: true
      });
    }
  }

  static #flattenPlain(value, prefix = "", output = {}) {
    if (Array.isArray(value) || value === null || typeof value !== "object") {
      if (prefix) output[prefix] = foundry.utils.deepClone(value);
      return output;
    }
    const keys = Object.keys(value);
    if (!keys.length) {
      if (prefix) output[prefix] = {};
      return output;
    }
    for (const key of keys) this.#flattenPlain(value[key], prefix ? `${prefix}.${key}` : key, output);
    return output;
  }

  static #emptySavantContext() {
    return { count: 0, featureItemId: null, schoolName: "", school: "", groups: [], levelGroups: [], selectedCount: 0, note: "" };
  }

  static #emptyInvocationContext() {
    return {
      advancementId: null,
      count: 0,
      allowReplacement: false,
      options: [],
      slots: [],
      targetCantrips: [],
      targetClassLevel: 0,
      existingIdentifiers: [],
      existingIdentifiersString: "",
      replacement: { available: false, existing: [], options: [] },
      note: ""
    };
  }

  static #emptyContext(note) {
    return {
      className: "",
      classIdentifier: "",
      oldClassLevel: 0,
      newClassLevel: 0,
      characterLevel: 0,
      model: "none",
      progression: "none",
      maximumSpellLevel: 0,
      cantripCount: 0,
      spellCount: 0,
      selectedCantripCount: 0,
      selectedSpellCount: 0,
      requiredSpellSelections: 0,
      selectedSpellSelections: 0,
      spellSelectionComplete: true,
      duplicateSelectionCount: 0,
      cantripGroups: [],
      cantripLevelGroups: [],
      spellGroups: [],
      spellLevelGroups: [],
      automaticGroups: [],
      automaticCount: 0,
      automaticItemGrants: [],
      automaticItemGrantCount: 0,
      savant: this.#emptySavantContext(),
      invocations: this.#emptyInvocationContext(),
      metamagic: MetamagicService.emptyContext(),
      replacement: { available: false, existing: [], options: [] },
      cantripReplacement: { available: false, existing: [], options: [] },
      features: {
        spellSections: [], targetSpellSections: [], replacementSections: [], optionSections: [],
        wildShape: { count: 0, options: [], groups: [] },
        land: { required: false, options: [], hasAutomatic: false },
        required: 0, selected: 0, complete: true, hasChoices: false, hasAutomatic: false, noWork: true
      },
      subclassCaster: null,
      magicalSecrets: { active: false, featureItemId: null, bardBaseSpellIdentifiers: [] },
      hasChoices: false,
      hasAutomatic: false,
      complete: false,
      noAdditionalWork: true,
      cantripScaling: { characterLevel: 0, threshold: 1, note: "" },
      note
    };
  }

  static #humanize(value) {
    return String(value ?? "").replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[-_]/g).filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  }

  static #slug(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
