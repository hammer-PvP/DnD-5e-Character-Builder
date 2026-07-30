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
   * Normalize array-slot ownership so each valid slot belongs to at most one
   * Ability. Invalid, empty, and duplicate assignments are discarded.
   */
  static normalizeAbilitySlotAssignments(assignments, validSlotIds) {
    const normalized = {};
    const claimed = new Set();
    for (const ability of ABILITIES) {
      const selectedId = String(assignments?.[ability.key] ?? "");
      if (!selectedId || !validSlotIds?.has?.(selectedId) || claimed.has(selectedId)) continue;
      normalized[ability.key] = selectedId;
      claimed.add(selectedId);
    }
    return normalized;
  }

  /**
   * Move one unique array slot to an Ability. If another Ability owns the slot,
   * every previous reference is removed. Selecting an empty value explicitly
   * clears the destination Ability and returns its former slot to the pool.
   */
  static moveAbilitySlot(assignments, abilityKey, selectedId, validSlotIds) {
    const validAbilities = new Set(ABILITIES.map(ability => ability.key));
    const next = this.normalizeAbilitySlotAssignments(assignments, validSlotIds);
    if (!validAbilities.has(abilityKey)) return next;

    // Always release the destination's previous slot first. This also makes the
    // real "— Select —" option reversible without relying on a disabled placeholder.
    delete next[abilityKey];

    const requestedId = String(selectedId ?? "");
    if (!requestedId) return next;
    if (!validSlotIds?.has?.(requestedId)) return next;

    // The selected slot must have exactly one owner. Remove every stale or
    // duplicated reference before assigning it to the new destination.
    for (const ability of ABILITIES) {
      if (next[ability.key] === requestedId) delete next[ability.key];
    }
    next[abilityKey] = requestedId;
    return next;
  }


  static optionLabel(slot, assignments, destinationAbilityKey) {
    const assigned = ABILITIES.find(ability => assignments?.[ability.key] === slot.id) ?? null;
    if (!assigned || assigned.key === destinationAbilityKey) return String(slot.value);
    return `${slot.value} — currently assigned to ${assigned.label}`;
  }
}
