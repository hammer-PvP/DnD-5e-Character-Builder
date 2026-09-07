import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";
import { SharedRollResolutionQueueService } from "./shared-roll-resolution-queue-service.mjs";
import { ConcentrationDecisionService } from "./concentration-decision-service.mjs";

const RULE_ID = "concentration-effect-lifecycle";
const FLAG_KEY = "contextualEffect";
const FINALIZED_HOOK = "dnd5e-character-builder.rollResolutionFinalized";
const CONCENTRATION_GATE_PROVIDER = `${MODULE_ID}:${RULE_ID}:resolution-gate`;

/**
 * Generic lifecycle bridge for runtime effects.
 *
 * Concentration itself remains owned by D&D5e. The service only completes
 * missing integration links:
 *   1. bind declared concentration-dependent effects to the native
 *      `flags.dnd5e.dependentOn` relationship;
 *   2. keep concentration request rolls attached to the concentrating Actor;
 *   3. open a shared-queue resolution gate before a Concentration roll is
 *      evaluated and, after every claimed Character/Item provider releases
 *      that roll, send a final failure to an explicit GM Chat decision.
 *
 * Only the GM decision calls D&D5e's native endConcentration(); D&D5e then
 * deletes bound dependents through its own registry.
 */
export class EffectLifecycleService {
  static #initialized = false;
  static #handledRolls = new WeakSet();
  static #pending = new Map();
  static #gates = new Map();
  static #reroutes = new Set();
  static #audit = new Map();
  static #worldTimeReconciling = false;
  static #worldTimeQueued = false;

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    ConcentrationDecisionService.initialize();

