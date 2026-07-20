# Character Builder 0.9.5d — Warlock Projected Cantrip Test Matrix

## Primary regression scenario

Prepare a Warlock who has:

- Pact of the Tome.
- Eldritch Blast granted only by Pact of the Tome.
- Toll the Dead as a normal Pact Magic cantrip.
- No existing Agonizing Blast.

During one Level Up:

1. In Optional Cantrip Replacement, select Toll the Dead as `Replace`.
2. In Optional Invocation Replacement, select Pact of the Tome as `Replace`.
3. Confirm Eldritch Blast becomes available in the cantrip `With` list.
4. Select Eldritch Blast.
5. Select Agonizing Blast as the replacement Invocation.
6. Confirm the pending Eldritch Blast becomes an eligible target.
7. Select Eldritch Blast and finish the Level Up.

Expected final state:

- Pact of the Tome is removed.
- Book of Shadows is removed.
- The Tome-owned Eldritch Blast is removed.
- Toll the Dead is removed.
- One new normal Warlock Eldritch Blast exists.
- Agonizing Blast exists.
- Agonizing Blast stores the new Eldritch Blast embedded Item ID.
- The new Eldritch Blast stores the reciprocal Invocation augment.
- No duplicate Eldritch Blast remains.
- No orphaned Tome ownership remains.

## UI cascade tests

### Cancel cantrip replacement

After targeting the pending Eldritch Blast, change the cantrip replacement to `No replacement`.

Expected:

- The pending target becomes unavailable.
- The Agonizing Blast target is cleared.
- Confirm Spells remains disabled until a valid target is selected.

### Cancel Invocation removal

After completing the primary setup, change the Invocation replacement `Replace` field to `No replacement`.

Expected:

- The Invocation replacement `With` and target fields clear.
- Eldritch Blast returns to unavailable in the cantrip replacement list because the Tome acquisition survives.
- No stale green/completed state remains.

### Change provider removal

Change the removed Invocation from Pact of the Tome to a different eligible Invocation.

Expected:

- The Tome-owned Eldritch Blast is treated as surviving.
- A redundant normal Eldritch Blast replacement is cleared or disabled.
- Target eligibility recalculates immediately.

## Duplicate-survival tests

### Independent copy survives

Create a test Actor with both a Tome-owned Eldritch Blast and a separate normal Eldritch Blast.

Expected:

- Removing Pact of the Tome does not make Eldritch Blast available as another new replacement.
- The surviving normal copy remains a valid Invocation target.

### Other feature-owned acquisition survives

Use a damaging Warlock cantrip with more than one explicit acquisition provider where only one provider is removed.

Expected:

- The cantrip remains unavailable as a redundant replacement.
- The surviving acquisition remains targetable.

## Negative validation tests

- Submit an Eldritch Blast replacement without removing its only current provider: rejected.
- Target the Tome-owned Eldritch Blast while removing Tome and without adding a replacement copy: rejected.
- Select the same cantrip through a new-cantrip slot and Optional Cantrip Replacement: rejected.
- Remove Pact of the Tome while a structural dependent Invocation exists: existing dependency block remains unchanged.

## Regression checks

- Acquire Pact of the Tome normally and select 3 cantrips plus 2 rituals.
- Remove Pact of the Tome without selecting a targeted Invocation.
- Replace Armor of Shadows.
- Acquire Agonizing Blast for a cantrip that already survives normally.
- Perform a normal Warlock cantrip replacement unrelated to Pact of the Tome.
- Complete one Sorcerer Metamagic replacement to confirm 0.9.5c remains unchanged.
- Open one native feat Advancement to confirm 0.9.5b remains unchanged.
