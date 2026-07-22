import { MODULE_ID } from "../constants.mjs";
import { HitPointService } from "./hit-point-service.mjs";
import { SourceResolver } from "./source-resolver.mjs";
import { ItemGrantIntegrityService } from "./item-grant-integrity-service.mjs";
import { NativeAdvancementModalGuard } from "./native-advancement-modal-guard.mjs";

export class AdvancementService {
  static async replacePrimaryDocument(draft, document, type, onComplete, options = {}) {
    const rollbackSnapshot = this.snapshotDraft(draft);
    try {
      const current = draft.items.find(item => item.type === type);
      if (current) {
        const removed = await this.removeItem(draft, current);
        if (!removed) return null;
      }
      const added = await this.addItem(draft, document, type, onComplete, options);
      if (!added) await this.restoreDraft(draft, rollbackSnapshot);
      return added;
    } catch (error) {
      await this.restoreDraft(draft, rollbackSnapshot);
      throw error;
    }
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
      automaticApplication: true,
      showVisualizer: false
    });

    if (!manager.steps.length) {
      await draft.createEmbeddedDocuments("Item", [data]);
      await finish();
      return draft.items.find(item => item.type === type && item.system?.identifier === data.system?.identifier);
    }

    recoveryActor = manager.clone;
    const result = await NativeAdvancementModalGuard.run(manager, { onComplete: finish });
    if (!result.completed) return null;

    return draft.items.find(item => item.type === type && item.system?.identifier === data.system?.identifier);
  }

  static async removeItem(draft, item) {
    const Manager = globalThis.dnd5e?.applications?.advancement?.AdvancementManager;
    if (!Manager) {
      await item.delete();
      return true;
    }

    const manager = Manager.forDeletedItem(draft, item.id, {
      automaticApplication: true,
      showVisualizer: false
    });

    if (!manager.steps.length) {
      await item.delete();
      return true;
    }

    const result = await NativeAdvancementModalGuard.run(manager);
    return result.completed;
  }

  static snapshotDraft(draft) {
    return {
      system: foundry.utils.deepClone(draft._source?.system ?? draft.toObject().system ?? {}),
      flags: foundry.utils.deepClone(draft._source?.flags ?? draft.toObject().flags ?? {}),
      items: draft.items.map(item => foundry.utils.deepClone(item._source ?? item.toObject())),
      effects: draft.effects.map(effect => foundry.utils.deepClone(effect._source ?? effect.toObject()))
    };
  }

  static async restoreDraft(draft, snapshot) {
    if (!snapshot) return;
    await draft.update(this.#flatten({ system: snapshot.system, flags: snapshot.flags }), {
      characterBuilderNativeAdvancementRollback: true
    });

    const itemIds = draft.items.map(item => item.id);
    if (itemIds.length) {
      await draft.deleteEmbeddedDocuments("Item", itemIds, {
        deleteContents: true,
        characterBuilderNativeAdvancementRollback: true
      });
    }
    if (snapshot.items.length) {
      await draft.createEmbeddedDocuments("Item", foundry.utils.deepClone(snapshot.items), {
        keepId: true,
        characterBuilderNativeAdvancementRollback: true
      });
    }

    const effectIds = draft.effects.map(effect => effect.id);
    if (effectIds.length) {
      await draft.deleteEmbeddedDocuments("ActiveEffect", effectIds, {
        characterBuilderNativeAdvancementRollback: true
      });
    }
    if (snapshot.effects.length) {
      await draft.createEmbeddedDocuments("ActiveEffect", foundry.utils.deepClone(snapshot.effects), {
        keepId: true,
        characterBuilderNativeAdvancementRollback: true
      });
    }
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

  static async dedupe(actor, { beforeItemIds = null } = {}) {
    const protectedIds = beforeItemIds == null ? null : new Set(beforeItemIds);
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
      // During Level Up, Items that existed before the transaction are
      // immutable input. Dedupe may remove only newly created technical
      // duplicates; it never collapses two legacy or GM-granted documents.
      const mutable = protectedIds ? bucket.filter(item => !protectedIds.has(item.id)) : bucket;
      if (!mutable.length) continue;
      const keeper = protectedIds
        ? (bucket.find(item => protectedIds.has(item.id)) ?? mutable[0])
        : bucket[0];
      for (const duplicate of mutable) {
        if (duplicate.id === keeper.id) continue;
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

      const redirectMap = new Map(redirects.map(row => [row.from, row.to]));
      const walk = value => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index++) {
            const replacement = redirectMap.get(value[index]);
            if (replacement) {
              value[index] = replacement;
              changed = true;
            } else walk(value[index]);
          }
          return;
        }
        for (const redirect of redirects) {
          if (Object.prototype.hasOwnProperty.call(value, redirect.from)) {
            if (!Object.prototype.hasOwnProperty.call(value, redirect.to)) value[redirect.to] = value[redirect.from];
            delete value[redirect.from];
            changed = true;
          }
        }
        for (const [key, nested] of Object.entries(value)) {
          const replacement = redirectMap.get(nested);
          if (replacement) {
            value[key] = replacement;
            changed = true;
          } else walk(nested);
        }
      };

      walk(advancement);
      if (changed) updates.push({ _id: item.id, "system.advancement": advancement });
    }
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { diff: false, recursive: false });
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

  static #originFor(item) {
    if (item.system?.sourceItem) return item.system.sourceItem;
    const advancementOrigin = item.getFlag("dnd5e", "advancementOrigin");
    if (!advancementOrigin) return item._stats?.compendiumSource ?? null;
    const [itemId] = advancementOrigin.split(".");
    return item.actor?.items.get(itemId)?.name ?? advancementOrigin;
  }
}
