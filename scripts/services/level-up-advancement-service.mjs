import { isWarcraftRune, removeRuneInscriptions } from "./warcraft-runeforging-service.mjs";
import { validateHunterChoice, prepareHunterChoice, selectWarcraftClass, resolveHeroProgression, retireGrantTree, invalidListGrant, activeWarcraft } from "./warcraft-progression-service.mjs";
import { MODULE_ID } from "../constants.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";
import { HitPointAdvancementService } from "./hit-point-advancement-service.mjs";
import { SourceResolver } from "./source-resolver.mjs";
import { AdvancementService } from "./advancement-service.mjs";
import { ItemGrantIntegrityService } from "./item-grant-integrity-service.mjs";
import { AdvancementChoiceAnnotationService } from "./advancement-choice-annotation-service.mjs";
import { NativeAdvancementSupportService, StructuralLevelUpError } from "./native-advancement-support-service.mjs";
import { FeatureSpellOwnershipService } from "./feature-spell-ownership-service.mjs";
import { ManagedAdvancementRegistry } from "./managed-advancement-registry.mjs";
import { ManagedFeatureAdvancementBridge } from "./managed-feature-advancement-bridge.mjs";
import { ItemChoiceReplacementIntegrityService } from "./item-choice-replacement-integrity-service.mjs";
import { NativeAdvancementModalGuard } from "./native-advancement-modal-guard.mjs";
import { RulesCompatibilityService } from "./rules-compatibility-service.mjs";
import { normalizedAdvancementName, repairAdvancementRecords } from "../utils/advancement-utils.mjs";
import { AdvancementCompletionGateService } from "./advancement-completion-gate-service.mjs";

