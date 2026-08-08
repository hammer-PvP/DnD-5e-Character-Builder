# Changelog

## 0.9.9f

### Contextual roll effects and concentration lifecycle

- Added a generic **Contextual Roll Modifiers** runtime. Active Effects can declaratively modify rolls based on whether the effect belongs to the roller or the current target; supported operations begin with formula modifiers plus advantage/disadvantage. Modifiers are ephemeral to the current native roll and are never persisted onto the attacker, weapon, or Actor statistics.
- Added the first official adapter for **Blade Ward 2024**. Casting the native spell materializes a lightweight contextual Active Effect on the caster with `Incoming Attack Roll: -1d4`. Attack rolls against that single selected target receive the penalty; rolls against other targets do not.
- Blade Ward's runtime effect is bound to the native D&D5e concentration Active Effect through `flags.dnd5e.dependentOn`. Recasts/replacements therefore follow the system's own concentration dependency lifecycle rather than a spell-name cleanup routine.
- Added generic **Concentration & Dependent Effects** assistance. Character Builder now resolves a failed native Concentration save at the end of the shared post-roll provider queue and calls `Actor.endConcentration()` only if the final total still fails. A Bardic Inspiration or later Item-origin bonus can therefore rescue the save before concentration is ended.
- Removed premature Character-phase finalization from Bardic Inspiration. The shared queue now remains pending through Item providers and lifecycle finalizers, then publishes its finalized result after all ordered providers complete. The canonical order remains D&D5e native → Character Builder → Item runtimes → lifecycle finalizer.
- Concentration-origin effects are normalized onto D&D5e's native dependency link when needed. This allows target effects such as **Bane** to disappear when their concentration anchor ends without generic Active Effect deletion. Effects without concentration are not touched.
- Exposed a reusable contextual-effects protocol/API for future Item Creator integration: `Symbol.for("dnd5e.contextual-roll-modifiers.v1")`, `api.contextualRollModifiers`, and `api.contextualEffects`. The runtime engine is generic; official spell knowledge lives only in declarative adapter data.
- The global hidden-outcome privacy rule remains in force: contextual math may use roll context internally but never authorizes player-facing AC/DC/Success/Failure leakage.
- Polished the Character Builder Tool footer so **Short Rest** and **Long Rest** grant buttons keep their narrower width while using the same 58px height as the Level Up/Epic Boon grant controls.
- No changes were made to Always Prepared ownership/reconciliation, Circle of the Land, Pact of the Tome, Short Rest homebrew recovery, or the v0.9.9d PHB compatibility fixes.

## 0.9.9e

### GM-managed rests, subclass review, and hidden-outcome post-roll privacy

- Added optional **GM-Managed Rest Availability**. When enabled, native Short Rest and Long Rest buttons remain visible on Player Character sheets but stay locked until the GM grants the corresponding rest from Character Builder Tool. Short and Long Rest grants are independent, per Actor, and one-use.
- Added compact **Short Rest** and **Long Rest** grant controls to Character Builder Tool. They act only on the GM-selected completed Player Characters and grant availability; they never execute a rest on behalf of a player. Available native sheet buttons glow until used.
- Rest gating is enforced both in the sheet UI and in D&D5e's pre-rest hooks. The actual rest remains the native D&D5e flow, followed by Character Keeper and any enabled post-rest assistance. A grant is consumed only after that complete flow succeeds; an interrupted post-native Keeper transaction keeps the grant available for recovery.
- Disabling GM-Managed Rest Availability returns the world to unrestricted native D&D5e rest behavior and clears Character Builder rest grants. The optional Half Long-Rest Recovery on Short Rest remains an independent setting and its recovery logic is unchanged.
- Added an explicit **subclass review** stage inside Level Up Class Progression. When native Advancement creates a new Subclass Item, Level Up remains on Class Progression instead of immediately advancing.
- The subclass review reorganizes the progression summary into a compact column and uses the remaining workspace for the selected subclass's native description, features granted at the current class level, and source-authored Advancement progression at later class levels. Players explicitly continue after reviewing the package.
- Reworked **Bardic Inspiration** assistance to avoid leaking hidden AC/DC outcomes. While a native Bardic Inspiration effect is available, the compact decision appears after every eligible attack roll, ability check, skill check, tool check, or saving throw rather than only after a detected failure.
- The player-facing Bardic Inspiration decision shows only the roll total, source Bard, die, and **Use / Keep** actions. It never displays AC, DC, Success, Failure, or any equivalent hidden-outcome cue. The decision is draggable and has no visual blur/backdrop, while remaining functionally modal so another action cannot be started before it is resolved.
- When Bardic Inspiration is used, the public result reports only the original total, bonus, and new total. A separate GM-only whisper carries the target/success result when D&D5e supplied enough information to determine it.
- The shared roll-resolution protocol still preserves internal `target` / `succeeded` data for provider coordination, but those fields are now explicitly private implementation data: a post-roll provider must not condition player-facing prompt visibility on a hidden success/failure result. Item Creator must adopt the same neutral-prompt policy in its own runtime; this release changes only the Character Builder side.
- No changes were made to Always Prepared ownership/reconciliation, Circle of the Land, Pact of the Tome, the Short Rest homebrew recovery algorithm, or the four PHB compatibility fixes validated in v0.9.9d.

