# Contextual Effect Protocol

Character Builder 0.9.9f introduced a source-agnostic protocol for Active Effects that modify a roll because of the relationship between the effect owner and the current roll. Blade Ward is the first official adapter, but the engine contains no Blade-Ward-specific branching.

## Shared protocol

The global registry is available at:

```js
const state = globalThis[Symbol.for("dnd5e.contextual-roll-modifiers.v1")];
```

The public Character Builder API is:

```js
const cb = game.modules.get("dnd5e-character-builder")?.api;
cb.contextualRollModifiers;
cb.contextualEffects;
```

External runtimes can register an effect reader:

```js
const unregister = cb.contextualRollModifiers.registerProvider({
  id: "my-module:contextual-effects",
  readEffect(effect) {
    return effect.getFlag("my-module", "contextualEffect") ?? null;
  }
});
```

A declaration uses schema 1:

```js
{
  schema: 1,
  modifiers: [{
    id: "incoming-attack-minus-1d4",
    label: "Protective Ward",
    rollTypes: ["attack"],
    relation: "incoming",
    operation: "formula",
    formula: "-1d4",
    priority: 100
  }],
  lifecycle: {
    mode: "concentration",
    anchorUuid: "Actor.x.ActiveEffect.y",
    controllerUuid: "Actor.x",
    sourceUuid: "Actor.x.Item.z",
    termination: "native-dependent"
  }
}
```

Supported relation families are `roller/self/outgoing` for effects owned by the roller and `target/incoming/against-owner` for effects owned by the single current target. Incoming modifiers are intentionally skipped when no target or multiple targets are selected and the individual roll target cannot be determined.

Supported operations in schema 1 are `formula`, `advantage`, and `disadvantage`. Formula changes are appended only to the current roll configuration.

## Lifecycle

The modifier engine does not own duration or concentration. Lifecycle metadata is separate. `cb.contextualEffects.bindEffectData` and `createEffect` can bind a runtime effect to a concentration anchor. Concentration mode maps to D&D5e's native `flags.dnd5e.dependentOn` relationship.

When concentration ends, D&D5e remains authoritative for deleting its dependents. Character Builder never performs a generic scan that deletes unrelated Active Effects. A non-concentration Item trigger can use the same contextual modifier declaration without a concentration anchor and will not be affected by concentration cleanup.

## Post-roll concentration resolution

D&D5e 5.3.3 rolls a Concentration save but does not automatically call `Actor.endConcentration()` on failure. Character Builder marks the roll pending and keeps the shared batch open with an inert lifecycle barrier long enough for asynchronous Character and Item providers triggered by the same roll to register. Concentration is ended only from the queue's finalized snapshot, using the final `currentTotal` against the save DC.

This ordering allows Bardic Inspiration or an Item-origin post-roll bonus to rescue concentration before any dependent effect is removed. The runtime also preserves request affinity: if a native concentration request card belongs to a concentrating Actor but the click would roll a different non-concentrating Actor because of current target selection, Character Builder cancels that mismatched roll and reissues the Concentration save for the request owner.

## Save-gated effects and the native chat tray

Save-gated debuffs are not automatically applied from a hidden failure. A compatibility adapter may ensure that a source Activity exposes an Item Active Effect through D&D5e's native `EffectApplicationElement`. Because non-transfer effects in that tray are GM-facing, the GM can adjudicate the save and apply the effect only to failed targets without leaking the result to players.

When D&D5e applies an effect from a concentrated usage card, it uses the concentration Active Effect as the origin and writes `flags.dnd5e.dependentOn` on the target effect. Character Builder does not replace that lifecycle. If an official effect profile already contains native mechanical changes, the adapter only repairs the Activity-to-effect link. If the profile is absent or mechanically empty, a declarative contextual-effect fallback may be materialized instead. Bane 2024 is the first regression case; the application runtime itself is generic.

## Privacy

Contextual roll modifiers change math only. They do not grant permission to expose hidden target values or outcomes. The shared Roll Result Privacy contract still applies: player-facing UI must not reveal AC, DC, Success, Failure, or make prompt visibility depend on a hidden outcome.
