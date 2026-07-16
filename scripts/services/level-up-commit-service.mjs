import { MODULE_ID, MODULE_VERSION } from "../constants.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";
import { LevelUpService } from "./level-up-service.mjs";
import { HitPointAdvancementService } from "./hit-point-advancement-service.mjs";
import { ItemGrantReconciliationService } from "./item-grant-reconciliation-service.mjs";

/**
 * Applies a completed Level Up draft as one recoverable transaction. The live
 * Actor remains untouched while native and module-managed choices are made.
 */
export class LevelUpCommitService {
  static async commit(actor, draft) {
    const state = LevelUpDraftManager.getState(draft);
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

    await this.#validateClassIntegrity(actor, draft, state);
    ItemGrantReconciliationService.validate(draft, state);

    const snapshot = this.#actorSnapshot(actor);
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

    let stage = "updating the Actor source";
    try {
      await actor.update(baseUpdate, { characterBuilderLevelUp: true });

      stage = "replacing embedded Items";
      const existingIds = actor.items.map(item => item.id);
      if (existingIds.length) {
        await actor.deleteEmbeddedDocuments("Item", existingIds, {
          deleteContents: true,
          characterBuilderLevelUp: true
        });
      }
      if (itemData.length) {
        await actor.createEmbeddedDocuments("Item", itemData, {
          keepId: true,
          characterBuilderLevelUp: true
        });
        const missing = itemData.filter(item => !actor.items.get(item._id));
        if (missing.length) throw new Error(`${missing.length} Level Up Item document(s) were not created on the live Actor.`);
      }

      // D&D5e automatically reassigns originalClass when the current original
      // Class Item is temporarily deleted. Restore the live Actor's original
      // Class after the Level Up Items have been recreated with their same IDs.
      if (originalClassId && actor.items.get(originalClassId)
        && actor.system?.details?.originalClass !== originalClassId) {
        stage = "restoring the original Class";
        await actor.update({ "system.details.originalClass": originalClassId }, { characterBuilderLevelUp: true });
      }

      stage = "synchronizing current Hit Points";
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
      await actor.update({ "system.attributes.hp.value": newValue }, { characterBuilderLevelUp: true });

      stage = "recording Level Up history";
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
      await actor.setFlag(MODULE_ID, "levelUpHistory", history);
      await actor.setFlag(MODULE_ID, "lastLevelUp", history.at(-1));
      await actor.unsetFlag(MODULE_ID, "levelUpDraftId");
      if (LevelUpService.settings().levelUpMode === "milestone") {
        await actor.unsetFlag(MODULE_ID, "levelUpGrant");
      }

      try {
        await draft.delete();
      } catch (cleanupError) {
        console.warn(`${MODULE_ID} | Level Up committed, but the temporary draft could not be deleted.`, cleanupError);
      }
      return { actor, history: history.at(-1), newMaximum, newValue };
    } catch (error) {
      console.error(`${MODULE_ID} | Level Up commit failed while ${stage}. Restoring Actor snapshot.`, error);
      try {
        await this.#restore(actor, snapshot);
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Level Up rollback also failed.`, rollbackError);
      }
      throw error;
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

  static #actorSnapshot(actor) {
    const source = this.#documentSource(actor);
    source.items = actor.items.map(item => this.#documentSource(item));
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

  static async #restore(actor, snapshot) {
    const itemData = this.#plainClone(snapshot.items ?? []);
    const update = this.#flattenForUpdate({
      system: snapshot.system,
      prototypeToken: snapshot.prototypeToken,
      img: snapshot.img,
      name: snapshot.name,
      flags: snapshot.flags
    });
    await actor.update(update, { characterBuilderLevelUpRollback: true });
    const existingIds = actor.items.map(item => item.id);
    if (existingIds.length) {
      await actor.deleteEmbeddedDocuments("Item", existingIds, {
        deleteContents: true,
        characterBuilderLevelUpRollback: true
      });
    }
    if (itemData.length) {
      await actor.createEmbeddedDocuments("Item", itemData, {
        keepId: true,
        characterBuilderLevelUpRollback: true
      });
    }
  }
}