## 0.9.9d

### PHB feature compatibility and focused runtime assistance

- Added an idempotent native-feature compatibility reconciliation for `Font of Inspiration`. When the feature is present, `Bardic Inspiration` is normalized to D&D5e 5.3.3's native `Short Rest → Recover All Uses` profile, so the native Short Rest restores all uses and the optional half-recovery homebrew no longer treats it as Long-Rest-only.
- Added the equivalent reconciliation for Light Domain `Improved Warding Flare`, changing `Warding Flare` to the native Short-Rest recover-all profile once the level-6 feature is present.
- Both recovery mutations run inside the Level Up Draft before commit and also perform a focused idempotent ready-time reconciliation, allowing existing Character Builder Actors that already own the trigger feature to be corrected without recreation. No spell ownership, Circle of the Land, Always Prepared, or resource-formula logic is changed.
- Added `Resourceful` to the protected post-Long-Rest lifecycle. After the native Long Rest completes, a Human with Resourceful is guaranteed Heroic Inspiration if it is not already present. The operation is idempotent and does not touch any other Actor resource.
- Extended the no-action Character Keeper path so automatic post-rest lifecycle rules can run transactionally even when the rest has no optional Keeper choices. Native rest recovery still executes first and exactly once.
- Added an optional granular Rules Automation Assistance rule for `Lay on Hands: Remove Poison`. After the official native Activity successfully consumes its 5-point Lay on Hands cost, Character Builder removes only the native `Poisoned` status from the single recorded target through `Actor.toggleStatusEffect`.
- Remove Poison target updates are owner/GM-authoritative. If the acting player cannot update the target Actor, the request is validated and delegated to the active GM through the module socket. No generic Active Effect deletion is performed.
- This patch is deliberately limited to the four live-confirmed gaps above. Existing Circle of the Land reconciliation, Always Prepared spell ownership, Short Rest homebrew recovery, Bardic Inspiration post-failure logic, and shared Item Creator roll-resolution integration remain otherwise unchanged.

## 0.9.9c

### Circle of the Land ownership and Long Rest state reconciliation

- Fixed Circle of the Land Level Up processing reapplying every already-unlocked Land spell on later Druid levels. Existing semantic Land owners are now left untouched; only newly unlocked or genuinely missing expected Land spells are processed.
- The durable Circle Land choice is no longer rewritten on every Level Up, preventing the same Land state from being presented as a new choice transaction repeatedly.
- Preserved the v0.9.9b ownership/reconciliation contract. `FeatureSpellOwnershipService` and `AlwaysPreparedSpellReconciliationService` are unchanged.
- Reworked the Character Keeper `Change Land` spell mutation into desired-state reconciliation. A compatible normal Druid acquisition is reused and promoted to Always Prepared; only spells without a normal Druid acquisition receive a dedicated Land spell Item.
- Leaving a Land removes only that Land owner. Normal Druid spells are preserved and return to their recorded prior preparation state; dedicated Land-only spells are removed when no other owner remains.
- Added a focused fallback for legacy Circle records whose repeated owner updates lost `previousPrepared`: during an explicit Change Land transaction, a normal Druid spell is never left invalidly Always Prepared after its Land owner is removed. A recorded reconciliation snapshot is preferred; otherwise the neutral full-list state is used.
- Character Keeper now reconciles Circle spell badges as current visual state. All previous Circle-of-the-Land spell badges are removed during a Land change and exactly one badge is projected onto each currently owned Land spell.
- History rebuilds now emit the durable Land-choice badge only for the transaction that actually established that Land, avoiding repeated `Land` badges across later Level Ups.
- Species/lineage spell acquisitions remain independent. Wood Elf Longstrider and Pass without Trace keep their own Always Prepared state, chosen lineage ability, 1/Long Rest free cast, and separate spell Item even when the class also has the same spell.
- Regression-tested the reported level-20 Druid Actor through Arid → Polar → Arid. Normal Druid copies were reused without duplication, Blight/Wall of Stone correctly lost and regained Always Prepared, dedicated Land cantrips were removed/recreated correctly, Circle badges stayed singular, and Wood Elf/Druid Longstrider remained two independent acquisitions.
- No migration scan is performed. Existing Actors are only reconciled when the player explicitly uses Change Land or proceeds through future Level Ups.

