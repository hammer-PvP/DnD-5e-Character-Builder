# Character Builder 0.9.5c — Sorcerer Metamagic Test Matrix

## Required environment

- Foundry VTT 14.364
- D&D5e 5.3.3
- Player's Handbook 2024 enabled
- Character Builder Level Up Draft starts from a clean pending transaction

## 1. Sorcerer level 1 → 2

1. Advance a level-1 Sorcerer.
2. Complete Hit Points and Class Progression.
3. Confirm that no native Metamagic selection window appears.
4. In `Spells & Features`, confirm `New Metamagic Options` requires exactly 2.
5. Open an option card and confirm the official source document opens without checking it.
6. Select two different options.
7. Confirm all remaining unchecked options become unavailable after the count is complete.
8. Commit and verify exactly two Metamagic Items exist.

Expected: the Sorcerer class Metamagic ItemChoice records both embedded Item IDs under level 2. No replacement record exists.

## 2. Sorcerer level 2 → 3 — no replacement

1. Advance the same Sorcerer to level 3.
2. Confirm `Optional Metamagic Replacement` appears.
3. Leave both fields on `No replacement`.
4. Complete the Level Up.

Expected: no Metamagic Item is added or removed, and the existing two options remain unchanged.

## 3. Sorcerer level 2 → 3 — valid replacement

1. Select one known option in `Replace`.
2. Confirm every already-known option is greyed out/disabled in `With`.
3. Select an unknown option.
4. Return `Replace` to `No replacement`.
5. Confirm `With` is cleared immediately.
6. Select the replacement again and commit.

Expected: only the selected original is removed; one new option is created; total known Metamagic remains 2. The native replacement record uses exact embedded Item IDs and points back to the original acquisition level.

## 4. Duplicate prevention

Test each condition:

- Attempt to replace one known option with another known option.
- Attempt to replace an option with itself.
- At level 10, select an option as a mandatory new choice and then inspect the same option in `With`.
- Choose a replacement destination first and confirm the same unchecked card becomes unavailable in the new-choice list.

Expected: every duplicate path is disabled in the UI and rejected again by server-side validation.

## 5. Sorcerer level 9 → 10

1. Confirm `New Metamagic Options` requires exactly 2.
2. Confirm `Optional Metamagic Replacement` is also present and optional.
3. Select two new options and optionally replace one old option with a fourth distinct option.
4. Commit.

Expected: without replacement, total known increases by 2. With replacement, total known still increases by exactly 2. The level-10 `added` map contains the new embedded Items and the `replaced` map contains the optional replacement pair.

## 6. Sorcerer level 16 → 17

Repeat the level-10 test.

Expected: two mandatory new options plus at most one independent optional replacement.

## 7. Sorcerer levels 3–9, 11–16, and 18–20

Advance representative levels from each range.

Expected: no mandatory new Metamagic count; one optional replacement is available on every gained Sorcerer level.

## 8. Multiclass boundary

- Advance a Sorcerer/other-class character by one level in the other class.
- Advance the same character by one Sorcerer level.

Expected: Metamagic replacement appears only when Sorcerer itself gains the level.

## 9. Rollback

Force a controlled failure after a replacement deletion or option creation.

Expected: the pre-choice Level Up Draft is restored exactly; the live Actor remains unchanged; the original Metamagic is present and no partial new option survives.

## 10. Regression smoke test

- Open a Warlock Level Up with Eldritch Invocations.
- Open a class Level Up that uses a native feat or subclass choice.
- Confirm the Native Advancement Modal Guard still blocks the background.
- Complete a non-Sorcerer Level Up.

Expected: all prior workflows behave as in 0.9.5b.
