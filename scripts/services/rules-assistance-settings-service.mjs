import {
  MODULE_ID,
  RULES_ASSISTANCE_DEFINITIONS,
  defaultSettings
} from "../constants.mjs";

/**
 * Resolves the GM world-level master switch and the persisted per-rule choices.
 * Existing worlds that predate granular settings inherit every current rule as
 * enabled while preserving the previous master-switch state.
 */
export class RulesAssistanceSettingsService {
  static settings(candidate = null) {
    const stored = candidate ?? globalThis.game?.settings?.get?.(MODULE_ID, "settings") ?? {};
    const merge = globalThis.foundry?.utils?.mergeObject;
    return merge
      ? merge(defaultSettings(), stored, { inplace: false })
      : this.#deepMerge(defaultSettings(), stored);
  }

  static masterEnabled(candidate = null) {
    return this.settings(candidate).assistWithDiceAutomation === true;
  }

  static configuredRuleEnabled(ruleIdOrKey, candidate = null) {
    const definition = this.definition(ruleIdOrKey);
    if (!definition) return false;
    const settings = this.settings(candidate);
    return settings.rulesAssistance?.rules?.[definition.key] !== false;
  }

  static ruleEnabled(ruleIdOrKey, candidate = null) {
    return this.masterEnabled(candidate) && this.configuredRuleEnabled(ruleIdOrKey, candidate);
  }

  static managedSummonFoldersEnabled(candidate = null) {
    const settings = this.settings(candidate);
    return settings.rulesAssistance?.managedSummons?.organizeFolders !== false;
  }

  static definition(ruleIdOrKey) {
    const value = String(ruleIdOrKey ?? "");
    return RULES_ASSISTANCE_DEFINITIONS.find(rule => rule.ruleId === value || rule.key === value) ?? null;
  }

  static rows(candidate = null) {
    const settings = this.settings(candidate);
    return RULES_ASSISTANCE_DEFINITIONS.map(rule => ({
      ...rule,
      enabled: settings.rulesAssistance?.rules?.[rule.key] !== false
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
