import { MODULE_ID } from "../constants.mjs";
import { SourceRegistry } from "../services/source-registry.mjs";
import { LevelUpService } from "../services/level-up-service.mjs";
import { LevelUpDraftManager } from "../services/level-up-draft-manager.mjs";
import { HitPointAdvancementService } from "../services/hit-point-advancement-service.mjs";
import { LevelUpAdvancementService } from "../services/level-up-advancement-service.mjs";
import { LevelUpRulesService } from "../services/level-up-rules-service.mjs";
import { LevelUpCommitService } from "../services/level-up-commit-service.mjs";
import { AdvancementChoiceAnnotationService } from "../services/advancement-choice-annotation-service.mjs";
import { MetadataReconciliationService } from "../services/metadata-reconciliation-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class LevelUpApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.draft = null;
    this.registry = new SourceRegistry();
    this.busy = false;
    this.commitDialog = null;
    this.commitInProgress = false;
    this.commitTransactionToken = null;
    this.metadataReconciled = false;
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
    if (!this.metadataReconciled) {
      await MetadataReconciliationService.reconcile(this.actor);
      this.metadataReconciled = true;
    }
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
      multiclassRequirementsEnforced: settings.enforceMulticlassRequirements,
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
      commitDialog: this.commitDialog,
      commitInProgress: this.commitInProgress,
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
        this.#clearInvalidInvocationDependents(input);
        this.#refreshInvocationSelectionState();
        this.#refreshPactOfTheTomeVisibility();
        this.#refreshSpellSelectionState();
      });
    });
    root.querySelectorAll("[data-spell-selection-control], [data-managed-selection-control]").forEach(input => {
      input.addEventListener("change", () => this.#refreshSpellSelectionState());
    });
    root.querySelectorAll("[data-filter-target]").forEach(input => {
      input.addEventListener("input", event => this.#filterSpellOptions(event));
    });
    root.querySelectorAll('[name^="levelUp.replaceSpell."], [name^="levelUp.replaceCantrip."], [name^="levelUp.featureReplace."], [name^="levelUp.featureOption."], [name="levelUp.land"], [name="levelUp.wildShapeForms"], [name^="levelUp.featureSpell."], [name^="levelUp.featureTarget."]').forEach(input => {
      input.addEventListener("change", () => {
        if (input.matches("[data-land-select]")) this.#refreshLandPreview(input.value);
        this.#refreshSpellSelectionState();
      });
    });
    this.#bindSpellCardDetails(root);
    this.#refreshInvocationSelectionState();
    this.#refreshPactOfTheTomeVisibility();
    this.#refreshSpellSelectionState();
  }

  #filterSpellOptions(event) {
    const input = event.currentTarget;
    const target = this.element.querySelector(input.dataset.filterTarget);
    if (!target) return;
    const query = input.value.trim().toLowerCase();
    for (const card of target.querySelectorAll("[data-spell-option]")) {
      const search = String(card.dataset.search ?? card.textContent ?? "").toLowerCase();
      card.hidden = Boolean(query && !search.includes(query));
    }
    for (const group of target.querySelectorAll(".cb-source-group")) {
      group.hidden = ![...group.querySelectorAll("[data-spell-option]")].some(card => !card.hidden);
    }
  }

  #bindSpellCardDetails(root) {
    for (const card of root.querySelectorAll(".cb-spell-option, .cb-spell-choice-card")) {
      card.addEventListener("click", event => {
        if (event.target.closest("input, label, select, option, a, button")) return;
        const details = card.querySelector('[data-action="open-document"]');
        if (details && !details.disabled) details.click();
      });
    }
  }

  async #onAction(event) {
    event.preventDefault();
    const target = event.currentTarget;
    const action = target.dataset.action;
    const modalActions = new Set(["confirm-commit", "cancel-commit", "restart-after-failed-commit", "close-critical-commit"]);
    if (this.busy && !modalActions.has(action)) return;
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
        case "confirm-commit":
          await this.#executeCommit();
          break;
        case "cancel-commit":
          if (!this.commitInProgress) {
            this.commitDialog = null;
            this.render({ force: true });
          }
          break;
        case "restart-after-failed-commit":
          if (!this.commitInProgress) {
            this.commitDialog = null;
            await this.#restartClassSelection({ skipConfirmation: true });
          }
          break;
        case "close-critical-commit":
          if (!this.commitInProgress) {
            this.commitDialog = null;
            await this.close();
          }
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
      console.error(`${MODULE_ID} | Level Up action failed.`, error?.diagnostic ?? error);
      this.busy = false;
      if (error?.structuralLevelUp) {
        await this.#handleStructuralLevelUpError(error);
        return;
      }
      ui.notifications.error(`Level Up failed: ${error.message}`, { permanent: true });
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
    const formData = new FormData(this.element);
    const removeCantripId = String(formData.get("levelUp.replaceCantrip.remove") ?? "");
    if (removeCantripId) {
      const cantrip = this.draft.items.get(removeCantripId);
      const augments = cantrip?.getFlag(MODULE_ID, "eldritchInvocationAugments") ?? [];
      if (augments.length) {
        const names = augments.map(row => foundry.utils.escapeHTML(row.name ?? row.identifier ?? "Eldritch Invocation"));
        const minimumLevels = augments.length;
        const confirmed = await this.#confirm({
          title: "Replace an Augmented Cantrip?",
          yes: "Replace Anyway",
          content: `<div class="cb-structural-error">
            <p><strong>${foundry.utils.escapeHTML(cantrip.name)} is currently augmented by ${augments.length} Invocation${augments.length === 1 ? "" : "s"}:</strong></p>
            <ul>${names.map(name => `<li>${name}</li>`).join("")}</ul>
            <p>The Invocations will remain known but provide no benefit. Their targets will not transfer automatically, and relearning ${foundry.utils.escapeHTML(cantrip.name)} will not reconnect them.</p>
            <p>Under the normal replacement sequence, restoring all targets may require at least <strong>${minimumLevels} future Warlock level${minimumLevels === 1 ? "" : "s"}</strong>.</p>
            <p><strong>I understand that these Invocations may remain inactive for multiple Warlock levels.</strong></p>
          </div>`
        });
        if (!confirmed) return;
      }
    }
    this.busy = true;
    await LevelUpRulesService.apply(this.actor, this.draft, this.registry, formData);
    this.busy = false;
    ui.notifications.info("Level Up spell and feature choices saved on the draft.");
    this.render({ force: true });
  }

  async #commit() {
    if (this.commitInProgress) {
      this.#focusCommitDialog();
      return;
    }
    const state = LevelUpDraftManager.getState(this.draft);
    // A repeated click before confirmation intentionally replaces the pending
    // confirmation with a fresh singleton state. It can never touch an active
    // commit because commitInProgress is set synchronously on confirmation.
    this.commitDialog = {
      open: true,
      mode: "confirmation",
      title: "Commit Level Up",
      targetLevel: state.targetCharacterLevel,
      actorName: this.actor.name,
      percent: 0,
      stage: "Ready to Commit",
      detail: "The live Actor has not been changed yet."
    };
    this.render({ force: true });
  }

  async #executeCommit() {
    if (this.commitInProgress) {
      this.#focusCommitDialog();
      return;
    }
    // Guard before the first await.
    this.commitInProgress = true;
    this.busy = true;
    this.commitTransactionToken = foundry.utils.randomID?.(24) ?? crypto.randomUUID();
    this.commitDialog = {
      ...(this.commitDialog ?? {}),
      open: true,
      mode: "progress",
      title: "Applying Level Up",
      percent: 1,
      stage: "Starting",
      detail: "Preparing the protected Level Up transaction."
    };
    this.render({ force: true });

    try {
      const result = await LevelUpCommitService.commit(this.actor, this.draft, {
        transactionToken: this.commitTransactionToken,
        onProgress: payload => this.#updateCommitProgress(payload)
      });
      this.commitDialog = {
        ...this.commitDialog,
        mode: "success",
        title: "Level Up Complete",
        percent: 100,
        stage: "Complete",
        detail: `${this.actor.name} reached character level ${result.history.targetCharacterLevel}.`
      };
      this.render({ force: true });
      ui.notifications.info(`${this.actor.name} reached level ${result.history.targetCharacterLevel}.`);
      await new Promise(resolve => setTimeout(resolve, 700));
      this.draft = null;
      this.commitInProgress = false;
      this.busy = false;
      this.commitTransactionToken = null;
      this.commitDialog = null;
      await super.close();
      this.actor.sheet?.render(false);
    } catch (error) {
      console.error(`${MODULE_ID} | Protected Level Up commit failed.`, error);
      this.commitInProgress = false;
      this.busy = false;
      this.commitTransactionToken = null;
      const critical = Boolean(error?.criticalRollback);
      this.commitDialog = {
        ...(this.commitDialog ?? {}),
        open: true,
        mode: critical ? "critical" : "error",
        title: critical ? "Critical Rollback Failure" : "Level Up Not Applied",
        percent: 100,
        stage: critical ? "GM Intervention Required" : "Actor Restored",
        detail: critical
          ? "The Actor could not be verified after rollback. Character Builder changes are locked for this Actor until a GM restores or inspects it."
          : "The Level Up failed and the original Actor was restored. Restart and redo this Level Up.",
        error: error.message
      };
      this.render({ force: true });
      ui.notifications.error(error.message, { permanent: true });
    }
  }

  #updateCommitProgress(payload) {
    if (!this.commitDialog) return;
    this.commitDialog = {
      ...this.commitDialog,
      percent: Math.max(0, Math.min(100, Number(payload.percent ?? this.commitDialog.percent ?? 0))),
      stage: payload.stage ?? this.commitDialog.stage,
      detail: payload.detail ?? this.commitDialog.detail
    };
    const root = this.element;
    const fill = root?.querySelector?.("[data-commit-progress-fill]");
    const value = root?.querySelector?.("[data-commit-progress-value]");
    const stage = root?.querySelector?.("[data-commit-progress-stage]");
    const detail = root?.querySelector?.("[data-commit-progress-detail]");
    if (fill) fill.style.width = `${this.commitDialog.percent}%`;
    if (value) value.textContent = `${Math.round(this.commitDialog.percent)}%`;
    if (stage) stage.textContent = this.commitDialog.stage;
    if (detail) detail.textContent = this.commitDialog.detail;
  }

  #focusCommitDialog() {
    const dialog = this.element?.querySelector?.(".cb-commit-transaction-dialog");
    dialog?.focus?.();
    dialog?.animate?.([
      { transform: "scale(1)" },
      { transform: "scale(1.015)" },
      { transform: "scale(1)" }
    ], { duration: 180 });
  }

  async #restartClassSelection({ skipConfirmation = false } = {}) {
    const lock = HitPointAdvancementService.lockedRoll(this.actor);
    const confirmed = skipConfirmation || await this.#confirm({
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

  async close(options = {}) {
    if (this.commitInProgress) {
      this.#focusCommitDialog();
      ui.notifications.warn("The Level Up commit is in progress and cannot be closed.");
      return this;
    }
    return super.close(options);
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

  #refreshLandPreview(selectedLand) {
    const section = this.element.querySelector("[data-land-selection]");
    if (!section) return;
    const value = String(selectedLand ?? "");
    const empty = section.querySelector("[data-land-preview-empty]");
    if (empty) empty.hidden = Boolean(value);
    for (const preview of section.querySelectorAll("[data-land-preview]")) {
      preview.hidden = preview.dataset.landPreview !== value;
    }
  }

  #clearInvalidInvocationDependents(changedInput) {
    const replacement = changedInput.closest("[data-invocation-replacement]");
    if (replacement) {
      const remove = replacement.querySelector('[name="levelUp.replaceInvocation.remove"]');
      const add = replacement.querySelector('[name="levelUp.replaceInvocation.add"]');
      const target = replacement.querySelector('[name="levelUp.replaceInvocation.target"]');
      if (changedInput === remove && !remove?.value) {
        if (add) add.value = "";
        if (target) target.value = "";
      }
      if (changedInput === add) {
        const requiresTarget = add.selectedOptions?.[0]?.dataset?.targetCantrip === "true";
        if (!add.value || !requiresTarget) {
          if (target) target.value = "";
        }
      }
    }

    const slot = changedInput.closest("[data-invocation-slot]");
    if (slot && changedInput.matches("select[data-invocation-select]")) {
      const target = slot.querySelector("[data-invocation-target-row] select");
      const requiresTarget = changedInput.selectedOptions?.[0]?.dataset?.targetCantrip === "true";
      if (!changedInput.value || !requiresTarget) {
        if (target) target.value = "";
      }
    }
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

  #refreshPactOfTheTomeVisibility() {
    const section = this.element?.querySelector?.("[data-pact-tome-level-up]");
    if (!section) return;
    const tomeIdentifier = "pact-of-the-tome";
    const selectedInvocationOptions = [
      ...this.element.querySelectorAll('select[data-invocation-select]'),
      ...this.element.querySelectorAll('select[name="levelUp.replaceInvocation.add"]')
    ].map(select => select.selectedOptions?.[0]).filter(Boolean);
    const acquiring = selectedInvocationOptions.some(option => option.dataset.identifier === tomeIdentifier);
    const remove = this.element.querySelector('select[name="levelUp.replaceInvocation.remove"]')?.selectedOptions?.[0];
    const add = this.element.querySelector('select[name="levelUp.replaceInvocation.add"]')?.selectedOptions?.[0];
    const removing = remove?.dataset.identifier === tomeIdentifier && add?.dataset.identifier !== tomeIdentifier;
    const needsInitial = section.dataset.needsInitial === "true";
    const visible = acquiring || (needsInitial && !removing);
    section.hidden = !visible;
    for (const input of section.querySelectorAll('input[type="checkbox"]')) {
      if (!visible) input.checked = false;
      input.disabled = !visible || input.dataset.baseDisabled === "true";
    }
  }

  #refreshSpellSelectionState() {
    const root = this.element;
    const selectionRoot = root.querySelector("[data-spell-selection-root]");
    if (!selectionRoot) return;

    this.#refreshInvocationTargetEligibility();

    const allSpellControls = [...selectionRoot.querySelectorAll("input[type=checkbox][data-spell-identifier]")];
    const controls = allSpellControls.filter(control => !control.matches("[data-managed-selection-control]"));
    const replacement = selectionRoot.querySelector('[name="levelUp.replaceSpell.add"]');
    const replacementRemove = selectionRoot.querySelector('[name="levelUp.replaceSpell.remove"]');
    const selectedControls = controls.filter(control => control.checked);
    const allSelectedControls = allSpellControls.filter(control => control.checked);
    const selectedByIdentifier = new Map();
    for (const control of allSelectedControls) {
      const identifier = control.dataset.spellIdentifier;
      const rows = selectedByIdentifier.get(identifier) ?? [];
      rows.push(control);
      selectedByIdentifier.set(identifier, rows);
    }
    const replacementIdentifier = String(replacement?.value ?? "");
    let conflict = false;

    for (const control of allSpellControls) {
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

    const pendingSpellIdentifiers = new Set(selectedControls.map(control => control.dataset.spellIdentifier).filter(Boolean));
    for (const control of selectionRoot.querySelectorAll('[data-managed-target-identifier][data-pending="true"]')) {
      const eligible = pendingSpellIdentifiers.has(control.dataset.managedTargetIdentifier);
      control.disabled = !eligible;
      if (!eligible) control.checked = false;
      const card = control.closest("[data-spell-option]");
      card?.classList.toggle("duplicate-disabled", !eligible);
      if (card) card.title = eligible ? "Selected during this Level Up." : "Select this spell in the Wizard spellbook choices above first.";
    }

    let managedSectionsComplete = true;
    for (const section of selectionRoot.querySelectorAll("[data-managed-selection-section]")) {
      const hidden = section.closest("[hidden]") !== null;
      const expected = Number(section.dataset.required ?? 0);
      const controls = [...section.querySelectorAll("input[type=checkbox][data-managed-selection-control]")];
      const selected = controls.filter(control => control.checked).length;
      section.querySelectorAll("[data-managed-selection-count]").forEach(node => {
        node.textContent = `${selected} / ${expected}`;
      });
      for (const control of controls) {
        const baseDisabled = control.dataset.baseDisabled === "true";
        const duplicateDisabled = control.closest("[data-spell-option]")?.classList.contains("duplicate-disabled") && !control.checked;
        control.disabled = hidden || baseDisabled || duplicateDisabled || (!control.checked && selected >= expected);
      }
      const complete = hidden || selected === expected;
      section.classList.toggle("complete", !hidden && complete);
      section.classList.toggle("invalid", !hidden && selected > expected);
      managedSectionsComplete &&= complete;
    }

    let managedSelectsComplete = true;
    for (const select of selectionRoot.querySelectorAll("[data-managed-required-select]")) {
      managedSelectsComplete &&= Boolean(select.value);
      select.closest("[data-managed-select-section]")?.classList.toggle("invalid", !select.value);
    }

    let optionalPairsComplete = true;
    for (const section of selectionRoot.querySelectorAll("[data-optional-pair]")) {
      const remove = section.querySelector("[data-optional-pair-remove]");
      const add = section.querySelector("[data-optional-pair-add]");
      const complete = Boolean(remove?.value) === Boolean(add?.value);
      optionalPairsComplete &&= complete;
      section.classList.toggle("invalid", !complete);
    }

    let featureReplacementsComplete = true;
    for (const section of selectionRoot.querySelectorAll("[data-feature-replacement]")) {
      const remove = section.querySelector("[data-feature-replace-remove]");
      const add = section.querySelector("[data-feature-replace-add]");
      const selectedLevel = Number(remove?.selectedOptions?.[0]?.dataset.spellLevel ?? 0);
      const sameLevel = section.dataset.sameLevel === "true";
      if (sameLevel && add) {
        const current = add.value;
        for (const option of [...add.options].slice(1)) {
          const eligible = !selectedLevel || Number(option.dataset.spellLevel ?? 0) === selectedLevel;
          option.disabled = !eligible;
          option.textContent = `${option.dataset.baseLabel ?? option.textContent}${eligible ? "" : ` — requires level ${selectedLevel}`}`;
        }
        if (current && add.selectedOptions?.[0]?.disabled) add.value = "";
      }
      const complete = Boolean(remove?.value) === Boolean(add?.value);
      featureReplacementsComplete &&= complete;
      section.classList.toggle("invalid", !complete);
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
      && managedSectionsComplete
      && managedSelectsComplete
      && optionalPairsComplete
      && featureReplacementsComplete
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

  async #handleStructuralLevelUpError(error) {
    const choice = foundry.utils.escapeHTML(error.choiceName ?? "The selected option");
    const reason = foundry.utils.escapeHTML(error.reason ?? error.message ?? "The native Advancement result is inconsistent.");
    const returnToChoices = error.returnStep === "choices";
    const returnLabel = returnToChoices ? "Return to Spells & Features" : "Return to Class Progression";
    const content = `<div class="cb-structural-error">
      <p><strong>${choice} cannot be applied safely.</strong></p>
      <p>${reason}</p>
      <p>The invalid choice was reverted to the pre-choice Draft snapshot. Return to the appropriate Character Builder step and choose a valid option.</p>
      <p><strong>Your live character has not been changed.</strong> The selected Class and locked Hit Die result are preserved.</p>
    </div>`;
    const DialogV2 = foundry.applications.api.DialogV2;
    if (DialogV2?.wait) {
      await DialogV2.wait({
        window: { title: error.title ?? "Native Choice Must Be Reopened", modal: true },
        content,
        buttons: [{ action: "return", label: returnLabel, icon: "fa-solid fa-rotate-left", default: true }],
        close: () => "return"
      });
    } else {
      await new Promise(resolve => {
        new Dialog({
          title: error.title ?? "Native Choice Must Be Reopened",
          content,
          buttons: { reopen: { label: returnLabel, callback: resolve } },
          default: "reopen",
          close: resolve
        }).render(true);
      });
    }
    await LevelUpDraftManager.setState(this.draft, {
      nativeRunning: false,
      nativeComplete: returnToChoices,
      additionalChoices: {},
      additionalComplete: false,
      commitReady: false,
      step: returnToChoices ? "choices" : "advancements"
    });
    ui.notifications.warn(returnToChoices
      ? "The invalid choice was reverted. Return to Spells & Features and choose again."
      : "The invalid native choice was reverted. Reopen Class Progression and choose again.", { permanent: true });
    this.render({ force: true });
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
