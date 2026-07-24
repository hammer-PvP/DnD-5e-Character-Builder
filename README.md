# Character Builder

Character Builder is a guided D&D 2024 character creation, Level Up, Epic Boon, and Character Keeper module for Foundry Virtual Tabletop 14 and D&D5e 5.3.3.

## Official compatibility

- Player's Handbook 2024 content package
- SRD 5.2 Modern
- Foundry VTT 14.364
- D&D5e 5.3.3

SRD 5.1 Legacy is not officially supported. Character Keeper is treated as stable for its currently implemented Short Rest, Long Rest, and Wizard spellbook-management routines; version 0.9.8a limits Keeper changes to visual or minor cross-cutting corrections.

## Level 1 creation

- Combined Ability Scores and Background creation with native D&D5e Advancements.
- Configurable Point Buy, exclusive Standard Array, GM-defined Custom Array, Single/Limited/Unlimited rolled sets, and manual Ability Score methods.
- Custom Background with free 2024 Ability Score assignment, an Origin Feat, two skills, one tool, Common plus two Standard Languages, and 1 GP.
- Species and Class selection with staged preview, confirmation, and source filtering.
- Class spell access for full-list, limited-selection, Pact Magic, and Wizard spellbook models.
- Exact acquisition ownership allows the same spell or cantrip to coexist when it comes from different sources.
- Independent Class and Background starting equipment or starting-currency choices.
- Transactional mundane Starting Equipment Shop with Checkout, exact purchase manifests, containers, quantity support, and GM Bonus Gold.
- Review and recoverable application to the original Actor.

## Character Builder 0.9.8a — Stability corrections

Version 0.9.8a keeps the approved 0.9.8 visual layout frozen and corrects the first issues found during live testing. It intentionally performs no migration or automatic repair of Actors created by earlier versions, other applications, manual editing, or homebrew workflows.


### 0.9.8a live-test corrections

- The native D&D5e AdvancementManager and Compendium Browser now run completely untouched. Feat, ASI +2, and Epic Boon policy is validated only after the native workflow finishes on the Level Up Draft and before any live Actor commit.
- `ASI +2` means only the generic two-point Ability Score Improvement option. Every other feat remains a Feat, including feats that grant +1 to an Ability Score.
- Invalid policy choices are rolled back to the pre-choice Draft snapshot and receive a concise GM-policy message before the player reopens Class Progression.
- Read-only `Automatically Added Class Spells` cards retain the approved layout and now display their spell names and source text instead of collapsing to the icon column.
- Circle of the Land `Change Land` spell cards retain the approved two-column Keeper layout, use larger readable content, and show only `Cantrip` or `Level N` beneath the spell name.

### Ability Scores

- **Exclusive Standard Array slots:** every Standard Array slot can be assigned exactly once. Selecting a slot removes it from the other Ability dropdowns; clearing or changing the assignment returns the prior slot immediately. Slot identity, rather than only numeric value, is validated before confirmation.
- **GM-configurable Custom Array:** the GM can enable a six-slot Custom Array and configure each independent whole-number slot from 1 through 20. Duplicate numeric values remain distinct slots, and players may assign each slot once to any Ability Score.
- **Explicit roll modes:** Roll Ability Scores supports `Single Roll`, `Limited Rolls`, and `Unlimited Rolls`. Limited Rolls uses a GM-defined total number of complete sets, including the first, while the creation screen reports generated and remaining sets and blocks duplicate or over-limit roll requests.

### Feat, ASI, and Epic Boon policy

- New GM controls are enabled by default: `Enable Feats`, `Enable Ability Score Improvement`, and `Enable Epic Boons`. With all three enabled, the existing official behavior is unchanged.
- Native D&D5e browsers, queries, indexes, filters, and Advancement documents remain untouched. Character Builder validates only the confirmed result and validates it again before commit.
- Disabling Feats rejects optional common Feats, including Feats that grant a +1 Ability Score increase, while mandatory source grants and already-owned Feats remain untouched.
- Disabling Ability Score Improvement rejects only the generic two-point ASI. When Feats remain enabled, eligible Feats that grant a +1 Ability Score increase remain valid.
- Disabling Epic Boons rejects new Epic Boon choices. The GM `Grant Epic Boons` tool additionally requires both `Enable Epic Boons` and `Enable Grant Epic Boons`.

### Spells and cantrips

- Every cantrip created or replaced by the current Character Creation, Level Up, Multiclass, Pact of the Tome, ItemGrant repair, or Character Keeper workflow is written as native D&D5e `Always Prepared` state. Cantrips remain separate from Prepared Spells of level 1+ and cannot be unprepared from the sheet.
- A central preparation-state policy keeps current module workflows consistent while preserving normal prepared, always-prepared, spellbook, full-list, and scribed spell behavior for leveled spells.
- No Actor-wide migration or retrospective cantrip repair is performed.

