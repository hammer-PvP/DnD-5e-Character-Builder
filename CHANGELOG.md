# Changelog

All notable changes to Character Builder are documented here.

## 0.9.8h

### Ability Score array correction

- Standard Array, Custom Array, and rolled-set dropdowns now treat `— Select —` as a real reversible choice.
- Selecting `— Select —` explicitly clears that Ability and returns its previous slot to the available pool.
- Moving an occupied slot to another Ability now removes every stale reference to that slot and immediately resets the previous Ability to `— Select —`.
- Array-slot ownership is normalized before rendering, repairing duplicated or interrupted Draft state without requiring an F5 reload.
- The requested dropdown value is captured before any protected edit confirmation can rerender the Application, preventing detached controls from restoring the previous selection.
- Equal numeric values in Custom or rolled arrays remain independent because uniqueness is enforced by slot ID rather than score value.
- Confirmation remains blocked until all six unique slots are assigned exactly once.

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
