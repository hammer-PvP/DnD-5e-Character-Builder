# Shared Roll Resolution Protocol

Character Builder exposes a shared post-roll contract for modules that may offer sequential bonuses on the same D20 Test. Protocol v2 coordinates provider order **without allowing hidden AC/DC outcomes to leak through player-facing prompts**.

## Resolution order

1. D&D5e completes the native roll and remains authoritative for its normal GM/player visibility.
2. Character Builder may mark the roll pending when native character-origin assistance is available.
3. Character Builder resolves its `character`-phase decision, such as Bardic Inspiration.
4. Item runtimes run afterward in the `items` phase.
5. Lifecycle/final adjudication providers may run after item providers when a mechanic must wait for every possible bonus (for example, breaking concentration after a failed Concentration save).
6. The queue publishes one finalized structured result after all ordered providers complete.
7. Every provider uses the latest `currentTotal`, but player-facing prompt visibility is based on public eligibility and resource availability—not on hidden success/failure.

The canonical order remains:

`D&D5e native → Character Builder → Item runtimes`

## Hidden-outcome privacy rule

`target` and `succeeded` can exist in the structured resolution because D&D5e or the responsible client may know them internally. They are **private coordination/adjudication data**, not permission to expose the outcome to the player.

A provider MUST NOT make a player-facing prompt appear only when `succeeded === false`, `success === false`, `currentTotal < target`, or any equivalent hidden-failure test. Doing so leaks the hidden result through the presence or absence of the prompt.

For a resource that can be relevant after a D20 Test, use this model instead:

```text
eligible roll + resource available
→ show the same neutral Use / Keep decision
→ never show AC, DC, Success, or Failure to the player
```

This rule applies to later providers too. The absence of a second prompt must not reveal that an earlier bonus already succeeded. If an Item-origin bonus is otherwise eligible and available, its player-facing decision must remain outcome-neutral. The player can wait for the GM's ruling and choose whether to spend the resource.

The GM may still receive the full result through D&D5e's native chat visibility or a GM-only assistance message.

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

Normal Character- and Item-phase providers should **not call `finalize()` from inside their provider**. Return the updated `currentTotal`, `succeeded`, and `adjustments`; the queue auto-finalizes after every ordered provider has completed. `finalize()` remains available for explicit external workflows that truly own the end of a batch.

Character Builder uses phase `character` with priority `200`. Item runtimes use phase `items` with priority `300`. Character Builder lifecycle finalizers use an explicit later priority (`900`) when a rule must wait for every bonus before acting.

## Hooks

```js
Hooks.on("dnd5e-character-builder.rollResolutionPending", (payload, roll) => {});
Hooks.on("dnd5e-character-builder.rollResolutionFinalized", (payload, roll) => {});
```

The pending hook is published before the first queued post-roll decision. The finalized hook is published only after all ordered Character, Item, and lifecycle providers for that roll have completed. A provider may wait on the queue to avoid competing prompts and stale totals.

## Payload

```js
{
  rollKey: "roll:unique-key",
  actorUuid: "Actor.actorId",
  rollType: "attackRoll",
  originalTotal: 17,
  currentTotal: 24,
  target: 21,       // internal/private when D&D5e treats the target as hidden
  succeeded: true,  // internal/private when the outcome is hidden
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
- `concentration` (internal lifecycle finalization)

When the player keeps Bardic Inspiration, `currentTotal` remains equal to `originalTotal`, `adjustments` is empty, and `succeeded` may still carry the native hidden outcome internally. That value must not be echoed into player-facing UI.

## Recommended Item runtime integration

An Item runtime can join the shared queue directly:

```js
queue.enqueue({
  roll,
  phase: "items",
  providerId: "item-creator:post-roll-effects",
  execute: async context => {
    const startingTotal = context.currentTotal;

    // Determine eligibility from the roll type/context and the Item resource.
    // DO NOT use context.succeeded/context.target to decide whether the player
    // sees the prompt when that outcome is hidden.
    // Show the same neutral Use / Keep UI for every otherwise eligible roll.

    // If used, apply the Item-origin bonus starting from startingTotal.
  }
});
```

A runtime that does not enqueue can instead listen for the finalized hook or call `waitForFinalized`. It must not evaluate or expose a stale native outcome while the resolution stored on `roll.options.dnd5eCharacterBuilderRollResolution` has `finalized: false`.

## Player-facing UI contract

Post-roll decisions that can imply a hidden outcome should follow the same UX contract across providers:

- compact and always on top;
- draggable;
- no blur or visually intrusive backdrop;
- functionally modal, blocking other actions until **Use** or **Keep** is chosen;
- show only player-safe information such as roll total, resource name/die, and resulting total after use;
- never show AC, DC, Success, Failure, “still failed”, “already succeeded”, or equivalent cues.

## Responsibility boundary

The protocol coordinates ordering and privacy semantics only. Character Builder controls native character-origin assistance that D&D5e does not automate adequately. The Item Creator runtime remains authoritative for effects originating from personalized Items, including their duration, turn tracking, use limits, consumption, expiration, and removal. Item Creator-specific implementation belongs to that module; Character Builder does not implement or mutate Item Creator effects.

## Public finalized-total handoff (v0.9.9j)

When a roll finishes all shared-queue providers after its D&D5e ChatMessage already exists, Character Builder mirrors a deliberately public-safe snapshot to `flags.dnd5e-character-builder.publicRollResolution`. The snapshot contains roll identity/type plus `originalTotal`, finalized `currentTotal`, and finalized state only. Hidden target/DC and success/failure state are never copied to the ChatMessage flag.

This lets manual later reactions such as Cutting Words read the total that Item-origin providers actually finalized without rerunning those providers or exposing hidden adjudication data. The Recent Roll Registry reconciles both ChatMessage creation and later updates; if the public finalized snapshot is absent, it falls back to the native roll total.