### Level Up and multiclass presentation

- `Native Progression Applied Automatically` now respects primary-versus-secondary class restrictions, so multiclass summaries do not display initial-class Saving Throws, Heavy Armor, or other grants that the native system did not apply.
- Automatic grants are consolidated by category and use complete labels such as `Constitution`, `Charisma`, `Martial Weapons`, `Light Armor`, `Medium Armor`, and `Shields` instead of internal abbreviations or truncated source text.
- The sticky spell-choice heading now meets the Level Up banner without an exposed scrolling strip.

### Protected confirmations and visual corrections

- Transaction confirmations use modal blocking behavior so Character Creation, Level Up, Multiclass, Epic Boon, Character Keeper, and Scribe Spell confirmations cannot fall behind another module window while awaiting a decision.
- Scribe Spell displays `Confirm Scribing` and the complete GP cost on separate lines in both the Keeper action and final confirmation.
- Square selection checks are centered without changing their approved size or hit area.
- Gold action buttons retain their visual identity with improved title and subtitle legibility.

## Character Builder 0.9.7g — Visual standardization follow-up

Version 0.9.7g consolidates the approved visual-standardization work from 0.9.7f and the complete live-review corrections. It does not change Character Creation rules, Level Up rules, Character Keeper operations, source filters, Advancements, ownership, transactions, commit behavior, rollback, or Actor data handling.

- **Foundry window controls restored:** module typography is now scoped to the window content only. Foundry's native title-bar controls retain their original icon font in Character Creation, Level Up, Character Keeper, Scribe Spell, and the other module windows.
- **Character Creation fixed header stack:** the stage title, search/context area, Confirm button, and Continue button remain together at the top while only the stage body scrolls. The exposed strip above the previous sticky header and the overlap over the top actions are removed.
- **Live selection counters remain visible:** Spell Selection choice headings and their current/required counters remain below the fixed stage controls while the relevant selection section is active.
- **Single clean checkbox mark:** Character Creation checkboxes suppress the additional native D&D5e checked square, leaving one outlined square and one green check. The approved large left selection zone and separate right source-details zone remain unchanged.
- **Preserved 0.9.7f visual fixes:** Level Up typography and sticky choice counters, Keeper two-zone cards, Keeper square selection controls, fully greyed-out unavailable choices, dark Weapon Mastery dropdowns, and the approved Bardo/Wizard Level Up layouts are retained.

## Character Builder 0.9.7f — Character Keeper reset and selectable-card patch

Version 0.9.7f preserves the 0.9.7e confirmation flow and consolidates the next live-test corrections without changing the validated Character Creation or Level Up mechanics.

- **Definitive `Discard Rest Changes`:** the complete `restManagementSession` flag is removed with `unsetFlag` before a clean session is written again. This avoids Foundry's recursive object-flag merge and guarantees that confirmed `operations` and `completedActionIds` cannot survive the reset.
- **Complete session rollback before rest:** confirmed and unconfirmed Weapon Mastery, Change Land, Replace Cantrip, Pact, Wild Shape, Spell Mastery, and every other staged Short/Long Rest operation return to the live Actor baseline. Green checks and form edits are rebuilt from the Actor; the Actor itself remains untouched until the final rest commit.
- **Protected public-roll locks:** Cosmic Omen and Portent operation payloads are discarded, but their public-chat roll locks remain for the pending rest so closing, reopening, or resetting cannot create a reroll exploit.
- **Keeper-wide two-zone selectable cards:** every selectable option card in the right panel now separates interaction into a compact left selection square and a larger right details panel. The left zone only changes the radio/checkbox; the right zone only opens the source document. This applies to Aspect of the Wilds, Ranger feature choices, Circle Land, Wild Shape forms, Pact of the Tome, Wizard Replace Cantrip, Spell Mastery, and Scribe Spell options.
- **Unavailable options are unambiguous:** blocked or ineligible cards are fully greyed out, including image, checkbox, text, border, background, and source-detail control. They cannot be selected or opened until they become eligible.
- **Clear hover and keyboard focus:** selection and source-detail zones use different hover/focus feedback, while the Keeper's left action column remains simple event navigation with no document-opening behavior.

## Character Builder 0.9.7e — Rest confirmation and legacy Item compatibility patch

Version 0.9.7e preserves the validated 0.9.7d runtime routines while improving the Character Keeper confirmation flow and preventing legacy or GM-granted Items from blocking an otherwise valid Level Up.

