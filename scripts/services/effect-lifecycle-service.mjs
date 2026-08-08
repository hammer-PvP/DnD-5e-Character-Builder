import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";
import { SharedRollResolutionQueueService } from "./shared-roll-resolution-queue-service.mjs";

const RULE_ID = "concentration-effect-lifecycle";
const FLAG_KEY = "contextualEffect";
const FINALIZER_PRIORITY = 900;

/**
 * Generic lifecycle bridge for runtime effects.
 *
 * Concentration itself remains owned by D&D5e. The service only completes two
 * missing links:
 *   1. bind declared concentration-dependent effects to the native
 *      `flags.dnd5e.dependentOn` relationship;
 *   2. after all post-roll providers have resolved a Concentration save, end
 *      native concentration if the final result still fails.
 *
 * D&D5e then deletes concentration dependents through its own registry.
 */
export class EffectLifecycleService {
  static #initialized = false;
  static #handledRolls = new WeakSet();
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

    Hooks.on("dnd5e.rollConcentration", (rolls, data) => {
      void this.#queueConcentrationResolution(rolls, data).catch(error => {
        console.warn(`${MODULE_ID} | Concentration lifecycle resolution failed.`, error);
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

    // Generic safety net: if any runtime already uses a native concentration
    // ActiveEffect as the origin, make the dependency explicit. D&D5e itself
    // does this for its Apply Effects tray; this keeps compatible external
    // materializers on the same lifecycle semantics.
    const origin = data.origin ?? effect?.origin ?? null;
    let nativeConcentrationOrigin = false;
    if (origin && !foundry.utils.getProperty(data, "flags.dnd5e.dependentOn")) {
      const originDoc = fromUuidSync?.(origin, { strict: false });
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

  static async #queueConcentrationResolution(rolls, data) {
    if (!this.enabled()) return;
    const actor = data?.subject?.actor ?? data?.subject ?? null;
    if (!actor?.endConcentration) return;

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

      SharedRollResolutionQueueService.enqueue({
        roll,
        rollKey: pending.rollKey,
        phase: "native",
        priority: FINALIZER_PRIORITY,
        providerId: `${MODULE_ID}:${RULE_ID}:finalizer`,
        actorUuid,
        rollType: "concentration",
        originalTotal,
        currentTotal: originalTotal,
        target,
        succeeded: initialSuccess,
        execute: async context => {
          const currentTotal = Number.isFinite(Number(context.currentTotal)) ? Number(context.currentTotal) : originalTotal;
          const finalTarget = Number.isFinite(Number(context.target)) ? Number(context.target) : target;
          // Concentration is a straight total-vs-DC test. Recompute from the
          // final total whenever the DC is known instead of trusting a stale
          // success flag left by an earlier provider.
          const failed = finalTarget != null
            ? currentTotal < finalTarget
            : context.succeeded === false;

          if (!failed) {
            this.#recordAudit(actor, {
              action: "Concentration maintained after final post-roll resolution",
              originalTotal,
              finalTotal: currentTotal,
              target: finalTarget
            });
            return { currentTotal, succeeded: finalTarget == null ? null : true, stop: false };
          }

          const maintained = actor.concentration?.effects?.size ?? 0;
          if (!maintained) return { currentTotal, succeeded: false, stop: false };

          await actor.endConcentration();
          this.#recordAudit(actor, {
            action: "Ended native concentration after final failed Concentration save",
            originalTotal,
            finalTotal: currentTotal,
            target: finalTarget,
            endedCount: maintained
          });
          return { currentTotal, succeeded: false, stop: false };
        }
      });
    }
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
