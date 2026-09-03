# Shared Roll Resolution Protocol — v3

Character Builder exposes a shared post-roll contract for modules that can modify the same D20 Test. Protocol v3 replaces timing-based provider discovery with explicit **claim / enqueue / release / finalization** coordination while preserving the global hidden-outcome privacy rule.

## Canonical resolution order

1. D&D5e completes the native roll.
2. Character-origin providers run in phase `character` (priority `200`).
3. Item-origin providers run in phase `items` (priority `300`).
4. Lifecycle decisions run only after the queue is truly finalized.

Canonical integration order:

`D&D5e native → Character Builder → Item Creator → lifecycle`

A provider always receives the latest `context.currentTotal`. It must never restart an earlier provider or rebuild the native roll merely to include a previous modifier.

## Why protocol v3 exists

An async provider may need time to discover whether a roll has an eligible resource or to wait for a player **Use / Keep** decision. A fixed delay cannot prove that discovery is complete. Protocol v3 therefore uses explicit claims:

```text
roll hook
→ provider claims synchronously
→ async eligibility discovery
→ no eligible resource: release
OR
→ enqueue provider: release discovery claim
→ queued provider resolves its UI/result
→ no queued providers + no claims
→ FINALIZED
```

A timeout exists only as a failsafe for abandoned claims. It is not the normal finalization mechanism.

### Discovery barrier guarantee

An active claim blocks **provider execution as well as finalization**. Providers may enqueue while one or more discoveries are unresolved, but the queue does not begin draining until all active discovery claims for that roll are released. This allows slower Character-phase discovery and faster Item-phase discovery to converge before canonical priority ordering begins:

```text
CB claim
IC claim
→ IC discovers first and enqueues Items 300
→ IC release
→ CB claim still active, so nothing executes
→ CB discovers and enqueues Character 200
→ CB release
→ claims = 0
→ Character 200 executes
→ Items 300 executes
```

The drain selects **one provider at a time** and re-sorts the live entries after each provider completes. If a new earlier-phase provider is discovered while another provider Promise is open, it can still take its correct place before a waiting later-phase provider.

A claim opened after a provider has already started cannot retroactively preempt that provider. It does, however, pause execution before the next provider is selected. For deterministic initial ordering, every runtime that may perform asynchronous discovery must therefore claim synchronously from the relevant D&D5e roll hook before its first `await`.

## Public API

```js
const queue = game.modules.get("dnd5e-character-builder")?.api?.rollResolutionQueue;
```

The compatibility symbol remains:

```js
Symbol.for("dnd5e.roll-resolution-queue.v1")
```

The API reports `version: 3`. A conforming v3 implementation also exposes:

```js
queue.capabilities.discoveryBarrier === true
queue.capabilities.dynamicPriorityDrain === true
```

External runtimes should require `discoveryBarrier === true` before enabling asynchronous v3 claim integration. Character Builder v0.9.9k exposed `version: 3` but did not yet enforce claims as an execution barrier; v0.9.9l is the first conforming implementation for this guarantee.

The API exposes:

- `enqueue(options)`
- `markPending(options)`
- `claim(options)`
- `release(options)`
- `requestFinalization(options)`
- `finalize(options)` — compatibility alias for a safe finalization request
- `getResolution({ roll, rollKey })`
- `waitForFinalized({ roll, rollKey, timeout })`
- `phasePriority(phase)`

`enqueue()` now publishes pending state automatically when necessary, so an Item-only provider can participate without depending on a Character Builder provider being present first.

## Async discovery rule

If a provider performs **any await before it knows whether it will enqueue**, it must claim synchronously from the D&D5e roll hook before the first await. This synchronous claim participates in the discovery barrier and is what guarantees that a faster later phase cannot execute before a slower earlier phase has finished discovery.

```js
const claim = queue.claim({
  roll,
  providerId: "item-creator:post-roll-discovery",
  reason: "eligible-item-modifiers"
});

void (async () => {
  let released = false;
  try {
    const eligible = await discoverEligibleModifiers(roll);
    if (!eligible.length) return;

    const task = queue.enqueue({
      roll,
      rollKey: claim.rollKey,
      phase: "items",
      providerId: "item-creator:post-roll-modifier",
      execute: async context => {
        // Player-facing eligibility must not depend on hidden success/failure.
        // Resolve Use / Keep and return the updated total.
        return {
          currentTotal: context.currentTotal + bonus,
          adjustments: [{ source: item.name, bonus }]
        };
      }
    });

    // The queued provider now keeps the batch alive while its Promise/UI is open.
    claim.release();
    released = true;
    await task;
  } finally {
    if (!released) claim.release();
  }
})();
```

Do not hold the discovery claim after the provider has been successfully enqueued; the queued provider itself blocks terminal finalization until its Promise settles.

## Concentration lifecycle

Concentration uses deferred terminal finalization.