- **Transaction-scoped source validation:** Level Up source enforcement now validates only documents created by the current progression transaction. Existing Class and other Actor documents are treated as legacy input unless the transaction replaces them with a new embedded document. Existing Actor Items are preserved without source revalidation, including homebrew and GM-granted weapons, armor, equipment, tools, potions, Spell Scrolls, consumables, ammunition, containers, loot, and magic Items whose historical `sourceId` or `compendiumSource` still points to SRD 5.1 or another disabled package.
- **No legacy inventory mutation:** pre-existing Items are copied to the completed Actor unchanged. Character Builder does not delete, replace, relink, or automatically clean their source metadata. Normal inventory changes such as quantity, uses, equipped state, attunement, identification, container, and sort order do not make those Items newly granted content.
- **New content remains protected:** Classes, subclasses, features, feats, spells, and other documents actually granted by the current Character Builder or native Advancement transaction are still checked against enabled sources. Error messages list only the new transaction content that could not be resolved safely.
- **Confirmed-per-action Rest flow:** editing a Character Keeper action creates an explicit amber `Unconfirmed Changes` state. The player must confirm that action with its top button before opening another action or continuing the Short or Long Rest. Confirmed actions retain the existing green check and remain staged until the final rest commit.
- **Discard Rest Changes:** before the native rest begins, the footer provides a dedicated reset action whenever confirmed or unconfirmed Keeper choices exist. It clears staged operations, checks, and the current form edit while leaving the Actor untouched. Public roll locks remain for the pending rest so discarded Cosmic Omen or Portent rolls cannot be rerolled.
- **Single final commit:** individual confirmation buttons stage choices only. `Continue Short Rest` or `Continue Long Rest` performs the native D&D5e rest exactly once and then applies all confirmed Character Keeper operations through the existing rollback-protected transaction.
- **Scribe confirmation layout:** the Scribe Spell button now uses two fixed lines: `Confirm Scribing` and the complete GP cost. The amount and `GP` remain together instead of wrapping independently.
- **Foundry module title:** the manifest title is now `Character Builder (DnD 5e - 2024)`, which is the name shown in the Foundry module browser.

## Character Builder 0.9.7d — Scribe Spell and Keeper cleanup patch

Version 0.9.7d is a focused follow-up to 0.9.7c. It preserves the validated Wizard cantrip-replacement routine and the existing native D&D5e mechanics while correcting the Scribe Spell workflow, removing an unnecessary prepared-spell manager, and improving Weapon Mastery selection.

- **Native prepared-spell management:** Character Keeper no longer creates `Replace Paladin Spell` or `Replace Ranger Spell` actions. Cleric, Druid, Paladin, Ranger, and Wizard prepare and unprepare their normal spells through the native D&D5e sheet. Keeper remains limited to permanent or feature-specific changes such as Wizard cantrip replacement, Spell Mastery, Scribe Spell, Pact of the Tome, and Circle of the Land ownership changes.
- **Scribe Spell checkout:** selecting an eligible Spell Scroll now opens a complete review before any roll, currency payment, scroll consumption, or spell creation. It displays the spell, level, source, official and effective costs, current and remaining currency, required time, Arcana bonus, DC when applicable, and the configured success and failure consequences.
- **Scribing settings:** `Allow Spell Scroll Scribing`, `Require Arcana Check for Spell Scroll Scribing`, and `Charge Scribing Cost on Failed Check` are GM checkboxes enabled by default. The existing `Charge Wizard Scribing Costs` setting remains authoritative for whether any GP is charged.
- **Configurable outcome:** when the Arcana check is disabled, a confirmed eligible attempt succeeds automatically without an artificial roll. When enabled, the check uses Intelligence (Arcana) against DC 10 + spell level. The scroll is consumed on an actual attempt; a failed attempt charges GP only when both general cost charging and failed-check charging are enabled.
- **Compact chat result:** Scribe Spell results use a Character Builder namespaced card with a small header icon, readable spell information, roll or automatic-success status, currency result, required time, and final outcome. It no longer allows the spell image to expand across the chat card or compress the title vertically.
- **Scribe visual identity:** the sheet shortcut and Scribe panel use only the image asset of the official Comprehend Languages spell as a noninteractive placeholder, preferring PHB 2024 and then SRD 5.2 Modern before a neutral fallback. No spell document, tooltip, or mechanics are attached to the image.
- **Sheet-control frame:** the alignment grid remains invisible. The gold frame, dimensions, and finish are applied only to the Scribe Spell button, matching the Level Up control while preserving the approved upper-right placement.
- **Weapon Mastery lists:** current and replacement weapons are grouped by enabled source priority and sorted alphabetically inside each source. Options and the replacement summary use `Weapon — Mastery`, with mastery read from the official weapon data and duplicate source copies suppressed by priority.

Wizard Replace Cantrip remains unchanged from its successful runtime test. Signature Spell clickable badges, final custom assets, global PHB-to-SRD fallback, and new Character Keeper actions remain future work.

## Character Builder 0.9.7c — Character Keeper runtime correction patch

Version 0.9.7c consolidates the next focused Character Keeper fixes discovered during live testing. It remains based on the stable 0.9.6 Character Creation and Level Up code plus the isolated runtime-management layer. Wizard cantrip replacement was validated in 0.9.7b and is intentionally unchanged.

