import { MODULE_ID } from "../constants.mjs";

const TITLE_FEATURE_BY_NORMALIZED = Object.freeze({
  shadowyfigments: "shadow-arts"
});

const SPELL_FEATURE_BY_IDENTIFIER = Object.freeze({
  "divine-smite": "paladins-smite",
  "find-steed": "faithful-steed",
  "hunters-mark": "favored-enemy",
  "power-word-heal": "words-of-creation",
  "power-word-kill": "words-of-creation",
  "counterspell": "spell-breaker",
  "dispel-magic": "spell-breaker",
  "summon-beast": "phantasmal-creatures",
  "summon-fey": "phantasmal-creatures",
  "beast-sense": "animal-speaker",
  "speak-with-animals": "animal-speaker",
  "commune-with-nature": "nature-speaker",
  "elementalism": "manipulate-elements",
  "telekinesis": "telekinetic-master",
  "guidance": "star-map",
  "guiding-bolt": "star-map"
});

/**
 * Adds acquisition ownership metadata to spells created by native ItemGrant
 * Advancements. The native D&D5e document remains responsible for preparation,
 * uses, activities, and rest recovery; Character Builder records which feature
 * owns that state so future replacement and Runtime Management can remove only
 * the correct source.
 */
export class FeatureSpellOwnershipService {
  static async reconcile(draft, integrityResult, state) {
    const updates = [];
    for (const row of integrityResult?.items ?? []) {
      const spell = draft.items.get(row.itemId);
      if (!spell || spell.type !== "spell") continue;
      const owner = draft.items.get(row.ownerItemId);
      const feature = this.#featureForTitle(draft, row.advancementTitle, owner, spell);
      const ownerRecord = {
        category: feature?.system?.identifier
          ?? this.#slug(feature?.name || row.advancementTitle || "automatic-feature-spell"),
        label: feature?.name || row.advancementTitle || "Automatic Feature Spell",
        classIdentifier: this.#classIdentifier(owner, draft),
        classItemId: this.#classItemId(owner, draft),
        subclassItemId: owner?.type === "subclass" ? owner.id : null,
        featureItemId: feature?.id ?? null,
        ownerItemId: owner?.id ?? null,
        advancementId: row.advancementId,
        transactionId: state?.transactionId ?? null,
        acquiredAtCharacterLevel: Number(state?.targetCharacterLevel ?? 0),
        acquiredAtClassLevel: Number(state?.targetClassLevel ?? row.level ?? 0),
        sourceUuid: spell.getFlag("dnd5e", "sourceId") ?? spell._stats?.compendiumSource ?? null,
        spellLevel: Number(spell.system?.level ?? 0),
        alwaysPrepared: Number(spell.system?.prepared ?? 0) === 2,
        nativeGrant: true
      };
      const owners = this.#mergeOwner(spell.getFlag(MODULE_ID, "featureSpellOwners") ?? [], ownerRecord);
      updates.push({
        _id: spell.id,
        [`flags.${MODULE_ID}.featureGrantedSpell`]: true,
        [`flags.${MODULE_ID}.featureSpellOwners`]: owners
      });
    }
    updates.push(...this.#nestedFeatureSpellUpdates(draft, state));
    const merged = new Map();
    for (const update of updates) merged.set(update._id, { ...(merged.get(update._id) ?? {}), ...update });
    const rows = [...merged.values()];
    if (rows.length) {
      await draft.updateEmbeddedDocuments("Item", rows, {
        characterBuilderFeatureOwnership: true
      });
    }
    return rows;
  }


  static #nestedFeatureSpellUpdates(draft, state) {
    const configurations = {
      "blessed-warrior": { classIdentifier: "paladin", ability: "cha", label: "Blessed Warrior" },
      "druidic-warrior": { classIdentifier: "ranger", ability: "wis", label: "Druidic Warrior" }
    };
    const updates = [];
    for (const spell of draft.items.filter(item => item.type === "spell")) {
      const root = String(spell.getFlag("dnd5e", "advancementRoot")
        ?? spell.getFlag("dnd5e", "advancementOrigin") ?? "");
      const [ownerId, advancementId] = root.split(".");
      const owner = draft.items.get(ownerId);
      const identifier = String(owner?.system?.identifier ?? "");
      const config = configurations[identifier];
      if (!owner || !config) continue;

      const classItem = draft.items.find(item => item.type === "class"
        && item.system?.identifier === config.classIdentifier);
      const record = {
        category: identifier,
        label: config.label,
        classIdentifier: config.classIdentifier,
        classItemId: classItem?.id ?? null,
        subclassItemId: null,
        featureItemId: owner.id,
        ownerItemId: owner.id,
        advancementId: advancementId || null,
        transactionId: state?.transactionId ?? null,
        acquiredAtCharacterLevel: Number(state?.targetCharacterLevel ?? 0),
        acquiredAtClassLevel: Number(state?.targetClassLevel ?? 0),
        sourceUuid: spell.getFlag("dnd5e", "sourceId") ?? spell._stats?.compendiumSource ?? null,
        spellLevel: Number(spell.system?.level ?? 0),
        alwaysPrepared: true,
        nativeGrant: true
      };
      const owners = this.#mergeOwner(spell.getFlag(MODULE_ID, "featureSpellOwners") ?? [], record);
      updates.push({
        _id: spell.id,
        "system.ability": config.ability,
        "system.method": "spell",
        "system.prepared": 2,
        "system.sourceItem": `class:${config.classIdentifier}`,
        [`flags.${MODULE_ID}.featureGrantedSpell`]: true,
        [`flags.${MODULE_ID}.featureSpellOwners`]: owners
      });
    }
    return updates;
  }

