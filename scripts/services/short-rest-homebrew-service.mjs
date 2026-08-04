import { MODULE_ID, defaultSettings } from "../constants.mjs";
import { RestSessionService } from "./rest-session-service.mjs";
import { RuntimeTransactionService } from "./runtime-transaction-service.mjs";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REQUEST = "shortRestHomebrewRequest";
const SOCKET_RESPONSE = "shortRestHomebrewResponse";
const REQUEST_TIMEOUT_MS = 15000;
const OWNER_LEVEL = 3;
const APPLY_ACTION = "apply-half-long-rest-recovery";

/**
 * Optional GM-authoritative homebrew layer applied after one completed native
 * Short Rest. Native rest recovery remains entirely owned by D&D5e. This
 * service only restores half of each Long-Rest-only reserve, rounded down.
 */
export class ShortRestHomebrewService {
  static FLAG = "shortRestHomebrewRecovery";
  static #socketReady = false;
  static #pending = new Map();
  static #locks = new Map();

  static ready() {
    if (this.#socketReady || !globalThis.game?.socket?.on) return;
    this.#socketReady = true;
    game.socket.on(SOCKET_CHANNEL, payload => {
      if (payload?.type === SOCKET_RESPONSE) {
        this.#handleResponse(payload);
        return;
      }
      if (payload?.type !== SOCKET_REQUEST || !this.#isActiveGM()) return;
      void this.#handleRequest(payload);
    });
  }

  static settings() {
    return foundry.utils.mergeObject(
      defaultSettings(),
      game.settings.get(MODULE_ID, "settings") ?? {},
      { inplace: false }
    );
  }

  static isEnabled() {
    return Boolean(this.settings().halfLongRestRecoveryOnShortRest);
  }

  /**
   * Apply or audit the optional recovery for a completed native Short Rest.
   * The same rest session is idempotent even after a socket retry or reload.
   */
  static async apply(actor, { session = null } = {}) {
    if (!actor || actor.type !== "character") return { status: "unsupported" };
    const activeSession = session ?? RestSessionService.get(actor);
    if (!activeSession?.id || activeSession.restType !== "short" || !activeSession.nativeRestCompleted) {
      return { status: "not-ready" };
    }
    if (!this.isEnabled()) return { status: "disabled" };

    try {
      return await this.#dispatch({
        action: APPLY_ACTION,
        actorId: actor.id,
        sessionId: activeSession.id
      });
    } catch (error) {
      console.warn(`${MODULE_ID} | Native Short Rest completed, but optional homebrew recovery was unavailable.`, error);
      return {
        status: "unavailable",
        sessionId: activeSession.id,
        recoveries: [],
        error: String(error?.message ?? error)
      };
    }
  }

