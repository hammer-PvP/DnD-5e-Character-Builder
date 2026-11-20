import { MODULE_ID } from "../constants.mjs";

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
      const feature = this.#featureForTitle(draft, row.advancementTitle, owner);
      const ownerRecord = {
        category: this.#slug(row.advancementTitle || feature?.name || "automatic-feature-spell"),
        label: row.advancementTitle || feature?.name || "Automatic Feature Spell",
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

  // This is a spell-level snapshot, not a property of whichever grant happens
  // to be removed last. A per-owner previousPrepared value is insufficient when
  // two Always Prepared grants are retired in opposite orders.
  static preparedBaseline(spell, owners = spell.getFlag(MODULE_ID, "featureSpellOwners") ?? []) {
    const flags = spell.getFlag(MODULE_ID, "featureSpellPreparedBaseline");
    const historical = spell.getFlag(MODULE_ID, "alwaysPreparedReconciliation")?.normalAcquisition?.previousPrepared;
    for (const value of [flags, historical, ...owners.map(owner => owner?.previousPrepared)]) {
      if (value === null || value === undefined || value === "") continue;
      const number = Number(value);
      if (Number.isInteger(number) && number >= 0 && number <= 2) return number;
    }
    return null;
  }

  static async addOwner(spell, ownerRecord, { prepared = null } = {}) {
    const existing = spell.getFlag(MODULE_ID, "featureSpellOwners") ?? [];
    const record = foundry.utils.deepClone(ownerRecord);
    const wasAlways = existing.some(owner => owner.alwaysPrepared);
    let baseline = this.preparedBaseline(spell, existing);
    if (prepared != null && !wasAlways && baseline == null) {
      baseline = Number(spell.system?.prepared);
      if (!Number.isInteger(baseline) || baseline < 0 || baseline > 2) baseline = null;
    }
    if (prepared != null && baseline != null) record.previousPrepared ??= baseline;
    const owners = this.#mergeOwner(existing, record);
    const update = {
      [`flags.${MODULE_ID}.featureGrantedSpell`]: true,
      [`flags.${MODULE_ID}.featureSpellOwners`]: owners
    };
    if (prepared != null && baseline != null) update[`flags.${MODULE_ID}.featureSpellPreparedBaseline`] = baseline;
    if (prepared != null) update["system.prepared"] = Number(prepared);
    await spell.update(update, { characterBuilderFeatureOwnership: true });
    return owners;
  }

  static async removeOwner(spell, predicate) {
    const current = spell.getFlag(MODULE_ID, "featureSpellOwners") ?? [];
    const removed = current.filter(predicate);
    const remaining = current.filter(owner => !predicate(owner));
    const hadAlways = removed.some(owner => owner.alwaysPrepared);
    const hasAlways = remaining.some(owner => owner.alwaysPrepared);
    const baseline = this.preparedBaseline(spell, current);
    const update = {
      [`flags.${MODULE_ID}.featureSpellOwners`]: remaining,
      [`flags.${MODULE_ID}.featureGrantedSpell`]: remaining.length > 0
    };
    if (hadAlways && !hasAlways) {
      // No guess for imported/legacy spells whose original preparation is unknown.
      if (baseline != null) {
        update["system.prepared"] = baseline;
        update[`flags.${MODULE_ID}.-=featureSpellPreparedBaseline`] = null;
      }
    } else if (hasAlways && baseline != null) {
      // Carry the baseline forward even if its original owner was removed first.
      update[`flags.${MODULE_ID}.featureSpellPreparedBaseline`] = baseline;
    }
    await spell.update(update, { characterBuilderFeatureOwnership: true });
    return remaining;
  }

  static #mergeOwner(existing, record) {
    const key = this.#ownerKey(record);
    const prior = existing.find(owner => this.#ownerKey(owner) === key) ?? null;
    const rows = existing.filter(owner => this.#ownerKey(owner) !== key);
    const next = foundry.utils.deepClone(record);

    if (prior) {
      // Validation is a repair observation, not a new acquisition. Preserve
      // historical acquisition fields when the Validator re-observes a proven
      // owner. Normal progression/runtime maintenance remains free to record a
      // legitimate new configuration transaction for that same owner.
      if (record.validationReconciled) {
        for (const field of [
          "transactionId", "acquiredAtCharacterLevel",
          "acquiredAtClassLevel", "previousPrepared"
        ]) {
          if (prior[field] !== undefined && prior[field] !== null && prior[field] !== "") next[field] = foundry.utils.deepClone(prior[field]);
        }
      }

      // Never discard an established structural pointer just because a later
      // observer has less context. Missing legacy metadata may still be filled
      // by the new record.
      for (const field of [
        "classIdentifier", "classItemId", "subclassItemId", "featureItemId",
        "ownerItemId", "advancementId", "sourceUuid", "spellLevel"
      ]) {
        const incomingMissing = next[field] === undefined || next[field] === null || next[field] === "";
        if (incomingMissing && prior[field] !== undefined && prior[field] !== null && prior[field] !== "") {
          next[field] = foundry.utils.deepClone(prior[field]);
        }
      }

      // Validator reconciliation is not permission to rename/reclassify a
      // proven owner. Runtime maintenance may legitimately update presentation
      // labels (for example a reconfigured Circle of the Land), so this
      // preservation is deliberately limited to validation observations.
      if (record.validationReconciled) {
        for (const field of ["category", "label"]) {
          if (prior[field] !== undefined && prior[field] !== null && prior[field] !== "") next[field] = foundry.utils.deepClone(prior[field]);
        }
      }

      if (prior.previousPrepared !== undefined && prior.previousPrepared !== null
        && (next.previousPrepared === undefined || next.previousPrepared === null)) {
        next.previousPrepared = prior.previousPrepared;
      }
      next.alwaysPrepared = Boolean(prior.alwaysPrepared || next.alwaysPrepared);
      next.nativeGrant = Boolean(prior.nativeGrant || next.nativeGrant);
      if (prior.validationReconciled || next.validationReconciled) next.validationReconciled = true;
    }

    rows.push(next);
    return rows;
  }

  static #ownerKey(owner) {
    const structuralOwner = owner.ownerItemId ?? owner.featureItemId ?? owner.subclassItemId ?? owner.classItemId ?? "";
    const advancementId = owner.advancementId ?? "";
    if (structuralOwner || advancementId) return `owner:${structuralOwner}:advancement:${advancementId}`;
    // Legacy records without an embedded owner/grant still need a stable,
    // non-presentational identity. Source + class is the narrowest safe
    // fallback and avoids returning to label/category based deduplication.
    return `fallback:${owner.classIdentifier ?? ""}:${owner.sourceUuid ?? ""}`;
  }

  static #featureForTitle(draft, title, owner) {
    if (owner?.type === "feat") return owner;
    const normalized = this.#normalize(title);
    if (!normalized) return owner?.type === "feat" ? owner : null;
    const candidates = draft.items.filter(item => item.type === "feat" && (
      this.#normalize(item.name) === normalized || this.#normalize(item.system?.identifier) === normalized
    ));
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
