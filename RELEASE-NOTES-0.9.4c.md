# Character Builder 0.9.4c — GitHub Release Notes

Character Builder `0.9.4c` is a focused private community-beta stabilization patch for Warlock on Foundry VTT `14.364` and D&D5e `5.3.3`. It also contains one Character Creation blocker correction for Druid.

## Main change: Pact of the Tome

Selecting **Pact of the Tome** in Character Creation or Level Up now exposes a Character Builder-native panel that follows the module's existing Spell Selection layout. The player chooses exactly:

- three cantrips from enabled class spell lists; and
- two level-1 spells with the Ritual property from enabled class spell lists.

The transaction creates a managed Book of Shadows and five exact source-owned spell Items. Tome spells remain separate from normal Pact Magic, Patron Spells, Mystic Arcanum, species, feats, and other acquisition channels. Replacing the Invocation removes only the Book and spells tied to that exact Pact of the Tome instance.

The component has a maintenance-ready contract for the future Character Keeper. This release does **not** add Short Rest or Long Rest hooks and does not expose runtime reconfiguration yet. Pact of the Chain remains entirely native to D&D5e.

## Warlock fixes

- Creation-time Invocation replacement no longer pre-deletes cached grant Items that D&D5e must remove through `deleteContents`. This targets the fatal Armor of Shadows / Mage Armor embedded-document failure.
- Independent native spell grants can coexist, preventing the Archfey Patron's Misty Step grants from being rejected as a non-repeatable feature.
- Patron and feature-owned spells remain visible but disabled in normal Pact Magic choices and replacement dropdowns, with an ownership explanation.
- Disabled spell cards use the shared grayscale presentation while remaining clickable for source details.
- Invocation replacement rows display exact targets or `Missing Target: <name>`.
- Replacing an augmented cantrip requires an explicit warning acknowledgement; Invocation Items remain known and are not automatically transferred or reconnected.
- Structural prerequisite dependencies remain blocking.
- `lastLevelUp` is written from the exact final history record, preventing stale Mystic Arcanum choices from leaking into later transactions.

## Druid fix

Druid Character Creation with **Primal Order: Magician** no longer throws `ReferenceError: classLevel is not defined` while saving Spell Selection.

## Packaging

Upload these two files to the GitHub release tagged `v0.9.4c`:

- `module.json`
- `module.zip`

The installable archive contains the single root folder `dnd5e-character-builder`.

## Runtime validation note

The release bundle includes a focused runtime matrix. Static validation cannot execute Foundry's native AdvancementManager, cast cached Invocation spells, or simulate live Actor rollback. Complete the included tests in a Foundry VTT 14.364 / D&D5e 5.3.3 world before treating the runtime defects as closed.
