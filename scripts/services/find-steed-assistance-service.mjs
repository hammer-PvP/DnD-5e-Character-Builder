import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "paladin-find-steed";
const POLICY_ID = "paladin-find-steed";

function normalized(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Source-specific Managed Summons policy for the 2024 Find Steed spell.
 *
 * D&D5e remains authoritative for every derived Steed statistic. Character
 * Builder keeps the source-specific exclusivity policy here; generic fresh-HP
 * reconciliation and lifecycle decisions belong to ManagedSummonsService.
 */
export class FindSteedAssistanceService {
  static get policyId() {
    return POLICY_ID;
  }

  static get exclusive() {
    return true;
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static matches(activity) {
    const item = activity?.item;
    if (!item) return false;
    const identities = new Set([
      item?.system?.identifier,
      item?.identifier,
      item?.name
    ].map(normalized).filter(Boolean));
    if (identities.has("find-steed")) return true;

    const source = String(item?.getFlag?.("dnd5e", "sourceId")
      ?? item?._stats?.compendiumSource
      ?? item?._stats?.duplicateSource
      ?? "").toLowerCase();
    return source.includes("findsteed") || source.includes("find-steed");
  }


}

export const FIND_STEED_RULE_ID = RULE_ID;
