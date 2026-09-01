import {
  MODULE_ID,
  PLAYER_SHEET_INTEGRITY_DEFINITIONS,
  UNPREPARED_SPELL_USAGE_MODES,
  defaultSettings
} from "../constants.mjs";

/**
 * Resolves the world-level Player Character Sheet Integrity master switch and
 * its deliberately coarse protection packages. Existing worlds inherit the
 * recommended enabled state for every package while retaining their previous
 * master-switch choice.
 */
export class PlayerSheetIntegritySettingsService {
  static settings(candidate = null) {
    const stored = candidate ?? globalThis.game?.settings?.get?.(MODULE_ID, "settings") ?? {};
    const merge = globalThis.foundry?.utils?.mergeObject;
    return merge
      ? merge(defaultSettings(), stored, { inplace: false })
      : this.#deepMerge(defaultSettings(), stored);
  }

  static masterEnabled(candidate = null) {
    return this.settings(candidate).playerSheetIntegrity === true;
  }

  static configuredRuleEnabled(ruleKey, candidate = null) {
    const definition = this.definition(ruleKey);
    if (!definition) return false;
    const settings = this.settings(candidate);
    return settings.playerSheetIntegrityConfig?.rules?.[definition.key] !== false;
  }

  static ruleEnabled(ruleKey, candidate = null) {
    return this.masterEnabled(candidate) && this.configuredRuleEnabled(ruleKey, candidate);
  }

  static unpreparedSpellUsageMode(candidate = null) {
    const raw = String(this.settings(candidate).playerSheetIntegrityConfig?.unpreparedSpellUsage ?? "");
    return Object.values(UNPREPARED_SPELL_USAGE_MODES).includes(raw)
      ? raw
      : UNPREPARED_SPELL_USAGE_MODES.off;
  }

  static unpreparedSpellUsageActive(candidate = null) {
    return this.masterEnabled(candidate) && this.unpreparedSpellUsageMode(candidate) !== UNPREPARED_SPELL_USAGE_MODES.off;
  }

  static unpreparedSpellUsageOptions(candidate = null) {
    const current = this.unpreparedSpellUsageMode(candidate);
    return [
      { value: UNPREPARED_SPELL_USAGE_MODES.off, label: "On", description: "Allow level 1+ unprepared spells to be cast normally.", selected: current === UNPREPARED_SPELL_USAGE_MODES.off },
      { value: UNPREPARED_SPELL_USAGE_MODES.combatOnly, label: "Out of Combat Only", description: "Allow unprepared spells outside combat, but require preparation while the Actor is in combat.", selected: current === UNPREPARED_SPELL_USAGE_MODES.combatOnly },
      { value: UNPREPARED_SPELL_USAGE_MODES.always, label: "Off", description: "Do not allow level 1+ unprepared spells to be cast, except the Wizard Ritual Adept ritual exception outside combat.", selected: current === UNPREPARED_SPELL_USAGE_MODES.always }
    ];
  }

  static unpreparedSpellUsageLabel(candidate = null) {
    return this.unpreparedSpellUsageOptions(candidate).find(row => row.selected)?.label ?? "On";
  }

  static definition(ruleKey) {
    const value = String(ruleKey ?? "");
    return PLAYER_SHEET_INTEGRITY_DEFINITIONS.find(rule => rule.key === value) ?? null;
  }

  static rows(candidate = null) {
    const settings = this.settings(candidate);
    return PLAYER_SHEET_INTEGRITY_DEFINITIONS.map(rule => ({
      ...rule,
      enabled: settings.playerSheetIntegrityConfig?.rules?.[rule.key] !== false
    }));
  }

  static summary(candidate = null) {
    const rows = this.rows(candidate);
    return {
      masterEnabled: this.masterEnabled(candidate),
      enabledCount: rows.filter(rule => rule.enabled).length,
      totalCount: rows.length,
      rows,
      unpreparedSpellUsageMode: this.unpreparedSpellUsageMode(candidate),
      unpreparedSpellUsageLabel: this.unpreparedSpellUsageLabel(candidate)
    };
  }

  /**
   * Return whether a stored settings object explicitly knew about a given
   * rule. This lets version migration distinguish a newly introduced
   * recommended protection from a rule the GM deliberately configured.
   */
  static hasStoredRule(ruleKey, candidate = null) {
    const stored = candidate ?? globalThis.game?.settings?.get?.(MODULE_ID, "settings") ?? {};
    return Object.prototype.hasOwnProperty.call(stored?.playerSheetIntegrityConfig?.rules ?? {}, String(ruleKey ?? ""));
  }

  static #deepMerge(base, other) {
    if (Array.isArray(base) || Array.isArray(other)) return structuredClone(other ?? base);
    const output = { ...(base ?? {}) };
    for (const [key, value] of Object.entries(other ?? {})) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        output[key] = this.#deepMerge(output[key] ?? {}, value);
      } else output[key] = value;
    }
    return output;
  }
}
