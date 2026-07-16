# Changelog

## 0.9.4 Beta — Feature-Owned Badges and Safe Class Restart

- Removes Advancement-choice badges from Character Creation and migrates legacy 0.9.2/0.9.3 badge flags out of Class, Background, Species, and other creation summaries.
- Restricts badges to Level Up choices that can be resolved to one specific feature. Wizard Scholar Expertise is displayed on the `Scholar` feature row instead of the `Wizard` Class header.
- Keeps Warlock target annotations bidirectional: each repeatable Invocation instance shows its own target cantrip, while the cantrip lists every Invocation augmenting it.
- Moves the complete GM-only `Reset Pending Level Up` action from the Level Up window to Actor Sheet → Toggle Controls, directly below Grant/Revoke Level Up.
- Replaces the old in-window reset with player-accessible `Restart Class Selection`, which rebuilds the Draft from the live Actor while preserving the first locked Hit Die roll.
- Allows the retained numeric roll to be reused for another Class when it fits that Class Hit Die, or replaced with the selected Class Average. A new roll and Maximum remain blocked; an impossible retained value leaves only Average available.
- Keeps `ItemGrantIntegrityService` active during both Character Creation and Level Up, with all 0.9.3 settings-localization, ItemGrant, cantrip-target, acquisition-origin, and original-Class protections.

## 0.9.3 Beta — Release Consistency, Settings Localization, and Hit Die Verification

- Synchronizes the release version across the manifest, runtime constants, README, changelog, download URL, and versioned GitHub asset name.
- Publishes the installable asset as `dnd5e-character-builder-v0.9.3.zip` to avoid confusing it with earlier unversioned downloads and reduce release-cache ambiguity.
- Changes the English localization file to flat Foundry keys and adds an explicit English fallback when registering the Character Builder settings menu, preventing unresolved `CB.Settings.*` labels and restoring the full settings hint.
- Revalidates the persistent Hit Die lock: the first roll is written to the live Actor before the temporary Draft is trusted, is restored into a rebuilt Draft, blocks changing the HP method or advanced Class, and is compared again during final Commit.
- Keeps all 0.9.2 features: shared Character Creation and Level Up ItemGrant integrity, Advancement choice badges, acquisition-safe duplicate handling, and owned-or-currently-selected Warlock cantrip targeting.

## 0.9.2 Beta — Shared Integrity, Choice Badges, and Persistent Hit Dice

- Refactors mandatory D&D5e `ItemGrant` auditing into `ItemGrantIntegrityService`, shared by Character Creation and Level Up.
- Reconciles missing mandatory grants after native Advancement, preserves each acquisition origin as a separate Item, and blocks final commit when a required grant remains incomplete.
- Adds read-only Advancement choice badges to source features and review screens, including Expertise, proficiencies, languages, tools, Ability Score assignments, Item Choices, and optional Item Grants.
- Derives badges from native Advancement values instead of renaming official Items or maintaining a second choice record.
- Restricts cantrip-targeted Eldritch Invocations to damaging Warlock cantrips already owned or explicitly selected during the same Level Up. Pending targets remain disabled until their cantrip is selected, and invalid targets are cleared and rejected again during validation.
- Persists the first rolled Hit Die result on the live Actor, bound to the source and target character levels, selected Class, and target Class level. Closing the application, rebuilding the Draft, or returning to Class selection cannot create another roll.
- Migrates rolled results from pending 0.9.1 Drafts into the persistent Actor lock. Only an explicit GM reset or a successful Level Up commit releases the lock.
- Corrects the Game Settings entry to display English labels and its full hint without exposing unresolved localization keys.

## 0.9.1 Beta — Native ItemGrant Integrity Candidate

- Preserves the Actor's existing `system.details.originalClass` through the transactional delete-and-recreate commit sequence.
- Adds a global post-Advancement reconciliation pass for mandatory D&D5e `ItemGrant` results from the Class, its Subclass, and linked progression features.
- Restores grants that were recorded in `value.added` but whose embedded Item documents were not retained by the native Advancement transaction.
- Recreates granted Items through the prepared D&D5e Advancement document whenever available, preserving spell preparation, casting method, source item, free uses, recovery, activities, effects, and Advancement flags.
- Treats acquisition origin as part of resource identity. A selected spell and an always-prepared copy, or two same-named resources with different usage models, remain separate Items.
- Restricts technical deduplication so Advancement-granted, Builder-managed, repeatable, and Level Up spell instances are never collapsed by name or identifier.
- Shows mandatory resources in **Spells & Features** as checked, locked automatic grants, including **Always Prepared**, free-use, and restored-grant indicators.
- Validates every applicable mandatory ItemGrant again before Commit and blocks the transaction if any required document is still missing or linked to the wrong Advancement origin.