## 0.9.9b

### Generic native free-cast reconciliation hotfix

- Fixed Always Prepared augmentation detection against live D&D5e 5.3.3 Items. `system.activities` is an `ActivityCollection` at runtime, so the reconciliation service now enumerates it through its collection iterator instead of treating it as a plain object.
- The fix is generic for every native ItemGrant spell augmentation and contains no spell-name or feature-name exceptions. Divine Smite and Find Steed are regression cases, not production special cases.
- Preparation-only reconciliation remains unchanged; the correction affects only grants that carry an explicit native use pool / free-cast augmentation.
- Added an independent pre-commit audit for native augmenting grants. If the transaction still contains both the normal class spell and its Always Prepared use-pool grant, commit is rejected instead of silently delivering duplicate spells.
- Verified the complete merge path against the reported Paladin Actor structure: the canonical spell receives Always Prepared, the native use pool and forwarding Activities, the duplicate is removed, and the owning Advancement `value.added` is redirected to the canonical spell.
- Corrected the internal `MODULE_VERSION` constant to `0.9.9b`, restoring accurate transaction/history version reporting.
- Preserved the transaction-only/no-migration rule and made no changes to Character Keeper, rest management, Rules Automation Assistance, Bardic Inspiration, shared roll resolution, or Item Creator runtime files.

## 0.9.9a

### Always Prepared reconciliation hotfix and native spell augmentation

- Fixed the v0.9.9 merge comparison incorrectly treating embedded Active Effect `_stats` timestamps and other runtime metadata as mechanical differences. Preparation-only duplicates such as Protection from Evil and Good, Shield of Faith, Aid, and Zone of Truth can now reconcile when their actual spell mechanics match.
- Added a generic native ItemGrant augmentation path for Always Prepared grants that explicitly declare a free-use pool. This covers Paladin's Smite / Divine Smite and Faithful Steed / Find Steed without hard-coded spell names.
- The canonical spell keeps its original spell-slot Activities while receiving only the ItemGrant-declared Always Prepared state, use pool/recovery, and free-cast forwarding Activities. Spending the free use therefore does not remove normal spell-slot casting.
- Native ItemGrant ownership is now recovered from `featureSpellOwners` and the owning Advancement even when the native-created spell did not receive a Character Builder `itemGrantInstance` flag. The Advancement `value.added` entry is redirected to the canonical spell and remains valid for later integrity audits.
- Previous preparation state is read from the untouched source Actor when available, rather than from a Draft that native Advancement processing may already have changed. This preserves the true pre-grant state for ownership receipts and future reversibility.
- Reconciliation receipts were expanded to schema 2 for augmenting grants, recording the previous use pool, applied use pool, added forwarding Activity IDs, and any consumption targets added by the ItemGrant.
- Preserved the transaction-only/no-migration rule. Existing Actors are not scanned or repaired automatically.
- No Character Keeper, rest-management, Rules Automation Assistance, Bardic Inspiration, shared roll-resolution, or Item Creator runtime implementation files were changed.

## 0.9.9

### Character Creation and Level Up stabilization — Always Prepared spell reconciliation

