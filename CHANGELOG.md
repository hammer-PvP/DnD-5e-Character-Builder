# Changelog

## v0.0.1f Alpha

### Profile-specific Banned Items

- Moved Banned Items out of the global configuration and into a dedicated subpage for each Supplier profile.
- Added a profile sub-navigation with separate **Stock Configuration** and **Banned Items** views.
- Added a full compendium browser for bans using the profile's enabled sources, native Item types, native subtypes, search, and multi-selection.
- Added a clear ban scope choice: only the selected source document, or every equivalent version across the profile's enabled sources.
- Made source-specific banning the default so a broken or unwanted SRD version can be excluded while PHB, DMG, or another module version remains eligible.
- Added equivalence feedback showing whether other versions remain allowed or how many equivalent versions are blocked.
- Added search, type, source, and scope filters to the ban-management page.
- Added individual removal and bulk removal for large ban lists.
- Applied profile bans before Mundane Catalog, Guaranteed Items, Random Stock, exact-item browsing, and pool diagnostics.
- Migrated legacy global bans into every existing profile without losing prior exclusions.

### Compendium configuration stability

- Stopped re-rendering the entire configuration window when a global compendium toggle is changed.
- Preserved the list position and window fit when enabling or disabling packs near the end of a long source list.
- Kept source ordering, profile source choices, and catalog rebuilding synchronized when changes are saved.

### Release packaging

- Updated manifest and download URLs to `v0.0.1f`.
- Kept `Release_git.zip` limited to `module.json` and `dnd5e-supplier.zip`.

## v0.0.1e Alpha

### Native D&D5e classification

- Replaced broad compendium-oriented stock filtering with native Item document type and native Item subtype filtering.
- Added dynamically discovered subtype choices and eligible counts for Weapon, Equipment, Consumable, Tool, Loot, and Container documents.
- Added Equipment support for native categories such as Clothing, Light/Medium/Heavy Armor, Ring, Rod, Shield, Trinket, Wand, Wondrous Item, and compatible third-party subtype values.
- Kept profile themes visual only; any profile can combine any enabled Item types and subtypes.

### Duplicate-source compatibility

- Consolidated duplicate Items across enabled packs while retaining alternate native subtype aliases.
- Allowed an Item classified differently between SRD 5.1, SRD 5.2, PHB, DMG, or another source to remain discoverable through its recognized classifications without receiving duplicate generation chances.
- Fixed profile source restriction so the selected source defines the primary document and subtype even when a higher-priority duplicate exists in an unselected pack.

### Two-stage stock rolls

- Changed guaranteed and Random Stock selection to roll an enabled native subtype bucket first and then an Item inside that bucket.
- Prevented document-heavy subtypes, such as Wondrous Item, from dominating smaller enabled subtypes solely because they contain more entries.
- Added per-rule pool diagnostics showing the eligible count inside each native subtype bucket.

### Source Items and generated quality

- Separated ready-made source magic Items from Supplier-generated mundane/+1/+2/+3 equipment.
- Added clear configuration guidance for source-quality mode and party-quality mode.
- Kept source +1/+2/+3 Items subject to the configured party enhancement ceiling; a party that unlocks only +1 cannot receive a ready-made +2 document.
- Limited synthetic +1/+2/+3 generation to Weapons and Equipment rules restricted entirely to native armor subtypes.

### Migration and compatibility

- Migrated legacy Weapon filters to native simpleM/simpleR/martialM/martialR subtypes.
- Migrated legacy Armor rules into Equipment with lightArmor/mediumArmor/heavyArmor/shield subtypes.
- Preserved legacy profile, source, banned-item, quantity, Healing Potion, and Spell Scroll configuration.
- Kept compatibility with SRD/PHB-only installations and future DMG packs using the same native D&D5e Item structure.

### Release packaging

- Updated manifest and download URLs to `v0.0.1e`.
- Kept `Release_git.zip` limited to `module.json` and `dnd5e-supplier.zip`.

## v0.0.1d Alpha

### Configuration usability

- Reduced padding, card height, field height, and unused space throughout Supplier Configuration.
- Added stronger visual start/end boundaries to the main sections.
- Added visible dividers between repeated rules in the same section.
- Made each Mundane, Guaranteed, and Random rule collapsible with a compact summary showing category, quantity/weight, and eligible pool count.
- Preserved collapsed/expanded state, scroll position, and field focus while editing the same profile.
- Kept the return-to-top behavior only for profile or main-section changes.
- Displayed profile sources in a compact human-readable format such as `Equipment — PHB 2024`, `Equipment — DMG 2024`, and `Equipment — D&D5e Core`.

### Banned Items

- Added a global Banned Items configuration section.
- Added a compendium browser with search, Item type, subtype, and source filters.
- Added multi-selection for inserting Items into the ban list.
- Made every banned Item a compact removable row; clicking it removes the ban.
- Applied bans before profile filters to Mundane Catalogs, Guaranteed categories, Random pools, and exact-item browsing.
- Consolidated bans across duplicate named Items from different enabled sources.

