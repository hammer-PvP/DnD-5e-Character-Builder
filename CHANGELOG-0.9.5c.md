# Character Builder 0.9.5c Changelog

## Sorcerer Metamagic

- Added Character Builder-owned Metamagic selection cards to `Spells & Features`.
- Added exactly two new choices at Sorcerer levels 2, 10, and 17.
- Added one optional replacement on every Sorcerer Level Up after level 2.
- Added projected duplicate prevention across known options, new same-level choices, and the replacement destination.
- Added cascading cleanup when replacement prerequisites change.
- Added exact native ItemChoice `added` and `replaced` records using embedded Item IDs.
- Added managed acquisition metadata and source ownership for each Metamagic Item.
- Removed only the Metamagic ItemChoice from the visible native Advancement queue.

## Scope Preservation

- No Warlock, Druid, Bard, Wizard, or other class rules changed.
- No spell selection or ownership rules changed.
- No Native Advancement Modal Guard behavior changed.
- No protected commit, settings, character-sheet controls, or GM tool behavior changed.
