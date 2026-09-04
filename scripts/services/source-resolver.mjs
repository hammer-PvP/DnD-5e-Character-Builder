import { MODULE_ID } from "../constants.mjs";

/**
 * Enforces enabled content sources at three boundaries:
 * 1. before a native Advancement flow opens,
 * 2. after the native Advancement flow completes,
 * 3. before the Draft is committed to the real Actor.
 */
export class SourceResolver {
  static filterAdvancementPools(itemData, registry) {
    const data = foundry.utils.deepClone(itemData);
    const advancements = data.system?.advancement ?? {};

    for (const advancement of Object.values(advancements)) {
      const configuration = advancement.configuration ?? {};

      if (Array.isArray(configuration.pool)) {
        configuration.pool = configuration.pool.filter(entry => {
          const uuid = typeof entry === "string" ? entry : entry?.uuid;
          return !uuid || registry.isUuidAllowed(uuid);
        });
      }

      if (Array.isArray(configuration.items)) {
        configuration.items = configuration.items.filter(entry => {
          const uuid = typeof entry === "string" ? entry : entry?.uuid;
          return !uuid || registry.isUuidAllowed(uuid);
        });
      }
    }
    return data;
  }

  static async enforceAllowedSources(actor, registry, {
    beforeItemIds = null,
    includeItemIds = [],
    context = "current transaction"
  } = {}) {
    const updates = [];
    const deletions = [];
    const blocked = [];
    const baselineIds = beforeItemIds == null ? null : new Set(beforeItemIds);
    const explicitIds = new Set(includeItemIds ?? []);

    for (const item of actor.items) {
      // Level Up must validate only the transaction delta. Existing inventory,
      // consumables, homebrew, and GM-granted Items are copied unchanged even
      // when their historical source metadata points at a disabled compendium.
      if (baselineIds?.has(item.id) && !explicitIds.has(item.id)) continue;
      if (item.getFlag(MODULE_ID, "customBackground")) continue;
      const currentSource = item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource;
      if (!currentSource || !String(currentSource).startsWith("Compendium.")) continue;
      if (registry.isUuidAllowed(currentSource)) continue;

      const identifier = item.system?.identifier;
      const preferred = identifier ? registry.preferredOption(item.type, identifier) : null;
      if (!preferred) {
        deletions.push(item.id);
        blocked.push(item.name);
        continue;
      }

      const document = await fromUuid(preferred.uuid);
      if (!document) {
        deletions.push(item.id);
        blocked.push(item.name);
        continue;
      }
      updates.push(this.#replacementUpdate(item, document, preferred));
    }

    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { diff: false, recursive: false });
    if (deletions.length) await actor.deleteEmbeddedDocuments("Item", deletions, { deleteContents: true });

    if (blocked.length) {
      throw new Error(`The ${context} attempted to grant content from disabled sources: ${blocked.join(", ")}. Enable a compatible source or choose another option.`);
    }
    return updates.length;
  }

  static async normalizeSpells(actor, registry, options = {}) {
    return this.enforceAllowedSources(actor, registry, options);
  }

  static #replacementUpdate(item, document, option) {
    const replacement = document.toObject();
    const current = item.toObject();
    delete replacement._id;

    replacement.system = foundry.utils.mergeObject(replacement.system ?? {}, {
      ability: current.system?.ability,
      method: current.system?.method,
      prepared: current.system?.prepared,
      sourceItem: current.system?.sourceItem,
      uses: current.system?.uses,
      activities: current.system?.activities,
      quantity: current.system?.quantity,
      equipped: current.system?.equipped,
      container: current.system?.container
    }, {
      inplace: false,
      overwrite: true,
      insertKeys: true,
      insertValues: true
    });

    replacement.flags ??= {};
    replacement.flags.dnd5e = foundry.utils.mergeObject(replacement.flags.dnd5e ?? {}, current.flags?.dnd5e ?? {}, {
      inplace: false,
      overwrite: true
    });
    replacement.flags.dnd5e.sourceId = option.uuid;
    replacement.flags[MODULE_ID] = foundry.utils.mergeObject(replacement.flags[MODULE_ID] ?? {}, current.flags?.[MODULE_ID] ?? {}, {
      inplace: false,
      overwrite: true
    });

    return {
      _id: item.id,
      name: replacement.name,
      img: replacement.img,
      system: replacement.system,
      flags: replacement.flags,
      effects: replacement.effects ?? current.effects
    };
  }
}
