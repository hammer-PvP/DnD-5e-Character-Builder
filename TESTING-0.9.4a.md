# Character Builder 0.9.4a — Level Up Test Plan

This is a private installable beta. It does not publish to GitHub, does not update from a release manifest, and does not include Runtime Character Management.

Use disposable test Actors or exported copies. After every successful Level Up, export the Actor JSON before continuing so failures can be compared level by level.

## Global safety checks

Run these before class-specific tests:

1. Select a non-repeatable feat already owned by the Actor, such as War Caster.
2. Confirm that Level Up is blocked by the persistent **Level Up Must Be Restarted** dialog.
3. Confirm that the live Actor is unchanged.
4. Click **Restart Level Up** and confirm that the GM grant and locked Hit Die result remain available, but the temporary native Advancement state is rebuilt.
5. Select an invalid prerequisite feat, such as Medium Armor Master without Medium Armor Training, and verify the same safe restart behavior.
6. Cancel a native Advancement and verify that the live Actor remains unchanged.

## Bard

### College of Lore 5 → 6

- Magical Discoveries requires exactly two choices.
- The pool contains Cleric, Druid, and Wizard spells.
- Each choice can be a cantrip or a spell available to Bard level 6.
- Existing spell identifiers cannot be selected again.
- Both resulting spells are Always Prepared, do not count as normal Bard selections, and carry Magical Discoveries metadata/badges.

### College of Lore 6 → 7

- Optional replacement appears for exactly one active Magical Discoveries spell.
- `Replace` and `With` clear together when either side is reset.
- The old spell loses only Magical Discoveries ownership.

### Bard 9 → 10 and later levels

- Magical Secrets expands normal new-spell and normal replacement pools to Bard, Cleric, Druid, and Wizard.
- These spells count as normal Bard prepared spells rather than extra Always Prepared spells.
- Later Bard levels retain the expanded pool without granting another Magical Secrets feature.

## Druid

### Druid 1 → 2

- Known Forms requires four Beast stat blocks.
- Maximum CR is 1/4 and flying forms are excluded.
- Selected form UUIDs are saved on Wild Shape.

### Druid 3 → 4

- Two additional forms are required.
- Maximum CR is 1/2.
- Previously known forms are excluded.

### Druid 7 → 8

- Two additional forms are required.
- Maximum CR is 1 and flying forms are enabled.

### Circle of the Land 2 → 3

- Initial land selection is required: Arid, Polar, Temperate, or Tropical.
- All spells available for Druid level 3 are granted as Always Prepared with feature ownership.

### Circle of the Land 4 → 5, 6 → 7, and 8 → 9

- The current land remains unchanged.
- Newly unlocked land spells are added automatically.
- The original land configuration transaction is preserved.

### Native Druid choices

Test Primal Order, Elemental Fury, and any nested choices. Confirm that incomplete native ItemChoices cannot commit.

## Fighter

### Battle Master 2 → 3

- Three Maneuvers are required by the native Advancement.
- No duplicate non-repeatable option is accepted.

### Battle Master 6 → 7, 9 → 10, and 14 → 15

- Two new Maneuvers and the native optional replacement remain structurally valid.

### Eldritch Knight 2 → 3

- Two Wizard cantrips and three level-1 Wizard spells are required.
- Intelligence is used.
- The spell level ceiling follows Eldritch Knight class level, not multiclass-combined slots.

### Eldritch Knight later levels

- Prepared-spell increases follow the subclass scale.
- Cantrip increases occur at the source-defined levels.
- One normal spell and one cantrip replacement are available on later Fighter levels.

### Fighting Styles

Test initial Fighting Style, later replacement, and Champion Additional Fighting Style. Confirm that replacing the primary style does not remove the additional style.

## Rogue

### Arcane Trickster 2 → 3

- Mage Hand is granted natively and cannot be replaced.
- Two additional Wizard cantrips and three level-1 Wizard spells are required.
- Intelligence is used.

### Arcane Trickster later levels

- Prepared-spell and cantrip increases follow the subclass scale.
- Mage Hand never appears in the cantrip replacement source list.
- Spell eligibility follows Rogue/Arcane Trickster level rather than combined slots.

## Sorcerer

### Sorcerer 1 → 2

- Native Metamagic grants exactly two options.

### Sorcerer 2 → 3

