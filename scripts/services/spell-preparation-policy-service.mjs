/**
 * Central preparation-state policy for Spell Items created by the current
 * Character Builder workflows. It intentionally performs no Actor migration.
 *
 * D&D5e preparation states:
 *   0 = Unprepared
 *   1 = Prepared
 *   2 = Always Prepared
 */
export class SpellPreparationPolicyService {
  static UNPREPARED = 0;
  static PREPARED = 1;
  static ALWAYS_PREPARED = 2;

  /**
   * Resolve the native D&D5e preparation state for a newly-created or replaced
   * spell. Cantrips are always available and therefore always use state 2.
   */
  static resolve({
    level = null,
    alwaysPrepared = false,
    explicitPrepared = null,
    category = "",
    accessModel = ""
  } = {}) {
    const numericLevel = Number(level);
    if (Number.isFinite(numericLevel) && numericLevel === 0) return this.ALWAYS_PREPARED;
    if (alwaysPrepared) return this.ALWAYS_PREPARED;

    if (explicitPrepared !== null && explicitPrepared !== undefined && explicitPrepared !== "") {
      const explicit = Number(explicitPrepared);
      if ([this.UNPREPARED, this.PREPARED, this.ALWAYS_PREPARED].includes(explicit)) return explicit;
    }

    const normalizedCategory = String(category ?? "").trim().toLowerCase();
    const normalizedModel = String(accessModel ?? "").trim().toLowerCase();
    if (["spellbook", "wizard-savant", "full-list", "scribed", "scribe-spell"].includes(normalizedCategory)
      || ["spellbook", "full-list"].includes(normalizedModel)) {
      return this.UNPREPARED;
    }
    return this.PREPARED;
  }

  static applyToData(data, options = {}) {
    data.system ??= {};
    data.system.prepared = this.resolve({
      level: data.system.level,
      ...options
    });
    return data.system.prepared;
  }

  /**
   * Normalize only cantrips created by the active workflow. Item IDs that
   * existed before the transaction are immutable input and are never touched.
   */
  static async normalizeNewCantrips(actor, {
    beforeItemIds = new Set(),
    updateOptions = {}
  } = {}) {
    const protectedIds = beforeItemIds instanceof Set ? beforeItemIds : new Set(beforeItemIds ?? []);
    const updates = actor?.items?.filter?.(item =>
      item.type === "spell"
      && !protectedIds.has(item.id)
      && Number(item.system?.level ?? -1) === 0
      && Number(item.system?.prepared ?? -1) !== this.ALWAYS_PREPARED
    ).map(item => ({ _id: item.id, "system.prepared": this.ALWAYS_PREPARED })) ?? [];
    if (!updates.length) return [];
    await actor.updateEmbeddedDocuments("Item", updates, {
      characterBuilderSpellPreparationPolicy: true,
      ...updateOptions
    });
    return updates.map(update => update._id);
  }
}
