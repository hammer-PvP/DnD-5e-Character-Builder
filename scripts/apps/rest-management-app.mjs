import { MODULE_ID } from "../constants.mjs";
import { SourceRegistry } from "../services/source-registry.mjs";
import { RestSessionService } from "../services/rest-session-service.mjs";
import { RuntimeFeatureService } from "../services/runtime-feature-service.mjs";
import { RuntimeTransactionService } from "../services/runtime-transaction-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function cloneRestConfig(config = {}) {
  const copy = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (typeof value === "function") {
      copy[key] = value;
      continue;
    }
    try { copy[key] = foundry.utils.deepClone(value); }
    catch (_error) { copy[key] = value; }
  }
  return copy;
}

/**
 * Character Keeper interface for optional Short/Long Rest reconfiguration.
 * Feature choices are staged first. The D&D5e rest remains authoritative and
 * runs exactly once; Keeper mutations are applied atomically only afterward.
 */
export class RestManagementApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instances = new Map();

  constructor(actor, {
    restType = "long",
    restConfig = {},
    externalMode = false,
    registry = null,
    session = null,
    options = {}
  } = {}) {
    super(options);
    this.actor = actor;
    this.restType = restType === "short" ? "short" : "long";
    this.restConfig = cloneRestConfig(restConfig);
    this.externalMode = Boolean(externalMode);
    this.registry = registry ?? new SourceRegistry();
    this.session = session;
    this.actions = [];
    this.busy = false;
    this.busyLabel = "";
    this.operationToken = null;
  }

  static DEFAULT_OPTIONS = {
    id: "dnd5e-character-keeper",
    classes: ["character-builder", "rest-management-app", "standard-form"],
    tag: "form",
    position: { width: 1180, height: 820 },
    window: { title: "Character Keeper", resizable: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/rest-management.hbs` }
  };

  get id() {
    return this.externalMode
      ? `dnd5e-character-keeper-scribe-${this.actor.id}`
      : `dnd5e-character-keeper-${this.restType}-${this.actor.id}`;
  }

  get restLabel() {
    return this.restType === "short" ? "Short Rest" : "Long Rest";
  }

  async _onClose(options = {}) {
    super._onClose(options);
    const key = this.externalMode ? `${this.actor.id}:scribe` : `${this.actor.id}:${this.restType}`;
    RestManagementApp.#instances.delete(key);
    if (this.externalMode) return;
    const session = RestSessionService.get(this.actor);
    const pristine = session?.id && !session.nativeRestCompleted
      && !Object.keys(session.operations ?? {}).length
      && !Object.keys(session.rollLocks ?? {}).length;
    if (pristine) {
      try { await RestSessionService.clear(this.actor); }
      catch (error) { console.warn(`${MODULE_ID} | Could not clear pristine Character Keeper session.`, error); }
    }
  }

  static async launch(actor, restType, restConfig = {}) {
    if (!actor || actor.type !== "character") return;
    if (!actor.isOwner) {
      ui.notifications.warn("You do not have permission to manage this character's rest.");
      return;
    }
    const type = restType === "short" ? "short" : "long";
    const key = `${actor.id}:${type}`;
    const existing = this.#instances.get(key);
    if (existing && !existing._stateIsClosing) {
      existing.bringToFront?.();
      return existing;
    }

    const registry = new SourceRegistry();
    await registry.load();
    const session = await RestSessionService.getOrCreate(actor, type);
    const actions = await RuntimeFeatureService.actions(actor, type, registry, session);
    if (!actions.length) {
      if (session.nativeRestCompleted) {
        throw new Error("The native rest completed, but the saved Character Keeper action is no longer eligible. The Actor was not modified further; a GM must inspect the pending rest session.");
      }
      const hadPendingState = Object.keys(session.operations ?? {}).length || Object.keys(session.rollLocks ?? {}).length;
      await RestSessionService.clear(actor);
      if (hadPendingState) ui.notifications.warn("A stale Character Keeper choice was discarded because its source feature is no longer present or eligible.");
      return actor.initiateRest({
        ...cloneRestConfig(restConfig),
        type,
        characterBuilderRestBypass: true
      });
    }

    const app = new this(actor, { restType: type, restConfig, registry, session });
    app.actions = actions;
    this.#instances.set(key, app);
    await app.render({ force: true });
    return app;
  }

  static async launchScribe(actor) {
    if (!actor || actor.type !== "character" || !actor.isOwner) return;
    const key = `${actor.id}:scribe`;
    const existing = this.#instances.get(key);
    if (existing && !existing._stateIsClosing) {
      existing.bringToFront?.();
      return existing;
    }
    const registry = new SourceRegistry();
    await registry.load();
    const context = await RuntimeFeatureService.externalScribeContext(actor, registry);
    if (!context.sources.length) {
      ui.notifications.warn(context.emptyMessage || "No eligible written Wizard spell is currently available to scribe.");
      return;
    }
    const app = new this(actor, { restType: "long", externalMode: true, registry });
    app.actions = [{
      id: "scribe-spell", label: "Scribe Spell to Spellbook", kind: "scribe-spell",
      description: "Copy an eligible written Wizard spell into the spellbook.",
      img: "systems/dnd5e/icons/svg/ink-pot.svg", complete: false, order: 1
    }];
    this.#instances.set(key, app);
    await app.render({ force: true });
    return app;
  }

  async _prepareContext() {
    if (!this.actor?.isOwner) throw new Error("You no longer have permission to manage this character.");
    await this.registry.load();
    if (!this.externalMode) {
      this.session = RestSessionService.get(this.actor) ?? await RestSessionService.getOrCreate(this.actor, this.restType);
      this.actions = await RuntimeFeatureService.actions(this.actor, this.restType, this.registry, this.session);
    }

    const selectedId = this.externalMode
      ? "scribe-spell"
      : (this.session?.activeActionId && this.actions.some(row => row.id === this.session.activeActionId)
        ? this.session.activeActionId
        : this.actions[0]?.id ?? null);
    const selectedBase = this.actions.find(row => row.id === selectedId) ?? null;
    const selected = selectedBase
      ? this.#decorateAction(await RuntimeFeatureService.actionContext(this.actor, selectedBase, this.registry, this.session))
      : null;

    const actionRows = this.actions.map(action => ({
      ...action,
      selected: action.id === selectedId,
      complete: Boolean(this.session?.completedActionIds?.includes(action.id))
    }));
    const title = this.externalMode
      ? "Character Keeper — Scribe Spell"
      : `Character Keeper — ${this.restType === "short" ? "Short" : "Long"} Rest`;
    this.window.title = title;

    return {
      actor: {
        id: this.actor.id,
        name: this.actor.name,
        img: this.actor.img,
        level: this.#actorLevel(this.actor)
      },
      restType: this.restType,
      restLabel: this.restType === "short" ? "Short Rest" : "Long Rest",
      externalMode: this.externalMode,
      actions: actionRows,
      selected,
      hasActions: actionRows.length > 0,
      busy: this.busy,
      busyLabel: this.busyLabel,
      nativeRestCompleted: Boolean(this.session?.nativeRestCompleted),
      continueLabel: this.session?.nativeRestCompleted
        ? "Apply Pending Changes"
        : `Continue ${this.restType === "short" ? "Short" : "Long"} Rest`,
      continueHint: this.session?.nativeRestCompleted
        ? "Retry Character Keeper changes; the native rest will not run again"
        : "Run the native D&D5e rest exactly once",
      sourceOrder: SourceRegistry.orderedSources().map(source => source.label).join(" → ")
    };
  }

  _onRender() {
    const root = this.element;
    for (const button of root.querySelectorAll("[data-action]")) {
      button.addEventListener("click", event => this.#onAction(event));
    }
    for (const input of root.querySelectorAll("[data-filter-target]")) {
      input.addEventListener("input", event => this.#filterCards(event));
    }
    for (const card of root.querySelectorAll("[data-document-card]")) {
      card.addEventListener("click", event => {
        if (event.target.closest("button, input, select, label, a")) return;
        card.querySelector('[data-action="open-document"]')?.click();
      });
    }
    root.querySelectorAll('[name="keeper.mastery.oldKey"], [name="keeper.mastery.newKey"]').forEach(select => {
      select.addEventListener("change", () => this.#refreshMasteryOptions());
    });
    this.#refreshMasteryOptions();
    root.querySelectorAll('[name="keeper.spellMastery.oldItemId"]').forEach(input => {
      input.addEventListener("change", () => this.#refreshSpellMasteryOptions(input));
    });
    const masteryOld = root.querySelector('[name="keeper.spellMastery.oldItemId"]:checked');
    if (masteryOld) this.#refreshSpellMasteryOptions(masteryOld);
    root.querySelectorAll('[name="keeper.tome.cantrips"], [name="keeper.tome.rituals"]').forEach(input => {
      input.addEventListener("change", () => this.#refreshTomeCounts());
    });
    this.#refreshTomeCounts();
    root.querySelectorAll("input, select").forEach(input => {
      input.addEventListener("change", () => this.#refreshApplyButton());
    });
    this.#refreshApplyButton();
  }

  async #onAction(event) {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const action = target.dataset.action;
    if (this.busy && !["open-document"].includes(action)) return;
    try {
      switch (action) {
        case "select-rest-action":
          await this.#selectAction(target.dataset.actionId);
          break;
        case "apply-current-action":
          await this.#confirmCurrentAction();
          break;
        case "roll-current-action":
          await this.#rollCurrentAction();
          break;
        case "invoke-native-feature":
          await this.#invokeNativeFeature();
          break;
        case "continue-rest":
          await this.#continueRest();
          break;
        case "cancel-rest-management":
          await this.#cancelManagement();
          break;
        case "recover-rest-management":
          await this.#recoverManagement();
          break;
        case "open-document":
          await this.#openDocument(target.dataset.uuid);
          break;
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Character Keeper action failed.`, error);
      ui.notifications.error(error.message, { permanent: Boolean(error.message?.includes("safety-locked")) });
      this.#setBusy(false);
      await this.render({ force: true });
    }
  }

  async #selectAction(actionId) {
    if (!this.actions.some(action => action.id === actionId)) return;
    if (!this.externalMode) this.session = await RestSessionService.selectAction(this.actor, actionId);
    await this.render({ force: true });
  }

  async #confirmCurrentAction() {
    if (this.busy) return;
    const action = this.#selectedAction();
    if (!action || action.native) return;
    const payload = this.#payloadFor(action);
    const token = foundry.utils.randomID();
    if (this.operationToken) return;
    this.operationToken = token;
    this.#setBusy(true, this.externalMode ? "Applying spellbook change…" : "Saving rest choice…");
    try {
      if (this.externalMode) {
        const syntheticSession = {
          id: `scribe:${this.actor.id}:${Date.now()}`,
          restType: null,
          operations: {
            "scribe-spell": { actionId: "scribe-spell", payload, token, confirmedAt: Date.now() }
          }
        };
        const result = await RuntimeTransactionService.run(this.actor, { session: syntheticSession, label: "Scribe Spell to Spellbook" }, async transactionId => {
          return RuntimeFeatureService.applyExternalScribe(this.actor, this.registry, payload, transactionId);
        });
        ui.notifications.info(result?.success === false
          ? "The Arcana check failed. The Spell Scroll was destroyed and the spell was not copied."
          : "Spell scribed to the Wizard spellbook.");
        await this.close();
        return;
      }
      await RuntimeFeatureService.validateOperation(this.actor, this.registry, action.id, payload);
      this.session = await RestSessionService.setOperation(this.actor, action.id, payload);
      ui.notifications.info(`${action.label} is ready to apply when the ${this.restLabel} completes.`);
    } finally {
      if (this.operationToken === token) this.operationToken = null;
      this.#setBusy(false);
    }
    await this.render({ force: true });
  }

  async #rollCurrentAction() {
    if (this.busy || this.externalMode) return;
    const action = this.#selectedAction();
    if (!action || !["roll-cosmic-omen", "roll-portent"].includes(action.kind)) return;
    const actionId = action.id;
    this.#setBusy(true, "Rolling publicly…");
    try {
      const result = await RuntimeFeatureService.performPublicRoll(this.actor, actionId, this.session);
      this.session = await RestSessionService.setRollLock(this.actor, actionId, result);
      this.session = await RestSessionService.setOperation(this.actor, actionId, result);
      ui.notifications.info(`${action.label} result recorded for this rest.`);
    } finally {
      this.#setBusy(false);
    }
    await this.render({ force: true });
  }

  async #invokeNativeFeature() {
    if (this.busy || this.externalMode) return;
    const action = this.#selectedAction();
    if (!action?.native) return;
    this.#setBusy(true, `Opening ${action.label}…`);
    try {
      const result = await RuntimeFeatureService.invokeNativeFeature(this.actor, action.id);
      if (result !== false && result !== null) {
        this.session = await RestSessionService.setOperation(this.actor, action.id, { native: true });
      }
    } finally {
      this.#setBusy(false);
    }
    await this.render({ force: true });
  }

  async #continueRest() {
    if (this.busy || this.externalMode) return;
    if (this.actor.getFlag(MODULE_ID, "runtimeManagementSafetyLock")) {
      throw new Error("This Actor is safety-locked after a failed Character Keeper rollback. A GM must inspect it before another management transaction.");
    }
    const token = foundry.utils.randomID();
    if (this.operationToken) return;
    this.operationToken = token;
    this.#setBusy(true, this.session?.nativeRestCompleted ? "Applying Character Keeper changes…" : `Starting ${this.restLabel}…`);
    try {
      this.session = RestSessionService.get(this.actor) ?? this.session;
      const stagedOperations = Object.values(this.session?.operations ?? {});
      if (!this.session?.nativeRestCompleted && stagedOperations.length) {
        const preflightActions = await RuntimeFeatureService.actions(this.actor, this.restType, this.registry, this.session);
        const preflightMap = new Map(preflightActions.map(action => [action.id, action]));
        for (const operation of stagedOperations) {
          const action = preflightMap.get(operation.actionId);
          if (!action) throw new Error(`The staged ${operation.actionId} action is no longer eligible on this Actor.`);
          if (action.native) continue;
          await RuntimeFeatureService.validateOperation(
            this.actor,
            this.registry,
            operation.actionId,
            operation.payload
          );
        }
      }
      if (!this.session?.nativeRestCompleted) {
        const result = await this.actor.initiateRest({
          ...cloneRestConfig(this.restConfig),
          type: this.restType,
          characterBuilderRestBypass: true
        });
        if (!result) {
          this.session = await RestSessionService.update(this.actor, { status: "pending" });
          this.#setBusy(false);
          this.operationToken = null;
          await this.render({ force: true });
          return;
        }
        this.session = await RestSessionService.markNativeRestCompleted(this.actor, result);
      }

      const operations = Object.values(this.session.operations ?? {});
      const lifecycleRequired = RuntimeFeatureService.restLifecycleRequired(this.actor, this.restType);
      if (operations.length || lifecycleRequired) {
        const actions = await RuntimeFeatureService.actions(this.actor, this.restType, this.registry, this.session);
        const actionMap = new Map(actions.map(action => [action.id, action]));
        await RuntimeTransactionService.run(this.actor, {
          session: this.session,
          label: `${this.restLabel} Character Keeper`
        }, async transactionId => {
          const results = [];
          results.push(...await RuntimeFeatureService.applyRestLifecycle(
            this.actor,
            this.restType,
            operations,
            transactionId
          ));
          for (const operation of operations) {
            const action = actionMap.get(operation.actionId);
            if (!action) throw new Error(`The staged ${operation.actionId} action is no longer eligible on this Actor.`);
            if (action.native) continue;
            results.push(await RuntimeFeatureService.applyOperation(
              this.actor,
              this.registry,
              operation.actionId,
              operation.payload,
              transactionId
            ));
          }
          return results;
        });
      }
      await RestSessionService.clear(this.actor);
      ui.notifications.info(`${this.restLabel} completed and Character Keeper changes were applied.`);
      await this.close();
    } catch (error) {
      this.session = RestSessionService.get(this.actor) ?? this.session;
      throw error;
    } finally {
      if (this.operationToken === token) this.operationToken = null;
      this.#setBusy(false);
    }
  }

  async #cancelManagement() {
    if (this.busy) return;
    if (this.externalMode) return this.close();
    if (this.session?.nativeRestCompleted) {
      ui.notifications.warn("The native rest already completed. Apply or recover the pending Character Keeper changes before clearing this session.");
      return;
    }
    if (Object.keys(this.session?.rollLocks ?? {}).length) {
      ui.notifications.info("Public rest rolls are locked for this pending rest. Closing Character Keeper preserves them against rerolls.");
      await this.close();
      return;
    }
    await RestSessionService.cancel(this.actor);
    await this.close();
  }

  async #recoverManagement() {
    if (this.busy || this.externalMode) return;
    this.session = RestSessionService.get(this.actor) ?? this.session;
    if (!this.session?.nativeRestCompleted) return this.#cancelManagement();
    const DialogV2 = foundry.applications.api.DialogV2;
    const title = "Discard Pending Character Keeper Changes";
    const content = `<p>The native ${this.restLabel} has already completed.</p><p>Discard the pending Character Keeper choices and close this session? The completed rest and its native recovery will remain in place.</p>`;
    const confirmed = DialogV2?.confirm
      ? await DialogV2.confirm({ window: { title }, content, yes: { label: "Discard Pending Changes" }, no: { label: "Keep Session" } })
      : await Dialog.confirm({ title, content, yes: () => true, no: () => false, defaultYes: false });
    if (!confirmed) return;
    this.#setBusy(true, "Recovering Character Keeper session…");
    try {
      await RestSessionService.recover(this.actor);
      ui.notifications.warn(`Pending Character Keeper changes were discarded. The completed ${this.restLabel} was kept.`);
      await this.close();
    } finally {
      this.#setBusy(false);
    }
  }

  async #openDocument(uuid) {
    if (!uuid) return;
    const document = await fromUuid(uuid);
    if (!document) return ui.notifications.warn("The source document could not be opened.");
    document.sheet?.render(true);
  }

  #selectedAction() {
    const selectedId = this.externalMode
      ? "scribe-spell"
      : (RestSessionService.get(this.actor)?.activeActionId ?? this.session?.activeActionId ?? this.actions[0]?.id);
    return this.actions.find(action => action.id === selectedId) ?? this.actions[0] ?? null;
  }

  #payloadFor(action) {
    const root = this.element;
    const checkedValues = name => [...root.querySelectorAll(`[name="${name}"]:checked`)].map(input => input.value);
    switch (action.kind) {
      case "weapon-mastery": {
        const changes = [];
        for (const group of root.querySelectorAll("[data-mastery-group]")) {
          for (const slot of group.querySelectorAll("[data-mastery-change-slot]")) {
            const oldKey = slot.querySelector('[name="keeper.mastery.oldKey"]')?.value ?? "";
            const newKey = slot.querySelector('[name="keeper.mastery.newKey"]')?.value ?? "";
            if (Boolean(oldKey) !== Boolean(newKey)) throw new Error("Complete both sides of each Weapon Mastery replacement or leave the row blank.");
            if (!oldKey) continue;
            if (oldKey === newKey) throw new Error("Choose a different replacement weapon.");
            changes.push({
              classItemId: group.dataset.classItemId,
              slotIndex: Number(slot.dataset.slotIndex ?? 0),
              oldKey,
              newKey
            });
          }
        }
        if (!changes.length) throw new Error("Choose at least one Weapon Mastery replacement.");
        return { changes };
      }
      case "effect-choice": {
        const effectId = checkedValues("keeper.effectId")[0] ?? "";
        if (!effectId) throw new Error("Choose one feature option.");
        return { effectId };
      }
      case "activity-choice": {
        const value = checkedValues("keeper.activityValue")[0] ?? "";
        if (!value) throw new Error("Choose one feature option.");
        return { value };
      }
      case "land": {
        const land = checkedValues("keeper.land")[0] ?? "";
        if (!land) throw new Error("Choose one Land.");
        return { land };
      }
      case "wild-shape-form": {
        const oldUuid = checkedValues("keeper.wildShape.oldUuid")[0] ?? "";
        const newUuid = checkedValues("keeper.wildShape.newUuid")[0] ?? "";
        if (!oldUuid || !newUuid || oldUuid === newUuid) throw new Error("Choose a known form and a different eligible Beast.");
        return { oldUuid, newUuid };
      }
      case "pact-of-the-tome": {
        const selectedCantrips = checkedValues("keeper.tome.cantrips");
        const selectedRituals = checkedValues("keeper.tome.rituals");
        if (selectedCantrips.length !== 3 || selectedRituals.length !== 2) throw new Error("Choose exactly three cantrips and two level 1 Ritual spells.");
        return { selectedCantrips, selectedRituals };
      }
      case "replace-cantrip": {
        const oldItemId = checkedValues("keeper.cantrip.oldItemId")[0] ?? "";
        const newUuid = checkedValues("keeper.cantrip.newUuid")[0] ?? "";
        if (!oldItemId || !newUuid) throw new Error("Choose the cantrip to replace and its replacement.");
        return { oldItemId, newUuid };
      }
      case "replace-prepared-spell": {
        const oldItemId = checkedValues("keeper.preparedSpell.oldItemId")[0] ?? "";
        const newUuid = checkedValues("keeper.preparedSpell.newUuid")[0] ?? "";
        if (!oldItemId || !newUuid) throw new Error("Choose the prepared spell to replace and its replacement.");
        return { oldItemId, newUuid };
      }
      case "spell-mastery": {
        const oldItemId = checkedValues("keeper.spellMastery.oldItemId")[0] ?? "";
        const newItemId = checkedValues("keeper.spellMastery.newItemId")[0] ?? "";
        if (!oldItemId || !newItemId || oldItemId === newItemId) throw new Error("Choose one mastered spell and a different eligible spell of the same level.");
        return { oldItemId, newItemId };
      }
      case "scribe-spell": {
        const sourceItemId = checkedValues("keeper.scribe.sourceItemId")[0] ?? "";
        const escaped = globalThis.CSS?.escape ? CSS.escape(sourceItemId) : sourceItemId;
        const row = root.querySelector(`[data-scribe-source-id="${escaped}"]`);
        const spellUuid = row?.dataset.spellUuid ?? "";
        if (!sourceItemId || !spellUuid) throw new Error("Choose a written Wizard spell to scribe.");
        return { sourceItemId, spellUuid };
      }
      default:
        throw new Error(`The ${action.label} form is not available.`);
    }
  }

  #decorateAction(action) {
    const kind = action.kind;
    const labels = {
      "weapon-mastery": "Apply Weapon Mastery Changes",
      "effect-choice": `Confirm ${action.label}`,
      "activity-choice": `Confirm ${action.label}`,
      land: "Confirm Land",
      "wild-shape-form": "Replace Known Form",
      "pact-of-the-tome": "Confirm Pact of the Tome",
      "replace-cantrip": "Replace Cantrip",
      "replace-prepared-spell": `Replace ${action.replacePreparedSpell?.className ?? "Prepared"} Spell`,
      "spell-mastery": "Confirm Spell Mastery",
      "roll-cosmic-omen": "Roll Cosmic Omen",
      "roll-portent": "Roll Portent",
      "scribe-spell": "Scribe Spell to Spellbook",
      "war-bond-guide": "War Bond Instructions",
      "native-feature": `Open ${action.label}`
    };
    return {
      ...action,
      applyLabel: labels[kind] ?? `Confirm ${action.label}`,
      isWeaponMastery: kind === "weapon-mastery",
      isEffectChoice: kind === "effect-choice",
      isActivityChoice: kind === "activity-choice",
      isLand: kind === "land",
      isWildShape: kind === "wild-shape-form",
      isPactTome: kind === "pact-of-the-tome",
      isReplaceCantrip: kind === "replace-cantrip",
      isReplacePreparedSpell: kind === "replace-prepared-spell",
      isSpellMastery: kind === "spell-mastery",
      isCosmicOmen: kind === "roll-cosmic-omen",
      isPortent: kind === "roll-portent",
      isRoll: ["roll-cosmic-omen", "roll-portent"].includes(kind),
      isScribe: kind === "scribe-spell",
      isWarBondGuide: kind === "war-bond-guide",
      isNativeFeature: kind === "native-feature"
    };
  }

  #filterCards(event) {
    const input = event.currentTarget;
    const target = this.element.querySelector(input.dataset.filterTarget);
    if (!target) return;
    const query = String(input.value ?? "").trim().toLowerCase();
    for (const row of target.querySelectorAll("[data-search]")) {
      row.hidden = Boolean(query && !String(row.dataset.search ?? row.textContent ?? "").toLowerCase().includes(query));
    }
    for (const group of target.querySelectorAll(".cb-source-group")) {
      group.hidden = ![...group.querySelectorAll("[data-search]")].some(row => !row.hidden);
    }
  }

  #refreshMasteryOptions() {
    const root = this.element;
    if (!root) return;
    const slots = [...root.querySelectorAll("[data-mastery-change-slot]")];
    const selectedOldBases = new Set(slots.map(slot => slot.querySelector('[name="keeper.mastery.oldKey"]')?.value ?? "")
      .filter(Boolean).map(value => String(value).split(":").at(-1)));
    const selectedNewKeys = slots.map(slot => slot.querySelector('[name="keeper.mastery.newKey"]')?.value ?? "").filter(Boolean);

    for (const group of root.querySelectorAll("[data-mastery-group]")) {
      const groupOldValues = [...group.querySelectorAll('[name="keeper.mastery.oldKey"]')].map(select => select.value).filter(Boolean);
      for (const slot of group.querySelectorAll("[data-mastery-change-slot]")) {
        const oldSelect = slot.querySelector('[name="keeper.mastery.oldKey"]');
        const newSelect = slot.querySelector('[name="keeper.mastery.newKey"]');
        if (!oldSelect || !newSelect) continue;

        for (const option of oldSelect.options) {
          if (!option.value) continue;
          option.disabled = groupOldValues.some(value => value === option.value && value !== oldSelect.value);
        }

        if (!oldSelect.value) {
          newSelect.value = "";
          newSelect.disabled = true;
          continue;
        }
        newSelect.disabled = false;
        for (const option of newSelect.options) {
          if (!option.value) continue;
          const baseDisabled = option.dataset.baseDisabled === "true";
          const baseItem = option.dataset.baseItem ?? "";
          const selectedElsewhere = selectedNewKeys.some(value => value === option.value && value !== newSelect.value);
          option.disabled = (baseDisabled && !selectedOldBases.has(baseItem)) || selectedElsewhere;
        }
        if (newSelect.selectedOptions[0]?.disabled) newSelect.value = "";
      }
    }
    this.#refreshApplyButton();
  }

  #refreshSpellMasteryOptions(oldInput) {
    const level = oldInput?.dataset.level ?? "";
    const currentId = oldInput?.value ?? "";
    for (const card of this.element.querySelectorAll("[data-spell-mastery-candidate]")) {
      const hidden = Boolean(level && card.dataset.level !== level) || card.dataset.itemId === currentId;
      card.hidden = hidden;
      const input = card.querySelector('[name="keeper.spellMastery.newItemId"]');
      if (input) {
        input.disabled = hidden;
        if (hidden && input.checked) input.checked = false;
      }
    }
    this.#refreshApplyButton();
  }

  #refreshTomeCounts() {
    for (const section of this.element?.querySelectorAll?.("[data-keeper-tome-section], [data-managed-selection-section]") ?? []) {
      const required = Number(section.dataset.required ?? 0);
      const checked = section.querySelectorAll('input[type="checkbox"]:checked').length;
      const count = section.querySelector("[data-keeper-tome-count], [data-managed-selection-count]");
      if (count) count.textContent = `${checked} / ${required}`;
      section.classList.toggle("complete", checked === required);
      if (checked >= required) {
        for (const input of section.querySelectorAll('input[type="checkbox"]:not(:checked)')) {
          if (input.dataset.baseDisabled !== "true") input.disabled = true;
        }
      } else {
        for (const input of section.querySelectorAll('input[type="checkbox"]')) {
          input.disabled = input.dataset.baseDisabled === "true";
        }
      }
    }
    this.#refreshApplyButton();
  }

  #refreshApplyButton() {
    const button = this.element?.querySelector?.('[data-action="apply-current-action"]');
    if (!button) return;
    const action = this.#selectedAction();
    if (!action || action.native || ["roll-cosmic-omen", "roll-portent"].includes(action.kind)) {
      button.disabled = true;
      return;
    }
    let valid = true;
    try { this.#payloadFor(action); } catch (_error) { valid = false; }
    if (action.kind === "scribe-spell") {
      const selected = this.element.querySelector('[name="keeper.scribe.sourceItemId"]:checked');
      if (selected?.dataset.affordable === "false") valid = false;
    }
    button.disabled = this.busy || !valid;
  }

  #setBusy(busy, label = "") {
    this.busy = Boolean(busy);
    this.busyLabel = label;
    const root = this.element;
    if (!root) return;
    root.classList.toggle("busy", this.busy);
    root.querySelectorAll("button, input, select").forEach(control => {
      if (this.busy) {
        control.dataset.cbKeeperWasDisabled = control.disabled ? "true" : "false";
        control.disabled = true;
      } else {
        control.disabled = control.dataset.cbKeeperWasDisabled === "true";
        delete control.dataset.cbKeeperWasDisabled;
      }
    });
    const overlay = root.querySelector("[data-keeper-busy]");
    if (overlay) {
      overlay.hidden = !this.busy;
      const copy = overlay.querySelector("strong");
      if (copy) copy.textContent = this.busyLabel || "Applying Character Keeper changes…";
    }
    if (!this.busy) this.#refreshApplyButton();
  }

  #actorLevel(actor) {
    return actor.items.filter(item => item.type === "class").reduce((sum, item) => sum + Number(item.system?.levels ?? 0), 0);
  }
}
