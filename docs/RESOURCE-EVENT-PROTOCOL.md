# Resource Consumption Event Protocol

Character Builder 0.9.9i exposes a small source-agnostic event contract for runtimes that need to react to the resource D&D5e **actually consumed**, rather than guessing from the Activity that the user clicked.

## API

```js
const cb = game.modules.get("dnd5e-character-builder")?.api;
const resourceEvents = cb?.resourceEvents;

const unsubscribe = resourceEvents?.subscribe(payload => {
  if (payload.type !== "resource-consumed") return;
  console.log(payload);
});
```

The same API is published under:

```js
globalThis[Symbol.for("dnd5e.resource-events.v1")]
```

Character Builder also emits the Foundry hook:

```js
Hooks.on("dnd5e-character-builder.resourceConsumed", payload => {});
```

## Timing and authority

The event is emitted from D&D5e's post-consumption lifecycle, after the native consumption transaction has produced its document deltas. Character Builder does not replace consumption and does not infer a spend merely because an Activity was activated.

Only deltas that represent consumption are published: increasing a `spent` field or decreasing a remaining `value`. Recovery/refund deltas are not reported as consumption.

## Payload

Schema 1 uses this shape:

```js
{
  type: "resource-consumed",
  schema: 1,
  at: 0,
  actorUuid: "Actor...",
  amount: 1,
  resource: {
    kind: "itemUses",        // spellSlot | actorResource | actorAttribute | itemUses | activityUses
    keyPath: "system.uses.spent",
    documentUuid: "Actor....Item....",
    itemUuid: "Actor....Item....",
    itemId: "...",
    activityId: null,
    identifier: "bardic-inspiration",
    name: "Bardic Inspiration"
  },
  cause: {
    actorUuid: "Actor...",
    itemUuid: "Actor....Item....",
    itemId: "...",
    itemIdentifier: "cutting-words",
    itemName: "Cutting Words",
    activityUuid: "Actor....Item....Activity....",
    activityId: "...",
    activityName: "Cut with Words",
    activityType: "utility",
    linkedActivity: null
  }
}
```

## Semantic boundary

`resource-consumed` means exactly that the named reserve was spent. It does **not** mean an effect was granted, a target received Bardic Inspiration, an attack hit, or any other higher-level gameplay event.

That distinction is deliberate. For example, normal Bardic Inspiration and Cutting Words can both consume the canonical Bardic Inspiration Item, so both may produce `resource-consumed` for `bardic-inspiration`. Only the normal Inspiration flow grants the Inspiration effect to a recipient. A consuming Item trigger and a grant/application Item trigger can therefore remain separate without name-based exceptions.
