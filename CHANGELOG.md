# Changelog

All notable changes to Character Builder are documented here.

## 0.9.8m

### Global parent-child modal stack security

- Restored a single global modal-stack coordinator for every Character Builder workflow that opens another Application, browser, picker, details sheet, or dialog.
- Only the top window in the stack can receive pointer input, focus, keyboard input, Enter, form submission, scrolling, or foreground priority; all parent and background Applications are made inert until the top window resolves or is cancelled.
- Native D&D5e detached Compendium Browsers opened by Advancement are detected without filtering or modifying their contents, covering Feats, Ability Score Improvement browsing, Spells, Items, Invocations, subclasses, and other native selectors.
- A Compendium Browser can no longer be left open while the underlying Advancement selects a different route or advances the Level Up transaction.
- Closing or cancelling a parent window closes any still-open protected descendants, preventing orphaned Browser and picker windows.
- The native Advancement guard now defers foreground priority to its active child Browser or dialog instead of raising the Advancement window above it.
- Applied the same parent-child protection to Starting Equipment Shop, Content Sources, the tutorial opened from Settings, Epic Boon browsing, document detail sheets, Character Creation, Level Up, Multiclass, and Character Keeper detail flows.
- Existing protected transaction confirmations remain authoritative and are not double-wrapped by the new stack coordinator.
- Preserved the v0.9.8l invalid generic Ability Score Improvement Item guard, global non-repeatable-option validation, v0.9.8k automatic Advancement settlement, slot-owned Ability Score arrays, and Restore Current Version Defaults.

## 0.9.8l

### Native Ability Score Improvement placeholder guard

- Restored the post-Advancement rejection for the generic `Ability Score Improvement` Item exposed by the native Feat Compendium Browser.
- The native D&D5e Advancement window and Compendium Browser remain completely untouched: no filtering, hiding, DOM manipulation, or monkeypatching is used.
- Selecting the generic Item now completes only on the temporary Level Up Draft, is detected by its native feat identity, and is rolled back to the pre-choice snapshot before any live Actor commit.
- The player receives an explicit explanation to use **Ability Score Improvement Feat** in the Advancement window so the native two-point Ability Score assignment step can run.
- The valid native ASI route remains available, as do ordinary Feats and explicitly repeatable options.
- Preserved the global non-repeatable Item/Feat validation, including source/identifier-based duplicate detection rather than name-only checks.
- Preserved the v0.9.8k automatic Advancement settlement, slot-owned Ability Score arrays, and **Restore Current Version Defaults**.

## 0.9.8k

### Automatic Advancement terminal settlement

- Fixed a client-wide deadlock when D&D5e 5.3.3 completed a fully automatic native Advancement without ever rendering an Advancement Application.
- `dnd5e.advancementManagerComplete` is now treated as the terminal lifecycle event only when no native manager window became connected.
- Automatic Species and other deterministic documents, including Orc and Dwarf, now finish post-processing, release the protected Advancement lane, re-enable Character Builder controls, and allow confirmation and progression without an F5 reload.
- Interactive Advancements continue to wait for the authoritative native window to close before the next operation can begin.
- Errors during automatic post-processing now release the guard and reservation path deterministically instead of leaving the client permanently busy.
- Preserved the approved slot-owned Standard, Custom, and rolled Array behavior and **Restore Current Version Defaults**.

## 0.9.8j

### Automatic native Advancement restoration

- Restored the generic D&D5e 5.3.3 automatic Advancement behavior for mandatory steps that require no player decision.
- Mandatory Item Grants, traits, proficiencies, spells, effects, and other deterministic results are applied directly to the Draft and continue into the Character Builder summary without opening a native Advancement window.
- The protected modal backdrop and Builder input lock now activate only after D&D5e actually renders an interactive Advancement application.
- Fully automatic Advancement processing no longer creates a modal ghost, leaves the Builder inert, or allows an Actor sheet rerender to become an unclosable foreground blocker.
- Interactive, optional, replacement, and player-choice Advancements continue to use the authoritative native D&D5e window with the existing single-flight and transactional protections.
- The correction is global for Species, Backgrounds, Classes, Subclasses, Multiclass, Feats, Level Up, and every other Character Builder workflow that invokes native Advancement.
- Preserved the v0.9.8i slot-owned Standard, Custom, and rolled Array behavior and the approved **Restore Current Version Defaults** maintenance tool.

## 0.9.8i

### Slot-owned Ability Score arrays

