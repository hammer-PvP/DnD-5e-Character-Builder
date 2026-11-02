/**
 * Additional native spellcasting progressions only (D&D5e 6.x).
 *
 * IMPORTANT: Do NOT route legacy full/half/third/pact through this service.
 * Their validated class/subclass-specific formulas remain unchanged in the
 * existing consumers. This resolver extends support for progression identifiers
 * registered by D&D5e itself, without naming books or classes.
 */
export class AdditionalNativeSpellProgressionService {
  static #legacy = new Set(["full", "half", "third", "pact"]);

  static isAdditionalRegistered(progression) {
    const key = String(progression ?? "").trim().toLowerCase();
    return !this.#legacy.has(key) && key !== "none"
      && Boolean(globalThis.CONFIG?.DND5E?.spellProgression?.[key]?.type);
  }

  static maximumSpellLevel(progression, classLevel) {
    const key = String(progression ?? "").trim().toLowerCase();
    const level = Math.trunc(Number(classLevel));
    if (!Number.isFinite(level) || level <= 0 || !this.isAdditionalRegistered(key)) return 0;

    const config = globalThis.CONFIG?.DND5E;
    const registration = config.spellProgression[key];
    const method = config.spellcasting?.[registration.type];
    const definition = method?.progression?.[key] ?? registration;
    const divisor = Number(definition?.divisor ?? 1);
    if (!method || typeof method.calculateSlots !== "function" || !Number.isFinite(divisor) || divisor <= 0) {
      throw new Error(`Invalid native D&D5e spell progression '${key}': missing slot calculation or divisor.`);
    }

    // Use the source CLASS level; multiclass slot totals do not grant access
    // to a higher-level spell on a particular class's spell list.
    const effectiveLevel = (definition.roundUp ? Math.ceil : Math.floor)(level / divisor);
    if (effectiveLevel <= 0) return 0;
    const slots = method.calculateSlots(effectiveLevel) ?? {};
    return Object.entries(slots).reduce((highest, [spellLevel, count]) => {
      const tier = Number(spellLevel);
      return Number.isInteger(tier) && tier >= 1 && Number(count) > 0
        ? Math.max(highest, tier) : highest;
    }, 0);
  }
}