    Hooks.on("preCreateActiveEffect", (effect, data) => {
      try {
        this.#normalizePendingEffect(effect, data);
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not normalize contextual effect lifecycle.`, error);
      }
    });

    // Foundry's World Time is the canonical clock for finite real-time effect
    // durations. Only the active GM mutates documents; every client may observe
    // the hook, but no duplicate expiration work is performed.
    Hooks.on("updateWorldTime", () => {
      this.#queueWorldTimeReconciliation("world-time-update");
    });

    // For newly created Actor effects, preserve core/native duration metadata.
    // If Foundry did not provide an absolute expiry/start anchor, stamp only a
    // Character Builder deadline. Existing pre-x9 effects are never guessed.
    Hooks.on("createActiveEffect", effect => {
      void this.#anchorNewWorldTimeEffect(effect).catch(error => {
        console.warn(`${MODULE_ID} | Could not anchor new finite effect to World Time.`, error);
      });
    });

    // Native concentration request cards can be clicked while a different
    // Actor is targeted/selected. Correct only the clear mismatch case.
    Hooks.on("dnd5e.preRollConcentration", (config, dialog, message) => {
      try {
        return this.#redirectMismatchedConcentrationRequest(config, dialog, message);
      } catch (error) {
        console.warn(`${MODULE_ID} | Concentration request affinity check failed.`, error);
      }
    });

    // D&D5e exposes this after the Concentration D20Roll exists but before it
    // is evaluated. Open a deferred-finalization gate here, before any
    // post-roll provider can begin asynchronous discovery.
    Hooks.on("dnd5e.postConcentrationRollConfiguration", (rolls, config) => {
      try {
        this.#openConcentrationGates(rolls, config);
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not open Concentration resolution gate.`, error);
      }
    });

    // rollConcentration delegates to rollSavingThrow first. Capture the
    // evaluated total on this earlier hook so Character providers registered
    // after this service see an already-pending deferred batch.
    Hooks.on("dnd5e.rollSavingThrow", (rolls, data) => {
      try {
        this.#captureConcentrationSavingThrow(rolls, data);
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not capture Concentration saving throw.`, error);
      }
    });

    Hooks.on("dnd5e.rollConcentration", (rolls, data) => {
      try {
        this.#requestConcentrationFinalization(rolls, data);
      } catch (error) {
        console.warn(`${MODULE_ID} | Concentration finalization request failed.`, error);
      }
    });

    Hooks.on(FINALIZED_HOOK, (payload, roll) => {
      void this.#onRollResolutionFinalized(payload, roll).catch(error => {
        console.warn(`${MODULE_ID} | Final concentration lifecycle action failed.`, error);
      });
    });
  }

  static async ready() {
    // A reload or GM handoff must catch effects whose native/core deadline was
    // already crossed while this client was offline. No missing legacy anchor
    // is invented here; only reliable deadlines are honored.
    if (!this.#isActiveGM()) return;
    await this.reconcileWorldTime({ reason: "ready", anchorMissing: false });
  }

  static async reconcileWorldTime({ reason = "manual", anchorMissing = false } = {}) {
    if (!this.#isActiveGM() || this.#worldTimeReconciling) return { changed: false, expired: [] };
    this.#worldTimeReconciling = true;
    try {
      const now = Number(game.time?.worldTime ?? 0);
      if (!Number.isFinite(now)) return { changed: false, expired: [] };

      const actors = this.#worldTimeActors();
      const expiredRows = [];
      for (const actor of actors) {
        const effects = Array.from(actor?.effects ?? []);
        if (!effects.length) continue;

        const expired = effects.filter(effect => {
          const deadline = this.#worldTimeDeadline(effect);
          if (Number.isFinite(deadline)) return now >= deadline;
          if (anchorMissing) void this.#anchorNewWorldTimeEffect(effect);
          return false;
        });
        if (!expired.length) continue;

        const concentrationExpired = expired.some(effect => this.#isConcentration(effect));
        if (concentrationExpired && typeof actor.endConcentration === "function") {
          await actor.endConcentration();
          expiredRows.push({ actorUuid: actor.uuid ?? null, kind: "concentration", reason });
        }

        const remainingIds = expired
          .filter(effect => !this.#isConcentration(effect) && actor.effects?.get?.(effect.id))
          .map(effect => effect.id)
          .filter(Boolean);
        if (remainingIds.length) {
          const names = remainingIds.map(id => actor.effects?.get?.(id)?.name ?? "Active Effect");
          await actor.deleteEmbeddedDocuments("ActiveEffect", remainingIds, {
            characterBuilderWorldTimeLifecycle: true,
            characterBuilderWorldTimeReason: reason,
            worldTime: now
          });
          names.forEach(name => expiredRows.push({ actorUuid: actor.uuid ?? null, kind: "effect", name, reason }));
        }
      }
      return { changed: expiredRows.length > 0, expired: expiredRows };
    } finally {
      this.#worldTimeReconciling = false;
    }
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static diagnostics(actor) {
    const key = String(actor?.id ?? actor ?? "");
    return (this.#audit.get(key) ?? []).map(row => ({ ...row }));
  }

  static bindEffectData(effectData, {
    mode = "duration",
    anchorUuid = null,
    controllerUuid = null,
    sourceUuid = null,
    termination = null,
    restType = null
  } = {}) {
    const data = foundry.utils.deepClone(effectData ?? {});
    const lifecycle = {
      mode: String(mode ?? "duration"),
      anchorUuid: anchorUuid ? String(anchorUuid) : null,
      controllerUuid: controllerUuid ? String(controllerUuid) : null,
      sourceUuid: sourceUuid ? String(sourceUuid) : null,
      termination: String(termination ?? (mode === "concentration" ? "native-dependent" : "native")),
      restType: restType ? String(restType) : null
    };
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.${FLAG_KEY}.lifecycle`, lifecycle);
    if (lifecycle.mode === "concentration" && lifecycle.anchorUuid) {
      foundry.utils.setProperty(data, "flags.dnd5e.dependentOn", lifecycle.anchorUuid);
    }
    return data;
  }

  static async createManagedEffect(actor, effectData, lifecycle = {}) {
    if (!actor) throw new TypeError("A target Actor is required for a managed effect.");
    const data = this.bindEffectData(effectData, lifecycle);
    const created = globalThis.ActiveEffect?.implementation?.create
      ? await ActiveEffect.implementation.create(data, { parent: actor })
      : (await actor.createEmbeddedDocuments("ActiveEffect", [data]))?.[0] ?? null;
    return created;
  }

  static concentrationEffectFromUsage(activity, results) {
    const concentrating = CONFIG.DND5E?.specialStatusEffects?.CONCENTRATING
      ?? CONFIG.specialStatusEffects?.CONCENTRATING
      ?? "concentrating";
    const effects = Array.isArray(results?.effects) ? results.effects : [];
    const direct = effects.find(effect => effect?.statuses?.has?.(concentrating));
    if (direct) return direct;

    const actor = activity?.actor;
    const id = results?.message?.system?.concentration
      ?? results?.message?.getFlag?.("dnd5e", "concentration")
      ?? null;
    return id ? actor?.effects?.get?.(id) ?? null : null;
  }

  static #queueWorldTimeReconciliation(reason) {
    if (!this.#isActiveGM() || this.#worldTimeQueued) return;
    this.#worldTimeQueued = true;
    queueMicrotask(() => {
      this.#worldTimeQueued = false;
      void this.reconcileWorldTime({ reason, anchorMissing: false }).catch(error => {
        console.warn(`${MODULE_ID} | World Time effect reconciliation failed.`, error);
      });
    });
  }

  static async #anchorNewWorldTimeEffect(effect) {
    if (!this.#isActiveGM() || effect?.documentName !== "ActiveEffect" || effect?.parent?.documentName !== "Actor") return;
    if (Number.isFinite(this.#worldTimeDeadline(effect))) return;
    const seconds = this.#finiteWorldSeconds(effect);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const now = Number(game.time?.worldTime ?? 0);
    if (!Number.isFinite(now)) return;
    await effect.setFlag(MODULE_ID, "worldTimeLifecycle", {
      version: 1,
      deadline: now + seconds,
      durationSeconds: seconds,
      anchoredAt: now
    });
  }

  static #worldTimeDeadline(effect) {
    if (!effect || effect.parent?.documentName !== "Actor") return null;
    const duration = effect.duration ?? effect._source?.duration ?? {};

    // Foundry 14 can expose an absolute expiry. Prefer it when numeric.
    const expiry = Number(duration?.expiry);
    if (Number.isFinite(expiry) && expiry > 0) return expiry;

    // Legacy/core duration representation.
    const startTime = Number(duration?.startTime ?? effect._source?.duration?.startTime);
    const seconds = Number(duration?.seconds ?? effect._source?.duration?.seconds);
    if (Number.isFinite(startTime) && Number.isFinite(seconds) && seconds > 0) return startTime + seconds;

    // Some Foundry 14 Active Effects expose value+units instead of seconds.
    const scalar = this.#finiteWorldSeconds(effect);
    if (Number.isFinite(startTime) && Number.isFinite(scalar) && scalar > 0) return startTime + scalar;

    const managed = effect.getFlag?.(MODULE_ID, "worldTimeLifecycle")
      ?? effect.flags?.[MODULE_ID]?.worldTimeLifecycle
      ?? null;
    const managedDeadline = Number(managed?.deadline);
    return Number.isFinite(managedDeadline) && managedDeadline > 0 ? managedDeadline : null;
  }

  static #finiteWorldSeconds(effect) {
    const duration = effect?.duration ?? effect?._source?.duration ?? {};
    const rounds = Number(duration?.rounds ?? effect?._source?.duration?.rounds);
    const turns = Number(duration?.turns ?? effect?._source?.duration?.turns);
    if ((Number.isFinite(rounds) && rounds > 0) || (Number.isFinite(turns) && turns > 0)) return null;

    const seconds = Number(duration?.seconds ?? effect?._source?.duration?.seconds);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;

    const value = Number(duration?.value ?? effect?._source?.duration?.value);
    if (!Number.isFinite(value) || value <= 0) return null;
    const units = String(duration?.units ?? effect?._source?.duration?.units ?? "").trim().toLowerCase();
    const multipliers = {
      second: 1, seconds: 1, sec: 1, secs: 1,
      minute: 60, minutes: 60, min: 60, mins: 60,
      hour: 3600, hours: 3600, hr: 3600, hrs: 3600,
      day: 86400, days: 86400,
      month: 2592000, months: 2592000,
      year: 31536000, years: 31536000
    };
    const multiplier = multipliers[units];
    return Number.isFinite(multiplier) ? value * multiplier : null;
  }

  static #worldTimeActors() {
    const actors = new Map();
    const add = actor => {
      if (!actor?.effects || !actor?.uuid) return;
      actors.set(String(actor.uuid), actor);
    };
    for (const actor of game.actors ?? []) add(actor);
    for (const scene of game.scenes ?? []) {
      for (const token of scene.tokens ?? []) add(token.actor);
    }
    return [...actors.values()];
  }

  static #activeGM() {
    const preferred = game.users?.activeGM;
    if (preferred?.active && preferred.isGM) return preferred;
    return game.users?.contents?.filter(user => user.active && user.isGM)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
  }

  static #isActiveGM() {
    return Boolean(game.user?.isGM && this.#activeGM()?.id === game.user.id);
  }

  static #normalizePendingEffect(effect, data) {
    if (!data || typeof data !== "object") return;
    const declaration = foundry.utils.getProperty(data, `flags.${MODULE_ID}.${FLAG_KEY}`)
      ?? effect?.getFlag?.(MODULE_ID, FLAG_KEY)
      ?? null;
    const lifecycle = declaration?.lifecycle ?? null;

    const origin = data.origin ?? effect?.origin ?? null;
    let nativeConcentrationOrigin = false;
    if (origin && !foundry.utils.getProperty(data, "flags.dnd5e.dependentOn")) {
      const originDoc = globalThis.fromUuidSync?.(origin, { strict: false });
      const concentrating = CONFIG.DND5E?.specialStatusEffects?.CONCENTRATING
        ?? CONFIG.specialStatusEffects?.CONCENTRATING
        ?? "concentrating";
      nativeConcentrationOrigin = Boolean(originDoc?.documentName === "ActiveEffect"
        && originDoc.statuses?.has?.(concentrating));
      if (nativeConcentrationOrigin) foundry.utils.setProperty(data, "flags.dnd5e.dependentOn", originDoc.uuid);
    }

    if (lifecycle?.mode === "concentration" && lifecycle.anchorUuid) {
      foundry.utils.setProperty(data, "flags.dnd5e.dependentOn", String(lifecycle.anchorUuid));
    } else if (nativeConcentrationOrigin) {
      foundry.utils.setProperty(data, `flags.${MODULE_ID}.${FLAG_KEY}.lifecycle`, {
        mode: "concentration",
        anchorUuid: origin,
        controllerUuid: null,
        sourceUuid: null,
        termination: "native-dependent"
      });
    }
  }

  static #redirectMismatchedConcentrationRequest(config, dialog, message) {
    if (!this.enabled() || config?.dnd5eCharacterBuilderConcentrationRerouted) return;
    const current = config?.subject ?? null;
    if (!current || this.#hasConcentration(current)) return;

    const messageId = config?.event?.target?.closest?.("[data-message-id]")?.dataset?.messageId
      ?? config?.event?.currentTarget?.closest?.("[data-message-id]")?.dataset?.messageId
      ?? null;
    if (!messageId) return;
    const request = game.messages?.get?.(messageId);
    const requested = request?.getAssociatedActor?.() ?? this.#actorFromSpeaker(request?.speaker);
    if (!requested || requested === current || !this.#hasConcentration(requested) || !requested.isOwner) return;

    const key = `${messageId}|${requested.uuid ?? requested.id}`;
    if (this.#reroutes.has(key)) return false;
    this.#reroutes.add(key);

    const clicked = config?.event?.target?.closest?.("[data-type='concentration'], [data-action='concentration'], [data-action='rollCheck']")
      ?? config?.event?.currentTarget
      ?? null;
    const explicitAbility = clicked?.dataset?.ability;
    const target = Number.isFinite(Number(config?.target)) ? Number(config.target) : 10;

    queueMicrotask(() => {
      void requested.rollConcentration({
        target,
        ...(explicitAbility ? { ability: explicitAbility } : {}),
        dnd5eCharacterBuilderConcentrationRerouted: true
      }).catch(error => {
        console.warn(`${MODULE_ID} | Could not reroute Concentration save to ${requested.name}.`, error);
      }).finally(() => this.#reroutes.delete(key));
    });

    this.#recordAudit(requested, {
      action: "Redirected concentration request to its concentrating Actor",
      attemptedActorUuid: current.uuid ?? null,
      requestMessageId: messageId,
      target
    });
    return false;
  }

  static #openConcentrationGates(rolls, config) {
    if (!this.enabled()) return;
    const actor = config?.subject ?? null;
    if (!actor?.endConcentration || !this.#hasConcentration(actor)) return;
    const actorUuid = actor.uuid ?? `Actor.${actor.id}`;
    const configuredTarget = Number.isFinite(Number(config?.target)) ? Number(config.target) : null;

    for (const roll of Array.isArray(rolls) ? rolls : [rolls]) {
      if (!roll) continue;
      const claim = SharedRollResolutionQueueService.claim({
        roll,
        providerId: CONCENTRATION_GATE_PROVIDER,
        reason: "concentration-lifecycle-finalization",
        actorUuid,
        rollType: "concentration",
        target: configuredTarget,
        deferFinalization: true
      });
      if (!claim?.active || !claim.rollKey) continue;
      this.#gates.set(claim.rollKey, {
        claim,
        actor,
        actorUuid,
        target: configuredTarget,
        createdAt: Date.now()
      });
    }
  }

  static #captureConcentrationSavingThrow(rolls, data) {
    if (!this.enabled()) return;
    const fallbackActor = data?.subject?.actor ?? data?.subject ?? null;

    for (const roll of Array.isArray(rolls) ? rolls : [rolls]) {
      if (!roll || this.#handledRolls.has(roll) || !Number.isFinite(Number(roll.total))) continue;
      const preResolution = SharedRollResolutionQueueService.getResolution({ roll });
      const gate = preResolution?.rollKey ? this.#gates.get(preResolution.rollKey) : null;
      if (!gate) continue; // Ordinary Saving Throw, not a Concentration roll.

      const actor = gate.actor ?? fallbackActor;
      if (!actor?.endConcentration || !this.#hasConcentration(actor)) continue;
      this.#handledRolls.add(roll);

      const originalTotal = Number(roll.total);
      const target = Number.isFinite(Number(roll.options?.target))
        ? Number(roll.options.target)
        : gate.target;
      const initialSuccess = target == null ? null : originalTotal >= target;
      const pending = SharedRollResolutionQueueService.markPending({
        roll,
        rollKey: gate.claim.rollKey,
        actorUuid: gate.actorUuid,
        rollType: "concentration",
        originalTotal,
        currentTotal: originalTotal,
        target,
        succeeded: initialSuccess,
        deferFinalization: true
      });

      this.#pending.set(pending.rollKey, {
        actor,
        actorUuid: gate.actorUuid,
        roll,
        originalTotal,
        target,
        createdAt: Date.now()
      });
    }
  }

  static #requestConcentrationFinalization(rolls, data) {
    if (!this.enabled()) return;
    // Defensive fallback if a system/module changed hook ordering.
    this.#captureConcentrationSavingThrow(rolls, data);

    for (const roll of Array.isArray(rolls) ? rolls : [rolls]) {
      if (!roll) continue;
      const resolution = SharedRollResolutionQueueService.getResolution({ roll });
      const rollKey = resolution?.rollKey;
      if (!rollKey) continue;
      const pending = this.#pending.get(rollKey);
      const gate = this.#gates.get(rollKey);
      if (!pending && !gate) continue;

      const originalTotal = Number.isFinite(Number(pending?.originalTotal))
        ? Number(pending.originalTotal)
        : Number(roll.total ?? 0);
      const target = Number.isFinite(Number(roll.options?.target))
        ? Number(roll.options.target)
        : (pending?.target ?? gate?.target ?? null);
      const currentTotal = Number.isFinite(Number(resolution?.currentTotal))
        ? Number(resolution.currentTotal)
        : originalTotal;

      SharedRollResolutionQueueService.requestFinalization({
        roll,
        rollKey,
        actorUuid: pending?.actorUuid ?? gate?.actorUuid ?? null,
        rollType: "concentration",
        originalTotal,
        currentTotal,
        target,
        succeeded: target == null ? null : currentTotal >= target
      });

      // Release only Character Builder's lifecycle gate. Character/Item
      // discovery claims remain authoritative and keep the roll open until
      // those runtimes explicitly release them.
      gate?.claim?.release?.();
      this.#gates.delete(rollKey);
    }
  }

  static async #onRollResolutionFinalized(payload, roll) {
    if (!this.enabled() || !payload?.rollKey) return;
    const pending = this.#pending.get(payload.rollKey);
    if (!pending) return;
    this.#pending.delete(payload.rollKey);
    this.#gates.delete(payload.rollKey);

    const actor = pending.actor;
    if (!actor?.endConcentration || !this.#hasConcentration(actor)) return;

    const currentTotal = Number.isFinite(Number(payload.currentTotal))
      ? Number(payload.currentTotal)
      : pending.originalTotal;
    const target = Number.isFinite(Number(payload.target))
      ? Number(payload.target)
      : pending.target;
    const failed = target != null ? currentTotal < target : payload.succeeded === false;

    if (!failed) {
      this.#recordAudit(actor, {
        action: "Concentration maintained after final shared-queue resolution",
        originalTotal: pending.originalTotal,
        finalTotal: currentTotal,
        target,
        rollKey: payload.rollKey
      });
      return;
    }

    const maintained = this.#concentrationEffects(actor).length;
    if (!maintained) return;
    const message = await ConcentrationDecisionService.request({
      actor,
      rollKey: payload.rollKey,
      originalTotal: pending.originalTotal,
      finalTotal: currentTotal,
      target,
      rollId: roll?.id ?? null
    });
    this.#recordAudit(actor, {
      action: "Deferred failed Concentration save to explicit GM Chat decision",
      originalTotal: pending.originalTotal,
      finalTotal: currentTotal,
      target,
      maintainedCount: maintained,
      decisionMessageId: message?.id ?? null,
      rollKey: payload.rollKey,
      rollId: roll?.id ?? null
    });
  }

  static #isConcentration(effect) {
    const concentrating = globalThis.CONFIG?.DND5E?.specialStatusEffects?.CONCENTRATING
      ?? globalThis.CONFIG?.specialStatusEffects?.CONCENTRATING
      ?? "concentrating";
    return Boolean(effect?.statuses?.has?.(concentrating)
      || Array.from(effect?.statuses ?? []).includes(concentrating));
  }

  static #hasConcentration(actor) {
    return this.#concentrationEffects(actor).length > 0;
  }

  static #concentrationEffects(actor) {
    const effects = actor?.concentration?.effects;
    if (effects) {
      if (Array.isArray(effects) && effects.length) return effects;
      if (Array.isArray(effects.contents) && effects.contents.length) return effects.contents;
      try {
        const rows = [...effects];
        if (rows.length) return rows;
      } catch (_error) {}
    }
    return Array.from(actor?.effects ?? []).filter(effect => this.#isConcentration(effect));
  }

  static #actorFromSpeaker(speaker) {
    if (!speaker?.actor) return null;
    return game.actors?.get?.(speaker.actor) ?? null;
  }

  static #recordAudit(actor, entry) {
    const key = String(actor?.id ?? actor ?? "");
    if (!key) return;
    const rows = this.#audit.get(key) ?? [];
    rows.push({ ruleId: RULE_ID, at: Date.now(), ...entry });
    this.#audit.set(key, rows.slice(-50));
  }
}

export const EFFECT_LIFECYCLE_RULE_ID = RULE_ID;
