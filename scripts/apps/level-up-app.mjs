import { MODULE_ID } from "../constants.mjs";
import { SourceRegistry } from "../services/source-registry.mjs";
import { LevelUpService } from "../services/level-up-service.mjs";
import { LevelUpDraftManager } from "../services/level-up-draft-manager.mjs";
import { HitPointAdvancementService } from "../services/hit-point-advancement-service.mjs";
import { LevelUpAdvancementService } from "../services/level-up-advancement-service.mjs";
import { LevelUpRulesService } from "../services/level-up-rules-service.mjs";
import { LevelUpCommitService } from "../services/level-up-commit-service.mjs";
import { AdvancementChoiceAnnotationService } from "../services/advancement-choice-annotation-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class LevelUpApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.draft = null;
    this.registry = new SourceRegistry();
    this.busy = false;
  }

  static DEFAULT_OPTIONS = {
    id: "dnd5e-character-level-up",
    classes: ["character-builder", "level-up-app", "standard-form"],
    tag: "form",
    position: { width: 1180, height: 820 },
    window: { title: "Character Builder — Level Up", resizable: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/level-up.hbs` }
  };

  get id() {
    return `dnd5e-character-level-up-${this.actor.id}`;
  }

  async _prepareContext() {
    const eligibility = LevelUpService.eligibility(this.actor);
    if (!eligibility.ready) throw new Error(eligibility.reason || "Level Up is not available for this Actor.");
    this.draft ??= await LevelUpDraftManager.getOrCreate(this.actor);
    await HitPointAdvancementService.hydrateLockedRoll(this.actor, this.draft);
    await this.registry.load();

    const state = LevelUpDraftManager.getState(this.draft);
    const hpRollLocked = Boolean(HitPointAdvancementService.lockedRoll(this.actor));
    const settings = LevelUpService.settings();
    const classes = LevelUpService.classItems(this.draft).map(item => ({
      id: item.id,
      name: item.name,
      img: item.img,
      identifier: item.system?.identifier,
      level: Number(item.system?.levels ?? 0),
      original: LevelUpService.originalClass(this.draft)?.id === item.id,
      selected: state.selectedClassId === item.id || state.selectedClassIdentifier === item.system?.identifier,
      disabled: state.nativeComplete
    }));

    const ownedIdentifiers = new Set(classes.map(row => row.identifier));
    const multiclassGroups = settings.allowMulticlassing && !state.nativeComplete
      ? this.registry.optionsByType("class").map(group => ({
        ...group,
        items: group.items
          .filter(option => !ownedIdentifiers.has(option.identifier))
          .map(option => {
            const prerequisite = LevelUpService.multiclassPrerequisite(this.draft, option.identifier);
            return {
              ...option,
              qualified: prerequisite.qualified,
              prerequisiteMessage: prerequisite.message,
              selected: state.multiclass && state.selectedClassSourceUuid === option.uuid
            };
          })
      })).filter(group => group.items.length)
      : [];

    const hpMethodAvailability = state.selectedClassIdentifier
      ? await HitPointAdvancementService.methodAvailability(this.draft, this.registry)
      : HitPointAdvancementService.methods().map(method => ({ ...method, disabled: false }));

    const rules = state.nativeComplete
      ? await LevelUpRulesService.buildContext(this.actor, this.draft, this.registry)
      : null;
    const review = this.#reviewContext(state);
    const stepOrder = ["class", "hp", "advancements", "choices", "review"];
    const activeIndex = Math.max(0, stepOrder.indexOf(state.step ?? "class"));
    const steps = [
      { id: "class", label: "Class", icon: "fa-solid fa-shield-halved" },
      { id: "hp", label: "Hit Points", icon: "fa-solid fa-heart-pulse" },
      { id: "advancements", label: "Class Progression", icon: "fa-solid fa-diagram-project" },
      { id: "choices", label: "Spells & Features", icon: "fa-solid fa-wand-magic-sparkles" },
      { id: "review", label: "Review", icon: "fa-solid fa-clipboard-check" }
    ].map((step, index) => ({
      ...step,
      active: step.id === state.step,
      complete: index < activeIndex || (step.id === "review" && state.commitReady),
      locked: index > activeIndex
    }));

    return {
      actor: {
        id: this.actor.id,
        name: this.actor.name,
        img: this.actor.img,
        level: LevelUpService.actorLevel(this.actor),
        targetLevel: state.targetCharacterLevel
      },
      state,
      settings,
      classes,
      multiclassGroups,
      multiclassAvailable: settings.allowMulticlassing && multiclassGroups.some(group => group.items.length),
      hpRollLocked,
      hpMethods: hpMethodAvailability.map(method => ({
        ...method,
        selected: state.hpMethod === method.id
      })),
      retainedHitPointRoll: HitPointAdvancementService.lockedRoll(this.actor),
      hpSummary: HitPointAdvancementService.summary(state.hpResult),
      rules,
      review,
      steps,
      isGM: game.user.isGM,
      busy: this.busy,
      sourceOrder: SourceRegistry.orderedSources().map(source => source.label).join(" → ")
    };
  }

  _onRender() {
    const root = this.element;
    root.querySelectorAll("[data-action]").forEach(element => {
      element.addEventListener("click", event => this.#onAction(event));
    });
    root.querySelectorAll('[name^="levelUp.invocation."], [name^="levelUp.replaceInvocation."]').forEach(input => {
      input.addEventListener("change", () => {
        this.#refreshInvocationSelectionState();
        this.#refreshSpellSelectionState();
      });
    });
    root.querySelectorAll("[data-spell-selection-control]").forEach(input => {
      input.addEventListener("change", () => this.#refreshSpellSelectionState());
    });
    root.querySelectorAll('[name^="levelUp.replaceSpell."]').forEach(input => {
      input.addEventListener("change", () => this.#refreshSpellSelectionState());
    });
    this.#refreshInvocationSelectionState();
    this.#refreshSpellSelectionState();
  }

  async #onAction(event) {
    event.preventDefault();
    if (this.busy) return;
    const target = event.currentTarget;
    const action = target.dataset.action;
    try {
      switch (action) {
        case "select-class":
          await this.#selectExistingClass(target.dataset.itemId);
          break;
        case "select-multiclass":
          await this.#selectMulticlass(target.dataset.uuid);
          break;
        case "resolve-hp":
          await this.#resolveHitPoints(target.dataset.method);
          break;
        case "confirm-hp":
          await this.#confirmHitPoints();
          break;
        case "back-class":
          await LevelUpDraftManager.setState(this.draft, { step: "class" });
          this.render({ force: true });
          break;
        case "restart-class":
          await this.#restartClassSelection();
          break;
        case "run-native":
          await this.#runNativeAdvancements();
          break;
        case "save-additional":
          await this.#saveAdditionalRules();
          break;
        case "commit":
          await this.#commit();
          break;
        case "open-document": {
          const uuid = target.dataset.uuid;
          if (!uuid) break;
          const document = await fromUuid(uuid);
          document?.sheet?.render(true);
          break;
        }
        case "toggle-spell-level": {
          const group = target.closest("[data-spell-level-group]");
          if (!group) break;
          const collapsed = group.classList.toggle("collapsed");
          target.setAttribute("aria-expanded", String(!collapsed));
          const icon = target.querySelector("[data-collapse-icon]");
          icon?.classList.toggle("fa-chevron-down", collapsed);
          icon?.classList.toggle("fa-chevron-up", !collapsed);
          break;
        }
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Level Up action failed.`, error);
      ui.notifications.error(`Level Up failed: ${error.message}`);
      this.busy = false;
      this.render({ force: true });
    }
  }

  async #selectExistingClass(itemId) {
    const state = LevelUpDraftManager.getState(this.draft);
    if (state.nativeComplete) throw new Error("Ask the GM to reset the pending Level Up before changing the advanced Class.");
    const cls = this.draft.items.get(itemId);
    if (!cls || cls.type !== "class") throw new Error("The selected Class was not found.");
    const level = Number(cls.system?.levels ?? 0);
    const lockedResult = HitPointAdvancementService.assertClassSelectionAllowed(this.actor, {
      selectedClassIdentifier: cls.system?.identifier,
      targetClassLevel: level + 1
    }, { allowRetarget: Boolean(state.restartClassSelection) });
    await LevelUpDraftManager.setState(this.draft, {
      step: "hp",
      selectedClassId: cls.id,
      selectedClassSourceUuid: LevelUpService.classSourceUuid(cls),
      selectedClassIdentifier: cls.system?.identifier,
      selectedClassName: cls.name,
      multiclass: false,
      sourceClassLevel: level,
      targetClassLevel: level + 1,
      hpMethod: state.restartClassSelection ? null : (lockedResult ? "roll" : null),
      hpResult: state.restartClassSelection ? null : lockedResult,
      nativeComplete: false,
      itemGrantIntegrity: { items: [], repairedItemIds: [] },
      itemGrantReconciliation: { items: [], repairedItemIds: [] },
      additionalChoices: {},
      additionalComplete: false,
      commitReady: false
    });
    this.render({ force: true });
  }

  async #selectMulticlass(uuid) {
    const state = LevelUpDraftManager.getState(this.draft);
    const settings = LevelUpService.settings();
    if (!settings.allowMulticlassing) throw new Error("Multiclassing is disabled in Character Builder settings.");
    if (state.nativeComplete) throw new Error("Ask the GM to reset the pending Level Up before changing the advanced Class.");
    const option = this.registry.findOption(uuid);
    if (!option || option.type !== "class") throw new Error("The selected multiclass is unavailable from the enabled sources.");
    if (this.draft.items.some(item => item.type === "class" && item.system?.identifier === option.identifier)) {
      throw new Error(`${option.name} already exists on this Actor. Advance its existing Class row instead.`);
    }
    const prerequisite = LevelUpService.multiclassPrerequisite(this.draft, option.identifier);
    if (!prerequisite.qualified) throw new Error(prerequisite.message);
    const lockedResult = HitPointAdvancementService.assertClassSelectionAllowed(this.actor, {
      selectedClassIdentifier: option.identifier,
      targetClassLevel: 1
    }, { allowRetarget: Boolean(state.restartClassSelection) });
    await LevelUpDraftManager.setState(this.draft, {
      step: "hp",
      selectedClassId: null,
      selectedClassSourceUuid: option.uuid,
      selectedClassIdentifier: option.identifier,
      selectedClassName: option.name,
      multiclass: true,
      sourceClassLevel: 0,
      targetClassLevel: 1,
      hpMethod: state.restartClassSelection ? null : (lockedResult ? "roll" : null),
      hpResult: state.restartClassSelection ? null : lockedResult,
      nativeComplete: false,
      itemGrantIntegrity: { items: [], repairedItemIds: [] },
      itemGrantReconciliation: { items: [], repairedItemIds: [] },
      additionalChoices: {},
      additionalComplete: false,
      commitReady: false
    });
    this.render({ force: true });
  }

  async #resolveHitPoints(method) {
    this.busy = true;
    this.render({ force: true });
    await HitPointAdvancementService.resolve(this.draft, this.registry, method);
    this.busy = false;
    this.render({ force: true });
  }

  async #confirmHitPoints() {
    const state = LevelUpDraftManager.getState(this.draft);
    if (!state.hpResult) throw new Error("Roll the Hit Die or choose an available fixed Hit Point value first.");
    await LevelUpDraftManager.setState(this.draft, { step: "advancements" });
    this.render({ force: true });
  }

  async #runNativeAdvancements() {
    this.busy = true;
    this.render({ force: true });
    const result = await LevelUpAdvancementService.apply(this.draft, this.registry);
    if (result.completed) {
      await LevelUpRulesService.autoCompleteIfEmpty(this.actor, this.draft, this.registry);
      ui.notifications.info("Class Progression completed on the Level Up draft.");
    }
    this.busy = false;
    this.render({ force: true });
  }

  async #saveAdditionalRules() {
    this.busy = true;
    const formData = new FormData(this.element);
    await LevelUpRulesService.apply(this.actor, this.draft, this.registry, formData);
    this.busy = false;
    ui.notifications.info("Level Up spell and feature choices saved on the draft.");
    this.render({ force: true });
  }

  async #commit() {
    const confirmed = await this.#confirm({
      title: "Commit Level Up",
      content: `<p>Apply character level ${foundry.utils.escapeHTML(String(LevelUpDraftManager.getState(this.draft).targetCharacterLevel))} to <strong>${foundry.utils.escapeHTML(this.actor.name)}</strong>?</p><p>This is the only step that changes the live Actor.</p>`,
      yes: "Commit Level Up"
    });
    if (!confirmed) return;
    this.busy = true;
    this.render({ force: true });
    const result = await LevelUpCommitService.commit(this.actor, this.draft);
    ui.notifications.info(`${this.actor.name} reached level ${result.history.targetCharacterLevel}.`);
    this.draft = null;
    await this.close();
    this.actor.sheet?.render(false);
  }

  async #restartClassSelection() {
    const lock = HitPointAdvancementService.lockedRoll(this.actor);
    const confirmed = await this.#confirm({
      title: "Restart Class Selection",
      content: lock
        ? `<p>Discard the current Class, multiclass, and all later draft choices?</p><p><strong>The locked Hit Die result (${foundry.utils.escapeHTML(String(lock.result?.raw ?? "—"))} on ${foundry.utils.escapeHTML(lock.result?.denomination ?? lock.denomination ?? "Hit Die")}) will be preserved.</strong> You may reuse that number when it fits the newly selected Class Hit Die, or choose Average.</p>`
        : "<p>Discard the current Class, multiclass, and all later draft choices and return to Class selection?</p>",
      yes: "Restart Class Selection"
    });
    if (!confirmed) return;
    this.busy = true;
    this.render({ force: true });
    this.draft = await LevelUpDraftManager.restartClassSelection(this.actor);
    this.busy = false;
    ui.notifications.info(lock
      ? "Class selection restarted. The locked Hit Die result was preserved."
      : "Class selection restarted.");
    this.render({ force: true });
  }

  #reviewContext(state) {
    const sourceIds = new Set(this.actor.items.map(item => item.id));
    const draftIds = new Set(this.draft.items.map(item => item.id));
    const added = this.draft.items
      .filter(item => !sourceIds.has(item.id))
      .map(item => ({
        id: item.id,
        name: item.name,
        img: item.img,
        type: item.type,
        badges: AdvancementChoiceAnnotationService.getBadges(item)
      }));
    const removed = this.actor.items
      .filter(item => !draftIds.has(item.id))
      .map(item => ({ id: item.id, name: item.name, img: item.img, type: item.type }));
    const selectedClass = this.draft.items.get(state.selectedClassId)
      ?? this.draft.items.find(item => item.type === "class" && item.system?.identifier === state.selectedClassIdentifier);
    const cantripAugmentChanges = this.#cantripAugmentChanges();
    return {
      sourceCharacterLevel: state.sourceCharacterLevel,
      targetCharacterLevel: state.targetCharacterLevel,
      className: state.selectedClassName,
      sourceClassLevel: state.sourceClassLevel,
      targetClassLevel: state.targetClassLevel,
      multiclass: Boolean(state.multiclass),
      hpSummary: HitPointAdvancementService.summary(state.hpResult),
      classItem: selectedClass ? {
        id: selectedClass.id,
        name: selectedClass.name,
        img: selectedClass.img,
        badges: AdvancementChoiceAnnotationService.getBadges(selectedClass)
      } : null,
      added,
      removed,
      addedCount: added.length,
      removedCount: removed.length,
      cantripAugmentChanges
    };
  }

  #cantripAugmentChanges() {
    const source = this.#collectCantripAugments(this.actor);
    const draft = this.#collectCantripAugments(this.draft);
    const changes = [];
    const handledSource = new Set();
    const handledDraft = new Set();

    const sourceByInvocation = new Map();
    const draftByInvocation = new Map();
    for (const row of source.values()) sourceByInvocation.set(row.invocationKey, row);
    for (const row of draft.values()) draftByInvocation.set(row.invocationKey, row);

    for (const [key, before] of sourceByInvocation) {
      const after = draftByInvocation.get(key);
      if (!after || before.cantripKey === after.cantripKey) continue;
      changes.push({
        change: "Changed",
        name: after.cantripName,
        img: after.cantripImg,
        invocation: after.invocationName,
        detail: `${before.cantripName} → ${after.cantripName}`
      });
      handledSource.add(before.pairKey);
      handledDraft.add(after.pairKey);
    }

    for (const [pairKey, row] of draft) {
      if (source.has(pairKey) || handledDraft.has(pairKey)) continue;
      changes.push({
        change: "Added",
        name: row.cantripName,
        img: row.cantripImg,
        invocation: row.invocationName,
        detail: `${row.invocationName} added to ${row.cantripName}`
      });
    }
    for (const [pairKey, row] of source) {
      if (draft.has(pairKey) || handledSource.has(pairKey)) continue;
      changes.push({
        change: "Removed",
        name: row.cantripName,
        img: row.cantripImg,
        invocation: row.invocationName,
        detail: `${row.invocationName} removed from ${row.cantripName}`
      });
    }
    return changes.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  }

  #collectCantripAugments(actor) {
    const rows = new Map();
    for (const cantrip of actor.items.filter(item => item.type === "spell" && Number(item.system?.level ?? 0) === 0)) {
      for (const augment of cantrip.getFlag(MODULE_ID, "eldritchInvocationAugments") ?? []) {
        const invocationKey = String(augment.invocationItemId ?? augment.instanceId ?? augment.sourceUuid ?? augment.identifier ?? augment.name);
        const pairKey = `${cantrip.id}::${invocationKey}`;
        rows.set(pairKey, {
          pairKey,
          invocationKey,
          cantripKey: cantrip.id,
          cantripName: cantrip.name,
          cantripImg: cantrip.img,
          invocationName: augment.name ?? augment.identifier ?? "Eldritch Invocation"
        });
      }
    }
    return rows;
  }

  #refreshInvocationSelectionState() {
    const root = this.element;
    const selectionRoot = root.querySelector("[data-spell-selection-root]");
    const section = root.querySelector("[data-invocation-selection-section]");
    const targetClassLevel = Number(section?.dataset.targetClassLevel
      ?? selectionRoot?.dataset.invocationTargetClassLevel
      ?? 0);
    const existing = new Set(String(section?.dataset.existingInvocations
      ?? selectionRoot?.dataset.existingInvocations
      ?? "").split("|").filter(Boolean));
    const available = new Set(existing);
    const selectedUuids = new Set();
    const slots = section ? [...section.querySelectorAll("[data-invocation-slot]")] : [];

    for (const slot of slots) {
      const select = slot.querySelector('select[data-invocation-select]');
      if (!select) continue;
      const current = select.value;
      let currentValid = true;
      for (const option of [...select.options].slice(1)) {
        const identifier = option.dataset.identifier ?? "";
        const minimumLevel = Number(option.dataset.minimumLevel ?? 0);
        const prerequisites = String(option.dataset.prerequisites ?? "").split("|").filter(Boolean);
        const repeatable = option.dataset.repeatable === "true";
        const alreadyKnown = option.dataset.alreadyKnown === "true";
        const levelValid = minimumLevel <= targetClassLevel;
        const prerequisiteValid = !prerequisites.length || prerequisites.some(id => available.has(id));
        const duplicate = selectedUuids.has(option.value) && !repeatable;
        const valid = levelValid && prerequisiteValid && !alreadyKnown && !duplicate;
        const baseLabel = option.dataset.baseLabel ?? option.textContent;
        let reason = "";
        if (!levelValid) reason = `Requires Warlock Level ${minimumLevel}`;
        else if (!prerequisiteValid) reason = `Requires ${option.dataset.prerequisiteLabels || prerequisites.join(" or ")}`;
        else if (alreadyKnown) reason = "Already known";
        else if (duplicate) reason = "Already selected";
        option.disabled = !valid;
        option.textContent = reason ? `${baseLabel} — ${reason}` : baseLabel;
        if (option.value === current && !valid) currentValid = false;
      }
      if (current && !currentValid) select.value = "";
      const selectedOption = select.selectedOptions?.[0];
      if (select.value && selectedOption) {
        selectedUuids.add(select.value);
        if (selectedOption.dataset.identifier) available.add(selectedOption.dataset.identifier);
      }
      this.#refreshInvocationSlot(slot, selectedOption);
    }

    const replacement = root.querySelector("[data-invocation-replacement]");
    if (replacement) {
      const select = replacement.querySelector('select[name="levelUp.replaceInvocation.add"]');
      const current = select?.value ?? "";
      let currentValid = true;
      for (const option of [...(select?.options ?? [])].slice(1)) {
        const minimumLevel = Number(option.dataset.minimumLevel ?? 0);
        const prerequisites = String(option.dataset.prerequisites ?? "").split("|").filter(Boolean);
        const prerequisiteValid = !prerequisites.length || prerequisites.some(id => available.has(id));
        const levelValid = minimumLevel <= targetClassLevel;
        const alreadyKnown = option.dataset.alreadyKnown === "true";
        const duplicate = selectedUuids.has(option.value) && option.dataset.repeatable !== "true";
        const valid = levelValid && prerequisiteValid && !alreadyKnown && !duplicate;
        const baseLabel = option.dataset.baseLabel ?? option.textContent;
        let reason = "";
        if (!levelValid) reason = `Requires Warlock Level ${minimumLevel}`;
        else if (!prerequisiteValid) reason = `Requires ${option.dataset.prerequisiteLabels || prerequisites.join(" or ")}`;
        else if (alreadyKnown) reason = "Already known";
        else if (duplicate) reason = "Already selected";
        option.disabled = !valid;
        option.textContent = reason ? `${baseLabel} — ${reason}` : baseLabel;
        if (option.value === current && !valid) currentValid = false;
      }
      if (select && current && !currentValid) select.value = "";
      this.#refreshInvocationSlot(replacement, select?.selectedOptions?.[0]);
    }

    this.#refreshInvocationDetailCards();
  }

  #refreshInvocationSlot(container, selectedOption) {
    const requiresTarget = selectedOption?.dataset?.targetCantrip === "true";
    const targetRow = container.querySelector("[data-invocation-target-row]");
    if (targetRow) {
      targetRow.hidden = !requiresTarget;
      const target = targetRow.querySelector("select");
      if (target) {
        target.required = requiresTarget;
        if (!requiresTarget) target.value = "";
      }
    }
    const card = container.querySelector("[data-invocation-detail]");
    if (!card) return;
    const placeholder = card.querySelector("[data-invocation-detail-placeholder]");
    const content = card.querySelector("[data-invocation-detail-content]");
    if (!selectedOption?.value) {
      card.disabled = true;
      card.dataset.uuid = "";
      placeholder?.removeAttribute("hidden");
      content?.setAttribute("hidden", "");
      return;
    }
    card.disabled = false;
    card.dataset.uuid = selectedOption.value;
    placeholder?.setAttribute("hidden", "");
    content?.removeAttribute("hidden");
    const img = card.querySelector("img");
    if (img) img.src = selectedOption.dataset.img ?? "icons/svg/book.svg";
    const name = card.querySelector("[data-invocation-detail-name]");
    if (name) name.textContent = selectedOption.dataset.name ?? selectedOption.textContent;
    const meta = card.querySelector("[data-invocation-detail-meta]");
    if (meta) meta.textContent = selectedOption.dataset.detailMeta ?? "Eldritch Invocation";
  }

  #refreshInvocationDetailCards() {
    for (const card of this.element.querySelectorAll("[data-invocation-detail]")) {
      const container = card.closest("[data-invocation-slot], [data-invocation-replacement]");
      const select = container?.querySelector("select[data-invocation-select], select[name=\"levelUp.replaceInvocation.add\"]");
      this.#refreshInvocationSlot(container, select?.selectedOptions?.[0]);
    }
  }

  #refreshInvocationTargetEligibility() {
    const root = this.element;
    const checkedPendingCantrips = new Set(
      [...root.querySelectorAll('input[name="levelUp.cantrips"][data-spell-identifier]:checked')]
        .map(input => input.dataset.spellIdentifier)
        .filter(Boolean)
    );

    for (const select of root.querySelectorAll("[data-invocation-target-select]")) {
      const current = select.value;
      for (const option of [...select.options].slice(1)) {
        const pending = option.dataset.pending === "true";
        const identifier = option.dataset.cantripIdentifier ?? option.value;
        const eligible = !pending || checkedPendingCantrips.has(identifier);
        const baseLabel = option.dataset.baseLabel ?? option.textContent;
        option.disabled = !eligible;
        option.textContent = pending
          ? `${baseLabel} — ${eligible ? "selected during this Level Up" : "choose this cantrip above first"}`
          : baseLabel;
      }
      const selected = [...select.options].find(option => option.value === current);
      if (current && selected?.disabled) select.value = "";
    }
  }

  #refreshSpellSelectionState() {
    const root = this.element;
    const selectionRoot = root.querySelector("[data-spell-selection-root]");
    if (!selectionRoot) return;

    this.#refreshInvocationTargetEligibility();

    const controls = [...selectionRoot.querySelectorAll("input[type=checkbox][data-spell-identifier]")];
    const replacement = selectionRoot.querySelector('[name="levelUp.replaceSpell.add"]');
    const replacementRemove = selectionRoot.querySelector('[name="levelUp.replaceSpell.remove"]');
    const selectedControls = controls.filter(control => control.checked);
    const selectedByIdentifier = new Map();
    for (const control of selectedControls) {
      const identifier = control.dataset.spellIdentifier;
      const rows = selectedByIdentifier.get(identifier) ?? [];
      rows.push(control);
      selectedByIdentifier.set(identifier, rows);
    }
    const replacementIdentifier = String(replacement?.value ?? "");
    let conflict = false;

    for (const control of controls) {
      const identifier = control.dataset.spellIdentifier;
      const selectedElsewhere = (selectedByIdentifier.get(identifier) ?? []).some(row => row !== control);
      const selectedAsReplacement = Boolean(replacementIdentifier && replacementIdentifier === identifier);
      const baseDisabled = control.dataset.baseDisabled === "true";
      const duplicateDisabled = !control.checked && (selectedElsewhere || selectedAsReplacement);
      control.disabled = baseDisabled || duplicateDisabled;
      const card = control.closest("[data-spell-option]");
      card?.classList.toggle("duplicate-disabled", duplicateDisabled || baseDisabled);
      if (card && duplicateDisabled) {
        card.title = selectedAsReplacement
          ? "Already selected as the replacement spell."
          : "Already selected through another spell choice.";
      } else if (card && !baseDisabled) card.removeAttribute("title");
      if (control.checked && (selectedElsewhere || selectedAsReplacement)) conflict = true;
    }

    if (replacement) {
      for (const option of replacement.options) {
        if (!option.value) continue;
        const baseDisabled = option.dataset.baseDisabled === "true";
        const checkedElsewhere = selectedByIdentifier.has(option.value);
        option.disabled = baseDisabled || (checkedElsewhere && replacement.value !== option.value);
        if (replacement.value === option.value && checkedElsewhere) conflict = true;
      }
    }

    let everySectionComplete = true;
    for (const section of selectionRoot.querySelectorAll("[data-spell-selection-section]")) {
      const expected = Number(section.dataset.required ?? 0);
      const selected = [...section.querySelectorAll("input[type=checkbox][data-spell-identifier]:checked")].length;
      section.querySelectorAll("[data-selection-count]").forEach(node => {
        node.textContent = `${selected} / ${expected}`;
      });
      const complete = selected === expected;
      section.classList.toggle("complete", complete);
      section.classList.toggle("invalid", selected > expected);
      everySectionComplete &&= complete;
    }

    const expectedTotal = Number(selectionRoot.dataset.required ?? 0);
    const selectedTotal = selectedControls.length;
    const spellReplacementComplete = !replacement && !replacementRemove
      || Boolean(replacement?.value) === Boolean(replacementRemove?.value);

    let invocationComplete = true;
    const invocationSection = selectionRoot.querySelector("[data-invocation-selection-section]");
    if (invocationSection) {
      const slots = [...invocationSection.querySelectorAll("[data-invocation-slot]")];
      let selected = 0;
      for (const slot of slots) {
        const select = slot.querySelector('select[data-invocation-select]');
        const option = select?.selectedOptions?.[0];
        const requiresTarget = option?.dataset?.targetCantrip === "true";
        const target = slot.querySelector("[data-invocation-target-row] select");
        const valid = Boolean(select?.value) && !option?.disabled && (!requiresTarget || Boolean(target?.value));
        if (valid) selected++;
      }
      const expected = Number(invocationSection.dataset.required ?? slots.length);
      invocationComplete = selected === expected;
      invocationSection.querySelectorAll("[data-invocation-count]").forEach(node => {
        node.textContent = `${selected} / ${expected}`;
      });
      invocationSection.classList.toggle("complete", invocationComplete);
      invocationSection.classList.toggle("invalid", !invocationComplete && selected > 0);
    }

    const invocationReplacement = selectionRoot.querySelector("[data-invocation-replacement]");
    let invocationReplacementComplete = true;
    if (invocationReplacement) {
      const remove = invocationReplacement.querySelector('[name="levelUp.replaceInvocation.remove"]');
      const add = invocationReplacement.querySelector('[name="levelUp.replaceInvocation.add"]');
      const option = add?.selectedOptions?.[0];
      const requiresTarget = option?.dataset?.targetCantrip === "true";
      const target = invocationReplacement.querySelector("[data-invocation-target-row] select");
      invocationReplacementComplete = Boolean(remove?.value) === Boolean(add?.value)
        && (!add?.value || (!option?.disabled && (!requiresTarget || Boolean(target?.value))));
      invocationReplacement.classList.toggle("invalid", !invocationReplacementComplete);
    }

    const complete = everySectionComplete
      && selectedTotal === expectedTotal
      && !conflict
      && spellReplacementComplete
      && invocationComplete
      && invocationReplacementComplete;
    selectionRoot.classList.toggle("complete", complete);
    selectionRoot.classList.toggle("invalid", !complete && (conflict || selectedTotal > expectedTotal || !spellReplacementComplete));

    const applyButton = selectionRoot.querySelector('[data-action="save-additional"]');
    if (applyButton && applyButton.dataset.busy !== "true") applyButton.disabled = !complete;
  }

  async #confirm({ title, content, yes }) {
    const DialogV2 = foundry.applications.api.DialogV2;
    if (DialogV2?.confirm) {
      return DialogV2.confirm({
        window: { title },
        content,
        yes: { label: yes, icon: "fa-solid fa-check" },
        no: { label: "Cancel", icon: "fa-solid fa-xmark" }
      });
    }
    return new Promise(resolve => {
      new Dialog({
        title,
        content,
        buttons: {
          yes: { label: yes, callback: () => resolve(true) },
          no: { label: "Cancel", callback: () => resolve(false) }
        },
        default: "no",
        close: () => resolve(false)
      }).render(true);
    });
  }
}
