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
 * Builder only closes the observed fresh-materialization gap where the source
 * profile's base current HP survives while the native synthetic Actor already
 * has the correctly scaled maximum HP.
 */
export class FindSteedAssistanceService {
  static get policyId() {
    return POLICY_ID;
  }

  // Do not copy Primal Companion's replacement semantics. Find Steed's own
  // source/native lifecycle remains authoritative; this policy only fixes the
  // freshly materialized current HP state.
  static get exclusive() {
    return false;
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
      // SET, never add. The maximum is D&D5e's final derived value. If the
      // system later materializes Find Steed at full HP itself, this is a no-op.
      foundry.utils.setProperty(data, "system.attributes.hp.value", hpMax);
    }
    return data;
  }
}

export const FIND_STEED_RULE_ID = RULE_ID;