  static async addOwner(spell, ownerRecord, { prepared = null } = {}) {
    const existing = spell.getFlag(MODULE_ID, "featureSpellOwners") ?? [];
    const record = foundry.utils.deepClone(ownerRecord);
    // Preserve the preparation state that existed before the first feature-owned
    // Always Prepared grant. Replacements can then remove only the state owned
    // by that feature without unpreparing a spell selected normally by the user.
    if (prepared != null && !existing.some(owner => owner.alwaysPrepared)) {
      record.previousPrepared = Number(spell.system?.prepared ?? 0);
    }
    const owners = this.#mergeOwner(existing, record);
    const update = {
      [`flags.${MODULE_ID}.featureGrantedSpell`]: true,
      [`flags.${MODULE_ID}.featureSpellOwners`]: owners
    };
    if (prepared != null) update["system.prepared"] = Number(prepared);
    await spell.update(update, { characterBuilderFeatureOwnership: true });
    return owners;
  }

  static async removeOwner(spell, predicate) {
    const current = spell.getFlag(MODULE_ID, "featureSpellOwners") ?? [];
    const removed = current.filter(predicate);
    const remaining = current.filter(owner => !predicate(owner));
    const update = {
      [`flags.${MODULE_ID}.featureSpellOwners`]: remaining,
      [`flags.${MODULE_ID}.featureGrantedSpell`]: remaining.length > 0
    };
    if (!remaining.some(owner => owner.alwaysPrepared) && removed.some(owner => owner.alwaysPrepared)) {
      const prior = [...removed].reverse().find(owner => Number.isFinite(Number(owner.previousPrepared)))?.previousPrepared;
      // Only restore a known prior state. Legacy records without this value are
      // left unchanged rather than risking the loss of normal preparation.
      if (prior != null && Number.isFinite(Number(prior))) update["system.prepared"] = Number(prior);
    }
    await spell.update(update, { characterBuilderFeatureOwnership: true });
    return remaining;
  }