### Party quality safety

- Prevented ready-made +1/+2/+3 weapon and armor documents from bypassing the configured party enhancement progression.
- A source `+2` Item is now excluded when the active party-level quality band unlocks only mundane and +1 equipment.
- Kept explicitly configured synthetic quality generation separate from source-document selection.

### Release packaging

- Updated manifest and download URLs to `v0.0.1d`.
- Added `Release_git.zip`, containing only `module.json` and `dnd5e-supplier.zip`.
- Kept the repository documentation limited to `README.md` and `CHANGELOG.md`.

## v0.0.1c Alpha

### Configuration stability

- Preserved the configuration content scroll position during every re-render inside the same profile.
- Preserved the active field and checkbox focus where possible.
- Kept the profile list scroll position stable.
- Reset the content to the top only when switching profile or main configuration section.
- Moved rule-pool diagnostics into a secondary collapsible panel.

### Stock recipe

- Redefined the configured total as **Random Stock only**.
- Mundane Catalog Items are always additional and never consume random slots.
- Guaranteed Items are always additional and never consume random slots.
- Replaced the ambiguous target/multiplier presentation with fixed random total or random Items per player.
- Added an immediate calculated random-slot preview using a configurable preview party size.

### Random pools

- Removed per-rule Random quantities from the normal interface.
- All enabled Random pools now compete for the profile's Random Stock slots.
- Added a relative chance weight to every Random pool.
- Applied quality and enchanted-minimum processing to the complete set won by each pool.

### Generation summary

- Added separate counts for Mundane Catalog units, Guaranteed units, and Random units.
- Added a dedicated warning when the Random Stock target cannot be filled.

## v0.0.1b Alpha

### Configuration workflow

- Replaced the technical generic filter form with three human-readable stock layers: Mundane Catalog, Guaranteed Items, and Random Items.
- Added progressive disclosure: weapon filters appear only for Weapons, armor filters only for Armor, and native subtypes only for compatible categories.
- Removed inherited `potion` / Healing Potion defaults from new and non-Alchemist profiles.
- Added live pool validation with eligible counts, sample names, and the filter stage that emptied a pool.
- Added visual profile themes for Alchemist, Blacksmith, General Goods, Jeweler, and Magic Assortment.
- Moved manual Font Awesome classes to the Custom theme only.

### Generation logic

- Added Mundane Catalog groups that include every distinct eligible mundane Item.
- Added per-Item catalog quantities including one each, half-party, and one per player.
- Defined every guaranteed quantity as independent generation slots.
- Fixed Healing Potions so ten slots produce ten independent family rolls and then stack matching tiers.
- Applied the same independent-slot rule to weapons, armor, consumables, and other categories.
- Multiple random remainder pools now share the remaining target slots.
- Kept equipment quality separate from base-item selection, including party-weighted +1/+2/+3 and enchanted minimums.

### Interface fixes

- Aligned the Items Directory Supplier button geometry with Item Creator while preserving the lilac identity.
- Stopped module button font rules from corrupting ApplicationV2 window controls, including toggle controls and Close.
- Preserved the fixed navigation, single scrolling content area, and fixed Save footer in Supplier Configuration.

### Output

- Confirming loot continues to create a timestamped Folder in the World Items Directory.
- Duplicate results continue to be stacked through `system.quantity`.

## v0.0.1a Alpha

### Validated baseline

- Preserves the v0.0.1 workflow that successfully created a World Items Folder, populated a third-party merchant, and supported item trading in a live Foundry test.

### Changed

- Corrected the display title to **Supplier (D&D 5e)**.
- Moved the Supplier directory control into its own full-width row without modifying the native Create Item or Create Folder controls.
- Added a lilac/blue Supplier button using the shared Character Builder / Item Creator visual family.
- Rebuilt Supplier Configuration around a fixed navigation shell, one scrolling content region, and a fixed footer.
- Added profile-specific source packs and Item document types.
- Added total-target stock generation: guaranteed units consume the target and random rules fill the remainder.
- Expanded guaranteed and random rules with exact Item, manual list, family, category, and Spell Scroll selection modes.
- Added canonical Healing Potions family resolution across enabled sources.
- Added structured weapon and armor filters.
- Separated base-item selection from mundane/+1/+2/+3 quality generation.
- Added party-level enhancement weight bands and configurable minimum enchanted coverage.
- Added native background Spell Scroll generation from compendium Spells.
- Added configurable spell-level access by party level.
- Added positive fallback prices and enhancement price additions.
- Added English and Brazilian Portuguese localization for the expanded UI.

### Output

- Confirming stock creates a Folder in the World Items Directory.
- Generated Items are assigned directly to that Folder.
- Duplicate generated results are stacked through `system.quantity` where applicable.
