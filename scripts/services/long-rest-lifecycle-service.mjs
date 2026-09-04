import { MODULE_ID } from "../constants.mjs";

/**
 * Conservative post-Long-Rest cleanup.
 *
 * This service does not redefine Actor capabilities and does not edit source
 * Items. D&D5e remains authoritative for concentration. After a successful
 * native Long Rest we:
 *   1. end every native concentration through Actor#endConcentration();
 *   2. delete only Actor-level effects that are provably transient.
 *
 * Indefinite source/passive effects, conditions, curses, diseases, and manual
 * or homebrew effects are preserved unless their own data proves a finite
 * duration / Long-Rest lifecycle.
 */
export class LongRestLifecycleService {
  static async apply(actor, { reason = "long-rest" } = {}) {
    if (!actor || actor.type !== "character") return { changed: false, concentrationsEnded: 0, effectsRemoved: [] };

    const result = {
      changed: false,
      concentrationsEnded: 0,
      effectsRemoved: [],
      reason
    };

    const concentrationBefore = this.#concentrationEffects(actor).length;
    if (concentrationBefore && typeof actor.endConcentration === "function") {
      await actor.endConcentration();
      const concentrationAfter = this.#concentrationEffects(actor).length;
      result.concentrationsEnded = Math.max(0, concentrationBefore - concentrationAfter);
      result.changed ||= result.concentrationsEnded > 0;
    }

    const removable = Array.from(actor.effects ?? []).filter(effect => this.#shouldRemoveAfterLongRest(effect, actor));
    if (removable.length) {
      const ids = removable.map(effect => effect.id).filter(Boolean);
      if (ids.length) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", ids, {
          characterBuilderLongRestLifecycle: true,
          characterBuilderLongRestReason: reason
        });
        result.effectsRemoved = removable.map(effect => ({ id: effect.id, name: effect.name ?? "Active Effect" }));
        result.changed = true;
      }
    }

    return result;
  }

  static #shouldRemoveAfterLongRest(effect, actor) {
    if (!effect || effect.parent !== actor) return false;
    if (this.#isConcentration(effect)) return false; // native API owns it

    const lifecycle = effect.getFlag?.(MODULE_ID, "contextualEffect")?.lifecycle
      ?? effect.flags?.[MODULE_ID]?.contextualEffect?.lifecycle
      ?? null;
    if (lifecycle?.mode === "concentration") return this.#dependencyIsGone(effect, actor);
    if (lifecycle?.mode === "duration") return true;

    if (this.#explicitLongRestExpiry(effect)) return true;
    if (this.#dependencyIsGone(effect, actor)) return true;

    // A finite clock by itself is enough to identify ordinary temporary buffs
    // and debuffs, but not a status-bearing condition/curse/disease. Long Rest
    // is not a universal cure: preserve status effects unless their own data
    // explicitly says Long Rest ends them (or native concentration dependency
    // already proves they belong to a concentration lifecycle).
    if (this.#hasFiniteDuration(effect) && !this.#hasStatuses(effect)) return true;

    // No positive proof of transience: preserve it. This protects passive
    // source-derived effects and persistent conditions/custom content.
    return false;
  }

  static #hasFiniteDuration(effect) {
    const duration = effect.duration ?? effect._source?.duration ?? {};
    if (duration?.expired === true) return true;
    const value = Number(duration?.value);
    if (Number.isFinite(value) && value > 0) return true;
    const seconds = Number(duration?.seconds);
    if (Number.isFinite(seconds) && seconds > 0) return true;
    const rounds = Number(duration?.rounds);
    if (Number.isFinite(rounds) && rounds > 0) return true;
    const turns = Number(duration?.turns);
    if (Number.isFinite(turns) && turns > 0) return true;
    return false;
  }


  static #hasStatuses(effect) {
    const statuses = effect?.statuses ?? effect?._source?.statuses ?? [];
    if (typeof statuses?.size === "number") return statuses.size > 0;
    if (Array.isArray(statuses)) return statuses.length > 0;
    return Boolean(statuses && typeof statuses[Symbol.iterator] === "function" && Array.from(statuses).length);
  }

  static #explicitLongRestExpiry(effect) {
    const candidates = [
      effect.getFlag?.(MODULE_ID, "expiresOn"),
      effect.getFlag?.("dnd5e", "expiresOn"),
      effect.flags?.[MODULE_ID]?.expiresOn,
      effect.flags?.dnd5e?.expiresOn,
      effect.flags?.dae?.specialDuration
    ].flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean);
    return candidates.some(value => /(?:^|[-_\s])(?:long[-_\s]?rest|lr)(?:$|[-_\s])/i.test(String(value)));
  }

  static #dependencyIsGone(effect, actor) {
    const dependency = String(effect.getFlag?.("dnd5e", "dependentOn") ?? effect.flags?.dnd5e?.dependentOn ?? "").trim();
    if (!dependency) return false;
    const id = dependency.split(".").at(-1);
    if (!id) return false;
    return !actor.effects?.get?.(id);
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
