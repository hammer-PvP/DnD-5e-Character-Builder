import { writeAdvancementRecords, readAdvancementRecords } from "../utils/advancement-utils.mjs";
import { ManagedAdvancementRegistry } from "./managed-advancement-registry.mjs";
import { MODULE_ID } from "../constants.mjs";

/**
 * Reconciles a CB-handled ItemChoice with *real* Items already created by CB.
 * The native AdvancementManager must never run these dependent choices again;
 * its original advancement definitions and ledger are retained for D&D5e
 * provenance and native advancement ownership. No content UUID or choice title is
 * hardcoded here; the caller supplies the validated acquisition groups.
 */
export class ManagedItemChoiceLedgerService {
  static plan(owner, acquisitions, { classIdentifier = "", workflow = "creation", throughLevel = Infinity } = {}) {
    const source = owner?.toObject?.().system?.advancement ?? {};
    const next = foundry.utils.deepClone(source);
    // Legacy/converted content without a native CB-managed ItemChoice keeps
    // its existing CB selection workflow. Do not invent PHB-specific ledgers.
    const managed = Object.entries(next).filter(([, advancement]) =>
      advancement?.type === "ItemChoice"
      && advancement.configuration?.type === "spell"
      && ManagedAdvancementRegistry.isManaged(advancement, { owner, classIdentifier, workflow })
    );
    if (!managed.length) return { advancement: next, mapped: [], skipped: true };
    const mapped = [];
    for (const { items, level, advancementId, original = null, originalLevel = null } of acquisitions) {
      if (!items?.length) throw new Error(`No selected spells to record for ${owner.name}.`);
      const matches = managed.flatMap(([id, advancement]) => {
        if (advancementId && id !== advancementId) return [];
        const restriction = advancement.configuration?.restriction?.level;
        if (restriction !== undefined && restriction !== null && restriction !== "" && restriction !== "available"
          && !items.every(item => Number(item.system?.level) === Number(restriction))) return [];
        return Object.entries(advancement.configuration?.choices ?? {}).flatMap(([key, row]) => {
          if (Number(key) > throughLevel) return [];
          if (level != null && Number(key) !== Number(level)) return [];
          if (original ? !row.replacement || items.length !== 1 : Number(row.count) !== items.length) return [];
          return [{ id, advancement, key }];
        });
      });
      if (matches.length !== 1) {
        throw new Error(`Expected one matching spell ItemChoice on ${owner.name}, found ${matches.length}.`);
      }
      const [{ id, advancement, key }] = matches;
      const value = advancement.value ??= {};
      value.added ??= {};
      value.replaced ??= {};
      const row = {};
      for (const item of items) {
        const uuid = this.#sourceUuid(item);
        if (item.type !== "spell" || !item.id || !uuid || Object.hasOwn(row, item.id)) {
          throw new Error(`Invalid or duplicate spell acquisition for ${owner.name}.`);
        }
        row[item.id] = uuid;
        mapped.push({ itemId: item.id, advancementId: id });
      }
      if (original) {
        const originalRows = Object.entries(value.added).filter(([entryLevel, entries]) =>
          Number(entryLevel) < Number(key) && Object.hasOwn(entries, original.id));
        const firstAcquisitionLevels = Object.entries(advancement.configuration.choices)
          .filter(([entryLevel, row]) => Number(entryLevel) < Number(key) && Number(row.count) > 0);
        const inferred = originalRows[0]?.[0] ?? originalLevel
          ?? (firstAcquisitionLevels.length === 1 ? firstAcquisitionLevels[0][0] : null);
        if (originalRows.length > 1 || inferred == null || Number(inferred) >= Number(key)
          || !advancement.configuration.choices[inferred]
          || !this.#sourceUuid(original)) {
          throw new Error(`Cannot resolve the original spell acquisition level on ${owner.name}.`);
        }
        const replacement = items[0].id;
        if (replacement === original.id) throw new Error(`A spell cannot replace itself on ${owner.name}.`);
        const history = value.replaced[key];
        if (history && (history.original !== original.id || history.replacement !== replacement)) {
          throw new Error(`A spell replacement is already recorded for ${owner.name} at level ${key}.`);
        }
        // Keep the historical original for the native reverse operation.
        value.added[inferred] ??= {};
        if (!originalRows.length) value.added[inferred][original.id] = this.#sourceUuid(original);
        value.replaced[key] = { level: Number(inferred), original: original.id, replacement };
        value.added[key] = { ...value.added[key], ...row };
      } else {
        const replacement = value.replaced[key]?.replacement;
        const current = replacement && value.added[key]?.[replacement];
        value.added[key] = current ? { ...row, [replacement]: current } : row;
      }
      if (advancement.configuration.spell?.ability?.length === 1) {
        value.ability = advancement.configuration.spell.ability[0];
      }
    }
    if (new Set(mapped.map(row => row.itemId)).size !== mapped.length) {
      throw new Error(`A spell Item was assigned more than once on ${owner.name}.`);
    }
    return { advancement: next, mapped };
  }

