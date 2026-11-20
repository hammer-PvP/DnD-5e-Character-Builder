import { activeWarcraft } from "./warcraft-progression-service.mjs";
import { documentFingerprint, fieldChanges, reconcileEmbeddedDocuments } from "../utils/embedded-document-utils.mjs";
import { repairAdvancementRecords } from "../utils/advancement-utils.mjs";
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
import { LevelUpFeatureService } from "./level-up-feature-service.mjs";
import { InternalActorReferenceRebindingService } from "./internal-actor-reference-rebinding-service.mjs";
import { SubclassSpellcastingService } from "./subclass-spellcasting-service.mjs";

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
    let attemptedItemIds = new Set();
    const progress = (percent, label, detail = "") => this.#emitProgress(onProgress, {
      token, percent, stage: label, detail
    });

    try {
      await progress(4, "Validating Draft", "Checking the completed Level Up draft.");
      this.#assertToken(actor, token);
      const state = LevelUpDraftManager.getState(draft);
      await repairAdvancementRecords(draft);
      await ItemChoiceReplacementIntegrityService.reconcile(draft);
      if (!state.nativeComplete || !state.additionalComplete || !state.commitReady) {
        throw new Error("Complete every Level Up step before committing the transaction.");
      }
      if (draft.getFlag(MODULE_ID, "sourceActorId") !== actor.id) {
        throw new Error("This Level Up draft does not belong to the selected Actor.");
      }
      const advancementMode = LevelUpService.settings().levelUpMode;
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
      await LevelUpFeatureService.restoreDraftSpellChoices(draft, state);
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
      const isManagedInspiration = item => item?.flags?.["heroic-inspiration-manager"]?.managed === true;
      const managed = actor.items.filter(isManagedInspiration);
      const managedIds = new Set(managed.map(item => item.id));
      const itemData = draft.items.filter(item => !isManagedInspiration(item) && !managedIds.has(item.id))
        .concat(managed).map(item => item.toObject());
      const revisions = state.sourceItemRevisions;
      const originalIds = revisions ? new Set(Object.keys(revisions)) : null;
      if (!originalIds && actor.items.some(item => !draft.items.has(item.id))) {
        throw new Error("This older draft has no inventory baseline for a removal. Restart Class Selection to capture the current inventory.");
      }
      if (originalIds) {
        for (const id of originalIds) {
          const current = actor.items.get(id);
          if (!current && isManagedInspiration(draft.items.get(id))) continue;
          if (isManagedInspiration(current)) continue;
          if (!current || (current._stats?.modifiedTime ?? null) !== revisions[id]) {
            throw new Error("An Item changed on the live Actor while Level Up was open. Restart Level Up to use the current inventory.");
          }
        }
        if (itemData.some(row => !originalIds.has(row._id) && actor.items.has(row._id))) {
          throw new Error("An Item added during Level Up has the same ID as a new draft Item. Restart Level Up.");
        }
      }
      const sourceItemIds = new Set(actor.items.map(item => item.id));
      const createdItems = itemData.filter(item => !sourceItemIds.has(item._id));
      attemptedItemIds = new Set(createdItems.map(row => row._id));
      const deletedItems = actor.items.filter(item => !managedIds.has(item.id) && !draft.items.get(item.id) && (!originalIds || originalIds.has(item.id)));
      const baseUpdate = this.#flattenForUpdate({
        system: draftData.system,
        prototypeToken: draftData.prototypeToken,
        img: draftData.img,
        name: actor.name
      });

      if (advancementMode === "free") {
        const threshold = CONFIG.DND5E.CHARACTER_EXP_LEVELS?.[currentLevel] ?? actor.system?.details?.xp?.max;
        if (!Number.isFinite(threshold)) throw new Error("The XP threshold for the new character level is unavailable.");
        baseUpdate["system.details.xp.value"] = threshold;
      }

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
      await progress(44, stage, "Applying Item changes from the completed draft.");
      this.#assertToken(actor, token);
      await reconcileEmbeddedDocuments(actor, "Item", itemData, {
        render: false,
        characterBuilderLevelUp: true,
        characterBuilderTransactionToken: token
      }, originalIds);
      if (itemData.length) {
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
        [`flags.${MODULE_ID}.lastLevelUp`]: new foundry.data.operators.ForcedDeletion()
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
      const finalFlagCleanup = { [`flags.${MODULE_ID}.levelUpDraftId`]: new foundry.data.operators.ForcedDeletion() };
      if (advancementMode === "milestone" || advancementMode === "free") {
        finalFlagCleanup[`flags.${MODULE_ID}.levelUpGrant`] = new foundry.data.operators.ForcedDeletion();
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
        const blocked = new Error(`Level Up was blocked during ${stage}. The live Actor was not changed. ${error.message}`);
        blocked.cause = error;
        blocked.actorRestored = true;
        blocked.commitStage = stage;
        throw blocked;
      }

      await progress(96, "Rolling Back", `A failure occurred during ${stage}. Restoring the original Actor.`);
      try {
        await this.#restore(actor, snapshot, token, attemptedItemIds);
        const restoredFingerprint = this.#fingerprint(this.#actorSnapshot(actor));
        if (restoredFingerprint !== snapshotFingerprint) {
          throw new Error("The post-rollback Actor does not match the pre-commit safety snapshot.");
        }
        // A verified rollback may have recreated an Item with a new database
        // timestamp. Rebase only revisions the original draft actually tracked.
        const revisions = draft.getFlag(MODULE_ID, "levelUpState")?.sourceItemRevisions;
        if (revisions) {
          const refreshed = Object.fromEntries(Object.keys(revisions).map(id => [id, actor.items.get(id)?._stats?.modifiedTime ?? null]));
          try {
            await draft.update({ [`flags.${MODULE_ID}.levelUpState.sourceItemRevisions`]: refreshed }, { render: false });
          } catch (refreshError) {
            console.warn(`${MODULE_ID} | Verified rollback. Restart Level Up to capture fresh inventory revisions.`, refreshError);
          }
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

  // A failed 0.9.934 rollback can leave all original documents intact plus
  // Items seen only in the draft. Recover that provable state on the original Actor.
  static inspectRecovery(actor) {
    if (!game.user.isGM) throw new Error("A GM is required to recover a Level Up.");
    const lock = actor.getFlag(MODULE_ID, "commitSafetyLock");
    const backup = game.actors.get(lock?.safetyBackupActorId);
    const draftId = actor.getFlag(MODULE_ID, "levelUpDraftId");
    const draft = game.actors.get(draftId);
    if (!lock?.transactionToken || !backup || !draft || new Set([actor.id, backup.id, draft.id]).size !== 3
      || backup.getFlag(MODULE_ID, "commitSafetyBackup") !== true
      || backup.getFlag(MODULE_ID, "transactionToken") !== lock.transactionToken
      || backup.getFlag(MODULE_ID, "sourceActorId") !== actor.id
      || backup.getFlag(MODULE_ID, "levelUpDraftId") !== draftId
      || draft.getFlag(MODULE_ID, "isLevelUpDraft") !== true
      || draft.getFlag(MODULE_ID, "sourceActorId") !== actor.id) {
      throw new Error("Recovery requires the original Actor and the linked Level Up draft and safety backup from the same transaction.");
    }
    const live = this.#actorSnapshot(actor);
    const before = this.#actorSnapshot(backup);
    const flags = { ...live.flags?.[MODULE_ID] };
    delete flags.commitSafetyLock;
    const backupFlags = { ...before.flags?.[MODULE_ID] };
    for (const key of ["commitSafetyBackup", "sourceActorId", "transactionToken", "createdAt", "createdByUserId", "moduleVersion"]) {
      // These fields were written on the temporary copy during backup creation.
      delete backupFlags[key];
      delete flags[key];
    }
    const actorState = (data, savedFlags) => documentFingerprint({
      system: data.system, img: data.img, prototypeToken: data.prototypeToken,
      effects: data.effects, flags: { [MODULE_ID]: savedFlags }
    }, "Actor");
    if (actorState(live, flags) !== actorState(before, backupFlags)) {
      throw new Error("The Actor data differs from the safety backup. Inspect the original and backup before restoring manually.");
    }
    for (const row of before.items) {
      const item = actor.items.get(row._id);
      if (!item || documentFingerprint(item.toObject(), "Item") !== documentFingerprint(row, "Item")) {
        throw new Error(`The original Item ${row.name} differs from the backup. Manual review is required.`);
      }
    }
    const remove = live.items.filter(row => !backup.items.has(row._id));
    for (const row of remove) {
      const source = draft.items.get(row._id);
      if (!source || documentFingerprint(row, "Item") !== documentFingerprint(source.toObject(), "Item")
        || Number(row._stats?.modifiedTime ?? 0) > Number(lock.lockedAt)) {
        throw new Error(`Item ${row.name} cannot be attributed safely to this failed Level Up. Manual review is required.`);
      }
    }
    return { token: lock.transactionToken, draft, backup, remove };
  }

  static async recover(actor, expectedToken, confirmedIds = null) {
    const plan = this.inspectRecovery(actor);
    if (this.#activeTransactions.has(actor.id) || plan.token !== expectedToken
      || (confirmedIds && (plan.remove.length !== confirmedIds.length || plan.remove.some(row => !confirmedIds.includes(row._id))))) {
      throw new Error("This transaction changed. Reopen recovery on the original Actor.");
    }
    this.#activeTransactions.set(actor.id, plan.token);
    try {
      if (plan.remove.length) {
        await actor.deleteEmbeddedDocuments("Item", plan.remove.map(row => row._id), {
          deleteContents: false, characterBuilderLevelUpRollback: true, characterBuilderTransactionToken: plan.token
        });
      }
      const verified = this.inspectRecovery(actor);
      if (verified.token !== plan.token || verified.remove.length) throw new Error("Recovery could not verify the original inventory.");
      await plan.draft.setFlag(MODULE_ID, "recoveredTransaction", plan.token);
      if (plan.draft.getFlag(MODULE_ID, "recoveredTransaction") !== plan.token) throw new Error("Could not archive the failed draft.");
      // Keep the backup and the abandoned draft. A new attempt must capture fresh revisions.
      const final = this.inspectRecovery(actor);
      if (final.token !== plan.token || final.remove.length) throw new Error("The Actor changed during recovery.");
      await actor.update({
        [`flags.${MODULE_ID}.levelUpDraftId`]: new foundry.data.operators.ForcedDeletion(),
        [`flags.${MODULE_ID}.commitSafetyLock`]: new foundry.data.operators.ForcedDeletion()
      }, { characterBuilderLevelUpRollback: true, characterBuilderTransactionToken: plan.token });
      if (actor.getFlag(MODULE_ID, "commitSafetyLock") || actor.getFlag(MODULE_ID, "levelUpDraftId")) {
        throw new Error("Could not clear the verified transaction lock. Inspect the preserved safety backup.");
      }
    } finally {
      this.#activeTransactions.delete(actor.id);
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
    const cls = draft.items.find(item => item.type === "class"
      && String(item.system?.identifier ?? "") === classIdentifier);
    if (!cls || String(cls.system?.spellcasting?.progression ?? "none") !== "none") return;
    const caster = SubclassSpellcastingService.find(draft, classIdentifier);
    if (!caster) return;

    const level = Number(state.targetClassLevel ?? 0);
    const maximum = SubclassSpellcastingService.maximumSpellLevel(caster.progression, level);
    const invalid = draft.items.find(item => {
      if (item.type !== "spell" || Number(item.system?.level ?? 0) <= maximum) return false;
      const acquisition = item.getFlag(MODULE_ID, "levelUpSpell");
      return acquisition?.transactionId === state.transactionId
        && acquisition?.classIdentifier === classIdentifier
        && (!acquisition.subclassItemId || acquisition.subclassItemId === caster.subclass.id);
    });
    if (invalid) {
      throw new Error(`${invalid.name} is a level ${invalid.system?.level} spell, but ${caster.subclass.name} level ${level} can learn spells only through level ${maximum}. Return to Spells & Features and select an eligible spell.`);
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

    const committedHero = reference.flags?.["dnd-world-warcraft"]?.heroClass;
    const fixed = activeWarcraft()?.config?.heroClasses?.[reference.system?.identifier]
      ?.find(hero => hero.identifier === committedHero && hero.subclass);
    if (fixed && draftClass.flags?.["dnd-world-warcraft"]?.heroClass !== committedHero) {
      throw new Error("The committed heroic class changed on the draft. Restart Class Selection.");
    }

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
    source.items = actor.items.map(item => item.toObject());
    source.effects = (actor.effects?.contents ?? [...(actor.effects ?? [])])
      .map(effect => effect.toObject());
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

  static async #restore(actor, snapshot, token, attemptedItemIds) {
    const itemData = snapshot.items ?? [];
    const effectData = snapshot.effects ?? [];

    const options = { characterBuilderLevelUpRollback: true, characterBuilderTransactionToken: token };
    const actorFields = data => ({
      system: data.system, prototypeToken: data.prototypeToken, img: data.img, name: data.name,
      flags: data.flags?.[MODULE_ID] === undefined ? {} : { [MODULE_ID]: data.flags[MODULE_ID] }
    });
    const update = fieldChanges(actorFields(this.#documentSource(actor)), actorFields(snapshot));
    if (Object.keys(update).length) await actor.update(update, options);
    await reconcileEmbeddedDocuments(actor, "Item", itemData, options, attemptedItemIds);
    await reconcileEmbeddedDocuments(actor, "ActiveEffect", effectData, options, new Set());
  }

  static #fingerprint(snapshot) {
    return documentFingerprint(snapshot, "Actor");
  }
}
