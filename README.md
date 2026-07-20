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

## Character Builder 0.9.5c community beta

Level Up uses a separate hidden transaction Draft. Native and module-managed choices are resolved on that Draft, and the live Actor is not changed until **Commit Level Up** succeeds.

The 0.9.5c update moves Sorcerer Metamagic selection and its once-per-Sorcerer-level optional replacement into the Character Builder `Spells & Features` step. The source ItemChoice Advancement remains structurally authoritative, while Character Builder owns the cards, duplicate prevention, projected final choice state, exact embedded Item IDs, and atomic replacement records. The Native Advancement Modal Guard introduced in 0.9.5b remains unchanged.

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

The release package includes a focused testing guide and static audit report. Live Foundry validation is still required for runtime Advancement dialogs, Actor commits, rollback injection, and class-specific progression before promoting this community beta beyond its tested environment.

## Repository

https://github.com/hammer-PvP/DnD-5e-Character-Builder
