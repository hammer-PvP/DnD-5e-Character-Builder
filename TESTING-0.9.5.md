# Character Builder 0.9.5 — Foundry Test Matrix

Target: Foundry VTT 14.364, D&D5e 5.3.3, PHB 2024 / SRD 5.2 Modern.

## Existing Individual GM Controls

1. In Milestone Mode, open a completed character sheet as GM.
2. Confirm `Grant Level Up` is present in Toggle Controls.
3. Grant, reopen controls, and confirm it changes to `Revoke Level Up`.
4. Begin a Level Up, confirm `Reset Pending Level Up` appears, and verify reset deletes the Draft and locked Hit Die result only after confirmation.
5. Confirm none of these controls appear to non-GM users.

## Actor Directory Tool

1. Open the Actors Directory as GM and confirm the full-width `Character Builder Tool` button appears below the native directory actions.
2. Confirm the button is absent for players.
3. Verify Search, Select All, Clear, and Current Scene selection.
4. Verify level-0 Actors without completed Character Creation and level-20 Actors are disabled.

### Milestone Mode

1. Select multiple eligible characters and grant Level Ups.
2. Confirm each Actor receives an independent GM grant and its sheet Level Up button becomes available.
3. Confirm already granted or pending Level Up Actors are disabled in the batch list.
4. Confirm the individual Revoke and Reset controls continue to work.
5. Double-click/rapid-click the apply action and confirm only one batch is recorded.

### XP Mode

1. Enter 1000 XP and select three characters.
2. Confirm the preview shows 333 XP each, 999 distributed, and remainder 1.
3. Apply and verify each Actor receives exactly 333 whole-number XP.
4. Confirm a character reaching its next XP threshold receives an available Level Up button.
5. Test exact division, non-exact division, zero/negative/decimal input, no selection, and a total too small to grant 1 XP each.
6. Confirm one Actor update failure is reported without reapplying XP to successful Actors.

## Sheet Interaction Slot

1. Open an uninitialized level-0 Player Character Actor.
2. Confirm Start Character Builder is beside Short Rest and Long Rest, uses the stair/arrow icon, solid gold presentation, dark border, and glow.
3. Complete Character Creation and confirm Start Character Builder is replaced by a permanent Level Up button.
4. Confirm unavailable Level Up is approximately 50% opacity, desaturated, non-hovering, and impossible to click.
5. Grant Milestone or sufficient XP and confirm the upward-arrow button becomes fully visible, clickable, and receives the golden proc glow.
6. Begin a Level Up and confirm the button resumes the Draft without presenting a new-availability proc.
7. Enable reduced motion at OS/browser level and confirm the glow becomes static.

## Fixed Spells & Features Header

1. Open a Level Up with a long Spells & Features page.
2. Scroll to the bottom and confirm Step 4 title, explanatory copy, divider, and Confirm Spells remain fixed.
3. Confirm only the content below the divider scrolls.
4. Confirm the button stays disabled until every requirement is complete and enables without returning to the top.
5. Resize the window and verify content does not overlap or pass through the header.

## Protected Character Creation Commit

1. Complete a new character and press Finish Character.
2. Confirm the Protected Transaction confirmation opens before the live Actor changes.
3. Confirm Back to Review leaves the Actor unchanged.
4. Confirm Create Character transforms the same dialog into a progress display and blocks close/navigation/repeated commit.
5. Verify successful creation transfers Actor data, Items, spells, equipment, exact IDs, Hit Points, completed history, and removes the Draft.
6. Force a failure at each stage and confirm the Actor is restored exactly and the Draft remains available.
7. Interrupt the client after the persistent transaction record is written; reconnect and confirm the original Actor is restored and the Draft preserved.
8. Interrupt after the transaction is marked complete; reconnect and confirm cleanup finishes without rolling the character back.
9. Verify cached Cast spells such as Armor of Shadows/Mage Armor do not cause duplicate deletion during rollback.
10. Simulate rollback verification failure and confirm the Actor receives a safety lock and the backup record remains for GM intervention.