  static #mergeOwner(existing, record) {
    const key = this.#ownerKey(record);
    const prior = existing.find(owner => this.#ownerKey(owner) === key) ?? null;
    const rows = existing.filter(owner => this.#ownerKey(owner) !== key);
    const merged = foundry.utils.deepClone(record);
    if (prior) {
      // Reconciliation can revisit earlier grants on later Level Ups. Keep the
      // original acquisition context rather than making an old spell appear to
      // have been gained again in the current transaction.
      for (const field of [
        "transactionId", "acquiredAtCharacterLevel", "acquiredAtClassLevel",
        "previousPrepared", "signaturePosition", "trackerActivityId",
        "trackerActivityName"
      ]) {
        if (prior[field] != null) merged[field] = foundry.utils.deepClone(prior[field]);
      }
    }
    rows.push(merged);
    return rows;
  }

  static #ownerKey(owner) {
    return [owner.category, owner.featureItemId, owner.ownerItemId, owner.advancementId].join(":");
  }

  static #featureForTitle(draft, title, owner, spell = null) {
    const mappedIdentifier = SPELL_FEATURE_BY_IDENTIFIER[String(spell?.system?.identifier ?? "")];
    if (mappedIdentifier) {
      const mapped = draft.items.find(item => item.type === "feat"
        && item.system?.identifier === mappedIdentifier);
      if (mapped) return mapped;
    }

    const normalized = this.#normalize(title);
    const titleMappedIdentifier = TITLE_FEATURE_BY_NORMALIZED[normalized];
    if (titleMappedIdentifier) {
      const mapped = draft.items.find(item => item.type === "feat"
        && item.system?.identifier === titleMappedIdentifier);
      if (mapped) return mapped;
    }
    if (!normalized) {
      if (owner?.type === "feat") return owner;
      if (owner?.type === "subclass") {
        // Some later spell-list rows omit their title (notably Gloom Stalker
        // levels 13 and 17). Resolve the single spell-list feature already
        // granted by that subclass rather than losing ownership attribution.
        const linkedSpellLists = draft.items.filter(item => {
          if (item.type !== "feat" || !/-spells$/.test(String(item.system?.identifier ?? ""))) return false;
          const root = String(item.getFlag("dnd5e", "advancementRoot")
            ?? item.getFlag("dnd5e", "advancementOrigin") ?? "");
          return root.startsWith(`${owner.id}.`);
        });
        if (linkedSpellLists.length === 1) return linkedSpellLists[0];
      }
      return null;
    }
    let candidates = draft.items.filter(item => item.type === "feat" && (
      this.#normalize(item.name) === normalized || this.#normalize(item.system?.identifier) === normalized
    ));
    if (!candidates.length) {
      // Titles such as "Star Map: Guidance" name the owning feature followed
      // by the individual granted spell.
      candidates = draft.items.filter(item => {
        if (item.type !== "feat") return false;
        const name = this.#normalize(item.name);
        const identifier = this.#normalize(item.system?.identifier);
        return (name && normalized.startsWith(name)) || (identifier && normalized.startsWith(identifier));
      });
    }
    if (candidates.length === 1) return candidates[0];
    const linked = candidates.find(item => {
      const root = String(item.getFlag("dnd5e", "advancementRoot") ?? item.getFlag("dnd5e", "advancementOrigin") ?? "");
      return owner && root.startsWith(`${owner.id}.`);
    });
    return linked ?? (owner?.type === "feat" ? owner : null);
  }

  static #classIdentifier(owner, draft) {
    if (!owner) return null;
    if (owner.type === "class") return owner.system?.identifier ?? null;
    if (owner.type === "subclass") return owner.system?.classIdentifier ?? owner.system?.class?.identifier ?? owner.system?.class ?? null;
    const root = String(owner.getFlag("dnd5e", "advancementRoot") ?? owner.getFlag("dnd5e", "advancementOrigin") ?? "");
    const rootItem = draft.items.get(root.split(".")[0]);
    return rootItem && rootItem.id !== owner.id ? this.#classIdentifier(rootItem, draft) : null;
  }

  static #classItemId(owner, draft) {
    const identifier = this.#classIdentifier(owner, draft);
    return draft.items.find(item => item.type === "class" && item.system?.identifier === identifier)?.id ?? null;
  }

  static #normalize(value) {
    return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  static #slug(value) {
    return String(value ?? "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
}
