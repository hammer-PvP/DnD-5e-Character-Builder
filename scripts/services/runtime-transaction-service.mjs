import { MODULE_ID, MODULE_VERSION } from "../constants.mjs";

/**
 * Atomic transaction wrapper for Character Keeper mutations. The snapshot is
 * captured after the native rest, so a failed Keeper action never reverses the
 * rest itself. Only Character Keeper's post-rest mutations are rolled back.
 */
export class RuntimeTransactionService {
  static LOCK_FLAG = "runtimeManagementCommitLock";

  static async run(actor, { session, label = "Character Keeper" } = {}, callback) {
    if (!actor || actor.type !== "character") throw new Error("Character Keeper requires a Player Character Actor.");
    if (actor.getFlag(MODULE_ID, this.LOCK_FLAG)) throw new Error("Character Keeper is already applying changes to this Actor.");
    const token = foundry.utils.randomID();
    await actor.setFlag(MODULE_ID, this.LOCK_FLAG, {
      token,
      sessionId: session?.id ?? null,
      startedAt: Date.now(),
      startedBy: game.user.id,
      label
    });
    const snapshot = this.#snapshot(actor);
    try {
      const result = await callback(token);
      const history = foundry.utils.deepClone(actor.getFlag(MODULE_ID, "runtimeManagementHistory") ?? []);
      history.push({
        transactionId: token,
        sessionId: session?.id ?? null,
        restType: session?.restType ?? null,
        label,
        committedAt: Date.now(),
        committedBy: game.user.id,
        moduleVersion: MODULE_VERSION,
        operations: Object.values(session?.operations ?? {}).map(operation => ({
          actionId: operation.actionId,
          token: operation.token,
          confirmedAt: operation.confirmedAt
        }))
      });
      if (history.length > 100) history.splice(0, history.length - 100);
      await actor.setFlag(MODULE_ID, "runtimeManagementHistory", history);
      return result;
    } catch (error) {
      try {
        await this.#restore(actor, snapshot);
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Character Keeper rollback failed.`, rollbackError);
        await actor.setFlag(MODULE_ID, "runtimeManagementSafetyLock", {
          token,
          sessionId: session?.id ?? null,
          failedAt: Date.now(),
          error: String(error?.message ?? error),
          rollbackError: String(rollbackError?.message ?? rollbackError)
        });
        throw new Error(`Character Keeper failed and could not verify a complete rollback. The Actor has been safety-locked for GM inspection. Original error: ${error.message}`);
      }
      throw error;
    } finally {
      const lock = actor.getFlag(MODULE_ID, this.LOCK_FLAG);
      if (lock?.token === token) await actor.unsetFlag(MODULE_ID, this.LOCK_FLAG);
    }
  }

  static #snapshot(actor) {
    const source = actor.toObject();
    return {
      system: foundry.utils.deepClone(source.system ?? {}),
      moduleFlags: foundry.utils.deepClone(source.flags?.[MODULE_ID] ?? {}),
      items: foundry.utils.deepClone(source.items ?? []),
      effects: foundry.utils.deepClone(source.effects ?? [])
    };
  }

  static async #restore(actor, snapshot) {
    const currentItemIds = actor.items.map(item => item.id);
    if (currentItemIds.length) {
      await actor.deleteEmbeddedDocuments("Item", currentItemIds, {
        characterBuilderRuntimeManagement: true,
        characterBuilderRuntimeRollback: true,
        deleteContents: false
      });
    }
    if (snapshot.items.length) {
      await actor.createEmbeddedDocuments("Item", snapshot.items, {
        keepId: true,
        characterBuilderRuntimeManagement: true,
        characterBuilderRuntimeRollback: true
      });
    }

    const currentEffectIds = actor.effects?.map(effect => effect.id) ?? [];
    if (currentEffectIds.length) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", currentEffectIds, {
        characterBuilderRuntimeManagement: true,
        characterBuilderRuntimeRollback: true
      });
    }
    if (snapshot.effects.length) {
      await actor.createEmbeddedDocuments("ActiveEffect", snapshot.effects, {
        keepId: true,
        characterBuilderRuntimeManagement: true,
        characterBuilderRuntimeRollback: true
      });
    }

    const currentFlags = foundry.utils.deepClone(actor.flags?.[MODULE_ID] ?? {});
    const update = { system: foundry.utils.deepClone(snapshot.system) };
    for (const key of Object.keys(currentFlags)) {
      if (!(key in snapshot.moduleFlags)) update[`flags.${MODULE_ID}.-=${key}`] = null;
    }
    update[`flags.${MODULE_ID}`] = foundry.utils.deepClone(snapshot.moduleFlags);
    await actor.update(update, {
      characterBuilderRuntimeManagement: true,
      characterBuilderRuntimeRollback: true
    });
  }
}
