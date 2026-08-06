const QUEUE_SYMBOL = Symbol.for("dnd5e.roll-resolution-queue.v1");
const DEFAULT_PRIORITY = 1000;

const PHASE_PRIORITIES = Object.freeze({
  native: 100,
  character: 200,
  items: 300
});

/**
 * Shared per-roll provider queue.
 *
 * Native D&D5e resolution completes before providers enqueue. Character
 * automation runs before item automation so each provider receives the roll
 * context produced by the previous phase instead of opening competing prompts.
 */
export class SharedRollResolutionQueueService {
  static api() {
    return this.#state().api;
  }

  static enqueue({
    roll,
    rollKey = null,
    phase = "character",
    priority = null,
    providerId,
    execute
  } = {}) {
    if (typeof execute !== "function") throw new TypeError("A roll-resolution provider requires an execute function.");
    const state = this.#state();
    const key = this.#rollKey(state, roll, rollKey);
    const provider = String(providerId ?? "anonymous-provider");
    const resolvedPriority = priority != null && Number.isFinite(Number(priority))
      ? Number(priority)
      : (PHASE_PRIORITIES[phase] ?? DEFAULT_PRIORITY);

    let batch = state.batches.get(key);
    if (!batch) {
      batch = {
        key,
        roll: roll ?? null,
        entries: [],
        context: {
          roll: roll ?? null,
          rollKey: key,
          currentTotal: Number.isFinite(Number(roll?.total)) ? Number(roll.total) : null,
          success: roll?.isSuccess === true ? true : roll?.isFailure === true ? false : null,
          results: [],
          stopped: false
        },
        scheduled: false,
        running: false
      };
      state.batches.set(key, batch);
    }

    const result = new Promise((resolve, reject) => {
      batch.entries.push({
        phase,
        priority: resolvedPriority,
        providerId: provider,
        execute,
        resolve,
        reject,
        order: state.sequence++
      });
    });

    if (!batch.scheduled && !batch.running) {
      batch.scheduled = true;
      queueMicrotask(() => void this.#drain(state, batch));
    }
    return result;
  }

  static phasePriority(phase) {
    return PHASE_PRIORITIES[phase] ?? DEFAULT_PRIORITY;
  }

  static #state() {
    const root = globalThis;
    if (root[QUEUE_SYMBOL]) return root[QUEUE_SYMBOL];

    const state = {
      version: 1,
      batches: new Map(),
      rollIds: new WeakMap(),
      sequence: 0,
      api: null
    };
    state.api = Object.freeze({
      version: 1,
      symbol: "dnd5e.roll-resolution-queue.v1",
      phases: PHASE_PRIORITIES,
      enqueue: options => SharedRollResolutionQueueService.enqueue(options),
      phasePriority: phase => SharedRollResolutionQueueService.phasePriority(phase)
    });
    root[QUEUE_SYMBOL] = state;
    return state;
  }

  static #rollKey(state, roll, explicitKey) {
    if (explicitKey != null && String(explicitKey).trim()) return String(explicitKey);
    if (roll && (typeof roll === "object" || typeof roll === "function")) {
      const existing = state.rollIds.get(roll);
      if (existing) return existing;
      const id = `roll:${globalThis.foundry?.utils?.randomID?.(24) ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${state.sequence++}`}`;
      state.rollIds.set(roll, id);
      return id;
    }
    return `roll:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${state.sequence++}`}`;
  }

  static async #drain(state, batch) {
    if (batch.running) return;
    batch.running = true;
    batch.scheduled = false;
    try {
      while (batch.entries.length) {
        const entries = batch.entries.splice(0).sort((a, b) =>
          a.priority - b.priority || a.order - b.order || a.providerId.localeCompare(b.providerId)
        );
        for (const entry of entries) {
          if (batch.context.stopped) {
            entry.resolve({ skipped: true, reason: "stopped", context: batch.context });
            continue;
          }
          try {
            const value = await entry.execute(batch.context);
            if (value && typeof value === "object") {
              batch.context.results.push({
                providerId: entry.providerId,
                phase: entry.phase,
                ...value
              });
              if (Number.isFinite(Number(value.currentTotal))) batch.context.currentTotal = Number(value.currentTotal);
              if (typeof value.success === "boolean") batch.context.success = value.success;
              if (value.stop === true) batch.context.stopped = true;
            }
            entry.resolve({ value, context: batch.context });
          } catch (error) {
            entry.reject(error);
          }
        }
        // Providers that enqueue during an earlier provider's Promise can join
        // the same roll before the next ordered pass.
        await Promise.resolve();
      }
    } finally {
      state.batches.delete(batch.key);
      batch.running = false;
    }
  }
}
