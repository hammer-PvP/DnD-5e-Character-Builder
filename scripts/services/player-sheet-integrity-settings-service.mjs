import {
  MODULE_ID,
  PLAYER_SHEET_INTEGRITY_DEFINITIONS,
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
      rows
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
