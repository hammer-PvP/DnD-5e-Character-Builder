# Character Builder 0.9.5g Changelog

## Exact `lastLevelUp` Replacement

- Creates an independent deep clone of the newest `levelUpHistory` transaction.
- Removes the previous `lastLevelUp` flag before persisting the new transaction summary.
- Prevents Foundry nested-object flag merging from retaining fields that existed only in an older Level Up.
- Keeps `levelUpHistory` unchanged and capped by the existing 50-transaction policy.
- Applies only to new successful commits; no retroactive Actor migration is performed.

## Scope

No Actor Items, features, spells, Hit Points, Advancement records, class progression, feat filtering, Metamagic, Warlock behavior, rollback, Settings, or GM tools changed.