- Rebuilt Standard Array, Custom Array, and rolled-set assignment around one canonical list of six named slots (`slot 0` through `slot 5`) instead of six independent Ability ownership fields.
- Every slot now stores exactly one `assignedAbility`, making it structurally impossible for the same Array token to remain in Strength and another Ability at the same time.
- Selecting an occupied value moves that slot to the destination and immediately leaves its former Ability on `— Select —`.
- The destination's previous value is released back to the pool; values are never swapped automatically.
- `— Select —` remains a real control and clears any of the six Abilities directly.
- Custom and rolled arrays support repeated numeric results because slot identity is based on position, not score value.
- Added one-way migration from the previous `abilitySlotAssignments` Draft state while retaining a derived compatibility mirror.
- Serialized Array mutations per Draft and disabled the six selects during persistence so delayed events from an older render cannot apply later or overwrite the current choice.
- Rolled sets receive the same stable positional slot IDs and reset to six unassigned controls whenever a new set is selected or generated.

### Maintenance

- Retained the approved GM-only **Restore Current Version Defaults** tool and its protected `RESET` confirmation from v0.9.8h.

## 0.9.8h

### Ability Score array correction

- Standard Array, Custom Array, and rolled-set dropdowns treat `— Select —` as a real reversible choice.
- Selecting `— Select —` explicitly clears that Ability and returns its previous slot to the available pool.
- Moving an occupied slot to another Ability removes every stale reference to that slot and immediately resets the previous Ability to `— Select —`.
- Fixed the Draft persistence layer that previously merged removed Ability keys back into `abilitySlotAssignments`, causing Strength, Dexterity, or Constitution to reclaim a moved slot on the next render.
- `abilitySlotAssignments` and array-derived `baseAbilities` are now persisted as complete atomic snapshots rather than recursive partial merges.
- Array-slot ownership is normalized before rendering, repairing duplicated or interrupted Draft state without requiring an F5 reload.
- Equal numeric values in Custom or rolled arrays remain independent because uniqueness is enforced by slot ID rather than score value.
- Confirmation remains blocked until all six unique slots are assigned exactly once.

### Restore Current Version Defaults

- Added the GM-only **Restore Current Version Defaults** maintenance action to Character Builder Settings.
- The action restores only the module's world configuration to the defaults declared by the installed version, then refreshes dynamic content-source discovery.
- Actors, Items, levels, progress records, transactions, Drafts, progression ledgers, Scenes, and campaign data are never deleted or modified by this reset.
- The confirmation is protected as a true foreground modal and requires the GM to type `RESET` before **Reset Settings** becomes available.
- Added the optional **Also reset individual user preferences** choice for tutorial suppression and tutorial revision state.
- The separate **Show Splash Tutorial to Everyone Once** action remains independent and is not triggered by restoring defaults.

## 0.9.8g

### Reversible Character Creation stages

- Returning to a confirmed Character Creation step is now always a normal review action and never opens a warning.
- Attempting to change a confirmed Ability Score, Background, Species, Class, spell choice, starting-equipment choice, or Shop purchase now opens a protected confirmation before the stage is unlocked.
- Cancelling the confirmation preserves the Draft exactly as confirmed.
- Confirming the change unlocks only that stage; unrelated choices remain intact, while dependent spell/equipment state is invalidated through the existing transactional services when required.
- Confirming the edited stage locks it again and restores normal progression.

### Ability Score arrays

- Standard Array, Custom Array, and rolled-set selectors now keep every slot visible.
- Occupied values identify their current Ability, for example `15 — currently assigned to Strength`.
- Selecting an occupied value moves it to the new Ability, clears the previous Ability, and returns the destination's previous value to the available pool instead of silently swapping scores.
- The six-slot uniqueness validation remains mandatory before confirmation.

### Native Advancement concurrency

- Added single-flight protection to Ability Scores & Background, Species/Class, Spell Selection, and Starting Equipment confirmation operations.
- A guarded D&D5e Advancement operation now settles only after its native window closes, and sequential remove/add workflows reserve the native Advancement lane so another Builder flow cannot enter between them.
- Added a typed busy error, stale-guard recovery, and focus restoration to the already-active Advancement window.
- A rejected secondary operation no longer restores a snapshot that belongs to a different active transaction.

### Draft recovery

- Character Creation Draft lookup is now atomic within the client and protected by a short-lived Actor lock across clients.
- Reloading after Draft creation can recover and relink an orphaned Draft by `sourceActorId` instead of creating another Actor.
- Multiple preserved Drafts are never deleted silently; one is selected deterministically and the GM receives a diagnostic warning.
- Only one Character Builder window can be opened for the same Actor in one client.

## 0.9.8f

### Required libWrapper integration

