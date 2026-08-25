import { MODULE_ID, MODULE_VERSION } from "../constants.mjs";
import { AgonizingBlastBindingService } from "./agonizing-blast-binding-service.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";
import { LevelUpService } from "./level-up-service.mjs";
import { HitPointAdvancementService } from "./hit-point-advancement-service.mjs";
import { ItemGrantIntegrityService } from "./item-grant-integrity-service.mjs";
import { AdvancementChoiceAnnotationService } from "./advancement-choice-annotation-service.mjs";
import { ItemChoiceReplacementIntegrityService } from "./item-choice-replacement-integrity-service.mjs";
import { TemporaryActorService } from "./temporary-actor-service.mjs";
import { AlwaysPreparedSpellReconciliationService } from "./always-prepared-spell-reconciliation-service.mjs";
import { NativeFeatureCompatibilityService } from "./native-feature-compatibility-service.mjs";
import { AdvancementCompletionGateService } from "./advancement-completion-gate-service.mjs";
import { InternalActorReferenceRebindingService } from "./internal-actor-reference-rebinding-service.mjs";

/**
 * Applies a completed Level Up draft as one recoverable transaction. The live
 * Actor remains untouched while native and module-managed choices are made.
 */
export class LevelUpCommitService {
  static #activeTransactions = new Map();

  static activeTransaction(actor) {
    return this.#activeTransactions.get(actor?.id) ?? null;
  }