- **Runtime badge reconciliation:** Character Keeper now replaces stale Character Builder choice badges instead of stacking a new runtime badge beside the original Character Creation or Level Up badge. The first reconciled families are Weapon Mastery, Spell Mastery, and Pact of the Tome. Only module-owned badge metadata is changed; Actor mechanics remain authoritative and the badge update participates in the same rollback-protected transaction.
- **Weapon Mastery:** after a Long Rest replacement, each owning class keeps one current Weapon Mastery badge. The previous weapon label is removed rather than retained beside the new choice, and multiclass ownership remains separated by class Item and class identifier.
- **Spell Mastery:** the D&D5e native enchantment remains responsible for adding and removing the `, Mastered` spell-name suffix and for the free-cast behavior. Character Keeper now moves only the Character Builder `Spell Mastery` badge from the old spell to the two currently mastered spells. It does not rename spells or recreate the native effect.
- **Pact of the Tome:** the 0.9.7b locked-cantrip and pre-rest validation corrections remain in place. A confirmed rest selection now also replaces the old Pact of the Tome badge with the current three cantrips and two level 1 Ritual spells.
- **Native Spell Scroll recognition:** Scribe Spell now recognizes the normal D&D5e 5.3.3 Spell Scroll produced by dragging a spell into the inventory and accepting the native scroll prompt. These Items may contain attack, save, or utility Activities without `activity.spell.uuid`; Character Keeper resolves them through an official effect origin when present, otherwise through an exact unambiguous scroll name and spell-level match against enabled official sources.
- **Scribing messages:** a compatible scroll remains visible even when the Actor cannot afford the transcription cost. Empty-state notifications now distinguish no scroll, an unresolved scroll, a non-Wizard spell, a spell already in the spellbook, and a spell above the maximum level the Wizard can prepare.
- **War Bond guidance:** War Bond remains listed once in an eligible Short or Long Rest, but Character Keeper no longer opens or executes the feature. Its panel is dedicated to instructions for using the native feature and chat enchantment card. The header displays the official War Bond image and, when the PHB 2024 source is available, only the image asset from Mordenkainen's Sword as a second noninteractive visual cue. Neither image opens a document or imports spell mechanics.
- **Character-sheet controls:** Short Rest, Long Rest, and Level Up are aligned on one lower row. The Wizard Scribe Spell shortcut occupies the upper-right cell directly above Level Up, without changing the native actions behind any control.

Signature Spells clickable badges remain a future runtime convenience. This patch does not add that behavior: the native `Expend First Spell` and `Expend Second Spell` Activities remain authoritative.

## Character Builder 0.9.7b — Pact of the Tome and rest recovery correction

Version 0.9.7b remains based directly on the stable 0.9.6 code plus the isolated Character Keeper layer. It corrects the first runtime issue found in 0.9.7a without changing Character Creation, Level Up, Epic Boon, or native class-entry behavior.

- A current Pact of the Tome cantrip targeted by Agonizing Blast, Eldritch Spear, Repelling Blast, or another recorded cantrip-dependent Invocation remains preselected and locked against removal, but is now valid to keep and reconfirm.
- Pact of the Tome still offers cantrips and level 1 Ritual spells from any enabled class list. Chosen spells function as Warlock spells while the Book of Shadows is carried.
- A locked cantrip cannot be removed during rest because Eldritch Invocation retargeting is not granted by Pact of the Tome or by a rest.
- Pact of the Tome choices are preflight-validated when confirmed and again before the native rest starts. An invalid staged choice can no longer complete the native rest first.
- If a post-rest Character Keeper transaction still fails after the native rest has completed, the interface now exposes **Discard Pending Changes**. This clears only the pending Keeper session, keeps the completed native rest, and remains unavailable when the Actor has a rollback safety lock.

## Character Builder 0.9.7a — Character Keeper test build

Version 0.9.7a is built directly on the runtime-validated 0.9.6 release. Version 0.9.6 remains the stable rollback baseline. This test build does not migrate, rewrite, or clean existing Actor history, Level Up transactions, class documents, spells, or feature ownership.

Level Up continues to use its separate hidden transaction Draft. Native and module-managed choices are resolved on that Draft, and the live Actor is not changed until **Commit Level Up** succeeds. The Character Keeper is an independent runtime layer and does not change Character Creation, class levels, XP, Hit Dice, `levelUpHistory`, or `lastLevelUp`.

### Character Keeper rest management

Character Keeper intercepts a Player Character's native Short Rest or Long Rest only when the Actor is owned and not a Builder Draft. It discovers the optional actions supported by the Actor, opens a Character Builder-sized interface, and displays one feature button per eligible action in the left column. The selected routine is rendered in the right panel. The header, sidebar, and footer remain fixed while only the routine content scrolls.