## 0.9.0 Beta — Community Testing Candidate

- Keeps the approved Class and Hit Points Level Up layouts unchanged.
- Renames the native Advancement step to **Class Progression** and moves **Confirm Progression** to the standard top-right confirmation position.
- Replaces the redundant overall spell counter with the standard top-right **Confirm Spells** action.
- Keeps separate cantrip and leveled-spell counters inside their own choice sections and applies completion tinting only when each section is complete.
- Adds collapsible Spell Level 0–9 groups that reduce to a single heading row without changing selections.
- Moves **Commit Level Up** to the top-right Review header and increases its primary label size.
- Keeps unavailable Eldritch Invocations visible in grey with Warlock-level and Item prerequisite explanations.
- Re-evaluates Eldritch Invocation prerequisites in slot order, allowing an earlier invocation selected in the same Level Up to unlock a later dependent invocation.
- Shows official source Item details for the selected Eldritch Invocation through a clickable card instead of duplicating PHB text.
- Preserves invocation target-cantrip selection and validates repeatable, prerequisite, level, and target rules again at commit preparation.
- Changes Review augment reporting from all active cantrip augments to only invocation-augment additions, removals, or target changes made by the current Level Up.
- Prevents unchanged Warlock augments from appearing during unrelated multiclass advancement, such as Sorcerer levels.

## 0.0.8 Beta — Level Up UI, Spell Deduplication, and Class Integrity

- Rebuilds the Class advancement cards with full-width Character Builder action buttons.
- Adds an explicit top-right **Confirm Hit Dice** action; HP rolls or fixed values remain pending until confirmed.
- Locks a rolled Hit Die result against switching methods when the GM enables roll locking.
- Rebuilds Level Up spell cards so the checkbox selects while the icon/name button opens spell details.
- Adds selection counters, completion tinting, and separate Spell Level 0–9 groups.
- Greys out the same spell across normal class choices, Wizard Savant choices, and limited-caster replacement choices.
- Blocks duplicate spell acquisition again at transaction validation instead of silently collapsing duplicate choices.
- Prevents Warlock invocation bookkeeping from replacing the full Class system data.
- Validates Class level, Hit Die, spellcasting progression, spellcasting ability, and description before committing to the live Actor.

## 0.0.7 Beta — Character Sheet Level Up Controls Hotfix

- Connects the Level Up interface to the D&D5e 5.3.3 ApplicationV2 character sheet.
- Adds the compact gold upward-arrow Level Up button beside the level badge only when XP or a Milestone grant makes Level Up available.
- Adds GM-only Grant Level Up and Revoke Level Up entries to the modern sheet Toggle Controls menu in Milestone mode.
- Preserves a pending Level Up as Resume Level Up and prevents duplicate controls during partial sheet renders.

## 0.0.7 Beta

- Declares official rules-content compatibility with Player's Handbook 2024 and SRD 5.2 Modern; SRD 5.1 Legacy is not officially supported in this beta.
- Adds transactional Level Up on a separate Draft Actor with final commit rollback.
- Separates total character level from individual Class levels for XP, cantrip scaling, Species progression, Class features, and spell access.
- Adds Experience Points and Milestone advancement modes.
- Adds per-Actor GM Grant Level Up and Revoke Level Up controls on character sheets.
- Adds a configurable multiclass permission and a Class-selection screen that lists the original Class first.
- Uses native D&D5e primary/secondary Class Advancement restrictions so multiclass entries do not repeat initial-Class proficiencies, Saving Throws, or Starting Equipment.
- Validates 2024 multiclass ability prerequisites.
- Adds configurable Roll, Average, and Maximum Hit Point advancement methods.
- Locks HP rolls to the Actor and target level and optionally applies Minimum Average.
- Adds a GM-only reset for a pending Level Up and its locked HP result.
- Runs source-native features, subclasses, feats, proficiencies, and choices through D&D5e AdvancementManager on the transaction Draft.
- Adds module-managed Class spell access for newly accessible full-list spells, limited-caster gains and replacements, Wizard spellbook additions, and Wizard Savant bonus spells.
- Validates cantrip scaling against total character level while leaving native D&D5e scaling formulas intact.
- Adds Warlock Eldritch Invocation instance history, repeatable-instance preservation, optional replacement, source prerequisite validation, and known-cantrip targeting.
- Adds an Eldritch Invocation Augmented annotation to targeted cantrips on the Actor sheet.
- Prevents repeatable invocation instances from being removed by feature deduplication.
- Skips Builder-generated class-list spell copies when a native Advancement already granted the same spell, including Hunter's Mark from Favored Enemy.
- Preserves the stable transactional Starting Equipment Shop and strengthens the Open Shop two-line button layout.

