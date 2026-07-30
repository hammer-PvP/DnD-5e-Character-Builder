/**
 * Pure helpers used by the runtime rules-assistance layer.
 *
 * These functions deliberately operate on roll configuration formulas rather
 * than on embedded Item data. Nothing here persists a formula change to an
 * Actor, Item, Activity, or Active Effect.
 */
export class RulesAssistanceFormulaService {
  /**
   * Apply a minimum result to every ordinary dice term in a formula.
   * Existing equal-or-stronger minimum modifiers are preserved and weaker
   * minimum modifiers are upgraded in place.
   *
   * @param {string} formula
   * @param {number} minimum
   * @returns {{ formula: string, changed: boolean, alreadyApplied: boolean }}
   */
  static applyDieMinimum(formula, minimum = 3) {
    const source = String(formula ?? "");
    if (!source || !Number.isInteger(minimum) || minimum < 1) {
      return { formula: source, changed: false, alreadyApplied: false };
    }

    let changed = false;
    let alreadyApplied = false;
    const result = source.replace(
      /((?:\d+|@[A-Za-z0-9_.]+|\([^()]+\))?d(?:\d+|@[A-Za-z0-9_.]+|\([^()]+\)))((?:[A-Za-z]+\d*)*)/g,
      (match, die, modifiers = "") => {
        const minimumMatch = String(modifiers).match(/min(\d+)/i);
        if (minimumMatch) {
          const current = Number(minimumMatch[1]);
          if (current >= minimum) {
            alreadyApplied = true;
            return match;
          }
          changed = true;
          return `${die}${String(modifiers).replace(/min\d+/i, `min${minimum}`)}`;
        }
        changed = true;
        return `${die}${modifiers ?? ""}min${minimum}`;
      }
    );

    return { formula: result, changed, alreadyApplied };
  }

  static includesAbilityModifier(parts = [], ability = "") {
    const needle = `@abilities.${String(ability)}.mod`;
    return (parts ?? []).some(part => String(part ?? "").replace(/\s+/g, "").includes(needle));
  }

  static includesMarker(rollConfig, ruleId) {
    return Boolean(rollConfig?.options?.dnd5eCharacterBuilderRulesAssistance?.[ruleId]);
  }

  static mark(rollConfig, ruleId, data = {}) {
    rollConfig.options ??= {};
    rollConfig.options.dnd5eCharacterBuilderRulesAssistance ??= {};
    rollConfig.options.dnd5eCharacterBuilderRulesAssistance[ruleId] = {
      applied: true,
      ...data
    };
  }
}