A feature that is valid after a Short or Long Rest appears once for the current rest. A Long Rest never creates a second opportunity for the same feature merely because it also satisfies Short Rest wording. The player can skip every optional action. Continuing calls the native D&D5e rest exactly once, then applies staged Character Keeper changes in a separate atomic transaction.

The test build includes:

- Weapon Mastery replacement, with class-specific limits and separate multiclass ownership.
- Aspect of the Wilds reconfiguration.
- Circle of the Land replacement, including Circle Spells and strict activation of the matching official Nature's Ward effect.
- replacement of one Known Wild Shape form using only finite numeric CR data and the class's actual Wild Shape CR scale; null, blank, missing, or nonnumeric CR values are rejected.
- Pact of the Tome maintenance using the same Book of Shadows, with current cantrips and rituals preselected and no duplicate book creation.
- Fiendish Resilience, Hunter's Prey, and Defensive Tactics state management.
- Wizard cantrip replacement and Spell Mastery replacement.
- public Cosmic Omen and Portent rolls, with visible chat results and persistent active-state badges.
- guided native use for War Bond, plus source-native surfacing for Star Map replacement and Primal Companion without reimplementing their native Activities.
- Wizard **Scribe Spell to Spellbook**, available from Long Rest management and from a book-and-quill sheet control.

Normal recovery of uses, spell slots, Hit Dice, class resources, effects, and prepared/unprepared states remains native D&D5e behavior. Signature Spells receives no Character Keeper replacement action because the feature only refreshes its native free uses.

Every feature commit blocks duplicate clicks immediately, uses an idempotency token, and is applied through a rollback-protected runtime transaction. Public rest rolls are locked to the pending rest session so closing and reopening cannot reroll them. If the native rest has already completed and a Keeper commit fails, the native rest remains complete while the Keeper mutation is restored to its post-rest safety snapshot for controlled retry or GM inspection.

### Wizard scribing

Four GM settings control the routine. **Allow Spell Scroll Scribing**, **Require Arcana Check for Spell Scroll Scribing**, and **Charge Scribing Cost on Failed Check** are enabled by default. The existing **Charge Wizard Scribing Costs** setting controls whether the official 50 GP per spell level is actually charged. The interface also reports the required 2 hours per spell level.

A Spell Scroll must contain an eligible level 1+ Wizard spell that the Actor can currently add and does not already have in the spellbook. The spell is resolved from the highest-priority enabled source, prioritizing PHB 2024 over SRD 5.2 Modern. Before committing, the checkout shows rule cost, effective cost, wallet balance, remaining currency, required time, Arcana bonus and DC when applicable, and the configured consequences of success or failure.

When the Arcana check is enabled, the routine rolls Intelligence (Arcana) against DC 10 + spell level and posts a compact result to chat. When disabled, the confirmed eligible attempt succeeds automatically without a roll. The scroll is destroyed by an actual attempt. A failed check charges GP only when both general cost charging and failed-check charging are enabled. D&D5e's native Currency Manager pays enabled costs and makes change without converting the entire wallet unnecessarily.

### Stable 0.9.6 baseline

Version 0.9.6 was built directly on the validated 0.9.5k codebase. It preserves the complete Character Creation and Level Up transaction model without migrating or rewriting existing Actor history. It added the optional GM Epic Boon gift flow for level 20 characters, replaced the native Add Class entry with a second Start Character Builder entry, and guarded direct class, subclass, and class-feature insertion while leaving normal item drag-and-drop untouched.

The 0.9.5k feat correction remains unchanged. The D&D5e native feat browser receives its original query and rendering options unchanged. Character Builder does not filter, rebuild, decorate, or hide normal feat-browser results. It checks only the UUID confirmed by the player and rejects Ability Score Improvement selected from inside `Choose a Feat`, an Epic Boon below projected total character level 19, or an already-owned non-repeatable feat. All other feat rules, sources, tooltips, filters, and internal Advancements remain native.

### Epic Boon gifts

A GM world setting, **Enable Grant Epic Boons**, appears in the same Level Up Availability block as XP, Milestone, and multiclass controls. It controls only new grants. Existing Epic Boons remain on Actors, and pending gifts remain claimable and revocable if the setting is later disabled.

When enabled, the GM-only Character Builder Tool displays **Grant Epic Boons** beside the normal progression action. The same character checkboxes can select one or more eligible level 20 Player Character Actors. Every grant requires explicit GM confirmation. Each selected Actor receives an independent pending permission; no class level, XP, Hit Die, `levelUpHistory`, or `lastLevelUp` data is changed.

