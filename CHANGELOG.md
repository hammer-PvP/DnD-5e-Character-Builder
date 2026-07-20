# Changelog

## 0.9.5c Community Beta — Custom Sorcerer Metamagic

### Custom Selection and Replacement

- Moves Sorcerer Metamagic choices from the visible native Advancement window into `Spells & Features`.
- Requires two new Metamagic options at Sorcerer levels 2, 10, and 17.
- Offers one optional replacement after every Sorcerer Level Up from level 3 onward.
- Keeps known options visible but greyed out and blocks duplicates across new choices and replacement.
- Writes exact embedded Item IDs to the source-native ItemChoice Advancement and preserves full rollback safety.

### Scope Preservation

- No other class rules, spell ownership, protected commits, Native Advancement Modal Guard behavior, GM progression tools, settings, or sheet controls changed.

## 0.9.5b Community Beta — Native Advancement Modal Guard

## Native Advancement Modal Guard

- Adds a protected full-screen backdrop whenever Character Builder opens a source-native D&D5e Advancement window.
- Keeps the active native Advancement above Character Builder without using an arbitrary global z-index.
- Blocks mouse and keyboard interaction with the Character Builder window while the native flow is active.
- Allows only one Character Builder-managed native Advancement at a time.
- Removes the backdrop and restores Character Builder interaction after completion, cancellation, window close, or a render error.
- Preserves the native D&D5e Advancement interface, data model, source choices, and application behavior.
- Safely restores Character Creation Draft state when a Species, Class, or Background replacement is cancelled after an earlier native removal step.

## Scope Preservation

- No class progression rules changed.
- No spell ownership or spell-selection behavior changed.
- No Metamagic implementation changed.
- No Eldritch Invocation or Pact of the Tome behavior changed.
- No protected commit, progression-tool, settings, or character-sheet control behavior changed.

## 0.9.5a Community Beta — Conservative Maintenance

This patch intentionally changes only three isolated areas and does not alter class progression, spell ownership, protected commit behavior, or the GM batch progression tool.

### Reset Pending Level Up in XP Mode

- Keeps `Grant Level Up` and `Revoke Level Up` exclusive to Milestone Mode.
- Makes `Reset Pending Level Up` available to GMs in both Milestone and XP modes whenever a Level Up Draft or locked Hit Die result exists.
- Reset continues to delete only pending Level Up state and preserves the Actor's current XP.

### Character Sheet Button Spacing

- Preserves the approved `Start Character Builder` size, icon, colors, border, and proc animation.
- Adds an isolated sheet-header slot state and shifts only the Character Builder start button away from the D&D5e level ornament.
- Keeps the button non-shrinking and its glow visible without changing the permanent Level Up button.

### Responsive Settings Layout

- Constrains the Settings window to the current viewport.
- Keeps the compact Character Builder heading and action footer visible.
- Makes only the settings body vertically scrollable.
- Uses a two-column desktop grid and automatically returns to one column on narrower screens.
- Reduces accumulated spacing without reducing the primary control text.
- Adds a non-destructive `Cancel` action and preserves scroll position across rerenders.

## Compatibility

- Foundry VTT 14.364.
- D&D5e 5.3.3.
- Player's Handbook 2024 and SRD 5.2 Modern.
- SRD 5.1 remains unsupported.

## 0.9.5 Community Beta — Protected Creation and GM Progression

## Protected Character Creation

- Adds the same Protected Transaction confirmation and progress presentation used by Level Up to the final Character Creation commit.
- Persists a complete safety snapshot and transaction record before the first live Actor mutation.
- Applies the completed Draft with guarded stages, exact embedded Item IDs, transaction metadata, final verification, and full rollback on failure.
- Preserves the Character Creation Draft after a failed transaction.
- Detects interrupted Character Creation transactions on reconnect and restores the original Actor from the persistent snapshot.
- Locks further Character Builder changes and preserves the safety record when rollback cannot be verified.
- Handles D&D5e cached Cast spell Items conservatively during commit and rollback to avoid duplicate embedded-document deletion.

## GM Character Builder Tool

- Adds a full-width, GM-only `Character Builder Tool` button to the Actor Directory header.
- Milestone Mode lists eligible Player Character Actors and grants one Level Up to every selected Actor.
- XP Mode accepts a total XP value, divides it equally among selected Actors, truncates fractional XP, and displays the unassigned remainder.
- Writes only whole-number XP values and immediately allows normal Level Up eligibility to react to the new XP threshold.
- Records batch IDs, idempotency tokens, GM identity, timestamps, per-Actor results, and the latest applied XP batch.
- Keeps the existing individual `Grant Level Up`, `Revoke Level Up`, and `Reset Pending Level Up` controls on each Actor sheet.

## Sheet Interaction and UI

- Moves `Start Character Builder` into the D&D5e sheet-header rest controls and gives it the Character Builder stair/arrow icon, solid gold emphasis, dark border, and a restrained proc-style glow.
- Keeps a permanent Level Up button in the same interaction area after Character Creation.
- Shows unavailable Level Up at reduced opacity, fully disabled and non-interactive.
- Restores the traditional upward arrow for starting Level Up and adds a golden proc-style glow only while a new Level Up is available.
- Respects `prefers-reduced-motion` by replacing pulsing animations with a static glow.
- Makes the `Spells & Features` header and `Confirm Spells` action fixed while only the choice content scrolls.
- Uses the Character Builder stair/arrow icon in the creation prompt and settings identity.

## Compatibility

- Foundry VTT 14.364.
- D&D5e 5.3.3.
- Player's Handbook 2024 and SRD 5.2 Modern.
- SRD 5.1 remains unsupported.


## 0.9.4d Community Beta — Warlock Invocation Hotfix

