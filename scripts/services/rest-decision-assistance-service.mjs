import { MODULE_ID } from "../constants.mjs";
import { RestSessionService } from "./rest-session-service.mjs";

const RECOVERY_ACTIONS = new Set(["arcane-recovery", "natural-recovery"]);
const NATIVE_ACTIVITY_NAMES = Object.freeze({
  "sorcerous-restoration": "Restore Sorcery Points",
  "magical-cunning": "Regain Pact Spell Slots"
});

/**
 * Optional rest-time decisions that need help without replacing D&D5e's own
 * rest or feature machinery. Spell-slot recovery is the one intentional gap:
 * PHB Arcane Recovery / Natural Recovery track their native use but leave the
 * selected spell slots to the player. Everything with a complete native
 * Activity is delegated back to that Activity.
 */
export class RestDecisionAssistanceService {
  static isRecoveryAction(actionId) {
    return RECOVERY_ACTIONS.has(String(actionId ?? ""));
  }

  static isManagedAction(actionId) {
    const id = String(actionId ?? "");
    return RECOVERY_ACTIONS.has(id) || id === "sorcerous-restoration" || id === "magical-cunning";
  }

  static async actions(actor, restType, session = null) {
    if (restType !== "short") return [];
    const rows = [];
    const add = (id, feature, kind, description, options = {}) => {
      if (!feature) return;
      rows.push({
        id,
        label: feature.name ?? options.label ?? id,
        kind,
        description,
        img: feature.img ?? "icons/svg/upgrade.svg",
        featureItemId: feature.id,
        complete: Boolean(session?.completedActionIds?.includes(id)),
        native: Boolean(options.native),
        nativeActivityName: options.nativeActivityName ?? null,
        immediateNative: Boolean(options.immediateNative),
        postRestNative: Boolean(options.postRestNative),
        order: Number(options.order ?? 15)
      });
    };

    const arcane = this.#feature(actor, "arcane-recovery");
    if (arcane && (session?.operations?.["arcane-recovery"] || this.#recoveryEligible(actor, "arcane-recovery", arcane, session))) {
      add(
        "arcane-recovery",
        arcane,
        "spell-slot-recovery",
        "Choose expended spell slots to recover when this Short Rest finishes.",
        { order: 12 }
      );
    }

    const natural = this.#feature(actor, "natural-recovery");
    if (natural && (session?.operations?.["natural-recovery"] || this.#recoveryEligible(actor, "natural-recovery", natural, session))) {
      add(
        "natural-recovery",
        natural,
        "spell-slot-recovery",
        "Choose expended spell slots to recover when this Short Rest finishes.",
        { order: 13 }
      );
    }

    const sorcerous = this.#feature(actor, "sorcerous-restoration");
    if (sorcerous && (session?.operations?.["sorcerous-restoration"] || this.#sorcerousRestorationEligible(actor, sorcerous))) {
      add(
        "sorcerous-restoration",
        sorcerous,
        "native-rest-feature",
        "Regain expended Sorcery Points after the Short Rest through the source-native D&D5e Activity.",
        {
          nativeActivityName: NATIVE_ACTIVITY_NAMES["sorcerous-restoration"],
          postRestNative: true,
          order: 14
        }
      );
    }

    const cunning = this.#feature(actor, "magical-cunning");
    if (cunning && this.#magicalCunningEligible(actor, cunning)) {
      add(
        "magical-cunning",
        cunning,
        "native-feature",
        "Use the source-native Regain Pact Spell Slots Activity when you perform Magical Cunning.",
        {
          native: true,
          nativeActivityName: NATIVE_ACTIVITY_NAMES["magical-cunning"],
          immediateNative: true,
          order: 15
        }
      );
    }

    return rows;
  }

  static async actionContext(actor, action, session = null) {
    if (action?.kind === "spell-slot-recovery") {
      return {
        ...action,
        feature: this.#itemSummary(actor.items.get(action.featureItemId)),
        spellRecovery: this.#recoveryContext(actor, action.id, session)
      };
    }
    if (action?.kind === "native-rest-feature" || action?.id === "magical-cunning") {
      return {
        ...action,
        feature: this.#itemSummary(actor.items.get(action.featureItemId))
      };
    }
    return action;
  }

  static async validateOperation(actor, actionId, payload = {}, session = null) {
    const id = String(actionId ?? "");
    if (RECOVERY_ACTIONS.has(id)) {
      const feature = this.#feature(actor, id);
      if (!feature) throw new Error(`${this.#label(id)} is no longer present on this Actor.`);
      const tracker = this.#recoveryTracker(feature, id);
      if (!tracker || !this.#trackerAvailable(tracker)) throw new Error(`${this.#label(id)} has no use remaining.`);
      const context = this.#recoveryContext(actor, id, session);
      const selection = this.#normalizeRecoverySelection(payload?.slots);
      const points = this.#selectionPoints(selection);
      if (points <= 0) throw new Error("Choose at least one expended spell slot to recover.");
      if (points > context.budget) throw new Error(`${this.#label(id)} can recover at most ${context.budget} combined spell levels.`);
      for (const row of context.levels) {
        const quantity = Number(selection[row.slotKey] ?? 0);
        if (quantity < 0 || !Number.isInteger(quantity)) throw new Error("Spell-slot recovery quantities must be whole numbers.");
        if (quantity > row.selectableMissing) {
          throw new Error(`Not enough expended ${row.label} slots remain available for this recovery choice.`);
        }
      }
      for (const [slotKey, quantity] of Object.entries(selection)) {
        if (!/^spell[1-5]$/.test(slotKey) && quantity) throw new Error("Only spell slots of levels 1–5 can be recovered.");
      }
      return true;
    }

    if (id === "sorcerous-restoration") {
      const feature = this.#feature(actor, id);
      if (!feature) throw new Error("Sorcerous Restoration is no longer present on this Actor.");
      if (!this.#itemUseAvailable(feature)) throw new Error("Sorcerous Restoration has no use remaining.");
      if (!this.#fontOfMagicMissing(actor)) throw new Error("No expended Sorcery Points are available to restore.");
      return true;
    }

    return false;
  }

  /**
   * Prepare Arcane/Natural Recovery before the authoritative Short Rest. This
   * is deliberately reversible so a cancelled external rest can restore the
   * exact pre-rest play state while retaining the Keeper choices.
   */
  static async prepareBeforeRest(actor, session) {
    if (!session?.id || session.nativeRestCompleted) return session;
    if (session.restDecisionPreparation?.prepared && session.restDecisionPreparation?.sessionId === session.id) return session;

    const recoveryOperations = Object.values(session.operations ?? {})
      .filter(operation => RECOVERY_ACTIONS.has(operation?.actionId));
    if (!recoveryOperations.length) return session;

    for (const operation of recoveryOperations) {
      await this.validateOperation(actor, operation.actionId, operation.payload, session);
    }

    const slotSnapshot = {};
    const trackerSnapshot = [];
    const actorUpdates = {};
    const itemUpdatesById = new Map();
    const operationIds = [];

    for (const operation of recoveryOperations) {
      const actionId = operation.actionId;
      const feature = this.#feature(actor, actionId);
      const tracker = this.#recoveryTracker(feature, actionId);
      const selection = this.#normalizeRecoverySelection(operation.payload?.slots);
      operationIds.push(actionId);

      for (let level = 1; level <= 5; level++) {
        const slotKey = `spell${level}`;
        const quantity = Number(selection[slotKey] ?? 0);
        if (!quantity) continue;
        const slot = actor.system?.spells?.[slotKey];
        const before = slotSnapshot[slotKey] ?? Number(slot?.value ?? 0);
        if (!(slotKey in slotSnapshot)) slotSnapshot[slotKey] = before;
        const updatePath = `system.spells.${slotKey}.value`;
        const currentPrepared = updatePath in actorUpdates ? Number(actorUpdates[updatePath]) : Number(slot?.value ?? 0);
        const max = Math.max(0, Number(slot?.max ?? 0));
        const next = Math.min(max, currentPrepared + quantity);
        if (next - currentPrepared !== quantity) throw new Error(`The staged ${this.#label(actionId)} choice no longer fits the Actor's available ${level}th-level slots.`);
        actorUpdates[`system.spells.${slotKey}.value`] = next;
      }

      if (tracker) {
        trackerSnapshot.push({
          actionId,
          itemId: tracker.item.id,
          path: tracker.path,
          spent: Number(tracker.spent ?? 0)
        });
        const update = itemUpdatesById.get(tracker.item.id) ?? { _id: tracker.item.id };
        update[tracker.path] = Number(tracker.spent ?? 0) + 1;
        itemUpdatesById.set(tracker.item.id, update);
      }
    }

    const preparation = {
      sessionId: session.id,
      prepared: true,
      preparedAt: Date.now(),
      preparedBy: game.user.id,
      operationIds,
      slotSnapshot,
      trackerSnapshot
    };

    try {
      if (Object.keys(actorUpdates).length) {
        await actor.update(actorUpdates, {
          characterBuilderRuntimeManagement: true,
          characterBuilderRestDecisionPreparation: true
        });
      }
      const itemUpdates = [...itemUpdatesById.values()];
      if (itemUpdates.length) {
        await actor.updateEmbeddedDocuments("Item", itemUpdates, {
          characterBuilderRuntimeManagement: true,
          characterBuilderRestDecisionPreparation: true
        });
      }
      return RestSessionService.update(actor, { restDecisionPreparation: preparation });
    } catch (error) {
      try {
        await this.#restoreSnapshot(actor, preparation);
      } catch (rollbackError) {
        await this.#safetyLock(actor, preparation, error, rollbackError);
        throw new Error(`Character Keeper could not verify rollback of the prepared rest decision and safety-locked this Actor for GM inspection. Original error: ${error.message}`);
      }
      throw error;
    }
  }

  static async rollbackPreparation(actor, session = null) {
    const current = RestSessionService.get(actor) ?? session;
    const preparation = current?.restDecisionPreparation;
    if (!preparation?.prepared || current?.nativeRestCompleted) return current;
    try {
      await this.#restoreSnapshot(actor, preparation);
    } catch (rollbackError) {
      await this.#safetyLock(actor, preparation, new Error("The authoritative rest was cancelled or failed."), rollbackError);
      throw new Error("Character Keeper could not verify restoration of the pre-rest spell-slot/use state and safety-locked this Actor for GM inspection.");
    }
    return RestSessionService.update(actor, { restDecisionPreparation: null });
  }

  static isPrepared(session, actionId) {
    return Boolean(session?.restDecisionPreparation?.prepared
      && session.restDecisionPreparation?.operationIds?.includes?.(actionId));
  }

  static async applyPreparedRecovery(_actor, actionId, _payload, _transactionId, session = null) {
    if (!this.isPrepared(session, actionId)) {
      throw new Error(`${this.#label(actionId)} must be prepared before the authoritative Short Rest.`);
    }
    return {
      changed: false,
      actionId,
      preparedBeforeRest: true,
      transactionId: _transactionId ?? null
    };
  }

  static async applyPostRestNative(actor, actionId, transactionId = null) {
    if (actionId !== "sorcerous-restoration") throw new Error(`Unsupported post-rest native decision: ${actionId}`);
    const feature = this.#feature(actor, actionId);
    if (!feature) throw new Error("Sorcerous Restoration is no longer present on this Actor.");
    if (!this.#fontOfMagicMissing(actor)) {
      return { changed: false, actionId, skipped: "resource-full", transactionId };
    }
    if (!this.#itemUseAvailable(feature)) {
      return { changed: false, actionId, skipped: "no-use-remaining", transactionId };
    }
    const result = await this.#invokeActivity(feature, NATIVE_ACTIVITY_NAMES[actionId]);
    return { changed: result !== false && result !== null, actionId, native: true, transactionId };
  }

  static async invokeImmediateNative(actor, actionId) {
    if (actionId !== "magical-cunning") throw new Error(`Unsupported immediate native decision: ${actionId}`);
    const feature = this.#feature(actor, actionId);
    if (!feature) throw new Error("Magical Cunning is no longer present on this Actor.");
    if (!this.#magicalCunningEligible(actor, feature)) throw new Error("Magical Cunning is not currently available to use.");
    return this.#invokeActivity(feature, NATIVE_ACTIVITY_NAMES[actionId]);
  }

  static #recoveryEligible(actor, actionId, feature, session) {
    const tracker = this.#recoveryTracker(feature, actionId);
    if (!tracker || !this.#trackerAvailable(tracker)) return false;
    const reserved = this.#reservedSlots(session, actionId);
    for (let level = 1; level <= 5; level++) {
      const slotKey = `spell${level}`;
      const slot = actor.system?.spells?.[slotKey];
      const max = Math.max(0, Number(slot?.max ?? 0));
      const value = Math.max(0, Number(slot?.value ?? 0));
      if (max - value - Number(reserved[slotKey] ?? 0) > 0) return true;
    }
    return false;
  }

  static #recoveryContext(actor, actionId, session) {
    const feature = this.#feature(actor, actionId);
    const operation = session?.operations?.[actionId]?.payload ?? {};
    const selected = this.#normalizeRecoverySelection(operation?.slots);
    const reserved = this.#reservedSlots(session, actionId);
    const budget = this.#recoveryBudget(actor, actionId, feature);
    const selectedPoints = this.#selectionPoints(selected);
    const levels = [];

    for (let level = 1; level <= 5; level++) {
      const slotKey = `spell${level}`;
      const slot = actor.system?.spells?.[slotKey] ?? {};
      const max = Math.max(0, Number(slot.max ?? 0));
      const value = Math.min(max, Math.max(0, Number(slot.value ?? 0)));
      const reservedOther = Math.max(0, Number(reserved[slotKey] ?? 0));
      const selectedHere = Math.max(0, Number(selected[slotKey] ?? 0));
      const missing = Math.max(0, max - value);
      const selectableMissing = Math.max(0, missing - reservedOther);
      const pips = [];
      for (let index = 0; index < max; index++) {
        let state = "open";
        if (index < value) state = "available";
        else if (index < value + reservedOther) state = "reserved";
        else if (index < value + reservedOther + selectedHere) state = "selected";
        pips.push({
          index,
          state,
          available: state === "available",
          reserved: state === "reserved",
          selected: state === "selected",
          selectable: state === "open" || state === "selected"
        });
      }
      if (max > 0) {
        levels.push({
          level,
          slotKey,
          label: this.#spellLevelLabel(level),
          max,
          value,
          missing,
          reservedOther,
          selectedHere,
          selectableMissing,
          pips
        });
      }
    }

    return {
      budget,
      selectedPoints,
      remainingPoints: Math.max(0, budget - selectedPoints),
      levels,
      trackerLabel: actionId === "natural-recovery" ? "Recover Spell Slots Activity" : "Arcane Recovery use"
    };
  }

  static #reservedSlots(session, excludingActionId = null) {
    const result = {};
    for (const operation of Object.values(session?.operations ?? {})) {
      if (!RECOVERY_ACTIONS.has(operation?.actionId) || operation.actionId === excludingActionId) continue;
      const selection = this.#normalizeRecoverySelection(operation.payload?.slots);
      for (const [slotKey, quantity] of Object.entries(selection)) {
        result[slotKey] = Number(result[slotKey] ?? 0) + Number(quantity ?? 0);
      }
    }
    return result;
  }

  static #normalizeRecoverySelection(selection = null) {
    const result = {};
    for (let level = 1; level <= 5; level++) {
      const slotKey = `spell${level}`;
      result[slotKey] = Math.max(0, Number.parseInt(selection?.[slotKey] ?? 0, 10) || 0);
    }
    return result;
  }

  static #selectionPoints(selection) {
    let total = 0;
    for (let level = 1; level <= 5; level++) total += level * Number(selection?.[`spell${level}`] ?? 0);
    return total;
  }

  static #recoveryBudget(actor, actionId, feature) {
    if (actionId === "arcane-recovery") {
      const activity = this.#activity(feature, "Recover");
      const formula = String(activity?.roll?.formula ?? "").trim();
      const fromSource = this.#evaluateFormula(actor, formula);
      if (Number.isFinite(fromSource) && fromSource > 0) return Math.floor(fromSource);
      return Math.ceil(this.#classLevel(actor, "wizard") / 2);
    }
    return Math.ceil(this.#classLevel(actor, "druid") / 2);
  }

  static #recoveryTracker(feature, actionId) {
    if (!feature) return null;
    if (actionId === "natural-recovery") {
      const activity = this.#activity(feature, "Recover Spell Slots");
      if (!activity) return null;
      return {
        item: feature,
        activity,
        path: `system.activities.${activity.id ?? activity._id}.uses.spent`,
        spent: Number(activity.uses?.spent ?? 0),
        max: this.#evaluateScalar(feature.actor, activity.uses?.max)
      };
    }
    const activity = this.#activity(feature, "Recover");
    const consumesItemUse = this.#activityConsumptionTargets(activity)
      .some(target => target?.type === "itemUses" && !target?.target);
    if (!consumesItemUse && !feature.system?.uses?.max) return null;
    return {
      item: feature,
      activity,
      path: "system.uses.spent",
      spent: Number(feature.system?.uses?.spent ?? 0),
      max: this.#evaluateScalar(feature.actor, feature.system?.uses?.max)
    };
  }

  static #trackerAvailable(tracker) {
    const max = Number(tracker?.max ?? 0);
    const spent = Number(tracker?.spent ?? 0);
    return max > spent;
  }

  static #sorcerousRestorationEligible(actor, feature) {
    return this.#itemUseAvailable(feature) && this.#fontOfMagicMissing(actor);
  }

  static #magicalCunningEligible(actor, feature) {
    if (!this.#itemUseAvailable(feature)) return false;
    const pact = actor.system?.spells?.pact ?? {};
    return Number(pact.max ?? 0) > Number(pact.value ?? 0);
  }

  static #fontOfMagicMissing(actor) {
    const font = this.#feature(actor, "font-of-magic");
    if (!font) return false;
    return Number(font.system?.uses?.spent ?? 0) > 0;
  }