## 0.0.6

- Expands the Starting Equipment action area so the complete Open Shop subtitle remains inside the button without clipping or overflow.
- Resets all pending and checked-out Shop purchases whenever a Class or Background starting-equipment choice changes, then restores the newly calculated full budget.
- Replaces source/quantity reconstruction with an exact Checkout manifest of root Item IDs, transaction IDs, line IDs, source UUIDs, and purchased quantities.
- Validates checked-out purchases against the exact created root Items, including stacked equipment and multiple independent containers or packs.
- Keeps an older 0.0.6 Checkout compatibility fallback while all new transactions use the exact manifest.
- Aligns the Starting Equipment action buttons to the right edge of the content grid and prevents them from extending beneath the main scrollbar.

- Reworks the Shop into a transactional Checkout flow without changing the test version number.
- Keeps cart quantity changes local to the Shop and prevents the parent Character Builder from rendering or taking focus after every item change.
- Adds a prominent Checkout action that atomically commits purchased Items and remaining starting currency to the Draft.
- Keeps pending cart changes separate from checked-out purchases and blocks equipment confirmation until pending changes are checked out.
- Preserves checked-out Shop Items when Class and Background equipment is confirmed, preventing duplicate purchases and duplicate currency deductions.
- Validates that checked-out Items still exist before Starting Equipment can be confirmed and directs the player to Checkout again if the Draft was edited externally.
- Adds rollback safeguards for failed Shop checkout transactions.

- Standardizes internal test versions as numeric semantic versions without alpha or beta suffixes.
- Adds the integrated Starting Equipment Shop to the level 1 creation flow.
- Adds hierarchical mundane-equipment categories, item search, source labels, item details, quantity controls, and a persistent Shopping Cart.
- Adds a GM-only Shop Bonus Gold world setting.
- Calculates the Shop budget from Class currency, Background currency, existing starting currency, and the captured GM bonus.
- Uses copper-piece arithmetic internally and applies unspent value to the completed Actor.
- Applies a Shop-only 1 GP price override to mundane spellcasting foci.
- Excludes magical, attuned, enhanced, rarity-bearing, vehicle, mount, service, and unpriced non-focus items from the level 1 Shop.
- Adds Shopping Cart purchases above Class and Background equipment on the Starting Equipment screen.
- Creates an independent complete container and contents set for every purchased equipment pack.
- Replaces Starting Equipment Continue with Open Shop and Confirm Equipment actions.
- Preserves both the overall step scroll and the Species/Class list scroll during interactions inside a step.
- Resets the destination step to the top whenever the user changes creation stages.

## 0.0.1.5-alpha hotfix

- Standardized Starting Equipment with the same top-right Continue action used by the earlier creation steps.
- Preserved Species and Class list scroll positions while previewing or checking options.
- Increased Species and Class checkbox visibility with a larger gold/green custom control.

## 0.0.1.5-alpha

- Aligned Ability Scores & Background actions with the ability-method controls.
- Moved Species, Class, and Spell Selection confirmation and continuation actions into the same top-right layout.
- Replaced direct Species/Class row activation with staged checkbox selection and separate details preview.
- Added explicit Confirm Species, Confirm Class, and Confirm Spell Selection actions.
- Cleared unconfirmed previews and pending Species/Class selections when navigating between steps.
- Restored committed Species/Class selections and their details when revisiting completed steps.
- Kept the emphasized Finish Character action from 0.0.1.4.


## 0.0.1.4-alpha

- Moves the Ability Scores and Background confirmation into a prominent two-action group aligned above the Background panel.
- Adds a green confirmation indicator and a dedicated top Continue action that unlocks after the step is confirmed.
- Removes the duplicate bottom Continue action from the Ability Scores and Background step.
- Places Select controls directly inside every Species and Class option row while retaining a separate preview area for reading source details.
- Starts the native D&D5e Advancement flow immediately from the option-row Select control.
- Marks the current Species and Class directly in their lists with a persistent Selected state.
- Replacing a Class clears its previous class-spell access, starting-equipment results, currency contribution, and dependent saved state before starting the new Class flow.
- Replacing a Species relies on the native deletion Advancement to remove the previous Species grants before applying the new selection.
- Promotes Finish Character to a large filled gold action with a green completion icon and a secondary explanatory line.
- Ensures Common is persisted on the Actor when the Custom Background native language Advancement records it but D&D5e omits the fixed grant from Actor source data.

## 0.0.1.3-alpha

