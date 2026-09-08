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
 * Builder closes two administrative gaps only: fresh current HP is reconciled
 * to the already-derived native maximum, and a successful new casting replaces
 * that caster's previous Find Steed managed instance.
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

  static prepareManagedActorData(data, synthetic) {
    const hpMax = Number(synthetic?.system?.attributes?.hp?.max ?? 0);
    const hpValue = Number(synthetic?.system?.attributes?.hp?.value ?? 0);
    if (Number.isFinite(hpMax) && hpMax > 0 && Number.isFinite(hpValue) && hpValue !== hpMax) {
      // SET, never add. D&D5e has already calculated the correct derived Max HP.
      foundry.utils.setProperty(data, "system.attributes.hp.value", hpMax);
    }
    return data;
  }
}

export const FIND_STEED_RULE_ID = RULE_ID;