  static #itemUseAvailable(item) {
    if (!item) return false;
    const max = this.#evaluateScalar(item.actor, item.system?.uses?.max);
    return max > Number(item.system?.uses?.spent ?? 0);
  }

  static #evaluateScalar(actor, value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    return this.#evaluateFormula(actor, String(value ?? ""));
  }

  static #evaluateFormula(actor, formula) {
    if (!formula) return 0;
    try {
      const data = actor?.getRollData?.() ?? {};
      const replaced = Roll.replaceFormulaData
        ? Roll.replaceFormulaData(formula, data, { missing: "0", warn: false })
        : formula;
      const safe = Roll.safeEval?.(replaced);
      if (Number.isFinite(Number(safe))) return Number(safe);
    } catch (_error) {
      // Fall through to the conservative class-level fallback where applicable.
    }
    return 0;
  }

  static #classLevel(actor, identifier) {
    const cls = actor?.items?.find?.(item => item.type === "class" && String(item.system?.identifier ?? "") === identifier);
    return Math.max(0, Number(cls?.system?.levels ?? 0));
  }

  static #feature(actor, identifier) {
    return actor?.items?.find?.(item => item.type === "feat" && String(item.system?.identifier ?? "") === identifier) ?? null;
  }

  static #activity(feature, name) {
    const activities = feature?.system?.activities;
    return activities?.getName?.(name)
      ?? [...(activities?.values?.() ?? [])].find(activity => String(activity?.name ?? "") === name)
      ?? Object.values(activities ?? {}).find(activity => String(activity?.name ?? "") === name)
      ?? null;
  }

  static #activityConsumptionTargets(activity) {
    const targets = activity?.consumption?.targets;
    if (Array.isArray(targets)) return targets;
    if (targets?.values) return [...targets.values()];
    return Object.values(targets ?? {});
  }

  static async #invokeActivity(feature, activityName) {
    const activity = this.#activity(feature, activityName);
    if (!activity?.use) throw new Error(`The source-native ${activityName} Activity could not be found on ${feature.name}.`);
    return activity.use({});
  }

  static async #restoreSnapshot(actor, preparation) {
    const actorUpdates = {};
    for (const [slotKey, value] of Object.entries(preparation?.slotSnapshot ?? {})) {
      actorUpdates[`system.spells.${slotKey}.value`] = Number(value ?? 0);
    }
    if (Object.keys(actorUpdates).length) {
      await actor.update(actorUpdates, {
        characterBuilderRuntimeManagement: true,
        characterBuilderRestDecisionRollback: true
      });
    }
    const itemUpdatesById = new Map();
    for (const tracker of preparation?.trackerSnapshot ?? []) {
      const update = itemUpdatesById.get(tracker.itemId) ?? { _id: tracker.itemId };
      update[tracker.path] = Number(tracker.spent ?? 0);
      itemUpdatesById.set(tracker.itemId, update);
    }
    const itemUpdates = [...itemUpdatesById.values()];
    if (itemUpdates.length) {
      await actor.updateEmbeddedDocuments("Item", itemUpdates, {
        characterBuilderRuntimeManagement: true,
        characterBuilderRestDecisionRollback: true
      });
    }
  }

  static async #safetyLock(actor, preparation, error, rollbackError) {
    console.error(`${MODULE_ID} | Rest Decision preparation rollback failed.`, rollbackError);
    try {
      await actor.setFlag(MODULE_ID, "runtimeManagementSafetyLock", {
        token: `rest-decision:${preparation?.sessionId ?? "unknown"}`,
        sessionId: preparation?.sessionId ?? null,
        failedAt: Date.now(),
        error: String(error?.message ?? error),
        rollbackError: String(rollbackError?.message ?? rollbackError),
        phase: "rest-decision-preparation"
      });
    } catch (lockError) {
      console.error(`${MODULE_ID} | Could not write Rest Decision safety lock.`, lockError);
    }
  }

  static #itemSummary(item) {
    if (!item) return null;
    return { id: item.id, uuid: item.uuid, name: item.name, img: item.img };
  }

  static #label(actionId) {
    return actionId === "natural-recovery" ? "Natural Recovery" : "Arcane Recovery";
  }

  static #spellLevelLabel(level) {
    const suffix = level === 1 ? "st" : level === 2 ? "nd" : level === 3 ? "rd" : "th";
    return `${level}${suffix} Level`;
  }
}
