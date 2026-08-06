# Always Prepared Spell Reconciliation

## Scope

This contract applies only inside a Character Builder **Character Creation** or **Level Up** Draft. It does not scan, migrate, or repair existing live Actors.

The first 0.9.9 implementation covers leveled spells granted as Always Prepared by a native Class, Subclass, or class-linked Feature when the same class already owns the same spell through normal class spell access.

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

Paladin's Smite remains its own Feature Item. Its free-cast Activity, use counter, and recovery are not moved or deleted. Reconciliation removes only the redundant Divine Smite spell granted during the current transaction.

The canonical Divine Smite spell retains its normal spell-slot Activities. After the free Feature use is spent, the same spell can continue to be cast with spell slots.

## Merge requirements

A merge requires all of the following:

- the same non-empty spell identifier and spell level;
- the same canonical source UUID;
- equivalent spell Activities and embedded effects;
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
- spells with their own Item use pool or recovery;
- spells containing a forwarding Activity;
- spells whose Activities consume Item uses or Activity uses;
- legacy duplicates that predate the active Draft transaction;
- cantrip acquisition channels in this first stabilization stage.

These exclusions favor correctness and reversible ownership over cosmetic deduplication.

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
