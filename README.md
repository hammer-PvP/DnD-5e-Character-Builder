# Character Builder

Character Builder is a guided D&D 2024 character creation and Level Up module for Foundry Virtual Tabletop 14 and D&D5e 5.3.3.

## Official compatibility

- Player's Handbook 2024 content package
- SRD 5.2 Modern
- Foundry VTT 14.364
- D&D5e 5.3.3

SRD 5.1 Legacy is not officially supported in this beta. It can remain disabled in the content-source settings while future compatibility work is evaluated.

## Level 1 creation

- Combined Ability Scores and Background creation with native D&D5e Advancements.
- Configurable Point Buy, Standard Array, rolled sets, and manual Ability Score methods.
- Custom Background with free 2024 Ability Score assignment, an Origin Feat, two skills, one tool, Common plus two Standard Languages, and 1 GP.
- Species and Class selection with staged preview, confirmation, and source filtering.
- Class spell access for full-list, limited-selection, Pact Magic, and Wizard spellbook models.
- Independent Class and Background starting equipment or starting-currency choices.
- Transactional mundane Starting Equipment Shop with Checkout, exact purchase manifests, containers, quantity support, and GM Bonus Gold.
- Review and recoverable application to the original Actor.

## Level Up 0.9.1 beta

Level Up uses a separate hidden transaction Draft. The live Actor is unchanged until **Commit Level Up** succeeds.

### Availability

- **Experience Points:** Level Up becomes available when the Actor reaches the next total character-level XP threshold.
- **Milestone:** the GM grants or revokes Level Up on each individual Actor sheet.

### Character and Class levels

Total character level and individual Class levels are evaluated separately. Character-level rules include XP thresholds, proficiency progression, Species Advancements, and cantrip scaling. Class features and spell access use the level of the Class being advanced.

### Multiclassing

A GM setting enables or disables adding a new multiclass. The Level Up screen lists the original Class first, then every existing Class with its own Advance control. New multiclasses use the source Class's secondary-Class Advancement restrictions, so initial-Class Saving Throws, Starting Equipment, and unrestricted initial proficiencies are not granted again. The module also checks the 2024 multiclass ability prerequisites.

### Hit Points

The GM controls which methods are available:

- Roll
- Average
- Maximum

A Roll is locked to the Actor, target character level, Class, and target Class level. Closing and reopening Level Up does not reroll it. An optional Minimum Average policy replaces a lower roll with the Class average. Only the GM can reset a pending Level Up and its locked HP result.

### Spells and managed features

The Level Up interface uses the same confirmation pattern as level 1 creation: **Confirm Progression**, **Confirm Spells**, and **Commit Level Up** appear in the top-right action position. Spell circles can be collapsed independently for faster review.


- Native D&D5e Advancements handle source-defined features, subclasses, feats, proficiencies, and choices.
- The module handles Class spell-list additions, newly accessible full-list spells, limited-caster gains and replacements, Wizard spellbook additions, and Wizard Savant bonus spells.
- Mandatory Class and Subclass `ItemGrant` results are audited after native Advancement and restored from the configured source when D&D5e records a grant without retaining its Item document.
- Granted spells preserve their native preparation method, casting method, free uses, recovery, activities, and Advancement origin.
- Equal names or spell identifiers from different acquisition origins are preserved as separate resources; the module does not merge source-granted and player-selected instances.
- Cantrip scaling remains native to D&D5e and is validated against total character level.
- Warlock Eldritch Invocations are stored as distinct instances with acquisition level history.
- Repeatable invocations remain repeatable when permitted by their source document.
- Unavailable invocations remain visible with their Warlock-level and Item prerequisites.
- Earlier invocation choices in the same Level Up can satisfy later invocation prerequisites in slot order.
- Selected invocation cards open the official enabled-source Item sheet instead of duplicating source text.
- Cantrip-targeted invocations select from eligible known damaging Warlock cantrips and store the chosen cantrip ID, identifier, and name.
- Affected cantrips display an **Eldritch Invocation Augmented** annotation on the Actor sheet.
- Review lists only augment relationships changed by the current transaction, not unchanged active augments inherited from another Class.

## Transaction model

Character creation, Shop Checkout, native Level Up Advancements, module-managed Level Up choices, and final Level Up commit all use recoverable Draft transactions. The module never calls `Actor#prepareData` manually. Foundry and D&D5e prepare documents after normal updates.

## Beta testing priorities

Test single-Class advancement, multiclass entry, subclass acquisition, every HP method, XP and Milestone availability, full-list and limited spellcasters, Wizard Savant features, Warlock repeatable invocations, cantrip-targeted invocations, feature-granted spell deduplication, and Actor JSON output after Commit Level Up.

## Repository

https://github.com/hammer-PvP/DnD-5e-Character-Builder
