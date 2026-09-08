import { MODULE_ID } from "../constants.mjs";

/**
 * Explicit rest-timed Active Effect cleanup.
 *
 * Foundry v14's ActiveEffectRegistry owns finite clock durations and D&D5e's
 * rest workflow advances World Time. This service therefore never treats a
 * finite duration as proof that a rest should end an effect. It handles only
 * explicit Short/Long Rest lifecycle declarations. Long Rest also preserves
 * the previously validated Character Builder behavior of ending concentration
 * through Actor#endConcentration().
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

    return result;
  }

  static #expiresOnRest(effect, restType) {
    if (!effect || effect.parent?.documentName !== "Actor") return false;
    if (this.#isConcentration(effect)) return false;

    const declaration = effect.getFlag?.(MODULE_ID, "contextualEffect")
      ?? effect.flags?.[MODULE_ID]?.contextualEffect
      ?? null;
    const lifecycle = declaration?.lifecycle ?? null;
    if (lifecycle?.mode === "rest") {
      const declared = String(lifecycle?.restType ?? lifecycle?.rest ?? lifecycle?.termination ?? "");
      if (this.#matchesRestText(declared, restType)) return true;
    }

    // v14-native duration.expiry is an event identifier, not a timestamp.
    const duration = effect._source?.duration ?? {};
    const candidates = [
      effect.getFlag?.(MODULE_ID, "expiresOn"),
      effect.getFlag?.("dnd5e", "expiresOn"),
      effect.flags?.[MODULE_ID]?.expiresOn,
      effect.flags?.dnd5e?.expiresOn,
      effect.flags?.dae?.specialDuration,
      duration?.expiry
    ].flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean);

    return candidates.some(value => this.#matchesRestText(String(value), restType));
  }

  static #matchesRestText(value, restType) {
    const text = String(value ?? "").trim();
    if (!text) return false;
    const long = /(?:^|[-_\s])(?:long[-_\s]?rest|lr)(?:$|[-_\s])/i.test(text) || /longrest/i.test(text);
    const short = /(?:^|[-_\s])(?:short[-_\s]?rest|sr)(?:$|[-_\s])/i.test(text) || /shortrest/i.test(text);
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
