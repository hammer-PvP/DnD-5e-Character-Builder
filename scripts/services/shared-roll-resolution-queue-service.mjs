import { MODULE_ID } from "../constants.mjs";

const QUEUE_SYMBOL = Symbol.for("dnd5e.roll-resolution-queue.v1");
const DEFAULT_PRIORITY = 1000;
const COMPLETED_TTL_MS = 60000;
const DEFAULT_CLAIM_FAILSAFE_MS = 300000;
const PENDING_HOOK = "dnd5e-character-builder.rollResolutionPending";
const FINALIZED_HOOK = "dnd5e-character-builder.rollResolutionFinalized";
const ROLL_FLAG = "dnd5eCharacterBuilderRollResolution";

const PHASE_PRIORITIES = Object.freeze({
  native: 100,
  character: 200,
  items: 300,
  lifecycle: 900
});

/**
 * Shared per-roll provider queue and public resolution contract.
 *
 * Protocol v3 adds explicit provider-discovery claims and deferred
 * finalization. A provider that needs asynchronous work before it can enqueue
 * a prompt claims the roll synchronously, then releases that claim once its
 * provider has been registered (or once it determines it has nothing to do).
 *
 * Concentration uses deferred finalization: its lifecycle gate opens before
 * the native roll is evaluated and requests finalization only after D&D5e has
 * finished the concentration workflow. The batch cannot finalize while any
 * provider claim or queued provider remains pending.
 *
 * The global symbol intentionally remains v1 for backward compatibility.
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
    const completed = this.#completed(state, key);
    if (completed && !state.batches.has(key)) {
      return Promise.resolve({ skipped: true, reason: "finalized", context: this.#clonePayload(completed.payload) });
    }

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
    batch.context.finalized = false;
    if (!batch.pendingPublished) {
      batch.pendingPublished = true;
      const payload = this.#snapshot(batch);
      this.#writeRollSnapshot(batch.roll, payload);
      this.#publish(PENDING_HOOK, payload, batch.roll);
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

  static markPending({
    roll,
    rollKey = null,
    actorUuid = null,
    rollType = null,
    originalTotal = null,
    currentTotal = null,
    target = null,
    succeeded = null,
    deferFinalization = false
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
    if (deferFinalization === true) batch.manualFinalization = true;
    batch.context.finalized = false;

    const payload = this.#snapshot(batch);
    this.#writeRollSnapshot(batch.roll, payload);
    if (!batch.pendingPublished) {
      batch.pendingPublished = true;
      this.#publish(PENDING_HOOK, payload, batch.roll);
    }
    return payload;
  }

  /**
   * Claim a roll while a provider performs asynchronous eligibility discovery.
   * Call this synchronously from the D&D5e roll hook, before the first await.
   * Once the provider has been enqueued (or ruled out), call release().
   */
  static claim({
    roll,
    rollKey = null,
    providerId = "anonymous-provider",
    reason = "provider-discovery",
    actorUuid = null,
    rollType = null,
    originalTotal = null,
    currentTotal = null,
    target = null,
    succeeded = null,
    deferFinalization = false,
    timeout = DEFAULT_CLAIM_FAILSAFE_MS
  } = {}) {
    const state = this.#state();
    const key = this.#rollKey(state, roll, rollKey);
    const completed = this.#completed(state, key);
    if (completed && !state.batches.has(key)) {
      return Object.freeze({
        active: false,
        rollKey: key,
        claimId: null,
        release: () => false
      });
    }

    const batch = this.#ensureBatch(state, { roll, rollKey: key });
    this.#applyDescriptor(batch, {
      actorUuid,
      rollType,
      originalTotal,
      currentTotal,
      target,
      succeeded
    });
    if (deferFinalization === true) batch.manualFinalization = true;

    const claimId = `claim:${globalThis.foundry?.utils?.randomID?.(20)
      ?? globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}:${state.sequence++}`}`;
    const claim = {
      claimId,
      providerId: String(providerId ?? "anonymous-provider"),
      reason: String(reason ?? "provider-discovery"),
      createdAt: Date.now(),
      timeout: null
    };
    const timeoutMs = Number(timeout);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      claim.timeout = setTimeout(() => {
        const live = state.batches.get(key);
        if (!live?.claims?.has(claimId)) return;
        live.claims.delete(claimId);
        console.warn(`${MODULE_ID} | Roll-resolution claim expired after failsafe timeout.`, {
          rollKey: key,
          claimId,
          providerId: claim.providerId,
          reason: claim.reason
        });
        this.#maybeFinalizeOrCleanup(state, live);
      }, timeoutMs);
    }
    batch.claims.set(claimId, claim);

    return Object.freeze({
      active: true,
      rollKey: key,
      claimId,
      release: updates => SharedRollResolutionQueueService.release({
        roll,
        rollKey: key,
        claimId,
        ...(updates && typeof updates === "object" ? updates : {})
      })
    });
  }

  static release({
    roll,
    rollKey = null,
    claimId,
    actorUuid,
    rollType,
    originalTotal,
    currentTotal,
    target,
    succeeded,
    adjustments
  } = {}) {
    if (!claimId) return false;
    const state = this.#state();
    const key = this.#rollKey(state, roll, rollKey);
    const batch = state.batches.get(key);
    if (!batch) return false;
    const claim = batch.claims.get(String(claimId));
    if (!claim) return false;
    if (claim.timeout) clearTimeout(claim.timeout);
    batch.claims.delete(String(claimId));
    this.#applyDescriptor(batch, {
      actorUuid,
      rollType,
      originalTotal,
      currentTotal,
      target,
      succeeded
    });
    if (Array.isArray(adjustments)) batch.context.adjustments.push(...this.#normalizeAdjustments(adjustments));
    this.#maybeFinalizeOrCleanup(state, batch);
    return true;
  }

  /**
   * Request terminal finalization. Deferred batches finalize only after this
   * request and once entries, running providers, and discovery claims are all
   * clear. This method never bypasses an active claim.
   */
  static requestFinalization({
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
    const completed = this.#completed(state, key);
    if (completed && !state.batches.has(key)) return this.#clonePayload(completed.payload);

    const batch = this.#ensureBatch(state, { roll, rollKey: key });
    this.#applyDescriptor(batch, {
      actorUuid,
      rollType,
      originalTotal,
      currentTotal,
      target,
      succeeded
    });
    if (Array.isArray(adjustments)) batch.context.adjustments = this.#normalizeAdjustments(adjustments);
    batch.finalizationRequested = true;
    batch.manualFinalization = true;

    // Do not terminally close a deferred batch in the middle of a synchronous
    // D&D5e hook dispatch. Later listeners on that same hook (for example an
    // Item runtime loaded after Character Builder) must get one deterministic
    // call-stack turn to claim the roll before terminal finalization is armed.
    if (!batch.finalizationArmScheduled) {
      batch.finalizationArmed = false;
      batch.finalizationArmScheduled = true;
      queueMicrotask(() => {
        const live = state.batches.get(key);
        if (!live || live.context.finalized) return;
        live.finalizationArmScheduled = false;
        live.finalizationArmed = true;
        this.#maybeFinalizeOrCleanup(state, live);
      });
    }
    return this.#snapshot(batch);
  }

  /**
   * Backward-compatible explicit finalization. Protocol v3 treats finalize()
   * as a request and will not bypass provider claims or running entries.
   */
  static finalize(options = {}) {
    return this.requestFinalization(options);
  }

  static getResolution({ roll, rollKey = null } = {}) {
    const state = this.#state();
    const key = this.#rollKey(state, roll, rollKey);
    const batch = state.batches.get(key);
    if (batch) return this.#snapshot(batch);

    const completed = this.#completed(state, key);
    if (completed) return this.#clonePayload(completed.payload);

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
      version: 3,
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
    state.version = Math.max(3, Number(state.version ?? 0));
    state.batches ??= new Map();
    state.completed ??= new Map();
    state.rollIds ??= new WeakMap();
    state.sequence ??= 0;
    for (const batch of state.batches.values()) {
      batch.claims ??= new Map();
      batch.manualFinalization ??= false;
      batch.finalizationRequested ??= false;
      batch.finalizationArmed ??= true;
      batch.finalizationArmScheduled ??= false;
      batch.waiters ??= new Set();
      batch.context ??= {};
      batch.context.adjustments ??= [];
    }
    state.api = Object.freeze({
      version: 3,
      symbol: "dnd5e.roll-resolution-queue.v1",
      phases: PHASE_PRIORITIES,
      hooks: Object.freeze({ pending: PENDING_HOOK, finalized: FINALIZED_HOOK }),
      enqueue: options => SharedRollResolutionQueueService.enqueue(options),
      markPending: options => SharedRollResolutionQueueService.markPending(options),
      claim: options => SharedRollResolutionQueueService.claim(options),
      release: options => SharedRollResolutionQueueService.release(options),
      requestFinalization: options => SharedRollResolutionQueueService.requestFinalization(options),
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
      batch.claims ??= new Map();
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
      claims: new Map(),
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
      manualFinalization: false,
      finalizationRequested: false,
      finalizationArmed: true,
      finalizationArmScheduled: false,
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
    const changedTotal = currentTotal != null;
    if (changedTotal) batch.context.currentTotal = currentTotal;
    else if (batch.context.currentTotal == null && batch.context.originalTotal != null) {
      batch.context.currentTotal = batch.context.originalTotal;
    }

    const target = this.#finiteNumber(descriptor.target);
    if (target != null) batch.context.target = target;

    if (typeof descriptor.succeeded === "boolean") {
      batch.context.succeeded = descriptor.succeeded;
      batch.context.success = descriptor.succeeded;
    } else if (changedTotal && batch.context.target != null) {
      const inferred = this.#inferSucceeded(batch);
      if (typeof inferred === "boolean") {
        batch.context.succeeded = inferred;
        batch.context.success = inferred;
      }
    }
  }

  static #maybeFinalizeOrCleanup(state, batch) {
    if (!batch || batch.context.finalized) return batch ? this.#snapshot(batch) : null;
    const idle = !batch.running && !batch.scheduled && batch.entries.length === 0;
    const claimed = (batch.claims?.size ?? 0) > 0;
    const permitted = batch.pendingPublished
      && (!batch.manualFinalization || (batch.finalizationRequested && batch.finalizationArmed !== false));

    if (idle && !claimed && permitted) return this.#finalizeBatch(state, batch);

    // Claims may be opened before a provider determines that a roll is
    // relevant. If no pending state/provider was ever published, remove the
    // empty coordination shell after the final claim is released.
    if (idle && !claimed && !batch.pendingPublished && !batch.waiters?.size) {
      state.batches.delete(batch.key);
    }
    return null;
  }

  static #finalizeBatch(state, batch) {
    if (batch.context.finalized && batch.finalizedPublished) return this.#snapshot(batch);
    if (batch.running || batch.scheduled || batch.entries.length || batch.claims?.size) return this.#snapshot(batch);
    if (batch.manualFinalization && (!batch.finalizationRequested || batch.finalizationArmed === false)) {
      return this.#snapshot(batch);
    }

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
    state.batches.delete(batch.key);
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
      finalizationRequested: batch.finalizationRequested === true,
      pendingClaims: Number(batch.claims?.size ?? 0),
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

    // Deliberately public-safe. Never persist hidden target/DC, success/failure,
    // claim metadata, or provider details merely to coordinate later reactions.
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
      finalizationRequested: payload.finalizationRequested === true,
      pendingClaims: Number(payload.pendingClaims ?? 0),
      adjustments: (payload.adjustments ?? []).map(entry => ({ ...entry }))
    };
  }

  static #completed(state, key) {
    const completed = state.completed.get(key);
    if (completed && completed.expiresAt > Date.now()) return completed;
    if (completed) state.completed.delete(key);
    return null;
  }

  static #inferSucceeded(batch) {
    const currentTotal = this.#finiteNumber(batch?.context?.currentTotal);
    const target = this.#finiteNumber(batch?.context?.target);
    if (currentTotal == null || target == null) return null;
    if (batch?.context?.rollType === "attackRoll") {
      if (batch.roll?.isFumble === true) return false;
      if (batch.roll?.isCritical === true) return true;
    }
    return currentTotal >= target;
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
      const stored = roll?.options?.[ROLL_FLAG]?.rollKey;
      if (stored) {
        state.rollIds.set(roll, String(stored));
        return String(stored);
      }
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
              const changedTotal = Number.isFinite(Number(value.currentTotal));
              if (changedTotal) batch.context.currentTotal = Number(value.currentTotal);
              if (typeof value.succeeded === "boolean") {
                batch.context.succeeded = value.succeeded;
                batch.context.success = value.succeeded;
              } else if (typeof value.success === "boolean") {
                batch.context.succeeded = value.success;
                batch.context.success = value.success;
              } else if (changedTotal && batch.context.target != null) {
                const inferred = this.#inferSucceeded(batch);
                if (typeof inferred === "boolean") {
                  batch.context.succeeded = inferred;
                  batch.context.success = inferred;
                }
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
        // Providers that enqueue while an earlier provider's Promise is open
        // join the next ordered pass before terminal finalization.
        await Promise.resolve();
      }
    } finally {
      batch.running = false;
      this.#maybeFinalizeOrCleanup(state, batch);
    }
  }
}
