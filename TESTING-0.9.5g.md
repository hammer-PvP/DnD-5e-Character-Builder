# Character Builder 0.9.5g — Exact `lastLevelUp` Test Matrix

## Primary validation

Commit one ordinary Level Up and export the Actor JSON.

Expected:

- `flags.dnd5e-character-builder.levelUpHistory.at(-1)` exists;
- `flags.dnd5e-character-builder.lastLevelUp` exists;
- the two objects are deeply equal;
- they are not an accumulated mixture of multiple transactions.

## Sequential transaction regression

Commit at least two Level Ups with different structures. Prefer one transaction with a Hit Point field or managed-feature choice that is absent from the next transaction.

Expected after the second commit:

- `lastLevelUp` contains only fields present in the second history entry;
- no nested field unique to the first transaction survives;
- the first history entry remains unchanged;
- the newest history entry remains complete.

## Mechanical regression checks

Confirm that the Level Up still delivers the expected:

- class and subclass levels;
- features and spells;
- created and deleted Items;
- Hit Point increase and current HP synchronization;
- Advancement `added` and `replaced` values;
- ownership and transaction metadata.

## Safety regression checks

- A failed commit still restores the pre-commit Actor from the safety snapshot.
- A successful commit still clears the pending Draft and locked Hit Die.
- `levelUpHistory` retains the existing maximum of 50 entries.
- No retroactive rewrite occurs merely by opening an older Actor.

## Previous patch smoke tests

- Owned non-repeatable feats remain excluded from later native ASI browsers.
- Epic Boons remain excluded below projected total character level 19.
- Metamagic replacement cards and replacement mechanics remain unchanged.
- Warlock same-Level-Up cantrip target rebinding remains unchanged.
