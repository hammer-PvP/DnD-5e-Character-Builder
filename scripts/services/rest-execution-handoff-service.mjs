const REST_RECOVERY_MODULE_ID = "rest-recovery";
const REST_RECOVERY_APP_CLASS = "rest-recovery-rest-workflow";
const DISCOVERY_FAILSAFE_MS = 5000;
const COMPLETION_FAILSAFE_MS = 30000;

/**
 * Executes the authoritative D&D5e rest while allowing known external rest
 * providers to take over the native dialog asynchronously.
 *
 * Character Keeper remains responsible for staging/applying its own choices.
 * This service only bridges the point where actor.initiateRest() may return
 * false because another module has claimed the rest and will complete it later.
 */
export class RestExecutionHandoffService {
  static #pending = new Map();

  static restRecoveryActive() {
    return game.modules.get(REST_RECOVERY_MODULE_ID)?.active === true;
  }

  static provider() {
    return this.restRecoveryActive() ? REST_RECOVERY_MODULE_ID : "dnd5e";
  }

  static async execute(actor, restType, restConfig = {}, { sessionId = null } = {}) {
    if (!actor || actor.type !== "character") throw new Error("A Player Character Actor is required to start a rest.");
    const type = restType === "short" ? "short" : "long";
    const provider = this.provider();
    const config = {
      ...this.#cloneConfig(restConfig),
      type,
      characterBuilderRestBypass: true
    };

    if (provider === "dnd5e") {
      const result = await actor.initiateRest(config);
      return {
        completed: Boolean(result),
        cancelled: !result,
        failed: false,
        provider,
        result: result || null,
        sessionId
      };
    }

    return this.#executeRestRecovery(actor, type, config, { sessionId });
  }

  static async #executeRestRecovery(actor, type, config, { sessionId }) {
    const key = `${actor.id}:${type}`;
    if (this.#pending.has(key)) {
      throw new Error(`A ${type === "short" ? "Short" : "Long"} Rest handoff is already pending for ${actor.name}.`);
    }

    let resolveWait;
    const wait = new Promise(resolve => { resolveWait = resolve; });
    const pending = {
      key,
      actorId: actor.id,
      type,
      sessionId,
      provider: REST_RECOVERY_MODULE_ID,
      app: null,
      appSeen: false,
      settled: false,
      renderHook: null,
      closeHook: null,
      completedHook: null,
      discoveryTimer: null,
      completionTimer: null,
      resolve: resolveWait
    };

    const settle = payload => this.#settle(pending, payload);

    pending.completedHook = Hooks.on("dnd5e.restCompleted", (completedActor, result) => {
      if (pending.settled || completedActor?.id !== actor.id) return;
      const resultType = result?.type;
      if (resultType && resultType !== type) return;
      settle({
        completed: true,
        cancelled: false,
        failed: false,
        provider: REST_RECOVERY_MODULE_ID,
        result: result ?? { type },
        sessionId
      });
    });

    pending.renderHook = Hooks.on("renderApplicationV2", app => {
      if (pending.settled || !this.#isRestRecoveryApp(app, actor)) return;
      pending.app = app;
      pending.appSeen = true;
      if (pending.discoveryTimer) {
        clearTimeout(pending.discoveryTimer);
        pending.discoveryTimer = null;
      }
    });

    pending.closeHook = Hooks.on("closeApplicationV2", app => {
      if (pending.settled || !this.#isRestRecoveryApp(app, actor)) return;
      pending.app ??= app;
      pending.appSeen = true;
      if (pending.discoveryTimer) {
        clearTimeout(pending.discoveryTimer);
        pending.discoveryTimer = null;
      }

      // Rest Recovery resolves its internal Promise and closes the window
      // before actor._rest() completes. A resolved window is therefore a
      // successful handoff which must keep waiting for dnd5e.restCompleted.
      if (app?.resolved === true) {
        if (!pending.completionTimer) {
          pending.completionTimer = setTimeout(() => settle({
            completed: false,
            cancelled: false,
            failed: true,
            provider: REST_RECOVERY_MODULE_ID,
            result: null,
            sessionId,
            reason: "Rest Recovery closed as completed, but D&D5e did not report restCompleted."
          }), COMPLETION_FAILSAFE_MS);
        }
        return;
      }

      settle({
        completed: false,
        cancelled: true,
        failed: false,
        provider: REST_RECOVERY_MODULE_ID,
        result: null,
        sessionId,
        reason: "Rest Recovery was closed before completing the rest."
      });
    });

    pending.discoveryTimer = setTimeout(() => {
      if (pending.settled || pending.appSeen) return;
      settle({
        completed: false,
        cancelled: true,
        failed: false,
        provider: REST_RECOVERY_MODULE_ID,
        result: null,
        sessionId,
        reason: "Rest Recovery did not open a rest workflow. The rest may have been blocked by another rule or module."
      });
    }, DISCOVERY_FAILSAFE_MS);

    this.#pending.set(key, pending);

    try {
      const immediate = await actor.initiateRest(config);
      if (immediate) {
        settle({
          completed: true,
          cancelled: false,
          failed: false,
          provider: pending.appSeen ? REST_RECOVERY_MODULE_ID : "dnd5e",
          result: immediate,
          sessionId
        });
      }
    } catch (error) {
      settle({
        completed: false,
        cancelled: false,
        failed: true,
        provider: REST_RECOVERY_MODULE_ID,
        result: null,
        sessionId,
        reason: error?.message || String(error)
      });
    }

    return wait;
  }

  static #isRestRecoveryApp(app, actor) {
    if (!app || app?.actor?.id !== actor.id) return false;
    const classes = app?.options?.classes ?? [];
    return classes.includes?.(REST_RECOVERY_APP_CLASS)
      || app?.classList?.contains?.(REST_RECOVERY_APP_CLASS)
      || app?.element?.classList?.contains?.(REST_RECOVERY_APP_CLASS);
  }

  static #settle(pending, payload) {
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.#cleanup(pending);
    this.#pending.delete(pending.key);
    pending.resolve(payload);
  }

  static #cleanup(pending) {
    if (pending.renderHook !== null) Hooks.off("renderApplicationV2", pending.renderHook);
    if (pending.closeHook !== null) Hooks.off("closeApplicationV2", pending.closeHook);
    if (pending.completedHook !== null) Hooks.off("dnd5e.restCompleted", pending.completedHook);
    if (pending.discoveryTimer) clearTimeout(pending.discoveryTimer);
    if (pending.completionTimer) clearTimeout(pending.completionTimer);
    pending.renderHook = null;
    pending.closeHook = null;
    pending.completedHook = null;
    pending.discoveryTimer = null;
    pending.completionTimer = null;
  }

  static #cloneConfig(config = {}) {
    const copy = {};
    for (const [key, value] of Object.entries(config ?? {})) {
      if (typeof value === "function") {
        copy[key] = value;
        continue;
      }
      try { copy[key] = foundry.utils.deepClone(value); }
      catch (_error) { copy[key] = value; }
    }
    return copy;
  }
}