export class LevelUpAdvancementService {
  static async apply(draft, registry) {
    const state = LevelUpDraftManager.getState(draft);
    if (state.nativeComplete) return { completed: true, classItem: draft.items.get(state.selectedClassId) };
    if (!state.hpResult) throw new Error("Resolve Hit Points before confirming Class Progression.");

    const Manager = globalThis.dnd5e?.applications?.advancement?.AdvancementManager;
    if (!Manager) throw new Error("D&D5e AdvancementManager is unavailable.");
    const rollbackSnapshot = this.#snapshot(draft);
    const beforeItemIds = new Set(draft.items.map(item => item.id));

    try {
      await repairAdvancementRecords(draft);
      let manager;
      let progressionChanged = false;
      let chosenSubclass;
      const previousRunes = activeWarcraft() ? draft.items.filter(isWarcraftRune) : [];
      let classIdentifier = state.selectedClassIdentifier;
      const hpValue = HitPointAdvancementService.advancementValue(state.hpResult);

      if (state.multiclass) {
        const document = await fromUuid(state.selectedClassSourceUuid);
        if (!document) throw new Error("The selected multiclass source document could not be loaded.");
        let data = await selectWarcraftClass(document.toObject(), registry);
        if (!data) return { completed: false };
        data = SourceResolver.filterAdvancementPools(data, registry);
        data = RulesCompatibilityService.prepareClassData(data, { sourceUuid: document.uuid ?? state.selectedClassSourceUuid });
        delete data._id;
        data.system ??= {};
        data.system.levels = 1;
        this.#setHitPointValue(data, 1, hpValue);
        manager = Manager.forNewItem(draft, data, {
          automaticApplication: true,
          showVisualizer: false
        });
        classIdentifier = data.system.identifier;
      } else {
        const classItem = draft.items.get(state.selectedClassId);
        if (!classItem) throw new Error("The selected Class no longer exists on the Level Up draft.");
        const progression = await resolveHeroProgression(draft, classItem, state.targetClassLevel, registry);
        if (!progression) return { completed: false };
        progressionChanged = progression.changed;
        chosenSubclass = progression.subclass;
        const hunter = await prepareHunterChoice(draft, classItem, state.targetClassLevel, registry);
        if (hunter === "cancelled") {
          if (progressionChanged) await this.#restore(draft, rollbackSnapshot);
          return { completed: false };
        }
        progressionChanged ||= hunter === "changed";
        await RulesCompatibilityService.ensureClassItemPolicy(classItem);
        manager = Manager.forLevelChange(draft, classItem.id, 1, {
          automaticApplication: true,
          showVisualizer: false
        });
        if (progression.subclass) {
          const step = manager.steps.find(step => step.type === "forward" && step.flow?.advancement?.type === "Subclass"
            && step.flow.advancement.item.id === classItem.id);
          if (!step) throw new Error("The subclass advancement is unavailable for this class.");
          step.flow.getAutomaticApplicationValue = async () => ({ uuid: progression.subclass });
        }
        const cloneClass = manager.clone.items.get(classItem.id);
        if (!cloneClass) throw new Error("The native Advancement clone did not contain the selected Class.");
        const source = cloneClass.toObject();
        this.#setHitPointValue(source, state.targetClassLevel, hpValue);
        cloneClass.updateSource({ "system.advancement": source.system.advancement });
      }

      // Reconcile any stale native ItemChoice replacement records on the
      // manager clone before D&D5e instantiates or renders its flow.
      await ItemChoiceReplacementIntegrityService.reconcile(manager.clone);

      // HP is resolved by the module so it can enforce the configured lock and
      // minimum-average policy. Warlock invocation choices are handled after
      // the native flow so repeatable, cantrip-targeted instances remain distinct.
      manager.steps = manager.steps.filter(step => !this.#isManagedStep(step, classIdentifier));
      await LevelUpDraftManager.setState(draft, { nativeRunning: true });

      const managed = ManagedFeatureAdvancementBridge.begin(manager, { workflow: "levelUp", classIdentifier });
      let result;
      try {
        result = await this.#runManager(manager);
        if (result.completed) await ManagedFeatureAdvancementBridge.restore(draft, managed);
      } finally {
        ManagedFeatureAdvancementBridge.end(managed);
      }
      if (!result.completed) {
        if (progressionChanged) await this.#restore(draft, rollbackSnapshot);
        await LevelUpDraftManager.setState(draft, { nativeRunning: false });
        return result;
      }

      if (!state.multiclass) validateHunterChoice(draft, draft.items.get(state.selectedClassId), state.targetClassLevel);
      await SourceResolver.enforceAllowedSources(draft, registry, {
        beforeItemIds,
        context: "current Level Up"
      });
      await ItemChoiceReplacementIntegrityService.reconcile(draft);
      const retiredRunes = previousRunes.filter(item => !draft.items.has(item.id));
      if (retiredRunes.length) {
        await retireGrantTree(draft, retiredRunes.map(item => item.id));
        await removeRuneInscriptions(draft, retiredRunes);
      }
      const invalid = draft.items.filter(item => invalidListGrant(draft, item));
      if (invalid.length) await draft.deleteEmbeddedDocuments("Item", invalid.map(item => item.id));
      await AdvancementService.dedupe(draft, { beforeItemIds });
      const integrityResult = await ItemGrantIntegrityService.reconcile(draft, registry, {
        context: "levelUp",
        state,
        recoveryActor: manager.clone
      });
      await FeatureSpellOwnershipService.reconcile(draft, integrityResult, state);
      await NativeAdvancementSupportService.validate(draft, {
        state,
        beforeItemIds,
        workflow: "Class Progression"
      });
      AdvancementCompletionGateService.assertItemPrerequisites(draft, rollbackSnapshot.items);
      await AdvancementChoiceAnnotationService.refresh(draft, { state: LevelUpDraftManager.getState(draft) });

      const classItem = state.multiclass
        ? draft.items.find(item => item.type === "class" && item.system?.identifier === classIdentifier)
        : draft.items.get(state.selectedClassId);
      if (!classItem) throw new Error("The advanced Class was not found after native Advancement completed.");

      if (state.multiclass) {
        const source = await fromUuid(state.selectedClassSourceUuid);
        if (source) {
          await classItem.setFlag(MODULE_ID, "sourceSnapshot", {
            uuid: source.uuid,
            name: source.name,
            img: source.img,
            identifier: source.system?.identifier ?? null,
            startingEquipment: [],
            wealth: "",
            multiclass: true
          });
        }
      }

      const resolvedClassIdentifier = classItem.system?.identifier ?? classIdentifier;
      const newSubclass = draft.items.find(item => item.type === "subclass"
        && !beforeItemIds.has(item.id)
        && (!item.system?.classIdentifier || item.system.classIdentifier === resolvedClassIdentifier));
      if (chosenSubclass) {
        const accepted = Object.values(classItem.toObject().system.advancement ?? {}).some(step =>
          step.type === "Subclass" && step.value?.uuid === chosenSubclass && step.value.document === newSubclass?.id);
        if (!newSubclass || !accepted) throw new Error("The native advancement did not apply the selected subclass.");
      }
      const subclassReviewRequired = Boolean(newSubclass);

      await LevelUpDraftManager.setState(draft, {
        selectedClassId: classItem.id,
        selectedClassIdentifier: resolvedClassIdentifier,
        selectedClassName: classItem.name,
        sourceClassLevel: Number(classItem.system?.levels ?? 1) - 1,
        targetClassLevel: Number(classItem.system?.levels ?? 1),
        nativeRunning: false,
        nativeComplete: true,
        subclassReviewRequired,
        subclassReviewComplete: !subclassReviewRequired,
        subclassReviewItemId: newSubclass?.id ?? null,
        step: subclassReviewRequired ? "advancements" : "choices"
      });
      return { completed: true, classItem };
    } catch (error) {
      try {
        await this.#restore(draft, rollbackSnapshot);
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Native Level Up rollback failed.`, rollbackError);
      }
      if (error?.structuralLevelUp) throw error;
      const message = String(error?.message ?? error ?? "");
      if (/must not have taken|prerequisite|not eligible|cannot be selected|advancement/i.test(message)) {
        throw new StructuralLevelUpError("A native Advancement choice could not be applied safely.", {
          reason: message.replace(/^\[[^\]]+\]\s*/, "") || "The selected native option is invalid.",
          diagnostic: message
        });
      }
      throw error;
    }
  }

  static #setHitPointValue(itemData, targetClassLevel, value) {
    const advancements = itemData.system?.advancement ?? {};
    const hitPoints = Object.values(advancements).find(entry => entry.type === "HitPoints");
    if (!hitPoints) throw new Error("The selected Class does not contain a Hit Points Advancement.");
    hitPoints.value ??= {};
    hitPoints.value[String(targetClassLevel)] = value;
  }

  static #isManagedStep(step, classIdentifier) {
    const advancement = step?.flow?.advancement ?? step?.flow?.document ?? null;
    const source = advancement?._source ?? advancement ?? {};
    const type = advancement?.constructor?.typeName
      ?? advancement?.constructor?.metadata?.type
      ?? source.type
      ?? "";
    const title = normalizedAdvancementName(advancement);
    if (String(type).toLowerCase().includes("hitpoints") || title === "hit points") return true;
    return ManagedAdvancementRegistry.isManaged(advancement, {
      classIdentifier,
      owner: step?.flow?.item ?? advancement?.item ?? null,
      workflow: "levelUp"
    });
  }

  static #runManager(manager) {
    // Keep the native manager and browser. The modal guard can reject an
    // invalid choice in place before the resulting draft is validated.
    return NativeAdvancementModalGuard.run(manager);
  }

  static #snapshot(draft) {
    return {
      system: foundry.utils.deepClone(draft._source?.system ?? draft.toObject().system ?? {}),
      flags: foundry.utils.deepClone(draft._source?.flags ?? draft.toObject().flags ?? {}),
      items: draft.items.map(item => foundry.utils.deepClone(item._source ?? item.toObject()))
    };
  }

  static async #restore(draft, snapshot) {
    await draft.update(this.#flatten({ system: snapshot.system, flags: snapshot.flags }), {
      characterBuilderLevelUpRollback: true
    });
    const ids = draft.items.map(item => item.id);
    if (ids.length) {
      await draft.deleteEmbeddedDocuments("Item", ids, {
        deleteContents: true,
        characterBuilderLevelUpRollback: true
      });
    }
    if (snapshot.items.length) {
      await draft.createEmbeddedDocuments("Item", foundry.utils.deepClone(snapshot.items), {
        keepId: true,
        characterBuilderLevelUpRollback: true
      });
    }
  }

  static #flatten(value, prefix = "", output = {}) {
    if (Array.isArray(value) || value === null || typeof value !== "object") {
      if (prefix) output[prefix] = foundry.utils.deepClone(value);
      return output;
    }
    const keys = Object.keys(value);
    if (!keys.length) {
      if (prefix) output[prefix] = {};
      return output;
    }
    for (const key of keys) this.#flatten(value[key], prefix ? `${prefix}.${key}` : key, output);
    return output;
  }
}