- Began the 0.9.9 stabilization line for Character Creation and Level Up while preserving v0.9.8v as the rollback baseline.
- Added transaction-scoped reconciliation for a leveled class spell that is already present through normal class access and is newly granted as Always Prepared by a native Class, Subclass, or class-linked Feature.
- The Actor now keeps one canonical spell Item. Character Builder promotes it to Always Prepared, records both acquisition owners, redirects the native ItemGrant receipt, and removes only the redundant spell created during the active Draft transaction.
- Limited-list casters recover a normal spell selection when a previously selected spell becomes Always Prepared. The Level Up screen requires the released replacement choice before commit, excludes that same spell from the optional replacement channel, and the Review identifies why the choice was restored.
- Full-list casters retain one class spell document and receive only the Always Prepared state; no artificial extra prepared-spell choice is created.
- Paladin's Smite keeps its native Feature Item, free-cast Activity, use counter, and recovery. Only the redundant Divine Smite spell is reconciled, so the single spell remains usable with spell slots after the free cast is spent.
- Added `mergedItemGrants` receipts so native ItemGrant integrity recognizes the canonical shared spell without recreating the deleted duplicate.
- Added strict merge guards. Character Builder requires the same canonical source document and equivalent Activities/effects, and does not merge Item-origin spells, different classes or casting abilities, different casting methods, spell documents with their own uses/recovery, forward Activities, or Activity/item-use consumption.
- Reconciliation occurs inside the Draft before commit and validates both the canonical spell and the redirected native Advancement link. It does not scan or migrate existing Actors.
- Added a dedicated Review section and architecture documentation at `docs/ALWAYS-PREPARED-SPELL-RECONCILIATION.md`.
- No Character Keeper, rest-management, runtime resource, or Rules Automation Assistance implementation files were changed.

## 0.9.8v

### Structured post-roll finalization contract

- Upgraded the shared roll-resolution API to protocol v2 while retaining `Symbol.for("dnd5e.roll-resolution-queue.v1")` and the original `enqueue` interface for backward compatibility.
- Character Builder now marks every eligible failed D20 Test as pending before resolving Bardic Inspiration and always publishes a finalized structured result afterward.
- Finalization occurs when Bardic Inspiration is used, kept, unavailable, disabled, or cannot be resolved, preventing downstream Item Creator prompts from reading the stale native total.
- Added the hooks `dnd5e-character-builder.rollResolutionPending` and `dnd5e-character-builder.rollResolutionFinalized`.
- Added `markPending`, `finalize`, `getResolution`, and `waitForFinalized` to `game.modules.get("dnd5e-character-builder").api.rollResolutionQueue`.
- The finalized payload contains `rollKey`, `actorUuid`, `rollType`, `originalTotal`, `currentTotal`, `target`, `succeeded`, `finalized`, and normalized `adjustments`.
- Bardic Inspiration records `{ source: "Bardic Inspiration", bonus }` only when the player actually uses the die; choosing **Keep Inspiration** publishes the unchanged total with an empty adjustments list.
- Preserved the phase order D&D5e native → Character Builder → Item runtime. An `items`-phase provider now receives the finalized Character Builder context, allowing it to skip its prompt after a converted success or continue from the updated failed total.
- Added `docs/ROLL-RESOLUTION-PROTOCOL.md` as the cross-module integration contract.
- Preserved all v0.9.8u Bardic Inspiration behavior, effect-origin boundaries, and prior Character Builder functionality.

## 0.9.8u

### Native Bardic Inspiration post-failure assistance

- Added **Bard — Bardic Inspiration** to the granular Rules Automation Assistance list.
- Detects an active official 2024 Bardic Inspiration effect on the rolling Actor after a failed attack roll, ability check, skill check, tool check, or saving throw when the native roll contains a real target number.
- Resolves the inspiration die from the source Bard's native class scale, with the official Bard-level progression as a safe fallback: d6 at levels 1–4, d8 at 5–9, d10 at 10–14, and d12 at 15–20.
- Presents a protected foreground choice to use the die or preserve the effect for a later failed D20 Test. Declining does not alter the Actor.
- When accepted, rolls the source Bard's current die, reports the original total, inspiration result, final total, and success state in chat, then removes the recipient's native Bardic Inspiration effect.
- Does not spend the source Bard's resource a second time; the Bard's native feature use remains authoritative when the inspiration is granted.
- Restricts the runtime to native Bardic Inspiration feature effects and does not claim effects originating from Items, which remain the responsibility of the Item Creator runtime.
- Added player-owner arbitration, duplicate-roll protection, per-effect locks, and active-GM socket fallback for effect removal.
- Added the shared per-roll resolution protocol `dnd5e.roll-resolution-queue.v1`: Character Builder registers in the `character` phase before the reserved `items` phase, preventing competing post-roll prompts and passing the updated total to later providers.
- Preserved the v0.9.8t optional Short Rest homebrew and all previously validated creation, Level Up, Keeper, and assistance behavior.

## 0.9.8t

### Configurable homebrew Short Rest recovery and settings documentation

