import { ABILITIES } from "../constants.mjs";

/**
 * Pure policy helpers for reversible Character Creation stages.
 *
 * The live Draft remains authoritative. These helpers only describe edit state
 * and deterministic Ability Score slot movement.
 */
export class CreationEditService {
  static STAGES = Object.freeze({
    abilitiesBackground: "abilitiesBackground",
    species: "species",
    class: "class",
    spells: "spells",
    equipment: "equipment"
  });

  static editingStages(state = {}) {
    const source = state?.editingStages ?? {};
    return {
      abilitiesBackground: Boolean(source.abilitiesBackground),
      species: Boolean(source.species),
      class: Boolean(source.class),
      spells: Boolean(source.spells),
      equipment: Boolean(source.equipment)
    };
  }

  static isEditing(state, stage) {
    return Boolean(this.editingStages(state)[stage]);
  }

  static withEditing(state, stage, editing) {
    return {
      ...this.editingStages(state),
      [stage]: Boolean(editing)
    };
  }

  /**
   * Move one unique array slot to an Ability. If another Ability owns the slot,
   * it becomes unassigned. The destination's prior slot becomes available.
   */
  static moveAbilitySlot(assignments, abilityKey, selectedId, validSlotIds) {
    const next = structuredClone(assignments ?? {});
    const validAbilities = new Set(ABILITIES.map(ability => ability.key));
    if (!validAbilities.has(abilityKey)) return next;

    if (!selectedId) {
      delete next[abilityKey];
      return next;
    }
    if (!validSlotIds?.has?.(selectedId)) return next;

    for (const ability of ABILITIES) {
      if (ability.key !== abilityKey && next[ability.key] === selectedId) {
        delete next[ability.key];
        break;
      }
    }
    next[abilityKey] = selectedId;
    return next;
  }


  static optionLabel(slot, assignments, destinationAbilityKey) {
    const assigned = ABILITIES.find(ability => assignments?.[ability.key] === slot.id) ?? null;
    if (!assigned || assigned.key === destinationAbilityKey) return String(slot.value);
    return `${slot.value} — currently assigned to ${assigned.label}`;
  }
}
