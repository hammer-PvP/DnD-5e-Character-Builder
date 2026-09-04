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

  /**
   * Maximize every ordinary numeric die using Foundry's native `minN` die
   * modifier. Dynamic-face dice are rejected instead of guessed so the derived
   * Activity remains portable across the D&D5e roll pipeline.
   *
   * @returns {{ formula: string, changed: boolean, compatible: boolean, reason?: string }}
   */
  static maximizeNumericDice(formula) {
    const source = String(formula ?? "");
    if (!source.trim()) return { formula: source, changed: false, compatible: false, reason: "No healing formula was found." };

    // Any die whose face count is not a literal integer is deliberately outside
    // this assistance contract.
    const dynamicDie = /(?:\d+|@[A-Za-z0-9_.]+|\([^()]+\))?d(?:@|\()/i;
    if (dynamicDie.test(source)) {
      return { formula: source, changed: false, compatible: false, reason: "The formula uses a dynamic die size that cannot be maximized safely." };
    }

    let found = false;
    let changed = false;
    const result = source.replace(
      /((?:\d+)?d(\d+))((?:[A-Za-z]+\d*)*)/gi,
      (match, die, faces, modifiers = "") => {
        found = true;
        const maximum = Number(faces);
        if (!Number.isInteger(maximum) || maximum < 1) return match;
        const minimumMatch = String(modifiers).match(/min(\d+)/i);
        if (minimumMatch) {
          const current = Number(minimumMatch[1]);
          if (current === maximum) return match;
          changed = true;
          return `${die}${String(modifiers).replace(/min\d+/i, `min${maximum}`)}`;
        }
        changed = true;
        return `${die}${modifiers ?? ""}min${maximum}`;
      }
    );
    if (!found) return { formula: source, changed: false, compatible: false, reason: "The healing formula contains no numeric dice to maximize." };
    return { formula: result, changed, compatible: true };
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
