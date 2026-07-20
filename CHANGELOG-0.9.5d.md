# Character Builder 0.9.5d Changelog

## Added

- Added a narrow Warlock projected-cantrip ownership service shared by the Level Up rules layer and UI.
- Added pending cantrip replacement candidates to cantrip-targeting Eldritch Invocation target lists.
- Added exact acquisition/provider bindings for projected survival checks.

## Fixed

- Pact of the Tome cantrips scheduled for removal no longer block a normal cantrip acquisition of the same spell in the same Level Up.
- Agonizing Blast and similar targeted Invocations can bind to a pending cantrip replacement that survives the final transaction.
- A removed provider acquisition is no longer accepted as the only surviving Invocation target.
- A separate surviving acquisition continues to block redundant cantrip creation.
- Cancelling or invalidating the pending acquisition clears an invalid target before confirmation.

## Unchanged

- Sorcerer Metamagic behavior from 0.9.5c.
- Native Advancement Modal Guard behavior from 0.9.5b.
- Pact of the Tome acquisition and cleanup mechanics from 0.9.4c–0.9.4d.
