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

## Level Up 0.9.4a private test beta

> **Private test branch:** 0.9.4a is an installable Level Up test build only. It is not a GitHub release and does not include Runtime Character Management. The next public version is planned as 0.9.5.


Level Up uses a separate hidden transaction Draft. The live Actor is unchanged until **Commit Level Up** succeeds.

### Availability

- **Experience Points:** Level Up becomes available when the Actor reaches the next total character-level XP threshold.
- **Milestone:** the GM grants or revokes Level Up on each individual Actor sheet.
- **GM controls:** `Reset Pending Level Up` is located directly below Grant/Revoke Level Up in the Actor sheet Toggle Controls. It performs a complete administrative reset, including the locked Hit Die.

### Character and Class levels

Total character level and individual Class levels are evaluated separately. Character-level rules include XP thresholds, proficiency progression, Species Advancements, and cantrip scaling. Class features and spell access use the level of the Class being advanced.

### Multiclassing

A GM setting enables or disables adding a new multiclass. The Level Up screen lists the original Class first, then every existing Class with its own Advance control. New multiclasses use the source Class's secondary-Class Advancement restrictions, so initial-Class Saving Throws, Starting Equipment, and unrestricted initial proficiencies are not granted again. The module also checks the 2024 multiclass ability prerequisites.

### Hit Points

The GM controls which methods are available:

- Roll
- Average
- Maximum

The first Roll is persisted on the live Actor and locked to the source and target character levels. Closing the interface, losing the Draft, or restarting Class selection never creates another roll. After **Restart Class Selection**, the player may reuse the original numeric result when it fits the newly selected Class Hit Die, or choose Average; Maximum and a new roll remain unavailable. An optional Minimum Average policy uses the currently selected Class average. Only **Reset Pending Level Up** in the GM Actor-sheet controls or a successful Commit releases the locked result.

### Spells and managed features

The Level Up interface uses the same confirmation pattern as level 1 creation: **Confirm Progression**, **Confirm Spells**, and **Commit Level Up** appear in the top-right action position. Spell circles can be collapsed independently for faster review.


- Native D&D5e Advancements handle source-defined features, subclasses, feats, proficiencies, and choices.
- Level Up choices with a clear owning feature are summarized with compact read-only badges on that feature, such as `Scholar — Expertise: Arcana`. Character Creation badges are intentionally omitted because those choices already have dedicated native sheet sections.
- The module handles Class spell-list additions, newly accessible full-list spells, limited-caster gains and replacements, Wizard spellbook additions, and Wizard Savant bonus spells.
- Mandatory `ItemGrant` results are audited through one shared integrity service during both Character Creation and Level Up, then restored from the configured source when D&D5e records a grant without retaining its Item document.
- Granted spells preserve their native preparation method, casting method, free uses, recovery, activities, and Advancement origin.
- Equal names or spell identifiers from different acquisition origins are preserved as separate resources; the module does not merge source-granted and player-selected instances.
- Cantrip scaling remains native to D&D5e and is validated against total character level.
- Warlock Eldritch Invocations are stored as distinct instances with acquisition level history.
- Repeatable invocations remain repeatable when permitted by their source document.
- Unavailable invocations remain visible with their Warlock-level and Item prerequisites.
- Earlier invocation choices in the same Level Up can satisfy later invocation prerequisites in slot order.
- Selected invocation cards open the official enabled-source Item sheet instead of duplicating source text.
- Cantrip-targeted invocations select only from damaging Warlock cantrips already owned or selected during the same Level Up, then store the chosen cantrip ID, identifier, and name.
- Each cantrip-targeted Invocation displays its chosen target on the Invocation feature row, and each affected cantrip displays the names of the Invocations augmenting it. Repeatable `Agonizing Blast` instances retain independent targets.
- Review lists only augment relationships changed by the current transaction, not unchanged active augments inherited from another Class.

### 0.9.4a Level Up feature audit

This private beta also adds Level Up-only handlers for:

- College of Lore Magical Discoveries and Bard Magical Secrets;
- Druid Known Wild Shape Forms and initial Circle of the Land configuration;
- Eldritch Knight and Arcane Trickster spell progression;
- Abjuration, Divination, Evocation, and Illusion Savant;
- Wizard Spell Mastery and Signature Spells initial configuration;
- Warlock Mystic Arcanum acquisition and same-level replacement;
- Hunter's Prey and Defensive Tactics;
- Sorcerer Metamagic replacement;
- Blessed Warrior and Druidic Warrior nested cantrip ownership and replacement;
- structural validation of native feats, ASIs, Fighting Styles, Maneuvers, Metamagic, and other source Advancements;
- feature ownership for automatic Domain, Oath, Circle, Patron, subclass-list, and feature-granted spells.

Runtime free-cast buttons, rest-triggered maintenance, and other event monitoring are intentionally deferred. See `TESTING-0.9.4a.md` for the class-by-class test matrix.

## Transaction model

Character creation, Shop Checkout, native Level Up Advancements, module-managed Level Up choices, and final Level Up commit all use recoverable Draft transactions. The module never calls `Actor#prepareData` manually. Foundry and D&D5e prepare documents after normal updates.

## Beta testing priorities

Follow `TESTING-0.9.4a.md`. The highest-value tests are Lore Bard 5→6 and 9→10, Druid 1→2 and Land Druid 2→3, Battle Master 2→3, Eldritch Knight and Arcane Trickster 2→3, Sorcerer 2→3, Blessed Warrior and Druidic Warrior, Wizard 17→18 and 19→20, and Warlock 10→11. Export Actor JSON after every successful commit.

## Repository

https://github.com/hammer-PvP/DnD-5e-Character-Builder