### Armor of Shadows replacement

- Removes Cast Activity cached spells before deleting their owning Eldritch Invocation.
- Deletes the Invocation root with `deleteContents: false`, preventing D&D5e's un-awaited cached-spell cleanup hook from issuing a competing delete for the same embedded Item.
- Restricts the post-delete cleanup pass to explicit Advancement and Character Builder ownership and filters every ID against the live Draft collection before deletion.
- Preserves the existing replacement path for Invocations without cached Cast spells.

### Invocation target paradox guard

- Tracks every existing damaging Warlock cantrip acquisition and its explicit provider Item IDs.
- Hides target options whose only eligible acquisition is scheduled to disappear because its provider Invocation or the cantrip itself is being replaced.
- Clears a selected target immediately when a newly selected removal makes it invalid.
- Keeps an identifier available when another independently owned acquisition survives, such as a Pact Magic copy remaining after Pact of the Tome is removed.
- Revalidates target survival on the server before any Draft mutation.

### Compatibility

- Foundry VTT 14.364.
- D&D5e 5.3.3.
- Player's Handbook 2024 and SRD 5.2 Modern.
- SRD 5.1 remains unsupported.

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

## 0.9.4b Community Beta — Integrity, Native Advancement, and UX

- Publishes the accumulated post-0.9.4a correction set as a GitHub Release-ready community beta for Foundry VTT 14.364 and D&D5e 5.3.3.
- Fixes the Warlock level 1→2 managed Eldritch Invocation preflight by deferring final count validation until the Character Builder handler has applied the current-level choices.
- Preserves strict mandatory ItemGrant validation while normalizing the exact redundant malformed College of Dance Unarmed Strike reference when a valid same-level canonical grant exists.
- Reconciles native ItemChoice replacement records to exact 16-character embedded Item IDs, including Sorcerer Metamagic replacement validation.
- Strengthens the pending Hit Die lock so the first roll survives navigation, Draft reconstruction, and interface reopening until a complete reset or successful commit.
- Replaces identifier-only spell deduplication with exact acquisition ownership, allowing independent species, background, feat, class, subclass, feature, invocation, magic-item, and multiclass copies to coexist.
- Adds strict numeric CR validation and focused invalid-form replacement for Druid Known Wild Shape Forms.
- Adds an explicit Primal Order: Magician cantrip acquisition and a focused missing-cantrip repair flow without consuming or reclassifying normal Druid choices.
- Activates exactly one official Circle of the Land Nature's Ward Active Effect for the selected Land and adds full progression previews plus later-level Circle Spell summaries.
- Makes spell cards consistently open official source documents while reserving checkboxes exclusively for selection.
- Rebuilds feature-choice badges on the exact owning feature, including Weapon Mastery, Fighting Style, Scholar, Pact of the Tome, and repeatable Agonizing Blast targets.
- Reconciles stale Character Builder-owned metadata after native D&D5e rollback without changing native mechanics, levels, Items, or Advancement values.
- Clears stale College of Lore managed-feature data before writing the current `lastLevelUp` transaction.
- Keeps Magical Discoveries as its dedicated two-spell feature and presents Magical Secrets as eligibility inside the normal Bard pool.
- Normalizes Wizard Spell Mastery and Signature Spells metadata to the Wizard Class, with no subclass ownership and no temporary Draft origins.
- Restores the pre-choice Draft when a native feat selection fails prerequisites, duplicate rules, repeatability, or structural validation.
- Adds exact Warlock replacement ownership, transitive Invocation dependency protection, Lessons of the First Ones cascade cleanup, and dependent UI-state cleanup.
- Adds a separate **Enforce Multiclass Requirements** world setting beneath **Enable Multiclass**.
- Automatically applies deterministic native D&D5e Advancements on the Draft and summarizes their results, while keeping the native interface for every real choice.
- Replaces Commit Level Up with a guarded single-confirmation workflow that becomes a staged progress overlay after confirmation.
- Adds a pre-mutation Actor snapshot, temporary safety backup Actor, atomic commit behavior, full rollback, rollback fingerprint verification, critical safety lock, and GM-facing recovery diagnostics.
- Preserves `system.details.originalClass` as the sole authoritative original Class and keeps class-level and total-character-level rules separate.
- Keeps Runtime Character Management, rest-triggered reconfiguration, and source-native manual activity behavior outside this release.

## 0.9.4a Private Level Up Test Beta

- Private installable test build only; not intended for GitHub publication. The next public release remains 0.9.5.
- Keeps Runtime Character Management out of scope; this build only configures and validates results produced during Level Up.
- Adds managed Level Up flows for Bard Magical Discoveries and Magical Secrets, Druid known Wild Shape forms and Circle of the Land, Eldritch Knight and Arcane Trickster spell progression, all four Wizard Savant schools, Wizard Spell Mastery and Signature Spells, Warlock Mystic Arcanum, and Hunter choices.
- Adds feature-owned spell metadata and badges so automatic grants, always-prepared ownership, replacements, and future runtime handlers can remove only the state owned by the granting feature.
- Audits native ItemGrant spell ownership and retains native preparation, activities, uses, and recovery.
- Adds structural validation around native Advancements, including duplicate non-repeatable feats, explicit prerequisites, nested ItemChoice completion, and full pending-draft restart when native state is unsafe.
- Adds the persistent blocking “Level Up Must Be Restarted” flow while keeping the live Actor unchanged and preserving the locked Hit Die result and GM grant.
- Extends limited-caster spell progression for Eldritch Knight and Arcane Trickster and keeps Bard Magical Secrets pools active after Bard level 10.
- Adds dependency-aware Eldritch Invocation replacement validation and level-grouped alphabetical invocation display.

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
