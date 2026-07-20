# Character Builder 0.9.5e — Metamagic Replacement Detail Cards Test Matrix

## Primary interface test

Use a Sorcerer of level 3 or higher with at least two known Metamagic options.

1. Open a Sorcerer Level Up and reach `Spells & Features`.
2. Under `Optional Metamagic Replacement`, select one known option in `Replace`.
3. Confirm a left detail card appears immediately below the dropdown row.
4. Confirm the card shows the correct official image, name, source label, and description.
5. Select an eligible option in `With`.
6. Confirm a right detail card appears beside the left card.
7. Confirm the right card matches the selected replacement option.
8. Change either dropdown and confirm only the corresponding card updates.
9. Click each card outside its description links and confirm the correct source document opens.
10. Complete and commit the replacement.

## Cascading cleanup

- Select both sides, then change `Replace` to `No replacement`.
- Confirm `With` is cleared immediately.
- Confirm both cards and their reserved space disappear.
- Select only `Replace` and confirm only the removal card is visible.
- Select a different `Replace` option and confirm the removal card changes immediately.
- Select a replacement that becomes invalid because it was chosen as a new Metamagic option and confirm the `With` value clears and its card disappears.

## Source rendering

- Confirm PHB 2024 artwork and descriptions render correctly.
- Confirm SRD 5.2 options render with their correct source label when enabled.
- Confirm enriched UUID links inside a description remain interactive and do not toggle any Metamagic selection.
- Confirm long descriptions remain readable without clipping the card header.
- Resize the Level Up window below 760 px and confirm the two cards stack vertically.

## Regression

- Acquire two Metamagics at Sorcerer level 2.
- Acquire two additional Metamagics at levels 10 and 17.
- Perform an optional replacement with no new Metamagic choices at the same level.
- Perform a level 10 or 17 replacement alongside two new selections.
- Confirm known options remain disabled and duplicate prevention is unchanged.
- Confirm native ItemChoice Advancement records exact embedded Item IDs.
- Confirm cancelling or failing application restores the pre-choice Draft.
- Repeat the validated Warlock Pact of the Tome target-rebind scenario and confirm no regression.
