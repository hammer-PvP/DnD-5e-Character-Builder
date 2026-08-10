import { MODULE_ID } from "../constants.mjs";

const QUEUE_SYMBOL = Symbol.for("dnd5e.roll-resolution-queue.v1");
const DEFAULT_PRIORITY = 1000;
const COMPLETED_TTL_MS = 60000;
const PENDING_HOOK = "dnd5e-character-builder.rollResolutionPending";
const FINALIZED_HOOK = "dnd5e-character-builder.rollResolutionFinalized";
const ROLL_FLAG = "dnd5eCharacterBuilderRollResolution";

const PHASE_PRIORITIES = Object.freeze({
  native: 100,
  character: 200,
  items: 300
});

/**
 * Shared per-roll provider queue and public resolution contract.
 *
 * Native D&D5e resolution completes before providers enqueue. Character
 * automation runs before item automation so each provider receives the roll
 * context produced by the previous phase instead of opening competing prompts.
 *
 * Protocol v2 adds explicit pending/finalized snapshots. The global symbol is
 * intentionally retained as v1 so item runtimes using the original queue keep
 * working while gaining the new API methods.
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
    execute,
    actorUuid,
    rollType,
    originalTotal,
    currentTotal,
    target,
    succeeded
  } = {}) {
    if (typeof execute !== "function") throw new TypeError("A roll-resolution provider requires an execute function.");
    const state = this.#state();
    const key = this.#rollKey(state, roll, rollKey);
    const provider = String(providerId ?? "anonymous-provider");
    const resolvedPriority = priority != null && Number.isFinite(Number(priority))
      ? Number(priority)
      : (PHASE_PRIORITIES[phase] ?? DEFAULT_PRIORITY);

    const batch = this.#ensureBatch(state, { roll, rollKey: key });
    this.#applyDescriptor(batch, {
      actorUuid,
      rollType,
      originalTotal,
      currentTotal,
      target,
      succeeded
    });

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

  static markPending({
    roll,
    rollKey = null,
    actorUuid = null,
    rollType = null,
    originalTotal = null,
    currentTotal = null,
    target = null,
    succeeded = null
  } = {}) {
    const state = this.#state();
    const key = this.#rollKey(state, roll, rollKey);
    const batch = this.#ensureBatch(state, { roll, rollKey: key });
    this.#applyDescriptor(batch, {
      actorUuid,
      rollType,
      originalTotal,
      currentTotal,
      target,
      succeeded
    });
    batch.context.finalized = false;

    const payload = this.#snapshot(batch);
    this.#writeRollSnapshot(batch.roll, payload);
    if (!batch.pendingPublished) {
      batch.pendingPublished = true;
      this.#publish(PENDING_HOOK, payload, batch.roll);
    }
    return payload;
  }

  static finalize({
    roll,
    rollKey = null,
    actorUuid,
    rollType,
    originalTotal,
    currentTotal,
    target,
    succeeded,
    adjustments
  } = {}) {
    const state = this.#state();
    const key = this.#rollKey(state, roll, rollKey);
    const batch = this.#ensureBatch(state, { roll, rollKey: key });
    if (batch.context.finalized && batch.finalizedPublished) return this.#snapshot(batch);
    this.#applyDescriptor(batch, {
      actorUuid,
      rollType,
      originalTotal,
      currentTotal,
      target,
      succeeded
    });
    if (Array.isArray(adjustments)) batch.context.adjustments = this.#normalizeAdjustments(adjustments);
    return this.#finalizeBatch(state, batch);
  }

  static getResolution({ roll, rollKey = null } = {}) {
    const state = this.#state();
    const key = this.#rollKey(state, roll, rollKey);
    const batch = state.batches.get(key);
    if (batch) return this.#snapshot(batch);

    const completed = state.completed.get(key);
    if (completed && completed.expiresAt > Date.now()) return this.#clonePayload(completed.payload);
    if (completed) state.completed.delete(key);

    const stored = roll?.options?.[ROLL_FLAG];
    return stored && typeof stored === "object" ? this.#clonePayload(stored) : null;
  }

  static waitForFinalized({ roll, rollKey = null, timeout = 15000 } = {}) {
    const state = this.#state();
    const key = this.#rollKey(state, roll, rollKey);
    const existing = this.getResolution({ roll, rollKey: key });
    if (existing?.finalized === true) return Promise.resolve(existing);

    const batch = this.#ensureBatch(state, { roll, rollKey: key });
    return new Promise(resolve => {
      const waiter = { resolve, timeout: null };
      if (Number.isFinite(Number(timeout)) && Number(timeout) > 0) {
        waiter.timeout = setTimeout(() => {
          batch.waiters.delete(waiter);
          resolve(null);
        }, Number(timeout));
      }
      batch.waiters.add(waiter);
    });
  }

  static phasePriority(phase) {
    return PHASE_PRIORITIES[phase] ?? DEFAULT_PRIORITY;
  }

  static #state() {
    const root = globalThis;
    if (root[QUEUE_SYMBOL]) {
      const existing = root[QUEUE_SYMBOL];
      this.#upgradeState(existing);
      return existing;
    }

    const state = {
      version: 2,
      batches: new Map(),
      completed: new Map(),
      rollIds: new WeakMap(),
      sequence: 0,
      api: null
    };
    this.#upgradeState(state);
    root[QUEUE_SYMBOL] = state;
    return state;
  }

  static #upgradeState(state) {
    state.version = Math.max(2, Number(state.version ?? 0));
    state.batches ??= new Map();
    state.completed ??= new Map();
    state.rollIds ??= new WeakMap();
    state.sequence ??= 0;
    state.api = Object.freeze({
      version: 2,
      symbol: "dnd5e.roll-resolution-queue.v1",
      phases: PHASE_PRIORITIES,
      hooks: Object.freeze({ pending: PENDING_HOOK, finalized: FINALIZED_HOOK }),
      enqueue: options => SharedRollResolutionQueueService.enqueue(options),
      markPending: options => SharedRollResolutionQueueService.markPending(options),
      finalize: options => SharedRollResolutionQueueService.finalize(options),
      getResolution: options => SharedRollResolutionQueueService.getResolution(options),
      waitForFinalized: options => SharedRollResolutionQueueService.waitForFinalized(options),
      phasePriority: phase => SharedRollResolutionQueueService.phasePriority(phase)
    });
  }

  static #ensureBatch(state, { roll, rollKey }) {
    let batch = state.batches.get(rollKey);
    if (batch) {
      if (!batch.roll && roll) batch.roll = roll;
      batch.waiters ??= new Set();
      batch.context.adjustments ??= [];
      return batch;
    }

    const rollTotal = this.#finiteNumber(roll?.total);
    const rollTarget = this.#finiteNumber(roll?.options?.target);
    const inferredSuccess = roll?.isSuccess === true
      ? true
      : roll?.isFailure === true
        ? false
        : null;

    batch = {
      key: rollKey,
      roll: roll ?? null,
      entries: [],
      context: {
        roll: roll ?? null,
        rollKey,
        actorUuid: null,
        rollType: null,
        originalTotal: rollTotal,
        currentTotal: rollTotal,
        target: rollTarget,
        succeeded: inferredSuccess,
        success: inferredSuccess,
        finalized: false,
        adjustments: [],
        results: [],
        stopped: false
      },
      scheduled: false,
      running: false,
      pendingPublished: false,
      finalizedPublished: false,
      waiters: new Set()
    };
    state.batches.set(rollKey, batch);
    return batch;
  }

  static #applyDescriptor(batch, descriptor = {}) {
    if (descriptor.actorUuid != null) batch.context.actorUuid = String(descriptor.actorUuid);
    if (descriptor.rollType != null) batch.context.rollType = String(descriptor.rollType);

    const originalTotal = this.#finiteNumber(descriptor.originalTotal);
    if (originalTotal != null) batch.context.originalTotal = originalTotal;

    const currentTotal = this.#finiteNumber(descriptor.currentTotal);
    if (currentTotal != null) batch.context.currentTotal = currentTotal;
    else if (batch.context.currentTotal == null && batch.context.originalTotal != null) {
      batch.context.currentTotal = batch.context.originalTotal;
    }

    const target = this.#finiteNumber(descriptor.target);
    if (target != null) batch.context.target = target;

    if (typeof descriptor.succeeded === "boolean") {
      batch.context.succeeded = descriptor.succeeded;
      batch.context.success = descriptor.succeeded;
    }
  }

  static #finalizeBatch(state, batch) {
    if (batch.context.finalized && batch.finalizedPublished) return this.#snapshot(batch);

    batch.context.finalized = true;
    if (typeof batch.context.succeeded !== "boolean"
      && batch.context.currentTotal != null
      && batch.context.target != null) {
      batch.context.succeeded = batch.context.currentTotal >= batch.context.target;
      batch.context.success = batch.context.succeeded;
    }

    const payload = this.#snapshot(batch);
    this.#writeRollSnapshot(batch.roll, payload);
    void this.#persistPublicMessageSnapshot(batch.roll, payload);
    state.completed.set(batch.key, {
      payload: this.#clonePayload(payload),
      expiresAt: Date.now() + COMPLETED_TTL_MS
    });

    if (!batch.finalizedPublished) {
      batch.finalizedPublished = true;
      this.#publish(FINALIZED_HOOK, payload, batch.roll);
    }

    for (const waiter of batch.waiters ?? []) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.resolve(this.#clonePayload(payload));
    }
    batch.waiters?.clear?.();
    return payload;
  }

  static #snapshot(batch) {
    return Object.freeze({
      rollKey: String(batch.key),
      actorUuid: batch.context.actorUuid ?? null,
      rollType: batch.context.rollType ?? null,
      originalTotal: this.#finiteNumber(batch.context.originalTotal),
      currentTotal: this.#finiteNumber(batch.context.currentTotal),
      target: this.#finiteNumber(batch.context.target),
      succeeded: typeof batch.context.succeeded === "boolean" ? batch.context.succeeded : null,
      finalized: batch.context.finalized === true,
      adjustments: Object.freeze(this.#normalizeAdjustments(batch.context.adjustments))
    });
  }

  static #normalizeAdjustments(adjustments) {
    if (!Array.isArray(adjustments)) return [];
    return adjustments
      .filter(entry => entry && typeof entry === "object")
      .map(entry => ({
        source: String(entry.source ?? "Unknown Adjustment"),
        bonus: this.#finiteNumber(entry.bonus) ?? 0
      }));
  }

  static #writeRollSnapshot(roll, payload) {
    if (!roll || (typeof roll !== "object" && typeof roll !== "function")) return;
    roll.options ??= {};
    roll.options[ROLL_FLAG] = this.#clonePayload(payload);
  }

  static async #persistPublicMessageSnapshot(roll, payload) {
    const message = roll?.parent?.documentName === "ChatMessage" ? roll.parent : null;
    if (!message?.update) return;

    // This flag is deliberately public-safe. Never persist hidden target/DC or
    // success/failure state to a ChatMessage merely to coordinate reactions.
    const snapshot = {
      schema: 1,
      rollKey: payload.rollKey ?? null,
      actorUuid: payload.actorUuid ?? null,
      rollType: payload.rollType ?? null,
      originalTotal: this.#finiteNumber(payload.originalTotal),
      currentTotal: this.#finiteNumber(payload.currentTotal),
      finalized: payload.finalized === true,
      at: Date.now()
    };

    try {
      const current = message.getFlag?.(MODULE_ID, "publicRollResolution");
      if (current?.rollKey === snapshot.rollKey
        && Number(current?.currentTotal) === Number(snapshot.currentTotal)
        && current?.finalized === snapshot.finalized) return;
      await message.update({ [`flags.${MODULE_ID}.publicRollResolution`]: snapshot }, {
        dnd5eCharacterBuilderRollResolution: true
      });
    } catch (error) {
      // The roll may finalize before its message is persisted or on a client
      // that cannot update that message. The serialized roll snapshot and
      // local finalized hook still provide a safe fallback.
      console.debug?.("Character Builder | Could not persist public roll-resolution snapshot.", error);
    }
  }

  static #publish(hook, payload, roll) {
    try {
      globalThis.Hooks?.callAll?.(hook, this.#clonePayload(payload), roll ?? null);
    } catch (error) {
      console.warn(`Character Builder | Failed to publish ${hook}.`, error);
    }
  }

  static #clonePayload(payload) {
    return {
      rollKey: payload.rollKey,
      actorUuid: payload.actorUuid,
      rollType: payload.rollType,
      originalTotal: payload.originalTotal,
      currentTotal: payload.currentTotal,
      target: payload.target,
      succeeded: payload.succeeded,
      finalized: payload.finalized === true,
      adjustments: (payload.adjustments ?? []).map(entry => ({ ...entry }))
    };
  }

  static #finiteNumber(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
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
              if (typeof value.succeeded === "boolean") {
                batch.context.succeeded = value.succeeded;
                batch.context.success = value.succeeded;
              } else if (typeof value.success === "boolean") {
                batch.context.succeeded = value.success;
                batch.context.success = value.success;
              }
              if (Array.isArray(value.adjustments)) {
                batch.context.adjustments.push(...this.#normalizeAdjustments(value.adjustments));
              }
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
      if (batch.pendingPublished && !batch.context.finalized) this.#finalizeBatch(state, batch);
      state.batches.delete(batch.key);
      batch.running = false;
    }
  }
}