- No new Metamagic is granted, but optional replacement is available.

### Sorcerer 9 → 10 and 16 → 17

- Native new Metamagic choices and optional replacement can coexist.
- The replacement updates the native Advancement record without duplicating options.

Test Draconic Elemental Affinity and subclass spell-list grants for Aberrant, Clockwork, and Draconic Sorcery.

## Paladin

### Paladin 1 → 2 with Blessed Warrior

- The nested native choice grants two Cleric cantrips.
- They use Charisma, are Paladin spells, and carry Blessed Warrior ownership.

### Later Paladin level

- Optional replacement of one Blessed Warrior cantrip appears.
- Paladin's Smite, Faithful Steed, Oath Spells, and their native uses/activities remain intact and receive ownership metadata.

## Ranger

### Ranger 1 → 2 with Druidic Warrior

- The nested native choice grants two Druid cantrips.
- They use Wisdom, even if the source ItemChoice contains an incorrect ability field.
- Later Ranger levels allow replacement of one of those cantrips.

### Hunter 2 → 3

- Hunter's Prey requires Colossus Slayer or Horde Breaker.

### Hunter 6 → 7

- Defensive Tactics requires Escape the Horde or Multiattack Defense.

Confirm ownership for Favored Enemy/Hunter's Mark, Fey Wanderer Spells, and Gloom Stalker Spells, including the source rows whose native title is blank.

## Warlock

### Warlock 10 → 11

- Normal Pact Magic progression and one level-6 Mystic Arcanum are separate choices.
- The Arcanum has one native Item use per Long Rest, consumes no Pact Slot, and cannot upcast.

### Warlock 12 → 13, 14 → 15, and 16 → 17

- The new exact-level Arcanum and optional replacement of an older Arcanum may coexist.
- Replacement requires the same spell level.

### Eldritch Invocations

- Options are grouped by minimum Warlock level and alphabetized within each group.
- Ineligible options remain visible and disabled with a reason.
- Replacing Pact of the Blade is blocked while dependent Invocations remain.
- Replacing Thirsting Blade is blocked while Devouring Blade remains.
- Lessons of the First Ones completes its nested Origin Feat Advancement and rejects unsafe duplicate feats.

## Wizard

### Wizard subclasses 2 → 3

Test Abjurer, Diviner, Evoker, and Illusionist:

- Each Savant requires exactly two matching-school Wizard spells.
- The spells are bonus spellbook acquisitions, not Always Prepared.
- They receive feature ownership/badges on the specific Savant feature.

### Wizard 4 → 5 and each newly unlocked spell level

- The corresponding Savant adds exactly one matching-school spell when a new Wizard spell level is unlocked.

### Wizard 17 → 18

- Spell Mastery requires one level-1 and one level-2 Wizard spell from that Wizard's spellbook.
- Both must have an Action casting time.
- The native Mastered enchantment/Always Prepared state is applied.
- Persistent target links and future free-cast metadata are recorded.
- Runtime free-cast buttons and Long Rest replacement are intentionally not included in 0.9.4a.

### Wizard 19 → 20

- Signature Spells requires two distinct level-3 Wizard spellbook spells.
- The native Signature enchantment is applied.
- Each spell is linked to the native First/Second Spell use tracker.
- Runtime clickable free-cast badges are intentionally not included in 0.9.4a.

## Automatic feature-spell ownership

Verify that automatic spell grants preserve their original Item data, activities, uses, recovery, preparation mode, and Advancement origin while receiving feature ownership metadata:

- Cleric Domain Spells
- Paladin Oath Spells, Paladin's Smite, and Faithful Steed
- Circle of the Moon and Circle of the Sea spells; Star Map spells
- Fey Wanderer and Gloom Stalker spells
- Psionic, Clockwork, and Draconic spells
- Warlock Patron Spells
- Words of Creation
- Spell Breaker and Phantasmal Creatures
- Animal Speaker and Nature Speaker
- Shadow Arts and Manipulate Elements
- Telekinetic Master

## Out of scope for 0.9.4a

The following are saved for the later Runtime Character Management layer:

- rest-triggered feature maintenance;
- clickable free-cast badges;
- Spell Mastery replacement after Long Rest;
- Signature Spell runtime charge execution;
- post-level-20 feat/Epic Boon grants;
- other runtime class-feature event handlers.
