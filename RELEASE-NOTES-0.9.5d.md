# Character Builder 0.9.5d — Warlock Projected Cantrip State

This focused patch resolves the remaining same-Level-Up ownership edge case between Pact of the Tome, normal Pact Magic cantrip replacement, and cantrip-targeting Eldritch Invocations.

## Projected cantrip replacement

A Warlock can now replace a normal Pact Magic cantrip with a cantrip whose current acquisition is scheduled to disappear because its providing Eldritch Invocation is being replaced in the same Level Up.

Supported example:

- Eldritch Blast is currently granted by Pact of the Tome.
- Toll the Dead is a normal Warlock cantrip.
- Optional Cantrip Replacement changes Toll the Dead to Eldritch Blast.
- Optional Invocation Replacement changes Pact of the Tome to Agonizing Blast.
- Agonizing Blast targets the pending normal Eldritch Blast acquisition.

The final Actor keeps one normal Eldritch Blast, removes the Tome-owned acquisition and Book of Shadows contents, and binds Agonizing Blast to the newly created embedded spell Item.

## Duplicate protection

The projected state remains conservative:

- A surviving independent acquisition still blocks a redundant copy.
- The old Tome-owned cantrip cannot be used as a target when its provider is scheduled for removal.
- A pending replacement cantrip becomes a valid target only after it is selected.
- Cancelling an upstream removal or cantrip replacement immediately clears invalid dependent state in the UI.
- Server-side validation repeats the projected ownership checks before applying the Draft.

## Scope

This is a Warlock-only projected-state fix. It does not introduce a global spell projection engine and does not alter Sorcerer Metamagic, native Advancements, other classes, protected commits, Settings, or GM progression tools.
