import { MODULE_ID, MODULE_VERSION } from "../constants.mjs";

/**
 * Applies a completed Character Creation Draft as one recoverable protected
 * transaction. A persistent safety snapshot is written before the first live
 * Actor mutation so interrupted connections can be restored on reconnect.
 */
export class ActorCommitService {
  static async commit(actor, draft, { transactionToken, onProgress } = {}) {
    if (!actor || !draft) throw new Error("The Actor or Character Creation Draft is missing.");
    if (!transactionToken) throw new Error("The Character Creation transaction guard rejected a missing token.");
    if (actor.getFlag(MODULE_ID, "commitSafetyLock")) {
      throw new Error("Character Builder changes are locked for this Actor because a previous rollback could not be verified. A GM must restore or inspect the Actor before continuing.");
    }

    const existingTransaction = actor.getFlag(MODULE_ID, "creationTransaction");
    if (existingTransaction?.status === "applying") {
      throw new Error("A protected Character Creation commit is already recorded for this Actor. Reconnect or ask the GM to recover it before trying again.");
    }
    if (existingTransaction?.status === "complete") await this.#finishCompletedRecovery(actor, existingTransaction);

    const progress = async (percent, stage, detail) => {
      if (typeof onProgress === "function") await onProgress({ percent, stage, detail });
    };

    let stage = "Validating Draft";
    let transactionStarted = false;
    const snapshot = this.#actorSnapshot(actor);
    const transactionId = foundry.utils.randomID?.(24) ?? crypto.randomUUID();

    try {
      await progress(4, stage, "Checking the completed Character Creation Draft.");
      if (draft.getFlag(MODULE_ID, "sourceActorId") !== actor.id) {
        throw new Error("This Character Creation Draft does not belong to the selected Actor.");
      }
      if (!draft.items.some(item => item.type === "class")) {
        throw new Error("The Character Creation Draft has no Class Item.");
      }

      stage = "Preparing Changes";
      await progress(12, stage, "Creating the persistent safety snapshot and protected transaction record.");
      const transaction = {
        transactionId,
        idempotencyToken: transactionToken,
        type: "character-creation",
        status: "applying",
        actorId: actor.id,
        draftId: draft.id,
        startedAt: Date.now(),
        lastProgressAt: Date.now(),
        startedBy: game.user.id,
        completedStages: ["Validating Draft"],
        snapshot
      };
      await actor.setFlag(MODULE_ID, "creationTransaction", transaction);
      transactionStarted = true;

      const draftData = this.#documentSource(draft);
      const characterName = String(draft.getFlag(MODULE_ID, "buildState")?.characterName ?? actor.name ?? "").trim()
        || actor.name;
      const prototypeToken = this.#plainClone(draftData.prototypeToken ?? {});
      prototypeToken.name = characterName;
      const itemData = draft.items.map(item => {
        const source = this.#documentSource(item);
        source.flags ??= {};
        source.flags[MODULE_ID] = {
          ...(source.flags[MODULE_ID] ?? {}),
          creationTransactionId: transactionId,
          creationIdempotencyToken: transactionToken
        };
        return source;
      });
      const baseUpdate = this.#flattenForUpdate({
        system: draftData.system,
        prototypeToken,
        img: draftData.img,
        name: characterName
      });
      await this.#recordStage(actor, "Preparing Changes");

      stage = "Applying Origins and Species";
      await progress(24, stage, "Transferring the completed Actor source data.");
      await actor.update(baseUpdate, {
        characterBuilder: true,
        characterBuilderTransactionId: transactionId,
        characterBuilderIdempotencyToken: transactionToken
      });
      await this.#recordStage(actor, stage);

      stage = "Applying Background and Ability Scores";
      await progress(36, stage, "Verifying Background, ability scores, and origin data on the live Actor.");
      for (const ability of ["str", "dex", "con", "int", "wis", "cha"]) {
        const expected = Number(draft.system?.abilities?.[ability]?.value);
        const actual = Number(actor.system?.abilities?.[ability]?.value);
        if (Number.isFinite(expected) && actual !== expected) {
          throw new Error(`${ability.toUpperCase()} did not transfer correctly (${expected} expected, ${actual} found).`);
        }
      }
      await this.#recordStage(actor, stage);

