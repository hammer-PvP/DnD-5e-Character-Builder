# Character Builder 0.9.51 Changelog

## Fixed

- Rebound new `invocationSelections` to the surviving embedded cantrip after same-transaction Pact of the Tome cleanup.
- Applied the same final target resolution to the optional Invocation replacement.
- Preferred cantrips created by the current spell-selection transaction when more than one acquisition shared the same identifier during the provisional Draft state.
- Rebuilt reciprocal cantrip augment metadata only after all created Invocation targets were finalized.
- Added rollback protection when no surviving eligible target can be resolved.

## Unchanged

- Warlock projected ownership eligibility from 0.9.5d.
- Pact of the Tome creation and cleanup rules.
- Sorcerer Metamagic.
- Native Advancement Modal Guard.
- Other class progression, protected commits, Settings, and GM progression tools.