- Added libWrapper 1.13.5.1 as a required module dependency using the official manifest URL.
- Moved the native AdvancementManager close-lifecycle interception into a centralized libWrapper `WRAPPER` registration.
- Removed the direct per-instance replacement of `manager.close`.
- Retained the official `closeApplicationV2` hook as an idempotent cleanup fallback.

### Cross-module compatibility hardening

- Fixed the reported `fnMapFind is not a function` failure by checking Arrays before any collection convenience method and removing reliance on external `.first()` implementations.
- Added safe collection helpers for Arrays, Sets, Maps, and Foundry Collections.
- Removed the second `.first()` dependency from identified Item lookup during Character Creation.
- Namespaced all Character Builder Handlebars helpers as `dnd5eCharacterBuilderEq`, `dnd5eCharacterBuilderGt`, `dnd5eCharacterBuilderAdd`, and `dnd5eCharacterBuilderConcat` so another module cannot silently provide incompatible generic helpers.
- Added the unique `dnd5e-character-builder` class to every module Application and used it for protected-window ownership lookup.
- Exposed the intentional API through the module namespace while preserving the previous beta alias for compatibility.

### Documentation

- Documented libWrapper as a required dependency and linked the official project.
- Added the compatibility-hardening policy and expanded conflict-report guidance.

## 0.9.8e

### Dynamic content sources

- Replaced the fixed Content Sources list with discovery of compatible active module, system, and world Item compendiums.
- Added a dedicated **Select Content Sources** window with search, enable/disable controls, source priority, rescan, package identity, and detected-content summaries.
- New packages such as Dungeon Master's Guide and third-party class/subclass modules can now be enabled without a hardcoded allowlist.
- Preserved separate logical entries for Player's Handbook 2024, SRD 5.2 Modern, and SRD 5.1 Legacy.

### Rules progression model

- Added a GM setting for **Modern D&D (2024 / SRD 5.2)** or **D&D 5th Edition (2014 / SRD 5.1)** progression.
- Modern mode moves native subclass ItemChoice Advancements authored at levels 1 or 2 to Class level 3.
- Legacy mode preserves the levels authored by the source Class/Subclass documents.
- Existing Class Items, creation Classes, and multiclass additions are normalized through native Advancement data rather than replacing the D&D5e Advancement workflow.

### Starting currency

- The configured GM bonus is now added to the Draft when character creation begins.
- Class and Background currency contributions are recalculated when those source documents or their equipment modes change.
- Starting currency no longer depends on entering the Shop or buying an item.
- Shop purchases remain a separate subtraction from the reconciled Draft budget, with existing checkout and rollback protections preserved.

## 0.9.8d

### Splash tutorial

- Moved `Don't Show Splash Tutorial` from browser-client storage to flags on each Foundry User.
- Users sharing the same browser now retain independent tutorial preferences.
- Moved the processed force-revision marker to each User as well.
- `Show Splash Tutorial to Everyone Once` now clears suppression directly for every User, including offline users, before triggering a new world revision.
- Preserved safe delayed opening while Character Creation, Level Up, Character Keeper, Shop, or a protected transaction is active.

### GitHub and module-page documentation

- Reorganized README as permanent user documentation instead of a version-by-version development log.
- Added a standalone changelog.
- Added public documentation images under `docs/images/` using the approved in-game tutorial assets.
- Added `docs/foundry-module-page.html`, ready to adapt for the Foundry module page.
- Changed the canonical GitHub release archive name to `dnd5e-character-builder.zip`.

## 0.9.8c

- Added multi-page first-run tutorials for Game Masters and players.
- Added contextual Wizard spellbook guidance.
- Added per-user tutorial controls and manual reopening.
- Added the GM one-shot tutorial trigger.
- Added safe opening delays around active Character Builder workflows.

## 0.9.8b

- Added true protected modal behavior to final Scribe Spell confirmation.
- Standardized automatic spell cards across Character Creation and Level Up.
- Reorganized Circle of the Land spell presentation.
- Restricted `Automatically Granted This Level` to the class/subclass being advanced.
- Simplified native automatic-progression cards.
- Fixed false multiclass conflicts between legitimate class-owned `Spellcasting` features.

## 0.9.8a

- Removed all filtering and interception from the native D&D5e Advancement browser.
- Added post-choice draft validation for Feat, ASI +2, and Epic Boon policy.
- Clarified that feats granting +1 remain Feats.
- Corrected read-only automatic spell-card rendering.
- Improved Circle of the Land spell-card readability.

## 0.9.8

- Established the frozen visual baseline planned for 1.0.
- Consolidated Character Creation, Level Up, Multiclass, Epic Boon, and Character Keeper workflows.

Earlier beta history is preserved in GitHub releases and project development records.
