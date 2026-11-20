import { MODULE_ID } from "../constants.mjs";

/**
 * Reverses only the mechanical delta owned by a retired spell grant. The
 * original spell (and any normal/independent acquisition) survives. A free
 * cast is not the same thing as acquiring the spell: it may add a use pool,
 * recovery, Forward Activities, or ItemUses consumption targets.
 *
 * This service only produces document updates. The caller must perform the
 * changes inside its existing draft/rollback transaction.
 */
export class SpellGrantReversalService {
  static #clone(value) { return foundry.utils.deepClone(value); }
  static #equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

  static nativeReceipt(nativeSpell, normalSpell, previousSnapshot) {
    const nativeActivities = nativeSpell.toObject().system?.activities ?? {};
    const normalActivities = normalSpell.toObject().system?.activities ?? {};
    const addedActivityIds = [];
    const activityConsumptionPrevious = {};
    const activityConsumptionApplied = {};
    const isItemUses = row => String(row?.type ?? "") === "itemUses";

    for (const [id, activity] of Object.entries(nativeActivities)) {
      const original = normalActivities[id];
      if (!original) {
        // D&D5e Activity IDs can differ across equivalent spell projections.
        // The caller has already compared their semantic fingerprints: a
        // non-Forward activity with a different ID is still a normal casting
        // activity and must never be deleted on grant retirement.
        if (activity?.type !== "forward") continue;
        if (!(activity.consumption?.targets ?? []).some(isItemUses)) return null;
        addedActivityIds.push(id);
        continue;
      }
      const before = original.consumption?.targets ?? [];
      const after = activity.consumption?.targets ?? [];
      if (this.#equal(before, after)) continue;
      if (!before.every(target => after.some(row => this.#equal(row, target)))
        || !after.some(row => isItemUses(row) && !before.some(prev => this.#equal(prev, row)))) return null;
      activityConsumptionPrevious[id] = this.#clone(before);
      activityConsumptionApplied[id] = this.#clone(after);
    }

    return {
      kind: "native-item-grant",
      previousUses: this.#clone(previousSnapshot?.uses ?? normalSpell.system?.uses ?? {}),
      appliedUses: this.#clone(nativeSpell.system?.uses ?? {}),
      addedActivityIds,
      activityConsumptionPrevious,
      activityConsumptionApplied
    };
  }

  static removalUpdate(spell, { retiring = [], surviving = [], reconciliation = null,
    expectedGrantUses = [] } = {}) {
    if (spell?.type !== "spell") return {};
    const history = reconciliation ?? spell.getFlag(MODULE_ID, "alwaysPreparedReconciliation") ?? {};
    const mechanical = retiring.map(row => row?.augmentation).filter(Boolean);
    const native = retiring.some(row => row?.nativeProjectionSurvivor || row?.grantKind === "augmenting")
      && Boolean(history.nativeProjectionSurvivor);
    if (!mechanical.length && !native) return {};
    // Two free-cast sources must never restore the normal use pool when only
    // one source is removed. The remaining augmentation is authoritative.
    const stillAugmented = surviving.some(row => row?.augmentation || row?.nativeProjectionSurvivor
      || row?.grantKind === "augmenting");
    if (stillAugmented) return {};

    const update = {};
    const originalSnapshot = history.normalAcquisition?.previousSnapshot ?? {};
    const previousUses = mechanical.find(row => row.previousUses)?.previousUses
      ?? (native ? originalSnapshot.uses : null);
    const currentUses = spell.toObject().system?.uses ?? {};
    const appliedUses = mechanical.find(row => row.appliedUses)?.appliedUses;
    const samePool = (expected, current) => String(expected?.max ?? "") === String(current?.max ?? "")
      && this.#equal(expected?.recovery ?? [], current?.recovery ?? []);
    // `spent` is deliberately ignored when verifying the grant's identity:
    // using the free cast changes spent but not the native max/recovery rules.
    const matchesOldNativeUse = expectedGrantUses.some(config =>
      String(config?.max ?? "") === String(currentUses.max ?? "")
      && (currentUses.recovery ?? []).some(row => String(row?.period ?? "") === String(config?.per ?? "")));
    if (previousUses && ((appliedUses && samePool(appliedUses, currentUses))
      || (!appliedUses && (!native || matchesOldNativeUse)))) {
      update["system.uses"] = foundry.data.operators.ForcedReplacement.create(this.#clone(previousUses));
    }

    const currentActivities = spell.toObject().system?.activities ?? {};
    const baselineActivities = originalSnapshot.activities ?? {};
    const claimedBySurvivor = new Set(surviving.flatMap(row => row?.augmentation?.addedActivityIds ?? []));
    const explicitlyAdded = new Set(mechanical.flatMap(row => row.addedActivityIds ?? []));
    if (native) {
      for (const [id, activity] of Object.entries(currentActivities)) {
        if (baselineActivities[id] || claimedBySurvivor.has(id)) continue;
        if (activity?.type === "forward" && (activity.consumption?.targets ?? [])
          .some(target => target?.type === "itemUses")) explicitlyAdded.add(id);
      }
    }
    for (const id of explicitlyAdded) {
      const activity = currentActivities[id];
      if (!activity || claimedBySurvivor.has(id)) continue;
      if (activity.type !== "forward" || !(activity.consumption?.targets ?? []).some(row => row?.type === "itemUses")) continue;
      update[`system.activities.-=${id}`] = null;
    }

    const consumption = new Map();
    for (const delta of mechanical) {
      for (const [id, before] of Object.entries(delta.activityConsumptionPrevious ?? {})) {
        consumption.set(id, { before, after: delta.activityConsumptionApplied?.[id] ?? null });
      }
    }
    if (native) {
      for (const [id, original] of Object.entries(baselineActivities)) {
        const current = currentActivities[id];
        if (!current || consumption.has(id)) continue;
        const before = original.consumption?.targets ?? [];
        const after = current.consumption?.targets ?? [];
        if (!this.#equal(before, after)) consumption.set(id, { before, after: null });
      }
    }
    for (const [id, { before, after }] of consumption.entries()) {
      const current = currentActivities[id];
      if (!current) continue;
      const targets = current.consumption?.targets ?? [];
      if (after && !this.#equal(after, targets)) continue;
      // An unknown edit is never replaced. A safe legacy delta consists only
      // of added ItemUses targets, with every original target still intact.
      if (!before.every(row => targets.some(target => this.#equal(row, target)))) continue;
      if (targets.some(row => !before.some(prev => this.#equal(prev, row)) && row?.type !== "itemUses")) continue;
      update[`system.activities.${id}.consumption.targets`] = this.#clone(before);
    }
    return update;
  }
}
