# Character Builder 0.9.5g — Exact `lastLevelUp` History Summary

This patch is a narrow Level Up history-integrity correction built on Character Builder 0.9.5f.

## What changes

After a successful Level Up commit, Character Builder now:

1. appends the complete current transaction to `levelUpHistory`;
2. creates an independent deep clone of the newest transaction;
3. removes the previous `lastLevelUp` flag;
4. writes the deep clone as the new `lastLevelUp`.

Foundry flag updates can merge nested object fields. Explicit replacement prevents a field from an older transaction, such as an obsolete Hit Point resolution timestamp, from surviving in the current summary.

## Result

Every new successful commit should satisfy:

```text
lastLevelUp === levelUpHistory.at(-1)
```

The equality requirement covers the complete transaction structure and values, including Hit Points, additional choices, created Items, deleted Items, class progression, ownership metadata, and transaction identifiers.

## Scope

This patch does not change:

- Actor Items, features, spells, effects, or Hit Points;
- Advancement `added` or `replaced` values;
- class or subclass progression;
- feat eligibility or safe recovery;
- Metamagic or Warlock behavior;
- commit rollback or safety backups;
- existing historical Actors.

Actors are not migrated retroactively. The exact-copy guarantee applies to Level Ups committed with 0.9.5g and later.

## Compatibility

- Foundry VTT 14.364
- D&D5e 5.3.3
- Player's Handbook 2024
- SRD 5.2 Modern
