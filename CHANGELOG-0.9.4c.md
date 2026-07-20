# Changelog

## 0.9.4c Community Beta — Warlock Stabilization

### Pact of the Tome

- Added a Character Builder-native Pact of the Tome selection panel in Character Creation and Level Up.
- Requires exactly three cantrips and two level-1 spells with the Ritual property from enabled class spell lists.
- Creates a managed Book of Shadows and five source-owned spell acquisitions that do not count against normal Pact Magic.
- Stores exact Invocation, Book, spell, class, source, acquisition-level, and transaction identities.
- Cleans only the exact Tome-owned documents when the Invocation is replaced.
- Built the selection contract with acquisition and future maintenance modes; no rest hook or Character Keeper panel is exposed yet.
- Leaves Pact of the Chain entirely under native D&D5e handling.

### Warlock corrections

- Fixed creation-time Eldritch Invocation replacement cleanup so cached grant Items are not deleted twice by Character Builder and D&D5e.
- Added Draft rollback around additional Level Up choices and local Pact of the Tome replacement.
- Allowed independent source-native spell grants with the same identifier, resolving the Archfey Patron Misty Step false duplicate failure.
- Patron and feature-granted spells now remain visible but disabled in normal Pact Magic selection and replacement lists, with the owning source shown.
- Restored consistent grayscale/disabled presentation for spell cards while preserving source-document detail actions.
- Invocation replacement lists identify exact target instances and retain missing-target names.
- Added a confirmation warning before replacing a cantrip augmented by one or more Eldritch Invocations; no target is transferred or reconnected automatically.
- Preserved direct and transitive Invocation prerequisite blocking.
- Ensured `lastLevelUp` is the exact final `levelUpHistory` transaction rather than an accumulated Mystic Arcanum choice snapshot.
- Updated the protected commit confirmation to use the green Character Builder Level Up mark while leaving the progress screen unchanged.

### Druid correction

- Fixed `SpellAccessService.save()` reading an out-of-scope `classLevel` while saving the Primal Order: Magician cantrip during Character Creation.

### Compatibility

- Foundry VTT 14.364.
- D&D5e 5.3.3.
- Player's Handbook 2024 and SRD 5.2 Modern.
- SRD 5.1 remains unsupported.