A pending gift lights the existing Character Builder sheet button. The player opens the native D&D5e Compendium Browser with the native **Epic Boon** subtype filter locked, chooses an official source document, and completes the Boon's native Advancement. Non-repeatable Boons already owned and documents from disabled Character Builder sources are rejected only after confirmation, without rebuilding the browser catalog. Cancellation leaves the gift pending; a controlled finalization failure restores the pre-claim ability values and removes the created Boon before returning the gift to its pending state. Completed gifts are recorded in `epicBoonGiftHistory`. The GM can use **Revoke Epic Boon** while a gift is still pending, even if new grants are disabled.

Character Builder does not override the current D&D5e system limitation that may prevent an Epic Boon from increasing an ability above 20. The official Item and its native Advancement are preserved so the system correction can apply without a module-side ability override.

### Native class-entry guard

For live Player Character Actors, the native **Add Class** control is removed. On an Actor without a class, the same location in the Features header displays **Start Character Builder** or **Resume Character Builder**, using the exact same draft and handler as the existing sheet-header button. After a class exists, native Add Class and native subclass-add controls remain unavailable; multiclassing continues through Character Builder Level Up.

The guard is selective. Direct insertion of `class`, `subclass`, or class-feature Items is blocked on the live Actor, including native Advancement completion paths. Weapons, armor, potions, consumables, equipment, tools, loot, containers, spells, general feats, and other normal drag-and-drop content continue to use the native D&D5e workflow. Character Builder draft and commit operations remain authorized.

### Availability

- **Experience Points:** Level Up becomes available when the Actor reaches the next total character-level XP threshold.
- **Milestone:** the GM grants or revokes Level Up on each individual Actor sheet, or grants one Level Up to multiple selected characters through the GM-only Actor Directory tool.
- **Experience distribution:** in XP Mode, the GM-only Actor Directory tool divides a total XP award equally, truncates fractional XP, and leaves the displayed remainder unassigned.
- **GM controls:** individual `Grant Level Up`, `Revoke Level Up`, and `Reset Pending Level Up` remain available on each Actor sheet; Reset performs a complete administrative reset, including the locked Hit Die.

### Character and Class levels

Total character level and individual Class levels are evaluated separately. Character-level rules include XP thresholds, proficiency progression, Species Advancements, and cantrip scaling. Class features, prerequisites, and spell access use the level of the Class being advanced.

### Multiclassing

Two independent GM world settings control multiclassing:

- **Enable Multiclass** controls whether a new Class can be added.
- **Enforce Multiclass Requirements** controls whether official ability and condition prerequisites are enforced when multiclassing is enabled.

The original level-1 Class remains authoritative through `system.details.originalClass`. New multiclasses use the source Class's secondary-Class Advancement restrictions, so original-Class Saving Throws, Starting Equipment, and unrestricted initial proficiencies are not granted again.

### Hit Points

The GM controls which methods are available:

- Roll
- Average
- Maximum

The first Roll is locked to the pending Level Up context. Back/Continue navigation, Draft reconstruction, closing the interface, and reopening the same Level Up reuse the original result. A new roll is available only after a complete GM reset or a successful commit.

### Native Advancement integration

Native D&D5e Advancements remain authoritative for source-defined choices. Deterministic Advancement steps that the D&D5e API can apply automatically are processed on the Draft without forcing repeated `Next`/`OK` dialogs. The Character Builder then presents the resulting grants in a larger **Unlocked This Level** summary.

The native interface remains visible for non-managed source decisions, including feats, Ability Score Improvements, subclasses, Fighting Styles, Weapon Masteries, proficiencies, optional grants, and ambiguous source data. Character Builder-owned panels handle Eldritch Invocations, Pact of the Tome, and Sorcerer Metamagic while preserving their native source Advancement records.

For native ASI feat choices, Character Builder passes the native browser options through unchanged. It validates only the confirmed source UUID before D&D5e applies it, rejecting the invalid Ability Score Improvement feat, early Epic Boons, and already-owned non-repeatable feats. It does not filter or reconstruct the catalog, alter source or tooltip data, create feat opportunities, or infer complex prerequisites.

### Spells and managed features

- Class spell-list additions, newly accessible full-list spells, limited-caster gains and replacements, Wizard spellbook additions, and feature-owned spells retain exact ownership.
- Equal identifiers from independent acquisition channels are preserved as separate Items.
- Every spell card uses a separate interaction model: the checkbox changes selection, while the card, icon, or title opens the official source document.
- Mandatory `ItemGrant` results are audited without weakening native integrity validation.
- Druid Known Forms reject missing or nonnumeric CR values.
- Primal Order: Magician creates a separate additional Druid cantrip acquisition.
- Circle of the Land previews its complete spell progression and activates the official Nature's Ward effect matching the selected Land.
- Bard Magical Discoveries remains a dedicated two-spell feature; Magical Secrets expands the normal Bard pool without granting an extra counter.
- Wizard Spell Mastery and Signature Spells remain owned by the Wizard Class rather than a subclass.
- Sorcerer Metamagic is selected directly in `Spells & Features`: two options at Sorcerer levels 2, 10, and 17, plus one optional replacement after every Sorcerer level gained from level 3 onward. Known and concurrently selected options are disabled to prevent duplicate acquisitions.
- Warlock Invocations retain exact instances, acquisition levels, targets, prerequisite dependencies, replacement cleanup, and feature-owned spell separation.
- Pact of the Tome opens a Character Builder selection panel for exactly three cantrips and two level-1 Ritual spells, creates one managed Book of Shadows during acquisition, and records source-specific ownership without counting those spells against normal Pact Magic. Character Keeper maintenance reuses that component and the existing book rather than creating another.
- Patron and other feature-granted Warlock spells remain visible in normal spell lists but are disabled and identified by their owning source. Independent source-native grants such as the Archfey Patron's separate Misty Step acquisitions are preserved.

