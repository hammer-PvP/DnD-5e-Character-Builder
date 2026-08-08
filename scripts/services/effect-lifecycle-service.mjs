import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";
import { SharedRollResolutionQueueService } from "./shared-roll-resolution-queue-service.mjs";

const RULE_ID = "concentration-effect-lifecycle";
const FLAG_KEY = "contextualEffect";
const BARRIER_PRIORITY = 10000;
const PROVIDER_DISCOVERY_GRACE_MS = 100;
const FINALIZED_HOOK = "dnd5e-character-builder.rollResolutionFinalized";

/**
 * Generic lifecycle bridge for runtime effects.
 *
 * Concentration itself remains owned by D&D5e. The service only completes
 * missing integration links:
 *   1. bind declared concentration-dependent effects to the native
 *      `flags.dnd5e.dependentOn` relationship;
 *   2. keep concentration request rolls attached to the concentrating Actor;
 *   3. end native concentration only after the shared post-roll queue has
 *      reached its final total.
 *
 * D&D5e then deletes concentration dependents through its own registry.
 */
export class EffectLifecycleService {
  static #initialized = false;
  static #handledRolls = new WeakSet();
  static #pending = new Map();
  static #reroutes = new Set();
  static #audit = new Map();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    Hooks.on("preCreateActiveEffect", (effect, data) => {
      try {
        this.#normalizePendingEffect(effect, data);
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not normalize contextual effect lifecycle.`, error);
      }
    });

    // Native concentration request cards can be clicked while a different
    // Actor is targeted/selected. D&D5e then rolls that Actor instead of the
    // Actor that posted the concentration challenge. Correct only the clear
    // mismatch case: request owner is concentrating, current subject is not.
    Hooks.on("dnd5e.preRollConcentration", (config, dialog, message) => {
      try {
        return this.#redirectMismatchedConcentrationRequest(config, dialog, message);
      } catch (error) {
        console.warn(`${MODULE_ID} | Concentration request affinity check failed.`, error);
      }
    });

    Hooks.on("dnd5e.rollConcentration", (rolls, data) => {
      void this.#queueConcentrationResolution(rolls, data).catch(error => {
        console.warn(`${MODULE_ID} | Concentration lifecycle resolution failed.`, error);
      });
    });

    Hooks.on(FINALIZED_HOOK, (payload, roll) => {
      void this.#onRollResolutionFinalized(payload, roll).catch(error => {
        console.warn(`${MODULE_ID} | Final concentration lifecycle action failed.`, error);
      });
    });
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static diagnostics(actor) {
    const key = String(actor?.id ?? actor ?? "");
    return (this.#audit.get(key) ?? []).map(row => ({ ...row }));
  }

  /**
   * Attach lifecycle provenance to effect data. Concentration mode uses the
   * D&D5e-native dependency registry, so ending concentration remains a native
   * lifecycle operation rather than Character Builder deleting arbitrary AEs.
   */
  static bindEffectData(effectData, {
    mode = "duration",
    anchorUuid = null,
    controllerUuid = null,
    sourceUuid = null,
    termination = null
  } = {}) {
    const data = foundry.utils.deepClone(effectData ?? {});
    const lifecycle = {
      mode: String(mode ?? "duration"),
      anchorUuid: anchorUuid ? String(anchorUuid) : null,
      controllerUuid: controllerUuid ? String(controllerUuid) : null,
      sourceUuid: sourceUuid ? String(sourceUuid) : null,
      termination: String(termination ?? (mode === "concentration" ? "native-dependent" : "native"))
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

  static #normalizePendingEffect(effect, data) {
    if (!data || typeof data !== "object") return;
    const declaration = foundry.utils.getProperty(data, `flags.${MODULE_ID}.${FLAG_KEY}`)
      ?? effect?.getFlag?.(MODULE_ID, FLAG_KEY)
      ?? null;
    const lifecycle = declaration?.lifecycle ?? null;

    // D&D5e's native Apply Effects tray uses a concentration ActiveEffect as
    // the origin and writes dependentOn itself. This safety net also covers
    // compatible external materializers that provide only the origin.
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

  static async #queueConcentrationResolution(rolls, data) {
    if (!this.enabled()) return;
    const actor = data?.subject?.actor ?? data?.subject ?? null;
    if (!actor?.endConcentration || !this.#hasConcentration(actor)) return;

    for (const roll of Array.isArray(rolls) ? rolls : [rolls]) {
      if (!roll || this.#handledRolls.has(roll) || !Number.isFinite(Number(roll.total))) continue;
      this.#handledRolls.add(roll);

      const originalTotal = Number(roll.total);
      const target = Number.isFinite(Number(roll.options?.target)) ? Number(roll.options.target) : null;
      const initialSuccess = target == null ? null : originalTotal >= target;
      const actorUuid = actor.uuid ?? `Actor.${actor.id}`;
      const pending = SharedRollResolutionQueueService.markPending({
        roll,
        actorUuid,
        rollType: "concentration",
        originalTotal,
        currentTotal: originalTotal,
        target,
        succeeded: initialSuccess
      });

      this.#pending.set(pending.rollKey, {
        actor,
        actorUuid,
        roll,
        originalTotal,
        target,
        createdAt: Date.now()
      });

      // The barrier is deliberately inert. Its only job is to keep the batch
      // open for a short discovery window so async Character/Item providers
      // that were triggered by the same native roll can enqueue before the
      // queue publishes its final snapshot. Providers that enqueue while an
      // earlier prompt is open are picked up by the queue's next pass.
      void SharedRollResolutionQueueService.enqueue({
        roll,
        rollKey: pending.rollKey,
        phase: "lifecycle",
        priority: BARRIER_PRIORITY,
        providerId: `${MODULE_ID}:${RULE_ID}:barrier`,
        actorUuid,
        rollType: "concentration",
        originalTotal,
        currentTotal: originalTotal,
        target,
        succeeded: initialSuccess,
        execute: async () => {
          await new Promise(resolve => setTimeout(resolve, PROVIDER_DISCOVERY_GRACE_MS));
          return { stop: false };
        }
      }).catch(error => {
        console.warn(`${MODULE_ID} | Concentration queue barrier failed.`, error);
      });
    }
  }

  static async #onRollResolutionFinalized(payload, roll) {
    if (!this.enabled() || !payload?.rollKey) return;
    const pending = this.#pending.get(payload.rollKey);
    if (!pending) return;
    this.#pending.delete(payload.rollKey);

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
        action: "Concentration maintained after final post-roll resolution",
        originalTotal: pending.originalTotal,
        finalTotal: currentTotal,
        target
      });
      return;
    }

    const maintained = this.#concentrationEffects(actor).length;
    if (!maintained) return;
    const ended = await actor.endConcentration();
    this.#recordAudit(actor, {
      action: "Ended native concentration after final failed Concentration save",
      originalTotal: pending.originalTotal,
      finalTotal: currentTotal,
      target,
      endedCount: Array.isArray(ended) ? ended.length : maintained,
      rollKey: payload.rollKey,
      rollId: roll?.id ?? null
    });
  }

  static #hasConcentration(actor) {
    return this.#concentrationEffects(actor).length > 0;
  }

  static #concentrationEffects(actor) {
    const effects = actor?.concentration?.effects;
    if (!effects) return [];
    if (Array.isArray(effects)) return effects;
    if (Array.isArray(effects.contents)) return effects.contents;
    return [...effects];
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