- Added the GM-only **Half Long-Rest Recovery on Short Rest** world setting. It is disabled by default, so existing worlds retain native D&D5e rest behavior until the GM explicitly enables the homebrew.
- After one native Short Rest completes, the optional layer restores half of each eligible Long-Rest-only reserve, rounded down and limited by the amount missing or spent. Supported reserves include normal Long-Rest spell slots, Actor resources, Item uses, and Activity uses.
- Excluded HP, Hit Dice, temporary HP, Death Saves, Exhaustion, spell preparation, effect expiry, consumable quantities, dawn/day recovery, Pact Magic, and resources already recovered by a native Short Rest.
- Added **Short Rest Homebrew Cooldown**, configurable from 0 to 10080 server-time minutes and defaulting to 5. The cooldown restricts only the additional homebrew recovery; the native Short Rest always completes normally.
- Added GM-authoritative socket execution, per-Actor locking, rest-session idempotency, persisted server timestamps, and duplicate-request protection for the homebrew layer.
- Added chat audit cards listing every recovered reserve, or reporting cooldown/no-resource outcomes.
- Ensured the optional recovery also runs for Actors that have no other Character Keeper rest action.
- Changed settings saving to conservatively merge with stored world settings, preventing new settings from erasing existing or future configuration fields.
- Added a complete settings reference at `docs/SETTINGS.md` and expanded inline descriptions for the new homebrew, its cooldown, and creation prompting.
- Preserved the validated v0.9.8s Level Up, temporary Actor socket, Weapon Mastery, Eldritch Knight, and Arcane Trickster behavior.

## 0.9.8s

### Protected temporary Actor socket hotfix

- Enabled the module socket namespace in the Foundry manifest with `"socket": true`, allowing player requests for protected Draft and Safety Backup creation or cleanup to reach the active GM client.
- Fixed the 15-second `The active GM did not complete the protected Character Builder Actor operation in time` failure that blocked player-initiated Level Up, Class Selection restart, commit preparation, and temporary Actor cleanup.
- Preserved the GM-authoritative validation model from v0.9.8r; players still do not need global Create Actor or Delete Actor permissions.
- Added package verification requiring `socket: true` in both the installable module manifest and the external release manifest.

## 0.9.8r

### GM-authoritative Draft lifecycle and third-caster Level Up fixes

- Added a closed, GM-authoritative temporary Actor service for Character Creation Drafts, Level Up Drafts, commit safety backups, reset/restart flows, and cleanup. Players no longer need the global Foundry permissions to create or delete Actors in order to use these Character Builder workflows.
- The active GM executes validated create/delete requests automatically through the module socket without confirmation prompts. Requests are restricted to known temporary Actor types, source-Actor ownership, provenance flags, transaction identity, and safety-lock checks; normal Actors cannot be deleted through this service.
- Fixed player-facing `lacks permission to delete Actor` errors after a successful Level Up and while restarting Class Selection. Completed transactions no longer fail or roll back merely because temporary cleanup needs GM authority.
- Corrected Eldritch Knight and Arcane Trickster spell-level progression: class levels 3–6 allow level 1 spells, 7–12 level 2, 13–18 level 3, and 19–20 level 4.
- Added a pre-commit guard that rejects newly selected third-caster spells above the legal spell level for the target class level.
- Expanded Arcane Trickster and Eldritch Knight spell ownership discovery across native `system.classIdentifier`, embedded `sourceItem` references, full Advancement UUID paths, source IDs, and Character Builder acquisition flags so optional spell replacement works for legacy and Builder-managed Actors.
- Preserved the v0.9.8q Advancement-integrity fix and the v0.9.8p granular Rules Automation Assistance controls.

## 0.9.8q

- Prevents rules-mode normalization from replacing complete live Class Advancement data.
- Preserves player choices such as Weapon Mastery, proficiencies, ItemGrant records, and ASI/Feat state across world reloads.
- Conservatively repairs missing Weapon Mastery `value.chosen` records when exact ownership can be recovered from Character Builder badges or an unambiguous single-class legacy state.
- Adds regression coverage for Advancement integrity and ambiguous multiclass mastery ownership.

All notable changes to Character Builder are documented here.

## 0.9.8p

### Granular Rules Automation Assistance and Foundry 14.365

