import { MODULE_ID } from "../constants.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";
import { HitPointAdvancementService } from "./hit-point-advancement-service.mjs";
import { SourceResolver } from "./source-resolver.mjs";
import { AdvancementService } from "./advancement-service.mjs";
import { ItemGrantReconciliationService } from "./item-grant-reconciliation-service.mjs";

export class LevelUpAdvancementService {
  static async apply(draft, registry) {
    const state = LevelUpDraftManager.getState(draft);
    if (state.nativeComplete) return { completed: true, classItem: draft.items.get(state.selectedClassId) };
    if (!state.hpResult) throw new Error("Resolve Hit Points before confirming Class Progression.");

    const Manager = globalThis.dnd5e?.applications?.advancement?.AdvancementManager;
    if (!Manager) throw new Error("D&D5e AdvancementManager is unavailable.");
    const rollbackSnapshot = this.#snapshot(draft);

    try {
      let manager;
      let classIdentifier = state.selectedClassIdentifier;
      const hpValue = HitPointAdvancementService.advancementValue(state.hpResult);

      if (state.multiclass) {
        const document = await fromUuid(state.selectedClassSourceUuid);
        if (!document) throw new Error("The selected multiclass source document could not be loaded.");
        let data = SourceResolver.filterAdvancementPools(document.toObject(), registry);
        delete data._id;
        data.system ??= {};
        data.system.levels = 1;
        this.#setHitPointValue(data, 1, hpValue);
        manager = Manager.forNewItem(draft, data, {
          automaticApplication: false,
          showVisualizer: false
        });
        classIdentifier = data.system.identifier;
      } else {
        const classItem = draft.items.get(state.selectedClassId);
        if (!classItem) throw new Error("The selected Class no longer exists on the Level Up draft.");
        manager = Manager.forLevelChange(draft, classItem.id, 1, {
          automaticApplication: false,
          showVisualizer: false
        });
        const cloneClass = manager.clone.items.get(classItem.id);
        if (!cloneClass) throw new Error("The native Advancement clone did not contain the selected Class.");
        const source = cloneClass.toObject();
        this.#setHitPointValue(source, state.targetClassLevel, hpValue);
        cloneClass.updateSource({ "system.advancement": source.system.advancement });
      }

      // HP is resolved by the module so it can enforce the configured lock and
      // minimum-average policy. Warlock invocation choices are handled after
      // the native flow so repeatable, cantrip-targeted instances remain distinct.
      manager.steps = manager.steps.filter(step => !this.#isManagedStep(step, classIdentifier));
      await LevelUpDraftManager.setState(draft, { nativeRunning: true });

      const result = await this.#runManager(manager);
      if (!result.completed) {
        await LevelUpDraftManager.setState(draft, { nativeRunning: false });
        return result;
      }

      await SourceResolver.enforceAllowedSources(draft, registry);
      await AdvancementService.dedupe(draft);
      await ItemGrantReconciliationService.reconcile(draft, registry, state);

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

      await LevelUpDraftManager.setState(draft, {
        selectedClassId: classItem.id,
        selectedClassIdentifier: classItem.system?.identifier ?? classIdentifier,
        selectedClassName: classItem.name,
        sourceClassLevel: Number(classItem.system?.levels ?? 1) - 1,
        targetClassLevel: Number(classItem.system?.levels ?? 1),
        nativeRunning: false,
        nativeComplete: true,
        step: "choices"
      });
      return { completed: true, classItem };
    } catch (error) {
      try {
        await this.#restore(draft, rollbackSnapshot);
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Native Level Up rollback failed.`, rollbackError);
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
    const title = String(advancement?.title ?? source.title ?? "").trim().toLowerCase();
    if (String(type).toLowerCase().includes("hitpoints") || title === "hit points") return true;
    if (classIdentifier === "warlock" && title === "eldritch invocations") return true;
    return false;
  }

  static #runManager(manager) {
    return new Promise((resolve, reject) => {
      let completed = false;
      let settled = false;
      const settle = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const hookId = Hooks.on("dnd5e.advancementManagerComplete", completedManager => {
        if (completedManager !== manager) return;
        completed = true;
        Hooks.off("dnd5e.advancementManagerComplete", hookId);
        settle({ completed: true });
      });

      const originalClose = manager.close.bind(manager);
      manager.close = async (...args) => {
        const closed = await originalClose(...args);
        if (!completed) {
          Hooks.off("dnd5e.advancementManagerComplete", hookId);
          settle({ completed: false, cancelled: true });
        }
        return closed;
      };

      try {
        manager.render(true);
      } catch (error) {
        Hooks.off("dnd5e.advancementManagerComplete", hookId);
        reject(error);
      }
    });
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
