# Character Builder 0.9.4c — Focused Runtime Validation

Use Foundry VTT `14.364`, D&D5e `5.3.3`, Player's Handbook 2024, and a fresh world or disposable Actors. Confirm no unsupported automation module changes native Advancements.

## A. Pact of the Tome — Character Creation

1. Create a level-1 Warlock and select Pact of the Tome as the initial Invocation.
2. Confirm the Spell Selection panel shows the normal Warlock choices plus Pact of the Tome.
3. Confirm Tome uses the project spell-card interaction: checkbox selects, card opens source details.
4. Select exactly three cantrips and two level-1 Ritual spells.
5. Confirm unavailable prepared spells are gray, disabled, and still open details.
6. Finish the character.
7. Verify one Pact of the Tome Invocation, one managed Book of Shadows, three Tome cantrips, and two Tome rituals.
8. Verify Tome spells have Warlock/Invocation ownership and do not count in normal Pact Magic prepared totals.
9. Return before finishing, replace Pact of the Tome with another Invocation, and verify all pending Tome selections are cleared.

## B. Pact of the Tome — Level Up

1. Start with a Warlock that does not know Pact of the Tome.
2. Acquire Pact of the Tome at a later Warlock level.
3. Confirm the Tome panel appears immediately after the Invocation is selected.
4. Confirm Level Up cannot continue until the 3/2 selection is complete.
5. Commit and inspect Book/spell ownership, transaction IDs, acquisition levels, and Review entries.
6. Replace Pact of the Tome on a later level after removing any structural dependent Invocations.
7. Confirm only that exact Tome Book and its five spells are removed.

## C. Creation-time Invocation replacement crash

1. Create Warlock 1 with Armor of Shadows.
2. Confirm its cached Mage Armor spell exists.
3. Reach Warlock 3 and replace Armor of Shadows with Pact of the Blade while selecting Fiend Patron.
4. Repeat with Great Old One Patron.
5. Confirm no `EmbeddedCollection` missing-ID error occurs.
6. Confirm Mage Armor is removed by native content cleanup, Pact of the Blade is present, and the Level Up interface remains usable.
7. Cancel or inject an error and confirm the Draft restores without changing the live Actor.

## D. Archfey Patron

1. Select Archfey Patron at Warlock 3.
2. Confirm Class Progression completes without a Misty Step non-repeatable error.
3. Verify the source-native Misty Step acquisitions remain separate with their own ownership/activities.

## E. Patron spell eligibility and gray state

1. Select Fiend Patron.
2. At the next normal Pact Magic choice, locate Suggestion.
3. Confirm it remains visible, gray, non-selectable, and reports `Already granted by Fiend Patron — Always Prepared`.
4. Confirm the card still opens the official source document.
5. Confirm Suggestion is also disabled in replacement destinations.
6. Repeat with another Patron spell.

## F. Invocation targets

1. Acquire repeatable target Invocations against different cantrips.
2. Confirm replacement rows identify each exact target.
3. Remove an augmented cantrip and accept the warning.
4. Confirm every affected Invocation remains present and displays `Missing Target: <name>`.
5. Relearn the cantrip and confirm no automatic reconnection occurs.
6. Replace the exact intended Invocation instance and confirm sibling instances are preserved.
7. Confirm Pact of the Blade cannot be removed while direct or transitive dependent Invocations remain.

## G. Mystic Arcanum and transaction history

1. Acquire Mystic Arcanum 6, 7, and 8 at their normal levels.
2. Replace one eligible Arcanum.
3. Advance another level without changing Arcana.
4. Verify `lastLevelUp` deep-equals the final `levelUpHistory` entry and does not contain choices from older levels.

## H. Druid Magician blocker

1. Create a Druid with Primal Order: Magician.
2. Select the normal Druid cantrips and the extra Magician cantrip.
3. Confirm Spell Selection without a `classLevel is not defined` error.
4. Verify the Magician cantrip has separate feature ownership.
5. Create a Druid with Warden and confirm no Magician choice or metadata appears.

## I. Protected commit regression

1. Confirm the confirmation screen uses the green Level Up mark.
2. Confirm the following progress screen still uses the existing blue gears, stage text, progress bar, and percentage.
3. Double-click Commit before confirmation and confirm only one pending confirmation exists.
4. Confirm commit cannot be cancelled after it starts.
5. Inject a commit failure and verify the live Actor is restored or a critical safety lock is raised if verification fails.

Record Actor exports and console logs for every failure.
