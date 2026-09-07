import { MODULE_ID } from "../constants.mjs";

/**
 * Explicit rest-timed Active Effect cleanup.
 *
 * World Time owns finite clock durations. Combat owns round/turn durations.
 * This service only handles effects whose own metadata explicitly names a
 * Short Rest or Long Rest lifecycle. A Long Rest also ends native D&D5e
 * concentration; dependents then disappear through D&D5e's normal lifecycle.
 */
export class RestEffectLifecycleService {
  static async apply(actor, { restType = "long", reason = "rest" } = {}) {
    const type = restType === "short" ? "short" : "long";
    if (!actor || actor.type !== "character") {
      return { changed: false, concentrationsEnded: 0, effectsRemoved: [], restType: type };
    }

    const result = {
      changed: false,
      concentrationsEnded: 0,
      effectsRemoved: [],
      restType: type,
      reason
    };

    // Finite duration does NOT make an effect a Long-Rest effect. Long Rest
    // still ends concentration itself through the native Actor API.
    if (type === "long") {
      const concentrationBefore = this.#concentrationEffects(actor).length;
      if (concentrationBefore && typeof actor.endConcentration === "function") {
        await actor.endConcentration();
        const concentrationAfter = this.#concentrationEffects(actor).length;
        result.concentrationsEnded = Math.max(0, concentrationBefore - concentrationAfter);
        result.changed ||= result.concentrationsEnded > 0;
      }
    }

    const removable = Array.from(actor.effects ?? []).filter(effect => this.#expiresOnRest(effect, type));
    if (removable.length) {
      const ids = removable.map(effect => effect.id).filter(Boolean);
      if (ids.length) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", ids, {
          characterBuilderRestEffectLifecycle: true,
          characterBuilderRestType: type,
          characterBuilderRestReason: reason
        });
        result.effectsRemoved = removable.map(effect => ({ id: effect.id, name: effect.name ?? "Active Effect" }));
        result.changed = true;
      }
    }

    return result;
  }

  static #expiresOnRest(effect, restType) {
    if (!effect || effect.parent?.documentName !== "Actor") return false;
    if (this.#isConcentration(effect)) return false; // native concentration API owns it

    const declaration = effect.getFlag?.(MODULE_ID, "contextualEffect")
      ?? effect.flags?.[MODULE_ID]?.contextualEffect
      ?? null;
    const lifecycle = declaration?.lifecycle ?? null;
    if (lifecycle?.mode === "rest") {
      const declared = String(lifecycle?.restType ?? lifecycle?.rest ?? lifecycle?.termination ?? "").toLowerCase();
      if (this.#matchesRestText(declared, restType)) return true;
    }

    const duration = effect.duration ?? effect._source?.duration ?? {};
    const candidates = [
      effect.getFlag?.(MODULE_ID, "expiresOn"),
      effect.getFlag?.("dnd5e", "expiresOn"),
      effect.flags?.[MODULE_ID]?.expiresOn,
      effect.flags?.dnd5e?.expiresOn,
      effect.flags?.dae?.specialDuration,
      duration?.units
    ].flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean);

    return candidates.some(value => this.#matchesRestText(String(value), restType));
  }

  static #matchesRestText(value, restType) {
    const text = String(value ?? "").trim();
    if (!text) return false;
    const long = /(?:^|[-_\s])(?:long[-_\s]?rest|lr)(?:$|[-_\s])/i.test(text)
      || /longrest/i.test(text);
    const short = /(?:^|[-_\s])(?:short[-_\s]?rest|sr)(?:$|[-_\s])/i.test(text)
      || /shortrest/i.test(text);
    return restType === "long" ? long : short;
  }

  static #isConcentration(effect) {
    const concentrating = globalThis.CONFIG?.DND5E?.specialStatusEffects?.CONCENTRATING
      ?? globalThis.CONFIG?.specialStatusEffects?.CONCENTRATING
      ?? "concentrating";
    return Boolean(effect.statuses?.has?.(concentrating)
      || Array.from(effect.statuses ?? []).includes(concentrating));
  }

  static #concentrationEffects(actor) {
    const direct = Array.from(actor?.concentration?.effects ?? []);
    if (direct.length) return direct;
    return Array.from(actor?.effects ?? []).filter(effect => this.#isConcentration(effect));
  }
}
