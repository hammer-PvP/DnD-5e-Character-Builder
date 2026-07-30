import { ABILITIES } from "../constants.mjs";

/**
 * Pure policy helpers for reversible Character Creation stages and Array-based
 * Ability Score assignment.
 *
 * Array methods use slot ownership as their single source of truth. A slot is
 * one token from Standard Array, Custom Array, or a rolled set. The slot owns at
 * most one assigned Ability, so the same token cannot exist in two selects.
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
   * Build the canonical slot-owned state from the current method definitions.
   * Stored v0.9.8i slots are preferred. Older ability -> slot assignments are
   * accepted only as a one-way migration source.
   */
  static normalizeAbilityArraySlots(definitions = [], storedSlots = [], legacyAssignments = {}) {
    const validAbilities = new Set(ABILITIES.map(ability => ability.key));
    const storedById = new Map();
    if (Array.isArray(storedSlots)) {
      for (const slot of storedSlots) {
        const id = String(slot?.id ?? "");
        if (id && !storedById.has(id)) storedById.set(id, slot);
      }
    }

    const legacyOwnerById = new Map();
    for (const ability of ABILITIES) {
      const id = String(legacyAssignments?.[ability.key] ?? "");
      if (id && !legacyOwnerById.has(id)) legacyOwnerById.set(id, ability.key);
    }

    const claimedAbilities = new Set();
    return definitions.map((definition, index) => {
      const id = String(definition?.id ?? `slot-${index}`);
      const stored = storedById.get(id);
      let assignedAbility = String((stored ? stored.assignedAbility : legacyOwnerById.get(id)) ?? "");
      if (!validAbilities.has(assignedAbility) || claimedAbilities.has(assignedAbility)) assignedAbility = "";
      if (assignedAbility) claimedAbilities.add(assignedAbility);
      return {
        id,
        value: Number(definition?.value),
        index: Number.isInteger(definition?.index) ? definition.index : index,
        assignedAbility: assignedAbility || null
      };
    });
  }

  /**
   * Apply one select intention without swapping values.
   *
   * - Selecting an empty value clears the destination Ability.
   * - Selecting an occupied slot moves that slot here; its former Ability is
   *   left on — Select —.
   * - The destination's former slot is merely released back to the pool.
   */
  static assignArraySlot(slots = [], abilityKey, selectedSlotId) {
    const validAbilities = new Set(ABILITIES.map(ability => ability.key));
    const next = this.normalizeAbilityArraySlots(slots, slots);
    if (!validAbilities.has(abilityKey)) return next;

    const requestedId = String(selectedSlotId ?? "");
    if (!requestedId) {
      for (const slot of next) {
        if (slot.assignedAbility === abilityKey) slot.assignedAbility = null;
      }
      return next;
    }

    const selectedSlot = next.find(slot => slot.id === requestedId);
    if (!selectedSlot) return next;
    if (selectedSlot.assignedAbility === abilityKey) return next;

    // Release the value currently shown in the destination. There is no swap.
    for (const slot of next) {
      if (slot.assignedAbility === abilityKey) slot.assignedAbility = null;
    }

    // One slot has one owner. Reassigning it automatically clears its former
    // Ability because the owner is stored on the slot itself.
    selectedSlot.assignedAbility = abilityKey;
    return next;
  }

  static assignmentsFromArraySlots(slots = []) {
    const assignments = {};
    const validAbilities = new Set(ABILITIES.map(ability => ability.key));
    for (const slot of slots) {
      const abilityKey = String(slot?.assignedAbility ?? "");
      const id = String(slot?.id ?? "");
      if (!id || !validAbilities.has(abilityKey) || Object.hasOwn(assignments, abilityKey)) continue;
      assignments[abilityKey] = id;
    }
    return assignments;
  }

  static baseAbilitiesFromArraySlots(slots = []) {
    const base = {};
    const validAbilities = new Set(ABILITIES.map(ability => ability.key));
    for (const slot of slots) {
      const abilityKey = String(slot?.assignedAbility ?? "");
      const value = Number(slot?.value);
      if (!validAbilities.has(abilityKey) || !Number.isFinite(value) || Object.hasOwn(base, abilityKey)) continue;
      base[abilityKey] = value;
    }
    return base;
  }

  static optionLabel(slot, slotsOrAssignments, destinationAbilityKey) {
    let assignedAbilityKey = String(slot?.assignedAbility ?? "");
    if (!assignedAbilityKey && slotsOrAssignments && !Array.isArray(slotsOrAssignments)) {
      assignedAbilityKey = ABILITIES.find(ability => slotsOrAssignments?.[ability.key] === slot?.id)?.key ?? "";
    }
    if (!assignedAbilityKey || assignedAbilityKey === destinationAbilityKey) return String(slot?.value);
    const assigned = ABILITIES.find(ability => ability.key === assignedAbilityKey);
    return assigned ? `${slot.value} — currently assigned to ${assigned.label}` : String(slot?.value);
  }

  // Compatibility helpers retained for beta Drafts and external callers. They
  // are no longer the live UI source of truth in v0.9.8i.
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

  static moveAbilitySlot(assignments, abilityKey, selectedId, validSlotIds) {
    const definitions = [...(validSlotIds ?? [])].map((id, index) => ({ id, value: index, index }));
    const slots = this.normalizeAbilityArraySlots(definitions, [], assignments);
    return this.assignmentsFromArraySlots(this.assignArraySlot(slots, abilityKey, selectedId));
  }
}