- Replaced the long Rules Assistance settings block with a compact GM-only master switch, a short purpose statement, an enabled-rule count, and a **Configure Assistance Rules** button.
- Added a protected configuration window with independent toggles for Great Weapon Fighting, Thrown Weapon Fighting, Cleric Potent Spellcasting, Druid Potent Spellcasting, Wizard Empowered Evocation, Mage Armor Effect Application, and Agonizing Blast Native Binding.
- Turning the master switch off now pauses every assistance without erasing the per-rule choices. Re-enabling it restores the previously selected rule set.
- Added per-rule runtime gates so a GM can disable only the automation that overlaps with another module while leaving the remaining Character Builder assistance active.
- Moved Agonizing Blast Native Binding under the same master and per-rule controls. Existing native enchantments remain intact while the rule is paused, and reconciliation resumes when it is enabled again.
- Preserved existing world preferences during migration: worlds upgrading from earlier builds inherit every current individual rule as enabled while retaining the previous master-switch state.
- Updated the module manifest, README, release metadata, and module-page compatibility text for Foundry VTT 14.365 while retaining the existing minimum version and removing the unnecessary Foundry maximum declaration.

## 0.9.8o

### Rules Automation Assistance and Mage Armor

- Renamed the visible **Assist with Dice Automation** setting to **Rules Automation Assistance** while preserving the existing internal setting key and saved GM preference.
- Added the settings note that managed bindings and reconciliation are most reliable for characters created, leveled, and maintained through Character Builder and Character Keeper, while manually created Actors remain supported when their native data can be identified.
- Added automatic **Mage Armor** effect application after a successful native activity use. The service resolves one real target for the normal spell and Self for Armor of Shadows.
- Reused the Active Effect embedded in the source spell or feature, preserving the native `system.attributes.ac.calc = mage` calculation and duration instead of inventing a parallel AC formula.
- Added pre-use validation that blocks Mage Armor before resource consumption when the target is wearing equipped light, medium, or heavy body armor. Clothing, shields, and non-armor equipment remain eligible.
- Recasting Mage Armor refreshes the existing effect instead of stacking a duplicate. Equipping body armor while Mage Armor is active ends the effect; removing that armor does not restore the spell automatically.
- Added active-GM socket fallback so an owned caster can apply Mage Armor to another eligible Actor even when the casting player cannot directly update that target.
- Preserved the approved v0.9.8n Great Weapon Fighting, Versatile two-hand detection, Empowered Evocation, Potent Spellcasting, Thrown Weapon Fighting, and Agonizing Blast reconciliation behavior.
- Added regression coverage for Mage Armor target validation, native-effect creation, refresh without duplication, and termination when body armor is equipped.

## 0.9.8n

### Rules Assistance foundation

- Added the GM-controlled **Assist with Dice Automation** world setting. It is disabled by default and applies only to the approved deterministic mechanics in this initial test package.
- Added a silent, hook-based runtime rules engine that modifies only the current native D&D5e damage-roll configuration. It does not duplicate Items, weapons, Activities, buttons, chat commands, or persist altered formulas.
- Added **Great Weapon Fighting** support: eligible damage dice from a Melee weapon used with two hands receive a temporary minimum result of 3. Versatile weapons require the native Two-Handed attack mode.
- Added **Thrown Weapon Fighting** support: a temporary +2 damage bonus is applied only when a weapon with the Thrown property is actually used in a native Thrown attack mode.
- Added **Blessed Strikes: Potent Spellcasting** and **Elemental Fury: Potent Spellcasting** support for Character Builder-tagged Cleric and Druid cantrips, using the Actor's current Wisdom modifier.
- Added **Empowered Evocation** support. A confirmed cast of a Wizard Evocation spell creates a short-lived cast context, and the Actor's current Intelligence modifier is added to one damage roll from that cast.
- Added native **Agonizing Blast** binding reconciliation. Character Builder's existing Invocation-to-cantrip target now applies and maintains the official PHB `Make Agonizing` enchantment, including the native `, Agonizing` display suffix and `@abilities.cha.mod` damage bonus.
- Agonizing Blast reconciliation runs during Level Up preparation and commit, Character Creation commit, relevant Item/Effect changes, and an authoritative GM startup audit. Existing native applications are adopted instead of duplicated.
- Added ownership metadata for managed native enchantments so retargeting or removing an Invocation removes only the enchantment belonging to that Invocation instance.
- Added a small in-memory diagnostics API for GM/Keeper auditing and possible duplicate-automation warnings.
- Added regression coverage for the new formula transformer, native binding reconciliation, Great Weapon Fighting, Thrown Weapon Fighting, Potent Spellcasting, and cast-scoped Empowered Evocation.

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