  static async commit(actor, draft, { onProgress = null, transactionToken = null, registry = null } = {}) {
    const token = transactionToken ?? foundry.utils.randomID(24);
    if (actor.getFlag(MODULE_ID, "commitSafetyLock")) {
      throw new Error("Character Builder changes are locked for this Actor because a previous rollback could not be verified. A GM must restore or inspect the Actor before another Level Up.");
    }
    if (this.#activeTransactions.has(actor.id)) {
      throw new Error("A Level Up commit is already running for this Actor.");
    }
    // Register the guard synchronously, before the first await, so a delayed
    // double-click cannot start a second transaction.
    this.#activeTransactions.set(actor.id, token);

    let stage = "Validating Draft";
    let snapshot = null;
    let snapshotFingerprint = null;
    let safetyBackup = null;
    let actorMutationStarted = false;
    const progress = (percent, label, detail = "") => this.#emitProgress(onProgress, {
      token, percent, stage: label, detail
    });

    try {
      await progress(4, "Validating Draft", "Checking the completed Level Up draft.");
      this.#assertToken(actor, token);
      const state = LevelUpDraftManager.getState(draft);
      await ItemChoiceReplacementIntegrityService.reconcile(draft);
      if (!state.nativeComplete || !state.additionalComplete || !state.commitReady) {
        throw new Error("Complete every Level Up step before committing the transaction.");
      }
      if (draft.getFlag(MODULE_ID, "sourceActorId") !== actor.id) {
        throw new Error("This Level Up draft does not belong to the selected Actor.");
      }
      const currentLevel = LevelUpService.actorLevel(actor);
      const originalClassId = actor?.system?.details?.originalClass?.id
        ?? actor?.system?.details?.originalClass
        ?? null;
      if (currentLevel !== Number(state.sourceCharacterLevel)) {
        throw new Error(`The live Actor is now level ${currentLevel}, but this Level Up began at level ${state.sourceCharacterLevel}. Ask the GM to reset the pending Level Up.`);
      }
      HitPointAdvancementService.validateLockedResult(actor, state);

      await this.#validateClassIntegrity(actor, draft, state);
      this.#validateSubclassCasterSpellLevels(draft, state);
      await AdvancementChoiceAnnotationService.refresh(draft, { state: LevelUpDraftManager.getState(draft) });
      ItemGrantIntegrityService.validate(draft, { context: "levelUp", state });
      AlwaysPreparedSpellReconciliationService.validate(draft, { context: "levelUp", state });
      await AdvancementCompletionGateService.assertComplete(draft, {
        registry,
        baselineActor: actor,
        context: "Level Up"
      });

      stage = "Preparing Changes";
      await progress(14, stage, "Creating the Actor safety snapshot and preparing document changes.");
      this.#assertToken(actor, token);
      snapshot = this.#actorSnapshot(actor);
      snapshotFingerprint = this.#fingerprint(snapshot);
      safetyBackup = await this.#createSafetyBackup(actor, draft, snapshot, token);
      const draftData = this.#documentSource(draft);
      const itemData = draft.items.map(item => this.#documentSource(item));
      const sourceItemIds = new Set(actor.items.map(item => item.id));
      const createdItems = itemData.filter(item => !sourceItemIds.has(item._id));
      const deletedItems = actor.items.filter(item => !draft.items.get(item.id));
      const baseUpdate = this.#flattenForUpdate({
        system: draftData.system,
        prototypeToken: draftData.prototypeToken,
        img: draftData.img,
        name: actor.name
      });

      stage = "Applying Class and Subclass Progression";
      await progress(28, stage, "Applying the validated class, subclass, and Actor source data.");
      this.#assertToken(actor, token);
      actorMutationStarted = true;
      await actor.update(baseUpdate, {
        render: false,
        characterBuilderLevelUp: true,
        characterBuilderTransactionToken: token
      });

      stage = "Creating Features and Spells";
      await progress(44, stage, "Replacing embedded Items with the completed draft documents.");
      this.#assertToken(actor, token);
      const existingIds = actor.items.map(item => item.id);
      if (existingIds.length) {
        await actor.deleteEmbeddedDocuments("Item", existingIds, {
          render: false,
          deleteContents: true,
          characterBuilderLevelUp: true,
          characterBuilderTransactionToken: token
        });
      }
      if (itemData.length) {
        await actor.createEmbeddedDocuments("Item", itemData, {
          render: false,
          keepId: true,
          characterBuilderLevelUp: true,
          characterBuilderTransactionToken: token
        });
        await InternalActorReferenceRebindingService.rebindActor(actor, {
          reason: "level-up-materialization",
          render: false
        });
        await AgonizingBlastBindingService.reconcileActor(actor, { reason: "level-up-commit", render: false });
        await NativeFeatureCompatibilityService.reconcileActor(actor, { reason: "level-up-commit", render: false });
        const missing = itemData.filter(item => !actor.items.get(item._id));
        if (missing.length) throw new Error(`${missing.length} Level Up Item document(s) were not created on the live Actor.`);
      }

      stage = "Updating Actor Data";
      await progress(63, stage, "Restoring class identity and synchronizing current Hit Points.");
      this.#assertToken(actor, token);
      // D&D5e automatically reassigns originalClass while the original Class
      // Item is temporarily absent. Restore the exact authoritative ID.
      if (originalClassId && actor.items.get(originalClassId)
        && actor.system?.details?.originalClass !== originalClassId) {
        await actor.update({ "system.details.originalClass": originalClassId }, {
          render: false,
          characterBuilderLevelUp: true,
          characterBuilderTransactionToken: token
        });
      }

      const hp = actor.system?.attributes?.hp ?? {};
      const newMaximum = Number(hp.effectiveMax ?? hp.max ?? state.sourceHpMaximum ?? 0);
      const oldMaximum = Number(state.sourceHpMaximum ?? 0);
      const oldValue = Number(state.sourceHpValue ?? 0);
      const maximumIncrease = Number.isFinite(newMaximum) && Number.isFinite(oldMaximum)
        ? Math.max(0, newMaximum - oldMaximum)
        : Number(state.hpResult?.applied ?? 0);
      const newValue = Number.isFinite(newMaximum)
        ? Math.max(0, Math.min(newMaximum, oldValue + maximumIncrease))
        : Math.max(0, oldValue + maximumIncrease);
      await actor.update({ "system.attributes.hp.value": newValue }, {
        render: false,
        characterBuilderLevelUp: true,
        characterBuilderTransactionToken: token
      });

      stage = "Saving Level-Up History";
      await progress(80, stage, "Recording one complete transaction and its exact ownership changes.");
      this.#assertToken(actor, token);
      const previousHistory = actor.getFlag(MODULE_ID, "levelUpHistory") ?? [];
      const history = [...previousHistory, {
        transactionId: state.transactionId,
        committedAt: Date.now(),
        committedBy: game.user.id,
        moduleVersion: MODULE_VERSION,
        rulesCompatibility: "D&D 2024 / SRD 5.2 Modern",
        sourceCharacterLevel: state.sourceCharacterLevel,
        targetCharacterLevel: state.targetCharacterLevel,
        classItemId: state.selectedClassId,
        classIdentifier: state.selectedClassIdentifier,
        className: state.selectedClassName,
        sourceClassLevel: state.sourceClassLevel,
        targetClassLevel: state.targetClassLevel,
        multiclass: Boolean(state.multiclass),
        hitPoints: this.#plainClone(state.hpResult),
        hitPointSummary: HitPointAdvancementService.summary(state.hpResult),
        // Rebuild the current transaction payload from the current draft only.
        // Never carry a previous transaction's feature choices into lastLevelUp.
        additionalChoices: this.#plainClone(state.additionalChoices ?? {}),
        createdItems: createdItems.map(item => ({
          id: item._id,
          name: item.name,
          type: item.type,
          identifier: item.system?.identifier ?? null,
          sourceUuid: item.flags?.dnd5e?.sourceId ?? item._stats?.compendiumSource ?? null
        })),
        deletedItems: deletedItems.map(item => ({
          id: item.id,
          name: item.name,
          type: item.type,
          identifier: item.system?.identifier ?? null
        }))
      }].slice(-50);
      const exactLastLevelUp = foundry.utils.deepClone(history.at(-1));
      // Foundry flag updates merge nested objects. Remove the previous
      // summary in the same suppressed update that writes canonical history,
      // then recreate lastLevelUp exactly from the current transaction.
      await actor.update({
        [`flags.${MODULE_ID}.levelUpHistory`]: history,
        [`flags.${MODULE_ID}.-=lastLevelUp`]: null
      }, {
        render: false,
        characterBuilderLevelUp: true,
        characterBuilderTransactionToken: token
      });
      await actor.update({ [`flags.${MODULE_ID}.lastLevelUp`]: exactLastLevelUp }, {
        render: false,
        characterBuilderLevelUp: true,
        characterBuilderTransactionToken: token
      });

      stage = "Finalizing";
      await progress(94, stage, "Clearing the pending draft and finalizing the Level Up.");
      this.#assertToken(actor, token);
      await HitPointAdvancementService.clearLockedRoll(actor, { reason: "committed", archive: false, render: false });
      const finalFlagCleanup = { [`flags.${MODULE_ID}.-=levelUpDraftId`]: null };
      if (LevelUpService.settings().levelUpMode === "milestone") {
        finalFlagCleanup[`flags.${MODULE_ID}.-=levelUpGrant`] = null;
      }
      await actor.update(finalFlagCleanup, {
        render: false,
        characterBuilderLevelUp: true,
        characterBuilderTransactionToken: token
      });
      try {
        await TemporaryActorService.deleteLevelUpDraft(draft, {
          sourceActorId: actor.id,
          transactionId: state.transactionId ?? null
        });
      } catch (cleanupError) {
        console.warn(`${MODULE_ID} | Level Up committed, but the temporary draft could not be deleted.`, cleanupError);
      }
      await this.#deleteSafetyBackup(safetyBackup);
      safetyBackup = null;
      await progress(100, "Complete", "The Level Up was applied successfully.");
      return { actor, history: history.at(-1), newMaximum, newValue, transactionToken: token };
    } catch (error) {
      console.error(`${MODULE_ID} | Level Up commit failed during ${stage}.`, error);
      if (!actorMutationStarted || !snapshot) {
        await this.#deleteSafetyBackup(safetyBackup);
        safetyBackup = null;
        if (error?.code === "DND5E_CHARACTER_BUILDER_ADVANCEMENT_INCOMPLETE") {
          error.actorRestored = true;
          error.commitStage = stage;
          throw error;
        }
        const blocked = new Error(`Level Up was blocked during ${stage}. The live Actor was not changed. Correct the problem and redo the Level Up.`);
        blocked.cause = error;
        blocked.actorRestored = true;
        blocked.commitStage = stage;
        throw blocked;
      }

      await progress(96, "Rolling Back", `A failure occurred during ${stage}. Restoring the original Actor.`);
      try {
        await this.#restore(actor, snapshot, token);
        const restoredFingerprint = this.#fingerprint(this.#actorSnapshot(actor));
        if (restoredFingerprint !== snapshotFingerprint) {
          throw new Error("The post-rollback Actor does not match the pre-commit safety snapshot.");
        }
        await this.#deleteSafetyBackup(safetyBackup);
        safetyBackup = null;
        await progress(100, "Actor Restored", "The original Actor was restored. Redo the Level Up.");
        const restored = new Error(`Level Up failed during ${stage}. The original Actor was restored successfully. Redo the Level Up.`);
        restored.cause = error;
        restored.actorRestored = true;
        restored.commitStage = stage;
        throw restored;
      } catch (rollbackError) {
        if (rollbackError?.actorRestored) throw rollbackError;
        console.error(`${MODULE_ID} | Level Up rollback or rollback verification failed.`, rollbackError);
        try {
          await actor.setFlag(MODULE_ID, "commitSafetyLock", {
            lockedAt: Date.now(),
            lockedBy: game.user.id,
            transactionToken: token,
            failedStage: stage,
            error: String(error?.message ?? error),
            rollbackError: String(rollbackError?.message ?? rollbackError),
            safetyBackupActorId: safetyBackup?.id ?? null,
            safetyBackupActorName: safetyBackup?.name ?? null
          });
        } catch (lockError) {
          console.error(`${MODULE_ID} | The critical Actor safety lock could not be persisted.`, lockError);
        }
        await progress(100, "Critical Rollback Failure", "The Actor could not be verified after rollback. GM intervention is required.");
        const backupReference = safetyBackup ? ` Safety backup Actor: ${safetyBackup.name}.` : "";
        const critical = new Error(`Critical Level Up rollback failure. Character Builder changes are locked for this Actor. The GM must restore the Actor from the preserved safety backup before continuing.${backupReference}`);
        critical.cause = rollbackError;
        critical.criticalRollback = true;
        critical.commitStage = stage;
        throw critical;
      }
    } finally {
      if (this.#activeTransactions.get(actor.id) === token) this.#activeTransactions.delete(actor.id);
    }
  }

  static #assertToken(actor, token) {
    if (this.#activeTransactions.get(actor.id) !== token) {
      throw new Error("The Level Up transaction guard rejected a stale or duplicate commit.");
    }
  }

  static async #emitProgress(callback, payload) {
    if (typeof callback !== "function") return;
    try {
      await callback(payload);
    } catch (error) {
      // A rendering problem must never interrupt or corrupt the transaction.
      console.warn(`${MODULE_ID} | Commit progress UI callback failed.`, error);
    }
  }


  static #validateSubclassCasterSpellLevels(draft, state) {
    const classIdentifier = String(state.selectedClassIdentifier ?? "");
    if (!["fighter", "rogue"].includes(classIdentifier)) return;
    const subclassIdentifiers = new Set(draft.items.filter(item => item.type === "subclass")
      .map(item => String(item.system?.identifier ?? "").toLowerCase()));
    const expectedSubclass = classIdentifier === "fighter" ? "eldritch-knight" : "arcane-trickster";
    if (!subclassIdentifiers.has(expectedSubclass)) return;

    const level = Number(state.targetClassLevel ?? 0);
    const maximum = level < 3 ? 0 : level < 7 ? 1 : level < 13 ? 2 : level < 19 ? 3 : 4;
    const invalid = draft.items.find(item => {
      if (item.type !== "spell" || Number(item.system?.level ?? 0) <= maximum) return false;
      const acquisition = item.getFlag(MODULE_ID, "levelUpSpell");
      return acquisition?.transactionId === state.transactionId
        && acquisition?.classIdentifier === classIdentifier;
    });
    if (invalid) {
      throw new Error(`${invalid.name} is a level ${invalid.system?.level} spell, but ${expectedSubclass === "eldritch-knight" ? "Eldritch Knight" : "Arcane Trickster"} level ${level} can learn spells only through level ${maximum}. Return to Additional Choices and select an eligible spell.`);
    }
  }

  static async #validateClassIntegrity(actor, draft, state) {
    const draftClass = draft.items.get(state.selectedClassId)
      ?? draft.items.find(item => item.type === "class" && item.system?.identifier === state.selectedClassIdentifier);
    if (!draftClass) throw new Error("The advanced Class is missing from the Level Up draft.");
    if (Number(draftClass.system?.levels ?? 0) !== Number(state.targetClassLevel)) {
      throw new Error(`${draftClass.name} should be Class level ${state.targetClassLevel}, but the draft contains level ${draftClass.system?.levels ?? 0}.`);
    }

    const reference = state.multiclass
      ? await fromUuid(state.selectedClassSourceUuid)
      : actor.items.get(state.selectedClassId)
        ?? actor.items.find(item => item.type === "class" && item.system?.identifier === state.selectedClassIdentifier);
    if (!reference) throw new Error("The source Class document could not be found for integrity validation.");

    const comparisons = [
      ["identifier", reference.system?.identifier, draftClass.system?.identifier],
      ["Hit Die", reference.system?.hd?.denomination, draftClass.system?.hd?.denomination],
      ["spellcasting progression", reference.system?.spellcasting?.progression, draftClass.system?.spellcasting?.progression],
      ["spellcasting ability", reference.system?.spellcasting?.ability, draftClass.system?.spellcasting?.ability]
    ];
    for (const [label, expected, actual] of comparisons) {
      if (expected == null || expected === "") continue;
      if (expected !== actual) {
        throw new Error(`${draftClass.name} ${label} changed unexpectedly during Level Up (${expected} → ${actual ?? "empty"}). The transaction was blocked before modifying the live Actor.`);
      }
    }
    const sourceDescription = String(reference.system?.description?.value ?? "").trim();
    const draftDescription = String(draftClass.system?.description?.value ?? "").trim();
    if (sourceDescription && !draftDescription) {
      throw new Error(`${draftClass.name} lost its Class description during Level Up. The transaction was blocked before modifying the live Actor.`);
    }
  }

  static async #createSafetyBackup(actor, draft, _snapshot, token) {
    return TemporaryActorService.createSafetyBackup(actor, {
      draftId: draft?.id ?? null,
      transactionToken: token
    });
  }

  static async #deleteSafetyBackup(backup) {
    if (!backup) return;
    try {
      await TemporaryActorService.deleteSafetyBackup(backup, {
        sourceActorId: backup.getFlag(MODULE_ID, "sourceActorId") ?? null,
        transactionToken: backup.getFlag(MODULE_ID, "transactionToken") ?? null
      });
    } catch (error) {
      console.warn(`${MODULE_ID} | The completed transaction safety backup could not be deleted.`, error);
    }
  }

  static #actorSnapshot(actor) {
    const source = this.#documentSource(actor);
    source.items = actor.items.map(item => this.#documentSource(item));
    source.effects = (actor.effects?.contents ?? [...(actor.effects ?? [])])
      .map(effect => this.#documentSource(effect));
    return source;
  }

  static #documentSource(document) {
    return this.#plainClone(document?._source ?? document?.toObject?.() ?? {});
  }

  static #plainClone(value, path = []) {
    if (Array.isArray(value)) return value.map((entry, index) => this.#plainClone(entry, [...path, index]));
    if (value instanceof Set) return Array.from(value, entry => this.#plainClone(entry, path));
    if (value instanceof Map) {
      return Object.fromEntries(Array.from(value.entries(), ([key, entry]) => [key, this.#plainClone(entry, [...path, key])]));
    }
    if (!value || typeof value !== "object") return value;

    const clone = {};
    const currentField = String(path.at(-1) ?? "");
    const isSensesField = currentField === "senses";
    const legacySenseKeys = new Set(["darkvision", "blindsight", "tremorsense", "truesight"]);
    for (const key of Object.keys(value)) {
      if (isSensesField && legacySenseKeys.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && !("value" in descriptor)) continue;
      clone[key] = this.#plainClone(descriptor ? descriptor.value : value[key], [...path, key]);
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
    for (const key of keys) this.#flattenForUpdate(value[key], prefix ? `${prefix}.${key}` : key, output);
    return output;
  }

  static async #restore(actor, snapshot, token) {
    const itemData = this.#plainClone(snapshot.items ?? []);
    const effectData = this.#plainClone(snapshot.effects ?? []);

    // The commit only writes Character Builder flags. Remove that complete
    // namespace before restoring it so no partial history/lastLevelUp/safety
    // marker survives a failed transaction.
    if (actor.flags?.[MODULE_ID] !== undefined) {
      await actor.update({ [`flags.-=${MODULE_ID}`]: null }, {
        characterBuilderLevelUpRollback: true,
        characterBuilderTransactionToken: token
      });
    }
    const update = this.#flattenForUpdate({
      system: snapshot.system,
      prototypeToken: snapshot.prototypeToken,
      img: snapshot.img,
      name: snapshot.name,
      flags: snapshot.flags
    });
    await actor.update(update, {
      characterBuilderLevelUpRollback: true,
      characterBuilderTransactionToken: token
    });

    const existingEffectIds = (actor.effects?.contents ?? [...(actor.effects ?? [])]).map(effect => effect.id);
    if (existingEffectIds.length) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", existingEffectIds, {
        characterBuilderLevelUpRollback: true,
        characterBuilderTransactionToken: token
      });
    }
    if (effectData.length) {
      await actor.createEmbeddedDocuments("ActiveEffect", effectData, {
        keepId: true,
        characterBuilderLevelUpRollback: true,
        characterBuilderTransactionToken: token
      });
    }

    const existingIds = actor.items.map(item => item.id);
    if (existingIds.length) {
      await actor.deleteEmbeddedDocuments("Item", existingIds, {
        deleteContents: true,
        characterBuilderLevelUpRollback: true,
        characterBuilderTransactionToken: token
      });
    }
    if (itemData.length) {
      await actor.createEmbeddedDocuments("Item", itemData, {
        keepId: true,
        characterBuilderLevelUpRollback: true,
        characterBuilderTransactionToken: token
      });
    }
  }

  static #fingerprint(snapshot) {
    const normalize = value => {
      if (Array.isArray(value)) return value.map(normalize);
      if (!value || typeof value !== "object") return value;
      const output = {};
      for (const key of Object.keys(value).sort()) {
        if (key === "_stats") continue;
        output[key] = normalize(value[key]);
      }
      return output;
    };
    const prepared = this.#plainClone(snapshot);
    prepared.items = [...(prepared.items ?? [])].sort((a, b) => String(a._id).localeCompare(String(b._id)));
    prepared.effects = [...(prepared.effects ?? [])].sort((a, b) => String(a._id).localeCompare(String(b._id)));
    return JSON.stringify(normalize(prepared));
  }
}
