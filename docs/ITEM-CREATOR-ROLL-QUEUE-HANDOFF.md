# Item Creator handoff — Character Builder Roll Queue v3

Character Builder v0.9.9k changes the shared roll queue from timing-based discovery to explicit provider claims. Item Creator should adopt this contract for any post-roll modifier whose eligibility discovery is asynchronous or whose player decision can remain open.

## Required Item Creator changes

1. Read `game.modules.get("dnd5e-character-builder")?.api?.rollResolutionQueue` and require `version >= 3` before using claim semantics.
2. On an eligible D&D5e roll hook, call `queue.claim(...)` **synchronously before the first await** when Item Creator may need async discovery. Prefer the generic D20 hook where the Item Creator already observes the roll (for Concentration this is typically `dnd5e.rollSavingThrow`); a later listener on the same synchronous `dnd5e.rollConcentration` dispatch can still claim because terminal close is armed on the next microtask, but the claim must still occur before any await.
3. Perform normal Item Creator eligibility/resource discovery without looking at hidden success/failure to decide prompt visibility.
4. If nothing applies, `claim.release()`.
5. If an Item provider applies, register it with `queue.enqueue({ phase: "items", ... })`, then release the discovery claim immediately. The queued provider Promise keeps the roll open through its Use/Keep UI.
6. Return the updated `currentTotal` and adjustment data from the provider. Do not rerun Character Builder or native providers.
7. Do not call `finalize()` from an ordinary Item provider.
8. Concentration is now finalized only after all claims/providers complete. Therefore Bless, Item Creator dice, or any other eligible post-roll modifier can rescue a Concentration Save if Item Creator claims/enqueues correctly.
9. Preserve the privacy contract: never condition a player-facing popup on hidden `target`, `succeeded`, hit/miss, AC, or DC.
10. Keep phase order `D&D5e native → Character Builder (200) → Item Creator (300) → lifecycle`.

## Concentration example

```text
native save 8 vs DC 10
→ CB lifecycle gate already open
→ IC synchronously claims roll
→ IC discovers available Bless/item resource
→ CB requests finalization, but IC claim keeps batch open
→ player Use: +4
→ IC provider returns currentTotal 12
→ IC provider completes
→ queue finalizes 12
→ CB concentration lifecycle keeps concentration
```

Choosing Keep follows the same order; concentration can end only after Item Creator has completed/released its opportunity.

## Minimal integration pattern

```js
const queue = game.modules.get("dnd5e-character-builder")?.api?.rollResolutionQueue;
if (queue?.version >= 3) {
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

Item Creator's existing Resource Consumed / Triggered Effect semantics are separate from this queue change and should remain owned by Item Creator.