  static #sourceUuid(item) {
    return item?.getFlag?.("dnd5e", "sourceId") ?? item?._stats?.compendiumSource ?? null;
  }

  static hasManagedSpellChoices(owner, options) {
    return Object.values(owner?.toObject?.().system?.advancement ?? {}).some(advancement =>
      advancement?.type === "ItemChoice" && advancement.configuration?.type === "spell"
      && ManagedAdvancementRegistry.isManaged(advancement, { owner, ...options })
    );
  }

  static async restoreDraftChoices(actor, cls, { workflow, level }) {
    if (!cls || !Number.isInteger(level)) return;
    const options = { classIdentifier: cls.system.identifier, workflow, throughLevel: level };
    const spells = actor.items.filter(item => item.type === "spell");
    for (const owner of actor.items) {
      if (!this.hasManagedSpellChoices(owner, options)) continue;
      const acquisitions = [];
      const advancements = readAdvancementRecords(owner);
      for (const [id, advancement] of Object.entries(advancements)) {
        const descriptor = ManagedAdvancementRegistry.descriptor(advancement, { owner, ...options });
        if (advancement.configuration?.type !== "spell" || !descriptor || descriptor.handler === "pact-of-the-tome") continue;
        const restriction = advancement.configuration.restriction?.level;
        for (const [key, row] of Object.entries(advancement.configuration.choices ?? {})) {
          const count = Number(row.count ?? 0);
          if (!count || Number(key) > level || Object.keys(advancement.value?.added?.[key] ?? {}).length) continue;
          const items = spells.filter(item => {
            const origin = item.getFlag("dnd5e", "advancementOrigin");
            if (origin && origin !== `${owner.id}.${id}`) return false;
            if (restriction != null && restriction !== "" && restriction !== "available"
              && Number(item.system.level) !== Number(restriction)) return false;
            const metadata = [
              ...(item.getFlag(MODULE_ID, "featureSpellOwners") ?? []),
              item.getFlag(MODULE_ID, "levelUpSpell")
            ];
            return metadata.some(entry => {
              if (entry?.classItemId !== cls.id || Number(entry.acquiredAtClassLevel) !== Number(key)) return false;
              if (entry.featureItemId === owner.id) return true;
              if (descriptor.handler !== "subclass-cantrips" || !entry.subclassItemId) return false;
              const root = owner.getFlag("dnd5e", "advancementOrigin") ?? "";
              return root.split(".")[0] === entry.subclassItemId;
            });
          });
          if (items.length === count) acquisitions.push({ items, level: Number(key), advancementId: id });
        }
      }
      if (acquisitions.length) await this.reconcile(actor, owner, acquisitions, options);
    }
  }

  static async reconcile(actor, owner, acquisitions, options = {}) {
    if (acquisitions.some(({ items }) => items.some(item => !actor.items.get(item.id)))) {
      throw new Error(`A selected spell is missing from the draft for ${owner.name}.`);
    }
    const plan = this.plan(owner, acquisitions, options);
    if (plan.skipped) return { reconciled: 0, advancementIds: [], legacyFallback: true };
    const root = String(owner.getFlag?.("dnd5e", "advancementRoot") ?? "");
    const updates = plan.mapped.filter(({ itemId, advancementId }) => {
      const item = actor.items.get(itemId);
      const origin = `${owner.id}.${advancementId}`;
      const previous = item.getFlag("dnd5e", "advancementOrigin");
      if (previous && previous !== origin) {
        throw new Error(`A selected spell already belongs to another native Advancement on ${owner.name}.`);
      }
      return previous !== origin || item.getFlag("dnd5e", "advancementRoot") !== (root || origin);
    }).map(({ itemId, advancementId }) => ({
      _id: itemId,
      "flags.dnd5e.advancementOrigin": `${owner.id}.${advancementId}`,
      "flags.dnd5e.advancementRoot": root || `${owner.id}.${advancementId}`
    }));
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, {
      characterBuilderManagedAdvancementReconcile: true
    });
    await writeAdvancementRecords(owner, plan.advancement, {
      characterBuilderManagedAdvancementReconcile: true
    });
    const actual = (actor.items.get(owner.id) ?? owner).toObject().system?.advancement ?? {};
    const canonicalAdded = added => JSON.stringify(Object.entries(added ?? {})
      .map(([level, entries]) => [String(level), Object.entries(entries ?? {}).sort(([a], [b]) => a.localeCompare(b))])
      .sort(([a], [b]) => a.localeCompare(b)));
    for (const { advancementId } of plan.mapped) {
      const expected = plan.advancement[advancementId]?.value?.added ?? {};
      const expectedReplaced = plan.advancement[advancementId]?.value?.replaced ?? {};
      const actualReplaced = actual[advancementId]?.value?.replaced ?? {};
      const replacementKeys = Object.keys(expectedReplaced);
      if (canonicalAdded(actual[advancementId]?.value?.added) !== canonicalAdded(expected)
        || Object.keys(actualReplaced).length !== replacementKeys.length
        || replacementKeys.some(key => ["level", "original", "replacement"]
          .some(field => actualReplaced[key]?.[field] !== expectedReplaced[key][field]))) {
        throw new Error(`The native Advancement ledger did not retain the CB selection for ${owner.name}.`);
      }
    }
    for (const { itemId, advancementId } of plan.mapped) {
      if (String(actor.items.get(itemId)?.getFlag("dnd5e", "advancementOrigin") ?? "") !== `${owner.id}.${advancementId}`) {
        throw new Error(`The selected spell ${itemId} lost its native Advancement origin.`);
      }
    }
    return { reconciled: plan.mapped.length, advancementIds: [...new Set(plan.mapped.map(row => row.advancementId))] };
  }
}