Character Builder opens a lifecycle gate at:

```text
dnd5e.postConcentrationRollConfiguration
```

This hook occurs after the Concentration D20Roll is constructed but **before it is evaluated**, so the lifecycle gate exists before any post-roll provider can begin async discovery.

After evaluation:

```text
dnd5e.rollSavingThrow
→ native total captured into pending queue
→ Character providers may claim/enqueue
→ Item Creator providers may claim/enqueue

dnd5e.rollConcentration
→ Character Builder requests terminal finalization
→ releases only its lifecycle gate
→ external claims/providers remain authoritative
```

A final failed Concentration result creates a GM decision in Chat. `Actor.endConcentration()` is called only after the shared queue has finalized **and** a GM explicitly chooses **Drop Concentration**. Choosing **Keep Concentration** leaves the native effect active.

When terminal finalization is requested, protocol v3 arms the terminal close on the next **microtask**, not in the middle of the current synchronous D&D5e hook dispatch. This is not a millisecond discovery delay: it simply lets modules whose listeners run later on the same hook synchronously call `claim()` before the batch can close. Any asynchronous work after that point still requires an explicit claim.

Example:

```text
native Concentration Save = 8 vs DC 10
→ Item Creator has Bless, claims roll
→ lifecycle requests finalization but cannot close the batch
→ player uses +1d4 and rolls 4
→ provider returns currentTotal 12
→ Item Creator releases/completes
→ queue FINALIZED at 12
→ concentration remains
```

If the player chooses **Keep**, the provider still completes/release first; only then can the unresolved final failure end concentration.

## Provider result contract

A provider should return only what it changed:

```js
{
  currentTotal: 21,
  adjustments: [
    { source: "Example Bonus", bonus: 4 }
  ],
  stop: false
}
```

If the queue has an internal numeric target, protocol v3 recomputes the internal outcome after a changed `currentTotal` unless the provider explicitly returns `succeeded`/`success`. Attack critical/fumble semantics remain respected when the roll exposes them.

## Hidden-outcome privacy rule

`target` and `succeeded` may exist inside the coordination payload because the responsible runtime can need them. They are **not player-facing data**.

A provider MUST NOT decide whether to show a player prompt based on:

- `context.succeeded`
- `context.success`
- `context.target`
- `currentTotal < target`
- any equivalent hidden hit/miss or success/failure test

Correct model:

```text
publicly eligible roll + resource available
→ same neutral Use / Keep decision
→ modifier resolves
→ GM adjudicates hidden outcome
```

Player-facing UI must not reveal AC, DC, Success, Failure, “still failed”, “already succeeded”, or equivalent information.

## Queue hooks

```js
Hooks.on("dnd5e-character-builder.rollResolutionPending", (payload, roll) => {});
Hooks.on("dnd5e-character-builder.rollResolutionFinalized", (payload, roll) => {});
```

The finalized hook means **terminal**: no queued provider or active discovery claim remains for that roll. In v0.9.9l, the same active claims also prevent provider drain from starting, so terminal order and execution order use the same discovery barrier.

## Structured internal payload

```js
{
  rollKey: "roll:unique-key",
  actorUuid: "Actor.actorId",
  rollType: "savingThrow",
  originalTotal: 17,
  currentTotal: 24,
  target: 21,              // internal/private
  succeeded: true,         // internal/private
  finalized: true,
  finalizationRequested: true,
  pendingClaims: 0,
  adjustments: [
    { source: "Bardic Inspiration", bonus: 7 }
  ]
}
```

Supported Character Builder roll labels include:

- `attackRoll`
- `abilityCheck`
- `skillCheck`
- `toolCheck`
- `savingThrow`
- `concentration`

## Public finalized-total handoff

When the originating ChatMessage exists, Character Builder mirrors a deliberately safe snapshot to:

```text
flags.dnd5e-character-builder.publicRollResolution
```

Only these coordination fields are persisted:

- roll identity/type
- `originalTotal`
- finalized `currentTotal`
- finalized state
- timestamp

Hidden target/DC, success/failure, provider identities, and active claims are never written to the public ChatMessage flag.

This is what later manual reactions such as Cutting Words use to start from the total already resolved by Character Builder and Item Creator instead of the native base roll.

## Finalization ownership

Ordinary Character/Item providers **must not call `finalize()`**. They claim, enqueue, resolve, and release.

`requestFinalization()` is intended for workflows that truly own the terminal lifecycle boundary, such as Character Builder's Concentration lifecycle. In protocol v3 even `finalize()` is only a request and cannot bypass active claims or running providers.

## Responsibility boundary

The queue standardizes ordering, finalization, arithmetic handoff, and privacy. Character Builder remains responsible for character-origin assistance; Item Creator remains responsible for Item-origin effects, eligibility, resource consumption, duration, and UI. Neither runtime should infer the other runtime's completion through timers.