  static async #dispatch(payload) {
    this.ready();
    const activeGM = this.#activeGM();
    if (!activeGM) {
      throw new Error("A connected GM is required to apply the configured Short Rest homebrew recovery.");
    }
    if (game.user?.id === activeGM.id) {
      return this.#execute({
        ...payload,
        requesterId: game.user.id,
        requestId: foundry.utils.randomID?.(24) ?? crypto.randomUUID()
      });
    }

    const requestId = foundry.utils.randomID?.(24) ?? crypto.randomUUID();
    const request = {
      type: SOCKET_REQUEST,
      requestId,
      requesterId: game.user.id,
      ...payload
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("The active GM did not complete the configured Short Rest homebrew recovery in time."));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve, reject, timeout });
      game.socket.emit(SOCKET_CHANNEL, request);
    });
  }

  static async #handleRequest(payload) {
    const response = {
      type: SOCKET_RESPONSE,
      requestId: payload.requestId,
      requesterId: payload.requesterId,
      success: false
    };
    try {
      response.result = await this.#execute(payload);
      response.success = true;
    } catch (error) {
      console.warn(`${MODULE_ID} | Short Rest homebrew recovery request rejected.`, {
        actorId: payload?.actorId,
        requesterId: payload?.requesterId,
        error
      });
      response.error = String(error?.message ?? error);
    }
    game.socket.emit(SOCKET_CHANNEL, response);
  }

  static #handleResponse(payload) {
    if (payload.requesterId !== game.user?.id) return;
    const pending = this.#pending.get(payload.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(payload.requestId);
    if (payload.success) pending.resolve(payload.result ?? {});
    else pending.reject(new Error(payload.error || "The GM rejected the configured Short Rest homebrew recovery."));
  }

  static async #execute(request) {
    if (String(request?.action ?? "") !== APPLY_ACTION) {
      throw new Error("The requested Short Rest homebrew operation is not allowed.");
    }
    const requester = game.users.get(String(request.requesterId ?? ""));
    if (!requester) throw new Error("The requesting Foundry user could not be resolved.");
    const actor = game.actors.get(String(request.actorId ?? ""));
    if (!actor || actor.type !== "character") throw new Error("The requested Player Character Actor could not be resolved.");
    if (!requester.isGM && !this.#userOwnsActor(requester, actor)) {
      throw new Error("The requesting user does not own the Player Character Actor.");
    }

    const lockKey = actor.id;
    const existing = this.#locks.get(lockKey);
    if (existing) return existing;
    const operation = this.#executeLocked(actor, request).finally(() => {
      if (this.#locks.get(lockKey) === operation) this.#locks.delete(lockKey);
    });
    this.#locks.set(lockKey, operation);
    return operation;
  }

  static async #executeLocked(actor, request) {
    const settings = this.settings();
    if (!settings.halfLongRestRecoveryOnShortRest) return { status: "disabled" };

    const session = RestSessionService.get(actor);
    if (!session?.id || session.id !== String(request.sessionId ?? "")) {
      throw new Error("The Short Rest homebrew request does not match the Actor's active rest session.");
    }
    if (session.restType !== "short" || !session.nativeRestCompleted) {
      throw new Error("The native Short Rest must complete before homebrew recovery can be applied.");
    }

    const previous = foundry.utils.deepClone(actor.getFlag(MODULE_ID, this.FLAG) ?? {});
    if (previous.lastSessionId === session.id && previous.lastResult) {
      return foundry.utils.deepClone(previous.lastResult);
    }

    const now = this.#serverTime();
    const cooldownMinutes = this.#cooldownMinutes(settings.shortRestHomebrewCooldownMinutes);
    const nextEligibleAt = Number(previous.nextEligibleAt ?? 0);
    if (cooldownMinutes > 0 && nextEligibleAt > now) {
      const result = {
        status: "cooldown",
        sessionId: session.id,
        nextEligibleAt,
        remainingMs: Math.max(0, nextEligibleAt - now),
        recoveries: []
      };
      await actor.setFlag(MODULE_ID, this.FLAG, {
        ...previous,
        lastSessionId: session.id,
        lastProcessedAt: now,
        lastResult: result
      });
      await this.#postChat(actor, result);
      return result;
    }

    const plan = this.#buildRecoveryPlan(actor);
    if (!plan.recoveries.length) {
      const result = {
        status: "no-resources",
        sessionId: session.id,
        nextEligibleAt,
        remainingMs: 0,
        recoveries: []
      };
      await actor.setFlag(MODULE_ID, this.FLAG, {
        ...previous,
        lastSessionId: session.id,
        lastProcessedAt: now,
        lastResult: result
      });
      await this.#postChat(actor, result);
      return result;
    }

    const result = {
      status: "applied",
      sessionId: session.id,
      appliedAt: now,
      nextEligibleAt: cooldownMinutes > 0 ? now + cooldownMinutes * 60_000 : now,
      remainingMs: 0,
      recoveries: foundry.utils.deepClone(plan.recoveries)
    };

    await RuntimeTransactionService.run(actor, {
      session,
      label: "Homebrew Short Rest Recovery"
    }, async () => {
      if (Object.keys(plan.actorUpdates).length) {
        await actor.update(plan.actorUpdates, { characterBuilderShortRestHomebrew: true });
      }
      if (plan.itemUpdates.length) {
        await actor.updateEmbeddedDocuments("Item", plan.itemUpdates, {
          characterBuilderShortRestHomebrew: true
        });
      }
      await actor.setFlag(MODULE_ID, this.FLAG, {
        ...previous,
        lastSessionId: session.id,
        lastProcessedAt: now,
        lastAppliedAt: now,
        nextEligibleAt: result.nextEligibleAt,
        lastResult: result
      });
    });

    await this.#postChat(actor, result);
    return result;
  }

  static #buildRecoveryPlan(actor) {
    const actorUpdates = {};
    const itemUpdates = new Map();
    const recoveries = [];

    const longSlotTypes = new Set(CONFIG.DND5E?.restTypes?.long?.recoverSpellSlotTypes ?? []);
    const shortSlotTypes = new Set(CONFIG.DND5E?.restTypes?.short?.recoverSpellSlotTypes ?? []);
    for (const [key, slot] of Object.entries(actor.system?.spells ?? {})) {
      const type = String(slot?.type ?? key);
      if (!longSlotTypes.has(type) || shortSlotTypes.has(type)) continue;
      const maximum = this.#wholeNumber(slot?.max);
      const current = this.#wholeNumber(slot?.value);
      const amount = this.calculateRecoveryAmount(maximum, Math.max(0, maximum - current));
      if (!amount) continue;
      actorUpdates[`system.spells.${key}.value`] = current + amount;
      const level = Number(key.replace(/^spell/, ""));
      const levelLabel = CONFIG.DND5E?.spellLevels?.[level];
      recoveries.push({
        kind: "spell-slot",
        label: levelLabel ? `Spell Slot — ${game.i18n.localize(levelLabel)}` : `Spell Slot — Level ${level || key}`,
        amount
      });
    }

    for (const [key, resource] of Object.entries(actor.system?.resources ?? {})) {
      if (!resource?.lr || resource?.sr) continue;
      const maximum = this.#wholeNumber(resource.max);
      const current = this.#wholeNumber(resource.value);
      const amount = this.calculateRecoveryAmount(maximum, Math.max(0, maximum - current));
      if (!amount) continue;
      actorUpdates[`system.resources.${key}.value`] = current + amount;
      recoveries.push({
        kind: "actor-resource",
        label: String(resource.label || key),
        amount
      });
    }

    for (const item of actor.items ?? []) {
      const itemUpdate = { _id: item.id };
      let changed = false;
      const uses = item.system?.uses;
      if (this.isLongRestOnlyRecovery(uses?.recovery)) {
        const maximum = this.#wholeNumber(uses?.max);
        const spent = this.#wholeNumber(uses?.spent);
        const amount = this.calculateRecoveryAmount(maximum, spent);
        if (amount) {
          itemUpdate["system.uses.spent"] = Math.max(0, spent - amount);
          recoveries.push({ kind: "item-use", label: String(item.name), amount });
          changed = true;
        }
      }

      for (const activity of this.#values(item.system?.activities)) {
        const activityUses = activity?.uses;
        if (!this.isLongRestOnlyRecovery(activityUses?.recovery)) continue;
        const maximum = this.#wholeNumber(activityUses?.max);
        const spent = this.#wholeNumber(activityUses?.spent);
        const amount = this.calculateRecoveryAmount(maximum, spent);
        const activityId = String(activity?.id ?? activity?._id ?? "");
        if (!activityId || !amount) continue;
        itemUpdate[`system.activities.${activityId}.uses.spent`] = Math.max(0, spent - amount);
        recoveries.push({
          kind: "activity-use",
          label: `${item.name} — ${activity.name || "Activity"}`,
          amount
        });
        changed = true;
      }
      if (changed) itemUpdates.set(item.id, itemUpdate);
    }

    return { actorUpdates, itemUpdates: [...itemUpdates.values()], recoveries };
  }

  static previewRecovery(actor) {
    return this.#buildRecoveryPlan(actor);
  }

  static isLongRestOnlyRecovery(recovery) {
    const periods = new Set(this.#values(recovery).map(profile => String(profile?.period ?? "")));
    const hasLong = periods.has("lr") || periods.has("long");
    const hasShort = periods.has("sr") || periods.has("short");
    return hasLong && !hasShort;
  }

  static calculateRecoveryAmount(maximum, missingOrSpent) {
    const normalizedMaximum = this.#wholeNumber(maximum);
    if (normalizedMaximum <= 0) return 0;
    const allowance = Math.floor(normalizedMaximum / 2);
    if (allowance <= 0) return 0;
    return Math.min(allowance, Math.max(0, this.#wholeNumber(missingOrSpent)));
  }

  static #wholeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
  }

  static #cooldownMinutes(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 5;
    return Math.min(10080, Math.max(0, Math.trunc(number)));
  }

  static #values(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return [...value];
    if (value instanceof Map || value instanceof Set) return Array.from(value.values());
    if (typeof value.values === "function") {
      try { return Array.from(value.values()); } catch (_error) { /* fall through */ }
    }
    if (typeof value === "object") return Object.values(value);
    return [];
  }

  static async #postChat(actor, result) {
    const rows = (result.recoveries ?? []).map(entry => `
      <li><strong>${this.#escape(entry.label)}</strong>: +${Number(entry.amount) || 0}</li>
    `).join("");
    let body;
    if (result.status === "applied") {
      body = `<p>Short Rest completed successfully. The configured homebrew recovery restored:</p><ul>${rows}</ul>`;
    } else if (result.status === "cooldown") {
      body = `<p>Short Rest completed successfully. Homebrew Short Rest Recovery is still on cooldown.</p>
        <p><strong>Available again in ${this.formatDuration(result.remainingMs)}.</strong></p>`;
    } else {
      body = "<p>Short Rest completed successfully. No additional Long-Rest-only resource was eligible for homebrew recovery.</p>";
    }
    const content = `
      <section class="dnd5e chat-card item-card" data-actor-id="${this.#escape(actor.id)}">
        <header class="card-header flexrow">
          <img src="${this.#escape(actor.img)}" alt="${this.#escape(actor.name)}">
          <h3>Homebrew Short Rest Recovery</h3>
        </header>
        <div class="card-content">${body}</div>
      </section>`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content,
      flags: {
        [MODULE_ID]: {
          homebrewShortRestRecovery: {
            actorId: actor.id,
            sessionId: result.sessionId,
            status: result.status,
            nextEligibleAt: result.nextEligibleAt ?? null,
            recoveries: foundry.utils.deepClone(result.recoveries ?? [])
          }
        }
      }
    });
  }

  static formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds ?? 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes && seconds) return `${minutes}m ${seconds}s`;
    if (minutes) return `${minutes}m`;
    return `${seconds}s`;
  }

  static #escape(value) {
    const text = String(value ?? "");
    if (foundry.utils?.escapeHTML) return foundry.utils.escapeHTML(text);
    return text.replace(/[&<>'"]/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[character]);
  }

  static #userOwnsActor(user, actor) {
    if (typeof actor.testUserPermission === "function") {
      try { return actor.testUserPermission(user, "OWNER"); } catch (_error) { /* fall through */ }
    }
    const explicit = Number(actor.ownership?.[user.id] ?? NaN);
    const fallback = Number(actor.ownership?.default ?? 0);
    return (Number.isFinite(explicit) ? explicit : fallback) >= OWNER_LEVEL;
  }

  static #serverTime() {
    const serverTime = Number(game.time?.serverTime);
    return Number.isFinite(serverTime) ? serverTime : Date.now();
  }

  static #activeGM() {
    const preferred = game.users?.activeGM;
    if (preferred?.active && preferred.isGM) return preferred;
    return game.users?.contents?.filter(user => user.active && user.isGM)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
  }

  static #isActiveGM() {
    return Boolean(game.user?.isGM && this.#activeGM()?.id === game.user.id);
  }
}
