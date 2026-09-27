import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "ranger-primal-companion";
const POLICY_ID = "ranger-primal-companion";

/**
 * Source-specific policy consumed by ManagedSummonsService.
 *
 * D&D5e remains authoritative for Primal Companion statistics. The generic
 * Managed Summons core owns materialization, fresh-HP reconciliation, ownership,
 * folders, instance identity, zero-HP decisions, and cleanup.
 */
export class PrimalCompanionAssistanceService {
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
    const identifier = String(item?.system?.identifier ?? "").trim().toLowerCase();
    if (identifier === "primal-companion") return true;
    const source = String(item?.getFlag?.("dnd5e", "sourceId") ?? item?._stats?.compendiumSource ?? "").toLowerCase();
    return source.includes("primal") && String(activity?.name ?? "").trim().toLowerCase() === "summon companion";
  }

  static companionType(profileName, tokenName = "") {
    const value = `${profileName ?? ""} ${tokenName ?? ""}`.toLowerCase();
    if (value.includes("sky")) return "sky";
    if (value.includes("sea")) return "sea";
    if (value.includes("land")) return "land";
    return "unknown";
  }
}

export const PRIMAL_COMPANION_RULE_ID = RULE_ID;
