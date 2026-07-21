# Character Builder

Character Builder is a guided D&D 2024 character creation and Level Up module for Foundry Virtual Tabletop 14 and D&D5e 5.3.3.

## Official compatibility

- Player's Handbook 2024 content package
- SRD 5.2 Modern
- Foundry VTT 14.364
- D&D5e 5.3.3

SRD 5.1 Legacy is not officially supported. Runtime Character Management remains a future top-level capability and is not included in this release.

## Level 1 creation

- Combined Ability Scores and Background creation with native D&D5e Advancements.
- Configurable Point Buy, Standard Array, rolled sets, and manual Ability Score methods.
- Custom Background with free 2024 Ability Score assignment, an Origin Feat, two skills, one tool, Common plus two Standard Languages, and 1 GP.
- Species and Class selection with staged preview, confirmation, and source filtering.
- Class spell access for full-list, limited-selection, Pact Magic, and Wizard spellbook models.
- Exact acquisition ownership allows the same spell or cantrip to coexist when it comes from different sources.
- Independent Class and Background starting equipment or starting-currency choices.
- Transactional mundane Starting Equipment Shop with Checkout, exact purchase manifests, containers, quantity support, and GM Bonus Gold.
- Review and recoverable application to the original Actor.

## Character Builder 0.9.6 community beta

Level Up uses a separate hidden transaction Draft. Native and module-managed choices are resolved on that Draft, and the live Actor is not changed until **Commit Level Up** succeeds.

Version 0.9.6 is built directly on the validated 0.9.5k codebase. It preserves the complete Character Creation and Level Up transaction model without migrating or rewriting existing Actor history. The release adds an optional GM Epic Boon gift flow for level 20 characters, replaces the native Add Class entry with a second Start Character Builder entry, and guards direct class, subclass, and class-feature insertion while leaving normal item drag-and-drop untouched.

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
- Pact of the Tome now opens a Character Builder selection panel for exactly three cantrips and two level-1 Ritual spells, creates a managed Book of Shadows, and records source-specific ownership without counting those spells against normal Pact Magic. The component is maintenance-ready for the future Character Keeper, but rest hooks are not enabled in this release.
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

This README is the consolidated project and release document. Static validation is performed before packaging, while live Foundry validation remains required for runtime Advancement dialogs, Epic Boon claiming, guarded class drops, Actor commits, rollback injection, and class-specific progression.

## Repository

https://github.com/hammer-PvP/DnD-5e-Character-Builder

## 0.9.6 validation checklist

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
