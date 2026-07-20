# Character Builder 0.9.51 — Warlock Invocation Target Rebind Test Matrix

## Primary regression

Create a level 1 Warlock with Pact of the Tome and choose Eldritch Blast through the Tome.

During level 1 → 2:

1. Replace a normal Pact Magic cantrip with Eldritch Blast.
2. Replace Pact of the Tome with Agonizing Blast.
3. Select Repelling Blast as one of the two new level 2 Invocations.
4. Target the pending normal Eldritch Blast with both Agonizing Blast and Repelling Blast.
5. Complete and commit the Level Up.

Expected final state:

- Pact of the Tome is absent.
- Book of Shadows and all Tome-selected spells are absent.
- Exactly one Eldritch Blast remains.
- Eldritch Blast is a normal Warlock Pact Magic cantrip acquired by the level 2 transaction.
- Agonizing Blast targets the surviving Eldritch Blast embedded Item ID.
- Repelling Blast targets the same surviving Eldritch Blast embedded Item ID.
- The surviving Eldritch Blast has two `eldritchInvocationAugments` rows, one for each Invocation.
- Neither Invocation badge displays `Missing Target`.
- The Invocation ItemChoice Advancement records all three level 2 Invocations and the Pact of the Tome replacement.

## Additional target checks

- Select only Agonizing Blast against a pending cantrip and confirm its target remains correct.
- Select only Repelling Blast against a pending cantrip and confirm its target remains correct.
- Select both against an already surviving normal Warlock cantrip and confirm both bind to that Item.
- Cancel the cantrip replacement and confirm dependent pending targets are cleared before submission.
- Cancel Pact of the Tome removal and confirm the redundant normal Eldritch Blast choice becomes unavailable.
- Attempt to remove every acquisition without a pending replacement and confirm submission is rejected.

## Rollback

Force target resolution failure after Invocation creation and confirm:

- the Spells & Features Draft returns to the snapshot taken before application;
- no partial Invocation or spell Items remain;
- the live Actor is unchanged;
- the locked Hit Die result remains reusable.

## Regression smoke tests

- Complete one Sorcerer Metamagic replacement.
- Complete a Warlock Level Up without Pact of the Tome.
- Complete a Warlock Level Up that keeps Pact of the Tome.
- Confirm the Native Advancement Modal Guard still blocks the Character Builder background.
