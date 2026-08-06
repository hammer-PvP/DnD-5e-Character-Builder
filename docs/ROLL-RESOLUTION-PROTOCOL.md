# Shared Roll Resolution Protocol

Character Builder exposes a shared post-roll contract for modules that may offer sequential bonuses after a failed D20 Test. The protocol prevents multiple modules from evaluating the same stale native total or opening competing prompts.

## Resolution order

1. D&D5e completes the native roll.
2. Character Builder marks the eligible failed roll as pending.
3. Character Builder resolves native character-origin assistance such as Bardic Inspiration.
4. Character Builder publishes a finalized structured result.
5. Item runtimes evaluate the finalized result.
6. If the result already succeeded, the Item runtime does not offer another bonus. If it still failed, the Item runtime starts from `currentTotal`.

## Public API

```js
const queue = game.modules.get("dnd5e-character-builder")?.api?.rollResolutionQueue;
```

The queue remains available under `Symbol.for("dnd5e.roll-resolution-queue.v1")` for compatibility. Protocol v2 provides:

- `enqueue(options)`
- `markPending(options)`
- `finalize(options)`
- `getResolution({ roll, rollKey })`
- `waitForFinalized({ roll, rollKey, timeout })`
- `phasePriority(phase)`

Character Builder uses phase `character` with priority `200`. Item runtimes use phase `items` with priority `300`.

## Hooks

```js
Hooks.on("dnd5e-character-builder.rollResolutionPending", (payload, roll) => {});
Hooks.on("dnd5e-character-builder.rollResolutionFinalized", (payload, roll) => {});
```

The pending hook is published before Character Builder opens a post-failure decision. The finalized hook is published exactly once for that Character Builder resolution, including when:

- Bardic Inspiration is used;
- the player keeps Bardic Inspiration;
- no valid native Bardic Inspiration effect is present;
- the assistance rule is disabled;
- Character Builder cannot apply an adjustment.

## Payload

```js
{
  rollKey: "roll:unique-key",
  actorUuid: "Actor.actorId",
  rollType: "attackRoll",
  originalTotal: 17,
  currentTotal: 24,
  target: 21,
  succeeded: true,
  finalized: true,
  adjustments: [
    {
      source: "Bardic Inspiration",
      bonus: 7
    }
  ]
}
```

Supported Character Builder roll-type labels are:

- `attackRoll`
- `abilityCheck`
- `skillCheck`
- `toolCheck`
- `savingThrow`

When the player keeps Bardic Inspiration, `currentTotal` remains equal to `originalTotal`, `succeeded` remains false, and `adjustments` is empty.

## Recommended Item runtime integration

An Item runtime can join the shared queue directly:

```js
queue.enqueue({
  roll,
  phase: "items",
  providerId: "item-creator:post-failure-effects",
  execute: async context => {
    if (context.succeeded === true || context.success === true) {
      return { skipped: true, reason: "already-succeeded" };
    }

    const startingTotal = context.currentTotal;
    // Offer the next eligible Item-origin bonus from startingTotal.
  }
});
```

A runtime that does not enqueue can instead listen for the finalized hook or call `waitForFinalized`. It must not evaluate the original native failure while the resolution stored on `roll.options.dnd5eCharacterBuilderRollResolution` has `finalized: false`.

## Responsibility boundary

The protocol coordinates ordering only. Character Builder controls native character-origin assistance that D&D5e does not automate adequately. The Item Creator runtime remains authoritative for effects originating from personalized Items, including their duration, turn tracking, use limits, consumption, expiration, and removal.
