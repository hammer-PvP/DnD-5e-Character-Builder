import {
  SPELL_PREPARATION_CADENCE_BY_CLASS,
  SPELL_PREPARATION_CADENCES
} from "../constants.mjs";

/**
 * Rules timing for replacing ordinary prepared spells.
 *
 * This deliberately does not describe how a class gains spell access. Access
 * model and preparation cadence are independent: Ranger is the canonical
 * example (full-list access, one-for-one replacement at Long Rest), while
 * Wizard uses a spellbook and refreshes its ordinary prepared list at Long Rest.
 */
export class SpellPreparationCadenceService {
  static LONG_REST = SPELL_PREPARATION_CADENCES.longRest;
  static LONG_REST_REPLACE_ONE = SPELL_PREPARATION_CADENCES.longRestReplaceOne;
  static LEVEL_UP = SPELL_PREPARATION_CADENCES.levelUp;
  static SPECIAL = SPELL_PREPARATION_CADENCES.special;

  static forClass(clsOrIdentifier) {
    const identifier = typeof clsOrIdentifier === "string"
      ? clsOrIdentifier
      : clsOrIdentifier?.system?.identifier;
    return SPELL_PREPARATION_CADENCE_BY_CLASS[String(identifier ?? "").trim().toLowerCase()] ?? null;
  }

  static allowsLongRest(clsOrIdentifier) {
    return [this.LONG_REST, this.LONG_REST_REPLACE_ONE].includes(this.forClass(clsOrIdentifier));
  }

  static replacesOneAtLongRest(clsOrIdentifier) {
    return this.forClass(clsOrIdentifier) === this.LONG_REST_REPLACE_ONE;
  }

  static allowsLevelUp(clsOrIdentifier) {
    return this.forClass(clsOrIdentifier) === this.LEVEL_UP;
  }

  static label(clsOrIdentifier) {
    switch (this.forClass(clsOrIdentifier)) {
      case this.LONG_REST: return "Long Rest";
      case this.LONG_REST_REPLACE_ONE: return "Long Rest — Replace One";
      case this.LEVEL_UP: return "Level Up";
      case this.SPECIAL: return "Special Rule";
      default: return "Unknown";
    }
  }
}
