# Character Builder 0.9.5f Changelog

## Native Feat Duplicate Filtering

- Keeps the native D&D5e Ability Score Improvement feat browser as the source of truth.
- Removes already-owned non-repeatable feats from that browser using official source UUID identity.
- Uses identifier plus feat subtype only as a cross-source PHB/SRD mirror fallback.
- Leaves officially repeatable feats available.
- Does not compare display names.

## Epic Boon Eligibility

- Removes `epicBoon` subtype feats when projected total character level is below 19.
- Allows Epic Boons at projected total character level 19 or higher when a legitimate native ASI/feat Advancement is active.
- Does not grant a feat choice merely because total character level reaches 19.
- Does not use the current class level as the Epic Boon prerequisite.

## Safe Recovery

- Validates the selected feat UUID before native application.
- Reopens the feat browser when an invalid duplicate or early Epic Boon is selected.
- Preserves the native ASI alternative, previous Advancement choices, and locked Hit Die result.
- Retains post-Advancement validation and full Draft rollback as a defensive fallback.

## Scope

No feat opportunity schedule, source pool reconstruction, free-form prerequisite interpretation, Metamagic, Warlock, spell ownership, protected commit, Settings, or GM progression behavior changed.
