import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "require-ammunition";

/**
 * Optional attack gate over D&D5e 6.x's native ammunition pipeline.
 *
 * Character Builder does not select, consume, persist, or modify ammunition.
 * D&D5e remains authoritative for the roll dialog, the selected ammunition,
 * quantity consumption, magical bonuses, damage linkage, and auto-destroy.
 * This service only prevents an Ammunition weapon from attacking when D&D5e
 * itself reports no eligible in-inventory ammunition stack with quantity.
 */
export class AmmunitionRequirementService {
  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  /**
   * libWrapper entry point for dnd5e.documents.activity.AttackActivity#rollAttack.
   */
  static async wrapRollAttack(activity, wrapped, config = {}, dialog = {}, message = {}) {
    if (!this.enabled() || !this.#requiresAmmunition(activity)) {
      return wrapped(config, dialog, message);
    }

    // Use the exact native D&D5e eligibility list that feeds the attack dialog.
    // Options with quantity 0 remain present but disabled, so they do not satisfy
    // the requirement. Do not duplicate subtype/container rules here.
    const options = Array.from(activity.item?.system?.ammunitionOptions ?? []);
    const hasEligibleAmmunition = options.some(option => option && option.disabled !== true
      && Number(option.item?.system?.quantity ?? 0) > 0);

    if (!hasEligibleAmmunition) {
      ui.notifications?.warn?.("No eligible ammunition is available in this character's inventory.");
      return null;
    }

    // Eligible ammunition exists. From this point onward Character Builder is
    // intentionally absent: D&D5e opens its normal roll dialog, keeps its own
    // selected ammunition, applies magical bonuses, and consumes the stack.
    return wrapped(config, dialog, message);
  }

  static #requiresAmmunition(activity) {
    const item = activity?.item;
    return Boolean(activity?.type === "attack"
      && item?.type === "weapon"
      && item?.actor
      && item.system?.properties?.has?.("amm"));
  }
}

export const REQUIRE_AMMUNITION_RULE_ID = RULE_ID;
