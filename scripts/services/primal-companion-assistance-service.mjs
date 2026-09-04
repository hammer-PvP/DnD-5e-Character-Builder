import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "ranger-primal-companion";
const POLICY_ID = "ranger-primal-companion";

/**
 * Source-specific policy consumed by ManagedSummonsService.
 *
 * D&D5e remains authoritative for every Primal Companion statistic except the
 * X3-observed fresh-summon current-HP gap. The generic Managed Summons core
 * owns materialization, ownership, folders, instance identity, and cleanup.
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

  static prepareManagedActorData(data, synthetic) {
    const hpMax = Number(synthetic?.system?.attributes?.hp?.max ?? 0);
    const hpValue = Number(synthetic?.system?.attributes?.hp?.value ?? 0);
    if (Number.isFinite(hpMax) && hpMax > 0 && hpValue !== hpMax) {
      // SET, never add. If D&D5e fixes fresh-summon current HP later, this is a
      // no-op and can never create double maximum HP.
      foundry.utils.setProperty(data, "system.attributes.hp.value", hpMax);
    }
    return data;
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