### Choice badges

Compact badges are attached to the exact owning feature instead of a Class header, including formats such as:

- `Scholar [Expertise: Arcana]`
- `Fighting Style [Defense]`
- `Weapon Mastery [Maul]`
- `Pact of the Tome [cantrips]`
- `Agonizing Blast [Eldritch Blast]`

### Protected Commit Level Up

The confirmation window becomes a software-style progress display after confirmation. A synchronous transaction token blocks duplicate commits before the first asynchronous operation.

The commit stages are:

1. Validating Draft
2. Preparing Changes
3. Applying Class and Subclass Progression
4. Creating Features and Spells
5. Updating Actor Data
6. Saving Level-Up History
7. Finalizing

Before the first live mutation, Character Builder creates a complete Actor safety snapshot and temporary backup Actor. A successful commit removes the backup. Any unexpected failure stops later stages, restores the original Actor, verifies the restored snapshot, and instructs the player to redo the level. If rollback verification fails, Character Builder locks further changes for that Actor and preserves the safety backup for GM intervention.

## Transaction model

Character creation, Shop Checkout, native Level Up Advancements, module-managed Level Up choices, and final Level Up commit use recoverable Draft transactions. The module never calls `Actor#prepareData` manually; Foundry and D&D5e prepare documents after normal updates.

## Release validation

This README is the consolidated project and release document. Static validation is performed before packaging, while live Foundry validation remains required for native Advancement dialogs, Epic Boon claiming, guarded class drops, Actor commits, rollback injection, native rest interception, source-native Activities, class-specific Character Keeper routines, and sheet integration.

## Repository

https://github.com/hammer-PvP/DnD-5e-Character-Builder

## 0.9.8a validation checklist

- With all three progression-policy toggles enabled, Feat, generic ASI, and Epic Boon behavior matches the prior official flow.
- With `Enable Feats` disabled, optional common Feats and +1 Ability Score Feats are rejected without altering the native browser; mandatory source grants remain intact.
- With `Enable Ability Score Improvement` disabled, only the generic two-point ASI is rejected, while eligible Feats including +1 Ability Score Feats remain valid when Feats are enabled.
- With `Enable Epic Boons` disabled, new Epic Boon choices and GM grant actions are unavailable, while already-applied Epic Boons remain untouched.
- `Grant Epic Boons` requires both the global Epic Boon toggle and the dedicated GM grant toggle.
- Standard Array and Custom Array consume six independent slots exactly once, including when Custom Array contains duplicate numeric values.
- Clearing or changing an array assignment immediately returns the prior slot to every other Ability dropdown.
- Single Roll creates one set, Limited Rolls respects the configured total including the first, and Unlimited Rolls remains unrestricted.
- Repeated clicks cannot generate a second roll while one roll-set request is in progress.
- Current-workflow cantrips created during Character Creation, Level Up, Multiclass, Pact of the Tome, ItemGrant reconciliation, and Wizard Replace Cantrip use native `Always Prepared` state.
- Leveled limited-list spells remain Prepared, full-list and spellbook entries remain Unprepared, feature-owned always-prepared spells remain Always Prepared, and Scribe Spell additions remain Unprepared.
- Multiclass automatic-progression summaries respect `primary` and `secondary` class restrictions and never advertise Heavy Armor or Saving Throws that were not applied.
- Automatic grant summaries use complete labels and consolidate repeated deterministic categories.
- Level Up sticky spell headers meet the fixed banner without exposing scrolling content through a gap.
- Square checkbox marks are centered, and gold action title/subtitle text remains legible.
- Scribe Spell shows `Confirm Scribing` and the full GP cost on separate lines.
- Transaction confirmations remain modal and cannot be pushed behind Character Creation, Level Up, Character Keeper, or another module window.
- No Actor migration, historical spell repair, or homebrew reinterpretation is performed.

## 0.9.7f validation checklist

