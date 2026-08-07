# Always Prepared Spell Reconciliation

## Scope

This contract applies only inside a Character Builder **Character Creation** or **Level Up** Draft. It does not scan, migrate, or repair existing live Actors.

The 0.9.9 stabilization line covers leveled spells granted as Always Prepared by a native Class, Subclass, or class-linked Feature when the same class already owns the same spell through normal class spell access. v0.9.9b distinguishes preparation-only grants from native ItemGrants that explicitly augment the spell with a free-cast use pool, including runtime D&D5e ActivityCollection documents.

## Canonical result

The committed Actor keeps one spell Item. Character Builder preserves two distinct concepts on that document:

1. the normal class acquisition that establishes access to the spell; and
2. the feature acquisition that makes the spell Always Prepared.

The spell is set to `system.prepared = 2`. Its normal acquisition is retained in `flags.dnd5e-character-builder.alwaysPreparedReconciliation.normalAcquisition`, and feature owners remain in `featureSpellOwners`.

## Native ItemGrant receipt

A native D&D5e ItemGrant normally records the embedded Item ID in the owning Advancement's `value.added` object. When the redundant grant Item is removed, Character Builder redirects that entry to the canonical spell and writes a matching `mergedItemGrants` receipt on the spell.

`ItemGrantIntegrityService` accepts the canonical spell only when both the Advancement origin and configured UUID match that receipt. This prevents a later integrity audit from recreating the redundant grant.

## Released selections

For limited-list spellcasters, an already selected normal spell that becomes Always Prepared no longer consumes a normal selection. The Level Up choice count increases by one for that transaction, and commit is blocked until the player fills the released choice. The released spell is removed from the optional replacement selector so one acquisition cannot create two replacement benefits.

Full-list spellcasters do not receive an additional prepared choice. Their existing class-list spell is simply promoted to Always Prepared.

## Paladin's Smite

Paladin's Smite remains its own Feature Item. The native Paladin ItemGrant is authoritative for the spell augmentation: it makes Divine Smite Always Prepared, gives the spell a 1/Long Rest use pool, and causes D&D5e to create forwarding Activities for the free casting.

When Divine Smite already exists through normal Paladin spell access, Character Builder keeps that canonical spell, applies only the ItemGrant-declared augmentation to it, redirects the native grant receipt, and removes the redundant grant copy. The original spell-slot Activities remain untouched. After the free use is spent, the same Divine Smite can continue to be cast with spell slots. Find Steed and other grants with the same native ItemGrant pattern use the same generic reconciliation path; there is no spell-name exception.

## Merge requirements

A merge requires all of the following:

- the same non-empty spell identifier and spell level;
- the same canonical source UUID;
- mechanically equivalent base spell Activities and embedded effects after removing non-mechanical document metadata;
- the same class acquisition;
- compatible casting method and ability;
- a normal class-access acquisition on the canonical spell;
- an Always Prepared grant created or owned by the active Draft transaction;
- a native Class, Subclass, or class-linked Feature owner.

## Hard exclusions

Character Builder does not merge:

- spells originating from Items or Item Creator runtime data;
- same-named spells from different classes;
- different casting abilities or methods;
- arbitrary spell use pools, forwarding Activities, or Item/Activity-use consumption that are not explicitly declared by the same native ItemGrant;
- native augmentations whose resulting Activity/use structure cannot be proven to match the ItemGrant configuration;
- legacy duplicates that predate the active Draft transaction;
- cantrip acquisition channels in this first stabilization stage.

For native augmenting ItemGrants, the receipt also records the previous use pool and Activities plus the exact augmentation applied, preserving enough provenance for a future safe reversal. These exclusions favor correctness and reversible ownership over cosmetic deduplication.

## Commit validation

Before commit, Character Builder verifies that:

- no eligible current-transaction duplicate remains;
- every canonical merged spell is Always Prepared;
- every `mergedItemGrants` receipt still points to a real owner and Advancement;
- the owner's `value.added` record points to the canonical spell ID and configured UUID;
- mandatory native ItemGrant integrity still succeeds.

Any failure aborts the Draft transaction before the live Actor is modified.

## Protected systems

This implementation does not modify Character Keeper, rest management, Rules Automation Assistance, Bardic Inspiration resolution, the shared roll-resolution protocol, or Item Creator runtime responsibilities.
