import { MODULE_ID } from "../constants.mjs";

/**
 * Stores the optional Character Keeper choices for one pending Short or Long
 * Rest. The live Actor is not mechanically changed until the native rest has
 * completed. This also locks public rest rolls against close/reopen rerolls.
 */
export class RestSessionService {
  static FLAG = "restManagementSession";

  static get(actor) {
    return foundry.utils.deepClone(actor?.getFlag(MODULE_ID, this.FLAG) ?? null);
  }

  static async getOrCreate(actor, restType) {
    const type = restType === "short" ? "short" : "long";
    const current = this.get(actor);
    if (current?.id && current.restType === type && current.status !== "complete") return current;
    if (current?.id && current.restType !== type && current.status !== "complete") {
      throw new Error(`Finish or cancel the pending ${current.restType === "short" ? "Short" : "Long"} Rest management session first.`);
    }
    const session = {
      id: foundry.utils.randomID(),
      restType: type,
      createdAt: Date.now(),
      createdBy: game.user.id,
      status: "pending",
      nativeRestCompleted: false,
      activeActionId: null,
      operations: {},
      completedActionIds: [],
      rollLocks: {}
    };
    await actor.setFlag(MODULE_ID, this.FLAG, session);
    return session;
  }

  static async update(actor, changes = {}) {
    const current = this.get(actor);
    if (!current?.id) throw new Error("No Character Keeper rest session is active.");
    const next = foundry.utils.mergeObject(current, foundry.utils.deepClone(changes), {
      inplace: false,
      insertKeys: true,
      insertValues: true,
      overwrite: true,
      recursive: true
    });
    await actor.setFlag(MODULE_ID, this.FLAG, next);
    return next;
  }

  static async selectAction(actor, actionId) {
    return this.update(actor, { activeActionId: actionId ?? null });
  }

  static async setOperation(actor, actionId, payload) {
    const current = this.get(actor);
    if (!current?.id) throw new Error("No Character Keeper rest session is active.");
    const operations = foundry.utils.deepClone(current.operations ?? {});
    operations[actionId] = {
      actionId,
      payload: foundry.utils.deepClone(payload ?? {}),
      confirmedAt: Date.now(),
      confirmedBy: game.user.id,
      token: operations[actionId]?.token ?? foundry.utils.randomID()
    };
    const completedActionIds = [...new Set([...(current.completedActionIds ?? []), actionId])];
    return this.update(actor, { operations, completedActionIds, activeActionId: actionId });
  }

  static async setRollLock(actor, actionId, data) {
    const current = this.get(actor);
    if (!current?.id) throw new Error("No Character Keeper rest session is active.");
    const rollLocks = foundry.utils.deepClone(current.rollLocks ?? {});
    rollLocks[actionId] = foundry.utils.deepClone(data);
    return this.update(actor, { rollLocks });
  }

  static async markNativeRestCompleted(actor, result = null) {
    return this.update(actor, {
      nativeRestCompleted: true,
      nativeRestCompletedAt: Date.now(),
      nativeRestResult: result ? this.#serializableRestResult(result) : null,
      status: "applying"
    });
  }

  static async discardChanges(actor, { preserveRollLocks = true } = {}) {
    const current = this.get(actor);
    if (!current?.id) throw new Error("No Character Keeper rest session is active.");
    if (current.nativeRestCompleted) {
      throw new Error("The native rest already completed. Use recovery to discard only the pending Character Keeper changes.");
    }

    // Do not use update()/mergeObject or setFlag directly over the existing
    // session. Foundry recursively merges object-valued flags, so writing an
    // empty operations object does not delete the confirmed operation keys.
    // Remove the complete session flag first, then write the clean session as
    // a new value so the reset is a true replacement rather than a merge.
    const next = foundry.utils.deepClone(current);
    next.operations = {};
    next.completedActionIds = [];
    next.rollLocks = preserveRollLocks
      ? foundry.utils.deepClone(current.rollLocks ?? {})
      : {};
    next.status = "pending";

    await actor.unsetFlag(MODULE_ID, this.FLAG);
    if (actor.getFlag(MODULE_ID, this.FLAG) != null) {
      throw new Error("Character Keeper could not clear the saved rest session before rebuilding it.");
    }
    await actor.setFlag(MODULE_ID, this.FLAG, next);
    const saved = this.get(actor);
    const operationsRemain = Object.keys(saved?.operations ?? {}).length > 0;
    const completedRemain = (saved?.completedActionIds ?? []).length > 0;
    if (operationsRemain || completedRemain) {
      throw new Error("Character Keeper could not fully discard the pending rest changes.");
    }
    return saved;
  }

  static async clear(actor) {
    if (!actor?.getFlag(MODULE_ID, this.FLAG)) return;
    await actor.unsetFlag(MODULE_ID, this.FLAG);
  }

  static async cancel(actor) {
    const session = this.get(actor);
    if (!session?.id) return;
    if (session.nativeRestCompleted) throw new Error("This rest has already completed and its pending Character Keeper changes must be applied or recovered.");
    await this.clear(actor);
  }

  static async recover(actor) {
    const session = this.get(actor);
    if (!session?.id) return;
    if (!session.nativeRestCompleted) throw new Error("This Character Keeper session can still be cancelled normally.");
    if (actor.getFlag(MODULE_ID, "runtimeManagementSafetyLock")) {
      throw new Error("This Actor is safety-locked after a failed Character Keeper rollback. A GM must inspect it before the session can be cleared.");
    }
    await this.clear(actor);
  }

  static #serializableRestResult(result) {
    try {
      return foundry.utils.deepClone(result);
    } catch (_error) {
      return { completed: true };
    }
  }
}
