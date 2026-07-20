# Character Builder 0.9.51 — Warlock Invocation Target Rebind Hotfix

This focused hotfix corrects the final embedded cantrip binding when multiple cantrip-targeting Eldritch Invocations are created during the same Level Up that removes Pact of the Tome.

## Corrected scenario

The supported transaction is:

- Pact of the Tome currently provides Eldritch Blast.
- A normal Pact Magic cantrip is replaced with Eldritch Blast.
- Pact of the Tome is replaced by another Invocation.
- Agonizing Blast and Repelling Blast are both selected and target the pending normal Eldritch Blast.

After the old Tome provider and its contents are removed, every newly created targeting Invocation is re-resolved against the surviving cantrip Items. The newly created Pact Magic Eldritch Blast is preferred and its real embedded Item ID is written to both Invocations.

## Reciprocal ownership

After target rebinding, `eldritchInvocationAugments` is rebuilt on the surviving cantrip. The final Eldritch Blast therefore records both Agonizing Blast and Repelling Blast, while neither Invocation points to the removed Tome-owned Item.

## Failure safety

If a newly created cantrip-targeting Invocation cannot find a surviving eligible target after cleanup, Spells & Features throws a controlled error and restores the pre-application Draft snapshot.

## Scope

This hotfix does not change projected duplicate eligibility, Pact of the Tome cleanup, Invocation counts or prerequisites, Sorcerer Metamagic, native Advancements, other classes, protected commits, Settings, or GM progression tools.
