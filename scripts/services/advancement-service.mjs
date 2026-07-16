import { MODULE_ID } from "../constants.mjs";
import { HitPointService } from "./hit-point-service.mjs";
import { SourceResolver } from "./source-resolver.mjs";
import { ItemGrantIntegrityService } from "./item-grant-integrity-service.mjs";

export class AdvancementService {
  static async replacePrimaryDocument(draft, document, type, onComplete, options = {}) {
    const current = draft.items.find(item => item.type === type);
    if (current) await this.removeItem(draft, current);
    return this.addItem(draft, document, type, onComplete, options);
  }

  static async addItem(draft, document, type, onComplete, { abilityAssignments = null, registry = null } = {}) {
    const Manager = globalThis.dnd5e?.applications?.advancement?.AdvancementManager;
    if (!Manager) throw new Error("D&D5e AdvancementManager is unavailable.");

    let data = document.toObject();
    delete data._id;

    if (abilityAssignments && type === "background") {
      for (const advancement of Object.values(data.system?.advancement ?? {})) {
        if (advancement.type !== "AbilityScoreImprovement") continue;
        advancement.value = {
          type: "asi",
          assignments: foundry.utils.deepClone(abilityAssignments)
        };
      }
    }

    if (registry) data = SourceResolver.filterAdvancementPools(data, registry);

    let recoveryActor = null;
    const finish = async () => {
      await this.#postProcessPrimary(draft, document, type);
      if (registry) {
        await SourceResolver.enforceAllowedSources(draft, registry);
        await ItemGrantIntegrityService.reconcile(draft, registry, {
          context: "creation",
          recoveryActor
        });
      }
      await onComplete?.();
    };

    const manager = Manager.forNewItem(draft, data, {
      automaticApplication: false,
      showVisualizer: false
    });

    if (!manager.steps.length) {
      await draft.createEmbeddedDocuments("Item", [data]);
      await finish();
      return draft.items.find(item => item.type === type && item.system?.identifier === data.system?.identifier);
    }

    recoveryActor = manager.clone;
    await new Promise((resolve, reject) => {
      const hookId = Hooks.on("dnd5e.advancementManagerComplete", async completed => {
        if (completed !== manager) return;
        Hooks.off("dnd5e.advancementManagerComplete", hookId);
        try {
          await finish();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      manager.render(true);
    });

    return draft.items.find(item => item.type === type && item.system?.identifier === data.system?.identifier);
  }

  static async removeItem(draft, item) {
    const Manager = globalThis.dnd5e?.applications?.advancement?.AdvancementManager;
    if (!Manager) {
      await item.delete();
      return;
    }

    const manager = Manager.forDeletedItem(draft, item.id, {
      automaticApplication: true,
      showVisualizer: false
    });

    if (!manager.steps.length) {
      await item.delete();
      return;
    }

    await new Promise(resolve => {
      const hookId = Hooks.on("dnd5e.advancementManagerComplete", completed => {
        if (completed !== manager) return;
        Hooks.off("dnd5e.advancementManagerComplete", hookId);
        resolve();
      });
      manager.render(true);
    });
  }

  static async #postProcessPrimary(draft, document, type) {
    const identifier = document.system?.identifier;
    const item = draft.items.find(candidate => candidate.type === type &&
      (!identifier || candidate.system?.identifier === identifier));
    if (!item) throw new Error(`The selected ${type} was not created on the Draft Actor.`);

    const source = document.toObject();
    await item.setFlag(MODULE_ID, "sourceSnapshot", {
      uuid: source.flags?.[MODULE_ID]?.customBackground ? "CharacterBuilder.CustomBackground" : document.uuid ?? null,
      name: document.name,
      img: document.img,
      identifier: document.system?.identifier ?? null,
      startingEquipment: foundry.utils.deepClone(source.system?.startingEquipment ?? []),
      wealth: source.system?.wealth ?? "",
      customBackground: Boolean(source.flags?.[MODULE_ID]?.customBackground)
    });

    if (source.flags?.[MODULE_ID]?.customBackground) {
      await item.setFlag(MODULE_ID, "customBackground", true);
    }
    if (type === "class") await HitPointService.enforceFirstLevelMaximum(draft);
  }

  static async ensureDeferredBackgroundASI() {
    return false;
  }

  static async dedupe(actor) {
    const deletions = [];
    const redirects = [];
    const groups = new Map();

    for (const item of actor.items) {
      // A D&D5e resource is identified by its acquisition path, not only by
      // name or identifier. Never collapse source-granted, Builder-managed, or
      // repeatable instances; equal-looking documents can have different
      // preparation, free-use, replacement, and recovery rules.
      if (item.getFlag("dnd5e", "advancementOrigin")
        || item.getFlag("dnd5e", "advancementRoot")
        || item.getFlag(MODULE_ID, "itemGrantInstance")
        || item.getFlag(MODULE_ID, "levelUpSpell")
        || item.getFlag(MODULE_ID, "classSpellAccess")
        || item.getFlag(MODULE_ID, "invocationInstance")) continue;

      const identifier = item.system?.identifier;
      const sourceUuid = item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource;
      if (!identifier || !sourceUuid || !["spell", "feat"].includes(item.type)) continue;
      const fingerprint = item.type === "spell"
        ? this.#spellFingerprint(item)
        : this.#featureFingerprint(item);
      const key = `${item.type}:${identifier}:${sourceUuid}:${fingerprint}`;
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }

    for (const bucket of groups.values()) {
      if (bucket.length < 2) continue;
      const keeper = bucket[0];
      for (const duplicate of bucket.slice(1)) {
        deletions.push(duplicate.id);
        redirects.push({ from: duplicate.id, to: keeper.id });
      }
    }

    if (redirects.length) await this.#redirectAdvancementReferences(actor, redirects);
    if (deletions.length) await actor.deleteEmbeddedDocuments("Item", [...new Set(deletions)]);
  }

  static #spellFingerprint(item) {
    const source = item.toObject().system ?? {};
    const uses = source.uses ?? {};
    const activities = Object.values(source.activities ?? {}).map(activity => ({
      type: activity.type,
      activation: activity.activation?.type,
      consumption: activity.consumption,
      uses: activity.uses
    }));
    return JSON.stringify({
      method: source.method,
      ability: source.ability,
      prepared: source.prepared,
      sourceItem: source.sourceItem,
      uses,
      activities
    });
  }

  static #featureFingerprint(item) {
    const source = item.toObject().system ?? {};
    const effects = item.effects.map(effect => effect.toObject()).map(effect => {
      delete effect._id;
      delete effect.origin;
      delete effect._stats;
      return effect;
    });
    return JSON.stringify({
      type: item.type,
      subtype: source.type?.subtype,
      uses: source.uses,
      activities: source.activities,
      effects
    });
  }


  static async #redirectAdvancementReferences(actor, redirects) {
    const updates = [];
    for (const item of actor.items) {
      const source = item.toObject();
      const advancement = source.system?.advancement;
      if (!advancement || !Object.keys(advancement).length) continue;
      let changed = false;

      const walk = value => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }
        for (const redirect of redirects) {
          if (Object.prototype.hasOwnProperty.call(value, redirect.from)) {
            if (!Object.prototype.hasOwnProperty.call(value, redirect.to)) value[redirect.to] = value[redirect.from];
            delete value[redirect.from];
            changed = true;
          }
        }
        Object.values(value).forEach(walk);
      };

      walk(advancement);
      if (changed) updates.push({ _id: item.id, "system.advancement": advancement });
    }
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { diff: false, recursive: false });
  }

  static #originFor(item) {
    if (item.system?.sourceItem) return item.system.sourceItem;
    const advancementOrigin = item.getFlag("dnd5e", "advancementOrigin");
    if (!advancementOrigin) return item._stats?.compendiumSource ?? null;
    const [itemId] = advancementOrigin.split(".");
    return item.actor?.items.get(itemId)?.name ?? advancementOrigin;
  }
}