- Existing 0.9.5k Character Creation and Level Up flows remain unchanged.
- The Epic Boon setting saves and reloads correctly.
- Grant Epic Boons is hidden when disabled and available when enabled.
- Only level 20 Player Character Actors without a pending gift are eligible.
- Individual and batch grants require confirmation.
- Pending gifts light the existing sheet button and remain claimable after the setting is disabled.
- The native browser opens with Epic Boon locked, source UUIDs remain intact, cancellation preserves the gift, and successful completion consumes it.
- Revoke Epic Boon appears only to GMs while a gift is pending.
- Add Class is replaced by Start/Resume Character Builder on classless Actors and does not reappear in Edit Mode.
- Native class, subclass, and class-feature insertion is blocked without affecting equipment, potion, spell, or other normal drops.
- Invalid Ability Score Improvement feat text matches the approved wording.


### 0.9.7f focused regression checklist

- Confirm Weapon Mastery, Change Land, Replace Cantrip, and another available Keeper action; `Discard Rest Changes` removes every green check and restores every panel to the live Actor state.
- Close and reopen Character Keeper after discarding; none of the previously confirmed payloads return.
- Continue the native rest after discarding; no discarded operation is applied.
- In every Keeper selectable card, clicking the left square changes only the radio/checkbox and clicking the right panel opens only the source document.
- Verify Aspect of the Wilds, Circle Land, Wild Shape, Pact of the Tome, Replace Cantrip, Spell Mastery, and Scribe Spell cards use the same two-zone behavior.
- Verify disabled or ineligible options are fully greyed out and neither zone is interactive.
- A Level Up succeeds with pre-existing GM/homebrew inventory Items whose saved source metadata points to disabled SRD 5.1 content.
- The same Level Up still blocks a new class feature, feat, spell, or other document actually granted from a disabled source when no enabled equivalent exists.
- Existing Items are not deleted, replaced, renamed, relinked, or source-cleaned during the draft or final commit.
- Editing any Character Keeper choice changes its sidebar state to `Unconfirmed Changes`, blocks action navigation, and disables the final rest button.
- Confirming the selected action restores normal navigation and adds the existing green check without changing the live Actor.
- `Discard Rest Changes` clears confirmed and unconfirmed choices before the native rest and leaves the Actor unchanged.
- Discarding a public Cosmic Omen or Portent result removes its staged operation but keeps the anti-reroll lock for that pending rest.
- The final rest executes natively exactly once and applies only confirmed operations.
- The Scribe Spell top button displays `Confirm Scribing` and the full `<cost> GP` value on separate fixed lines.
- Foundry displays `Character Builder (DnD 5e - 2024)` as the module title.

### Character Keeper runtime checklist

- A character with no supported rest action reaches the native Short or Long Rest directly.
- A supported action appears once in Short Rest and once in Long Rest where permitted, never twice in a Long Rest.
- The native rest dialog and recovery execute exactly once.
- Closing before the native rest does not perform the rest or apply staged changes.
- Header, sidebar, and footer remain fixed while the selected routine scrolls.
- Repeated clicks and lag do not duplicate a staged action, chat roll, Item creation, deletion, or currency payment.
- Weapon Mastery applies only the number of changes permitted by each owning class and replaces its stale Character Builder badge instead of stacking another badge.
- Change Land replaces only the Land-owned spells and activates exactly one matching official Nature's Ward effect.
- Known Wild Shape Forms rejects `null`, blank, missing, nonnumeric, over-limit, and premature flying forms. PHB and SRD copies of the same name and CR cannot coexist as duplicate known forms.
- Pact of the Tome preselects the current five spells, preserves the same Book of Shadows, and safely remaps dependent cantrip augments when a permitted cantrip changes.
- Paladin and Ranger prepared-spell replacement actions are absent. Cleric, Druid, Paladin, Ranger, and Wizard normal spell preparation remains native D&D5e behavior.
- Wizard cantrip replacement remains unchanged and preserves official source and ownership metadata. Spell Mastery keeps the native `, Mastered` behavior and moves only the Character Builder badge.
- Cosmic Omen and Portent rolls are public, persist after closing, and cannot be rerolled in the same pending rest.
- War Bond displays noninteractive instructions and two visual header assets without opening a feature; Star Map and Primal Companion continue to call their source-native Activities.
- Scribe Spell uses the same routine from Long Rest and the Wizard sheet icon, recognizes native D&D5e Spell Scroll Items even when they have no cast Activity UUID, presents checkout before commitment, honors all four scribing settings, consumes the scroll only after a confirmed attempt, and records a readable roll or automatic-success result in chat.
- Weapon Mastery options are grouped by source priority, alphabetical inside each source, deduplicated across equivalent sources, and displayed as `Weapon — Mastery`.
- The sheet-control grid has no visible frame; only the Scribe Spell button carries the Level Up-style gold border.
- Character Creation, Level Up, Epic Boon gifts, normal equipment drag-and-drop, and existing Actor histories remain unchanged from stable 0.9.6.
