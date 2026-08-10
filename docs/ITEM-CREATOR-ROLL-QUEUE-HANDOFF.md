# Item Creator handoff — Character Builder Roll Queue v3 (v0.9.9l)

Character Builder v0.9.9l fixes the discovery-ordering race identified during Item Creator integration review. The shared queue remains protocol v3, but external runtimes must verify the corrected capabilities before adopting the claim contract.

## Compatibility gate

```js
const queue = game.modules.get("dnd5e-character-builder")?.api?.rollResolutionQueue;
const compatible = queue?.version >= 3
  && queue?.capabilities?.discoveryBarrier === true
  && queue?.capabilities?.dynamicPriorityDrain === true;
```

Do **not** enable v3 asynchronous claim integration against a queue that reports v3 but lacks `discoveryBarrier`. Character Builder v0.9.9k is such a build; v0.9.9l is the corrected implementation. No workaround should be added in Item Creator.

## Canonical order

`D&D5e native → Character Builder (200) → Item Creator (300) → lifecycle`

The queue now guarantees this ordering across asynchronous discovery as long as each participating runtime claims synchronously before its first `await`.

## Required Item Creator pattern

1. From the relevant synchronous D&D5e roll hook, call `queue.claim(...)` **before the first await** whenever Item Creator may need asynchronous eligibility/resource discovery.
2. Perform Item Creator's normal discovery. Player-facing eligibility must not depend on hidden AC/DC/success/failure.
3. If nothing applies, `claim.release()`.
4. If an Item provider applies, call `queue.enqueue({ phase: "items", ... })`, then release the discovery claim immediately.
5. The queued provider Promise itself keeps the queue open during any `Use / Keep` UI. Do not retain the discovery claim after successful enqueue.
6. Return the updated `currentTotal` and adjustments. Do not rerun native or Character Builder providers.
7. Ordinary Item providers must not call `finalize()` / `requestFinalization()`.

```js
const queue = game.modules.get("dnd5e-character-builder")?.api?.rollResolutionQueue;
if (queue?.version >= 3 && queue?.capabilities?.discoveryBarrier === true) {
  const claim = queue.claim({
    roll,
    providerId: "item-creator:discovery",
    reason: "post-roll-item-modifiers"
  });

  void (async () => {
    let released = false;
    try {
      const modifiers = await discoverModifiers();
      if (!modifiers.length) return;

      const task = queue.enqueue({
        roll,
        rollKey: claim.rollKey,
        phase: "items",
        providerId: "item-creator:modifier",
        execute: async context => {
          const bonus = await resolveNeutralUseKeep(modifiers, context.currentTotal);
          return {
            currentTotal: context.currentTotal + bonus,
            adjustments: bonus ? [{ source: "Item Creator", bonus }] : []
          };
        }
      });

      claim.release();
      released = true;
      await task;
    } finally {
      if (!released) claim.release();
    }
  })();
}
```

## What changed from v0.9.9k

In v0.9.9k, claims prevented terminal finalization but did not prevent `#drain()` from starting. A fast Item Creator discovery could therefore enqueue/release Items 300 and execute before a slower Character 200 discovery finished.

v0.9.9l changes the queue itself:

```text
CB claim
IC claim

IC discovers first
→ enqueue Items 300
→ release IC claim
→ CB claim still active
→ NO PROVIDER EXECUTES

CB discovers
→ enqueue Character 200
→ release CB claim
→ claims = 0

queue drains:
Character 200
Items 300
lifecycle after terminal finalization
```

The drain also selects one live provider at a time and re-sorts after each provider. If Character B (200) is enqueued while Character A (200) is resolving and Items (300) is waiting, the order is `Character A → Character B → Items`.

If a new claim opens while a provider is already running, the running provider is not rolled back; the queue pauses before choosing the next provider until the claim is released.

## Concentration integration

Character Builder opens its Concentration lifecycle gate before the native Concentration roll is evaluated and requests terminal finalization only at the native post-roll concentration stage.

For Item Creator to keep concentration open while it discovers or resolves Bless/item modifiers, it must claim synchronously before asynchronous discovery:

```text
native Concentration Save = 8 vs internal DC 10
→ CB lifecycle gate exists
→ CB/IC synchronous discovery claims exist
→ IC discovers Bless and enqueues Items provider
→ discovery claims release
→ ordered providers resolve
→ IC Use rolls +4, currentTotal becomes 12
→ all providers finish
→ queue FINALIZED = 12
→ Character Builder lifecycle keeps concentration
```

If the player chooses Keep, the Item provider still settles first; only after the queue is terminally finalized may Character Builder end concentration.

Item Creator must not inspect hidden `target`, `succeeded`, AC, DC, hit/miss, or success/failure to decide whether to show the player a modifier prompt.

## Scope boundary

This handoff changes only shared roll coordination. Item Creator remains responsible for its own Item-origin eligibility, resource consumption, Triggered Effects, duration, and UI. The separate Item Creator issue where Bardic Inspiration **consumption** is being confused with Bardic Inspiration **granted to a target** is not part of this queue change.
