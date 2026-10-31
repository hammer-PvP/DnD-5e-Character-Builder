/**
 * Class-local spell accessibility, driven by the D&D5e registered casting
 * progression for additional methods (for example, artificer).
 *
 * The four previously validated PHB 2024 paths remain unchanged for this
 * incremental release; they can migrate here individually after equivalence QA.
 * This service does not compute multiclass slot totals or grant spell Items.
 */
export class SpellProgressionService {
  static #legacy = new Set(["full", "half", "third", "pact"]);

  static isRegistered(progression) {
    const key = String(progression ?? "").trim().toLowerCase();
    return this.#legacy.has(key) || Boolean(globalThis.CONFIG?.DND5E?.spellProgression?.[key]?.type);
  }

  /**
   * @param {string} progression Native class/subclass progression identifier.
   * @param {number} level Level *in that class*, not the character's total level.
   * @param {string} legacyThirdFlavor Preserves both historical third-caster paths
   *   until their existing behavior is migrated and regression-tested.
   */
  static maximumSpellLevel(progression, level, { legacyThirdFlavor = "standard" } = {}) {
    const classLevel = Math.trunc(Number(level));
    if (!Number.isFinite(classLevel) || classLevel <= 0) return 0;
    const key = String(progression ?? "").trim().toLowerCase();
    switch (key) {
      case "full": return Math.min(9, Math.ceil(classLevel / 2));
      case "half": return Math.min(5, Math.max(1, Math.floor((classLevel + 3) / 4)));
      case "third":
        return legacyThirdFlavor === "subclass"
          ? classLevel < 3 ? 0 : classLevel < 7 ? 1 : classLevel < 13 ? 2 : classLevel < 19 ? 3 : 4
          : Math.min(4, Math.max(1, Math.floor((classLevel + 2) / 3)));
      case "pact": return Math.min(5, Math.ceil(classLevel / 2));
      case "none": return 0;
    }

    const registration = globalThis.CONFIG?.DND5E?.spellProgression?.[key];
    const method = registration?.type && globalThis.CONFIG?.DND5E?.spellcasting?.[registration.type];
    const declared = method?.progression?.[key] ?? registration;
    const divisor = Number(declared?.divisor);
    if (!registration?.type || !method || !Number.isFinite(divisor) || divisor <= 0
      || typeof method.calculateSlots !== "function") {
      throw new Error(`Unsupported D&D5e spellcasting progression: ${key || "(empty)"}. Verify the class source and the system's registered spellcasting methods.`);
    }
    // A single class's accessibility is based on its own progression. For
    // multiclass characters, the D&D5e system independently aggregates slots.
    // We must never use the aggregate multiclass slots to unlock class spells.
    const effectiveLevel = (declared.roundUp ? Math.ceil : Math.floor)(classLevel / divisor);
    if (effectiveLevel <= 0) return 0;
    const slots = method.calculateSlots(effectiveLevel) ?? {};
    return Object.entries(slots).reduce((max, [spellLevel, available]) =>
      Number(available) > 0 && Number.isInteger(Number(spellLevel))
        ? Math.max(max, Number(spellLevel)) : max, 0);
  }
}