- Adds a Character Name field above the creation steps and applies that name to the completed Actor and Prototype Token.
- Left-aligns every creation-step label and prevents the sidebar from clipping into the main content area.
- Removes the decorative Character Builder icon and keeps the sidebar header text-only.
- Renames the Spells step and page to Spell Selection.
- Removes the Native D&D5e Background Configuration information panel and related explanatory copy from the Background screen.
- Separates spell selection checkboxes from spell detail controls. The checkbox selects the spell; clicking the spell card opens its enabled-source Item sheet for full details.
- Makes automatic full-list spells clickable for source-document review.
- Rebuilds Review cards with fixed heights, left-aligned icons, single-line ellipsis titles, full-name hover text, and a second origin/source line for Features, Feats, Spells, and Equipment.

## 0.0.1.2-alpha

- Removes all direct calls to `Actor#prepareData` from finalization. D&D5e 5.3.3 already prepares Actors after updates and embedded Item changes; calling it again reinstalled non-configurable sense compatibility accessors and caused `Cannot redefine property: darkvision` for every species.
- Adds the original finalization exception and stack trace to the browser console before displaying the Foundry notification.
- Combines Ability Scores and Background into the first creation step.
- Passes each Background intact to the native D&D5e Advancement flow; Background Ability Score bonuses are selected only in the game-system dialog.
- Shows base scores and the native applied result after the Background is confirmed.
- Removes the duplicate custom Background Ability Score selector and its invalid-state loop.
- Adds the always-available Custom Background with native Advancements and a 1 GP starting package.
- Adds a Heroic Inspiration icon when the PHB package is active and a D&D5e-styled capital C fallback otherwise.
- Enforces disabled content sources before, during, and after native Advancement flows.
- Preserves Background starting equipment and wealth from the selected source document.
- Fixes native Advancement collection reading for Bard, Cleric, Warlock, Wizard, and other spellcasting models.
- Updates cantrip and spell selection counters immediately.
- Integrates Spell Access saving with Continue and final application with Finish Character.
- Synchronizes current Hit Points to the derived maximum after feats and effects such as Tough.
- Fixes final Actor application failing with `Cannot redefine property: darkvision` by committing only plain differential leaf values, preventing D&D5e prepared-data sense shims from being reused as persisted Actor source.
- Adds commit-stage diagnostics and uses the same safe differential update strategy during rollback.
- Uses the Foundry 14 namespaced TextEditor implementation and removes the Version 13 deprecation warning.
- Adds Background icons to the custom Background picker.

## 0.0.1.1-alpha

### Deferred Background ASI hotfix

- Stores the Background Ability Score Improvement in the Character Builder Build Plan while Origins are configured.
- Restores the completed native Advancement only after Ability Scores are validated.
- Recovers interrupted drafts created by the earlier 0.0.1.1-alpha package.


### Added

- Interactive Point Buy steppers with live 27-point budget validation.
- Background Ability Score Improvement on the Ability Scores screen.
- Dedicated Spell Access step using the native D&D5e spell-list registry.
- Full-list spell population for Cleric, Druid, Paladin, and Ranger models.
- Limited spell and cantrip selection for Bard, Sorcerer, and Warlock models.
- Wizard starting cantrip and six-spell spellbook selection.
- Highest-priority source resolution for class spell pools and native granted spells.
- First-level Hit Point enforcement using maximum Hit Die plus Constitution modifier.
- Recoverable, sequential final Actor transaction with rollback.
- Automatic equipping of starting armor and shields.

### Changed

- Species, Background, and Class actions now use **Select** instead of **Configure**.
- Select buttons moved to the source preview header.
- Species and Background switching uses larger, clearer controls.
- Source option rows have increased spacing and left-aligned icons.
- Re-selecting a Class or Background rebuilds its native Advancement state instead of editing stale choices in place.
- Starting Equipment parsing now recognizes empty root group identifiers used by D&D5e 5.3.3.
- Final embedded Item application is sequential instead of concurrent.

### Fixed

- Class equipment packages failing to reach the final Actor.
- Average Hit Points being applied after repeating the level 1 Class flow.
- Paladin, Cleric, Warlock, and Wizard finishing without their class spell access.
- Wizard Background currency incorrectly masking missing Class equipment.
- Negative Dexterity and armor behavior now relies on correctly equipped native armor Items.

## 0.0.1.0-alpha

- Initial level 1 Character Builder alpha.

### 0.0.6 — Open Shop button layout hotfix 2
- Corrected a later CSS override that was shrinking the Starting Equipment action area back to two equal narrow columns.
- Increased the Open Shop column width so the full secondary label remains visible.
- Kept the Confirm Equipment button aligned without overflowing the content grid.
