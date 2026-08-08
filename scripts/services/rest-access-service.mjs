import { MODULE_ID, defaultSettings } from "../constants.mjs";

/**
 * Optional GM-managed rest availability.
 *
 * When enabled, the GM grants a one-use Short Rest or Long Rest permission to
 * individual character Actors. The player still initiates the normal D&D5e
 * rest from the sheet; this service only gates availability and records the
 * grant. A grant is consumed only after the native rest actually completes.
 */
export class RestAccessService {
  static FLAG = "restAccess";

  static settings() {
    return foundry.utils.mergeObject(defaultSettings(), game.settings.get(MODULE_ID, "settings") ?? {}, {
      inplace: false
    });
  }

  static enabled() {
    return this.settings().gmManagedRestAccess === true;
  }

  static state(actor) {
    const stored = actor?.getFlag?.(MODULE_ID, this.FLAG) ?? {};
    return foundry.utils.deepClone({
      short: stored.short ?? null,
      long: stored.long ?? null
    });
  }

  static grant(actor, restType) {
    return this.#grant(actor, this.#normalizeType(restType));
  }

  static async grantMany(actors, restType) {
    this.#assertGM();
    if (!this.enabled()) throw new Error("GM-managed rests are disabled in Character Builder settings.");
    const type = this.#normalizeType(restType);
    const unique = new Map();
    for (const actor of actors ?? []) {
      if (this.#eligibleActor(actor)) unique.set(actor.id, actor);
    }
    if (!unique.size) throw new Error("Select at least one completed Player Character.");

    const results = [];
    for (const actor of unique.values()) {
      try {
        const current = this.entry(actor, type);
        if (current?.available) {
          results.push({ actorId: actor.id, name: actor.name, ok: true, skipped: true, message: `${this.label(type)} already available.` });
          continue;
        }
        await this.#grant(actor, type);
        results.push({ actorId: actor.id, name: actor.name, ok: true, message: `${this.label(type)} available.` });
        actor.sheet?.render?.(false);
      } catch (error) {
        results.push({ actorId: actor.id, name: actor.name, ok: false, message: error.message });
      }
    }
    return { restType: type, results };
  }

  static entry(actor, restType) {
    const type = this.#normalizeType(restType);
    return this.state(actor)[type] ?? null;
  }

  static available(actor, restType) {
    if (!this.enabled()) return true;
    return this.entry(actor, restType)?.available === true;
  }

  static async consume(actor, restType, metadata = {}) {
    const type = this.#normalizeType(restType);
    if (!this.enabled()) return { consumed: false, unrestricted: true };
    if (!this.#eligibleActor(actor)) return { consumed: false, unavailable: true };

    const state = this.state(actor);
    const current = state[type];
    if (!current?.available) return { consumed: false, unavailable: true };
    state[type] = {
      ...current,
      available: false,
      consumedAt: Date.now(),
      consumedBy: game.user?.id ?? null,
      ...foundry.utils.deepClone(metadata ?? {})
    };
    await actor.setFlag(MODULE_ID, this.FLAG, state);
    actor.sheet?.render?.(false);
    return { consumed: true, entry: foundry.utils.deepClone(state[type]) };
  }

  static async clearAllGrants() {
    if (!game.user?.isGM) return;
    for (const actor of game.actors?.filter?.(candidate => this.#eligibleActor(candidate)) ?? []) {
      if (actor.getFlag(MODULE_ID, this.FLAG) == null) continue;
      await actor.unsetFlag(MODULE_ID, this.FLAG);
      actor.sheet?.render?.(false);
    }
  }

  static label(restType) {
    return this.#normalizeType(restType) === "short" ? "Short Rest" : "Long Rest";
  }

  static #normalizeType(restType) {
    return restType === "short" ? "short" : "long";
  }

  static async #grant(actor, type) {
    this.#assertGM();
    if (!this.enabled()) throw new Error("GM-managed rests are disabled in Character Builder settings.");
    if (!this.#eligibleActor(actor)) throw new Error("Rest access can be granted only to completed Player Characters.");
    const state = this.state(actor);
    state[type] = {
      available: true,
      grantedAt: Date.now(),
      grantedBy: game.user.id,
      grantId: foundry.utils.randomID?.(20) ?? crypto.randomUUID()
    };
    await actor.setFlag(MODULE_ID, this.FLAG, state);
    return foundry.utils.deepClone(state[type]);
  }

  static #eligibleActor(actor) {
    return Boolean(actor
      && actor.type === "character"
      && !actor.getFlag?.(MODULE_ID, "isDraft")
      && !actor.getFlag?.(MODULE_ID, "isLevelUpDraft")
      && actor.items?.some?.(item => item.type === "class"));
  }

  static #assertGM() {
    if (!game.user?.isGM) throw new Error("Only a GM can grant rest availability.");
  }
}
