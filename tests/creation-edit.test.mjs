import test from "node:test";
import assert from "node:assert/strict";

import { CreationEditService } from "../scripts/services/creation-edit-service.mjs";

test("array value movement clears the previous Ability instead of silently swapping", () => {
  const valid = new Set(["slot-15", "slot-14", "slot-13"]);
  const initial = { str: "slot-15", cha: "slot-14" };
  const moved = CreationEditService.moveAbilitySlot(initial, "cha", "slot-15", valid);

  assert.deepEqual(moved, { cha: "slot-15" });
  assert.deepEqual(initial, { str: "slot-15", cha: "slot-14" });
});

test("array option labels show where an occupied value is currently assigned", () => {
  const slot = { id: "slot-15", value: 15 };
  const assignments = { str: "slot-15" };

  assert.equal(
    CreationEditService.optionLabel(slot, assignments, "cha"),
    "15 — currently assigned to Strength"
  );
  assert.equal(CreationEditService.optionLabel(slot, assignments, "str"), "15");
});

test("creation stage edit flags are independent and reversible", () => {
  const state = { editingStages: { species: true } };
  const editingClass = CreationEditService.withEditing(state, "class", true);
  assert.deepEqual(editingClass, {
    abilitiesBackground: false,
    species: true,
    class: true,
    spells: false,
    equipment: false
  });
  const restoredSpecies = CreationEditService.withEditing({ editingStages: editingClass }, "species", false);
  assert.equal(restoredSpecies.species, false);
  assert.equal(restoredSpecies.class, true);
});


test("all confirmed creation choice stages can enter review-safe edit mode independently", () => {
  let state = { editingStages: {} };
  for (const stage of ["abilitiesBackground", "species", "class", "spells", "equipment"]) {
    state = { editingStages: CreationEditService.withEditing(state, stage, true) };
    assert.equal(CreationEditService.isEditing(state, stage), true);
  }
  assert.deepEqual(state.editingStages, {
    abilitiesBackground: true,
    species: true,
    class: true,
    spells: true,
    equipment: true
  });
});