      stage = "Applying Class and Features";
      await progress(49, stage, "Removing the Actor's previous embedded Items before applying the completed build.");
      await this.#deleteAllItemsSafely(actor, {
        characterBuilder: true,
        characterBuilderTransactionId: transactionId
      });
      await this.#recordStage(actor, stage);

      stage = "Creating Spells and Equipment";
      await progress(66, stage, "Creating features, feats, spells, equipment, and their exact ownership metadata.");
      if (itemData.length) {
        await actor.createEmbeddedDocuments("Item", itemData, {
          keepId: true,
          characterBuilder: true,
          characterBuilderTransactionId: transactionId,
          characterBuilderIdempotencyToken: transactionToken
        });
      }
      const missing = itemData.filter(item => !actor.items.get(item._id));
      if (missing.length) throw new Error(`${missing.length} embedded Item document(s) were not created on the final Actor.`);
      await this.#recordStage(actor, stage);

      stage = "Updating Actor Data";
      await progress(82, stage, "Synchronizing derived Hit Points and validating the completed Actor.");
      const hp = actor.system.attributes?.hp;
      const derivedMaximum = Number(hp?.effectiveMax ?? hp?.max);
      if (Number.isFinite(derivedMaximum) && derivedMaximum >= 0) {
        await actor.update({ "system.attributes.hp.value": derivedMaximum }, {
          characterBuilder: true,
          characterBuilderTransactionId: transactionId
        });
      }
      if (!actor.items.some(item => item.type === "class")) throw new Error("The final Actor has no Class Item after creation.");
      await this.#recordStage(actor, stage);

      stage = "Saving Character Creation History";
      await progress(92, stage, "Marking Character Creation complete and sealing the transaction history.");
      await actor.update({
        [`flags.${MODULE_ID}.completed`]: {
          completedAt: Date.now(),
          version: MODULE_VERSION,
          transactionId
        },
        [`flags.${MODULE_ID}.creationHistory`]: {
          transactionId,
          idempotencyToken: transactionToken,
          completedAt: Date.now(),
          completedBy: game.user.id,
          draftItemCount: itemData.length
        },
        [`flags.${MODULE_ID}.creationTransaction.status`]: "complete",
        [`flags.${MODULE_ID}.creationTransaction.completedAt`]: Date.now(),
        [`flags.${MODULE_ID}.draftActorId`]: null
      }, { characterBuilder: true, characterBuilderTransactionId: transactionId });
      await this.#recordStage(actor, stage);

      stage = "Finalizing";
      await progress(97, stage, "Clearing the temporary Draft and persistent safety record.");
      if (game.actors.get(draft.id)) await draft.delete();
      await actor.unsetFlag(MODULE_ID, "draftActorId");
      await actor.unsetFlag(MODULE_ID, "creationTransaction");
      await progress(100, "Complete", "The character was created successfully.");
      return { actor, transactionId };
    } catch (error) {
      console.error(`${MODULE_ID} | Character Creation commit failed during ${stage}.`, error);
      if (!transactionStarted) {
        const blocked = new Error(`Character Creation was blocked during ${stage}. The live Actor was not changed. Correct the Draft and try again.`);
        blocked.cause = error;
        throw blocked;
      }

      try {
        await progress(96, "Restoring Actor", `The transaction failed during ${stage}. Restoring the original Actor.`);
        await this.#restore(actor, snapshot);
        await this.#verifyRestore(actor, snapshot);
        await actor.unsetFlag(MODULE_ID, "creationTransaction");
        await actor.unsetFlag(MODULE_ID, "commitSafetyLock");
        await progress(100, "Actor Restored", "The original Actor was restored and the Character Creation Draft was preserved.");
        const restored = new Error(`Character Creation failed during ${stage}. The original Actor was restored successfully and the Draft was preserved.`);
        restored.cause = error;
        restored.actorRestored = true;
        throw restored;
      } catch (rollbackError) {
        if (rollbackError?.actorRestored) throw rollbackError;
        console.error(`${MODULE_ID} | Character Creation rollback or verification failed.`, rollbackError);
        try {
          await actor.setFlag(MODULE_ID, "commitSafetyLock", {
            type: "character-creation",
            transactionId,
            lockedAt: Date.now(),
            reason: rollbackError.message
          });
          const current = actor.getFlag(MODULE_ID, "creationTransaction") ?? {};
          await actor.setFlag(MODULE_ID, "creationTransaction", { ...current, status: "rollback-failed", rollbackError: rollbackError.message });
        } catch (lockError) {
          console.error(`${MODULE_ID} | Could not persist the Character Creation safety lock.`, lockError);
        }
        const critical = new Error("Critical Character Creation rollback failure. Character Builder changes are locked for this Actor. A GM must restore the preserved safety backup before continuing.");
        critical.cause = error;
        critical.rollbackCause = rollbackError;
        critical.criticalRollback = true;
        throw critical;
      }
    }
  }

  static async recoverInterrupted(actor, { notify = true, force = false } = {}) {
    const transaction = actor?.getFlag?.(MODULE_ID, "creationTransaction");
    if (!transaction) return { recovered: false };
    if (!game.user.isGM && !actor.isOwner) return { recovered: false };

    if (transaction.status === "complete") {
      await this.#finishCompletedRecovery(actor, transaction);
      if (notify) ui.notifications.info(`Finished cleaning the completed Character Creation transaction for ${actor.name}.`);
      return { recovered: true, completed: true };
    }
    if (transaction.status !== "applying") return { recovered: false, locked: transaction.status === "rollback-failed" };
    const staleAfterMs = 120000;
    const lastActivity = Number(transaction.lastProgressAt ?? transaction.startedAt ?? 0);
    const age = Date.now() - lastActivity;
    if (!force && Number.isFinite(lastActivity) && age < staleAfterMs) {
      return { recovered: false, deferred: true, retryAfter: Math.max(1000, staleAfterMs - age + 500) };
    }
    if (!transaction.snapshot) throw new Error(`The interrupted Character Creation transaction for ${actor.name} has no safety snapshot.`);

    try {
      await this.#restore(actor, transaction.snapshot);
      await this.#verifyRestore(actor, transaction.snapshot);
      await actor.unsetFlag(MODULE_ID, "creationTransaction");
      await actor.unsetFlag(MODULE_ID, "commitSafetyLock");
      if (notify) ui.notifications.warn(`Interrupted Character Creation for ${actor.name} was restored safely. The Draft was preserved.`, { permanent: true });
      return { recovered: true, restored: true };
    } catch (error) {
      console.error(`${MODULE_ID} | Interrupted Character Creation recovery failed for ${actor.name}.`, error);
      await actor.setFlag(MODULE_ID, "commitSafetyLock", {
        type: "character-creation",
        transactionId: transaction.transactionId,
        lockedAt: Date.now(),
        reason: error.message
      });
      throw error;
    }
  }

  static async recoverOwnedInterruptedTransactions() {
    const results = [];
    for (const actor of game.actors.filter(candidate => candidate.type === "character" && candidate.getFlag(MODULE_ID, "creationTransaction"))) {
      if (!game.user.isGM && !actor.isOwner) continue;
      try {
        const result = await this.recoverInterrupted(actor);
        results.push(result);
        if (result?.deferred) this.#scheduleRecovery(actor.id, result.retryAfter);
      } catch (error) {
        ui.notifications.error(`Character Creation recovery failed for ${actor.name}: ${error.message}`, { permanent: true });
      }
    }
    return results;
  }

  static #scheduleRecovery(actorId, delay) {
    setTimeout(async () => {
      const actor = game.actors.get(actorId);
      if (!actor?.getFlag(MODULE_ID, "creationTransaction")) return;
      try {
        const result = await this.recoverInterrupted(actor);
        if (result?.deferred) this.#scheduleRecovery(actorId, result.retryAfter);
      } catch (error) {
        ui.notifications.error(`Character Creation recovery failed for ${actor.name}: ${error.message}`, { permanent: true });
      }
    }, Math.max(1000, Number(delay) || 1000));
  }

  static #actorSnapshot(actor) {
    const source = this.#documentSource(actor);
    source.items = actor.items.map(item => this.#documentSource(item));
    return source;
  }

  static #documentSource(document) {
    const source = document?._source ?? document?.toObject?.() ?? {};
    return this.#plainClone(source);
  }

  static #plainClone(value, path = []) {
    if (Array.isArray(value)) return value.map((entry, index) => this.#plainClone(entry, [...path, index]));
    if (value instanceof Set) return Array.from(value, entry => this.#plainClone(entry, path));
    if (value instanceof Map) return Object.fromEntries(Array.from(value.entries(), ([key, entry]) => [key, this.#plainClone(entry, [...path, key])]));
    if (!value || typeof value !== "object") return value;

    const clone = {};
    const currentField = String(path.at(-1) ?? "");
    const isSensesField = currentField === "senses";
    const legacySenseKeys = new Set(["darkvision", "blindsight", "tremorsense", "truesight"]);
    for (const key of Object.keys(value)) {
      if (isSensesField && legacySenseKeys.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && !("value" in descriptor)) continue;
      const entry = descriptor ? descriptor.value : value[key];
      clone[key] = this.#plainClone(entry, [...path, key]);
    }
    return clone;
  }

  static #flattenForUpdate(value, prefix = "", output = {}) {
    if (Array.isArray(value) || value === null || typeof value !== "object") {
      if (prefix) output[prefix] = this.#plainClone(value);
      return output;
    }
    const keys = Object.keys(value);
    if (!keys.length) {
      if (prefix) output[prefix] = {};
      return output;
    }
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      this.#flattenForUpdate(value[key], path, output);
    }
    return output;
  }

  static async #recordStage(actor, stage) {
    const transaction = actor.getFlag(MODULE_ID, "creationTransaction");
    if (!transaction || transaction.status !== "applying") return;
    const completedStages = [...new Set([...(transaction.completedStages ?? []), stage])];
    await actor.update({
      [`flags.${MODULE_ID}.creationTransaction.completedStages`]: completedStages,
      [`flags.${MODULE_ID}.creationTransaction.lastProgressAt`]: Date.now()
    }, { characterBuilderTransactionProgress: true });
  }

  static async #finishCompletedRecovery(actor, transaction) {
    const draft = transaction?.draftId ? game.actors.get(transaction.draftId) : null;
    if (draft?.getFlag(MODULE_ID, "isDraft")) await draft.delete();
    await actor.unsetFlag(MODULE_ID, "draftActorId");
    await actor.unsetFlag(MODULE_ID, "creationTransaction");
  }

  static async #restore(actor, snapshot) {
    const restoreItems = this.#plainClone(snapshot.items ?? []);
    const update = this.#flattenForUpdate({
      system: snapshot.system,
      prototypeToken: snapshot.prototypeToken,
      img: snapshot.img,
      name: snapshot.name
    });
    await actor.update(update, { characterBuilderRollback: true });

    await this.#deleteAllItemsSafely(actor, { characterBuilderRollback: true });
    if (restoreItems.length) {
      await actor.createEmbeddedDocuments("Item", restoreItems, {
        keepId: true,
        characterBuilderRollback: true
      });
    }

    const snapshotFlags = this.#plainClone(snapshot.flags?.[MODULE_ID] ?? {});
    await actor.update({ [`flags.-=${MODULE_ID}`]: null }, { characterBuilderRollback: true });
    if (Object.keys(snapshotFlags).length) {
      await actor.update({ [`flags.${MODULE_ID}`]: snapshotFlags }, { characterBuilderRollback: true });
    }
  }

  static async #deleteAllItemsSafely(actor, options = {}) {
    // D&D5e Cast activities can own cached spell Items and schedule their own
    // asynchronous cleanup. Delete cached children first, then every remaining
    // root with deleteContents disabled so no embedded ID is submitted twice.
    const cachedIds = actor.items.filter(item => String(item.getFlag("dnd5e", "cachedFor") ?? ""))
      .map(item => item.id)
      .filter(id => actor.items.has(id));
    if (cachedIds.length) {
      await actor.deleteEmbeddedDocuments("Item", cachedIds, { ...options, deleteContents: false });
    }
    const remainingIds = actor.items.map(item => item.id).filter(id => actor.items.has(id));
    if (remainingIds.length) {
      await actor.deleteEmbeddedDocuments("Item", remainingIds, { ...options, deleteContents: false });
    }
  }

  static async #verifyRestore(actor, snapshot) {
    if (actor.name !== snapshot.name) throw new Error("The Actor name did not restore correctly.");
    const expectedIds = [...(snapshot.items ?? [])].map(item => item._id).sort();
    const actualIds = actor.items.map(item => item.id).sort();
    if (expectedIds.length !== actualIds.length || expectedIds.some((id, index) => id !== actualIds[index])) {
      throw new Error("The Actor's embedded Items did not restore exactly.");
    }
    const expectedClassIds = (snapshot.items ?? []).filter(item => item.type === "class").map(item => item._id).sort();
    const actualClassIds = actor.items.filter(item => item.type === "class").map(item => item.id).sort();
    if (expectedClassIds.join("|") !== actualClassIds.join("|")) throw new Error("The Actor's Class Items did not restore exactly.");
  }
}
