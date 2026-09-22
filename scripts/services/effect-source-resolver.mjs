/**
 * Shared D&D5e 6.x ActiveEffect source resolver.
 *
 * D&D5e 6 can identify an effect's source through several forms at once:
 * - ActiveEffect#getSource() / getSourceActor();
 * - structured effect.system.origin (activity/item/effect/actor/...);
 * - top-level origin and dependentOn retained by older/migrated documents;
 * - canonical sourceId / compendiumSource metadata.
 *
 * Runtime services should use this helper instead of each implementing its own
 * partial interpretation of effect.origin.
 */
export class EffectSourceResolver {
  /**
   * Resolve using only synchronous APIs. Suitable for pre-roll hooks which
   * cannot yield while D&D5e is building a roll configuration.
   *
   * @param {ActiveEffect} effect
   * @returns {{document: Document|null, actor: Actor|null, item: Item|null, activity: object|null, effect: ActiveEffect|null}}
   */
  static resolveSync(effect) {
    if (!effect) return this.#empty();

    const sourceActor = this.#safeSourceActor(effect);
    let best = null;

    for (const candidate of this.#candidateUuids(effect)) {
      const document = this.#fromUuidSync(candidate, effect);
      const resolved = this.#normalize(document, { sourceActor, relative: effect });
      if (resolved?.item) return resolved;
      best ??= resolved;
    }

    const sourceId = this.#sourceId(effect);
    if (sourceId) {
      const document = this.#fromUuidSync(sourceId, effect);
      const resolved = this.#normalize(document, { sourceActor, relative: effect });
      if (resolved?.item) return resolved;
      best ??= resolved;
    }

    return best ?? { ...this.#empty(), actor: sourceActor };
  }

  /**
   * Resolve with D&D5e's public async getSource() helper first, then structured
   * and historical fallbacks.
   *
   * @param {ActiveEffect} effect
   * @returns {Promise<{document: Document|null, actor: Actor|null, item: Item|null, activity: object|null, effect: ActiveEffect|null}>}
   */
  static async resolve(effect) {
    if (!effect) return this.#empty();

    const sourceActor = this.#safeSourceActor(effect);
    let best = null;

    try {
      const document = await effect.getSource?.() ?? null;
      const resolved = this.#normalize(document, { sourceActor, relative: effect });
      if (resolved?.item) return resolved;
      best ??= resolved;
    } catch (_error) {
      // Continue into the structured and migrated-world fallbacks.
    }

    for (const candidate of this.#candidateUuids(effect)) {
      const document = await this.#fromUuid(candidate, effect);
      const resolved = this.#normalize(document, { sourceActor, relative: effect });
      if (resolved?.item) return resolved;
      best ??= resolved;
    }

    const sourceId = this.#sourceId(effect);
    if (sourceId) {
      const document = await this.#fromUuid(sourceId, effect);
      const resolved = this.#normalize(document, { sourceActor, relative: effect });
      if (resolved?.item) return resolved;
      best ??= resolved;
    }

    return best ?? { ...this.#empty(), actor: sourceActor };
  }

  static #candidateUuids(effect) {
    const structured = effect.system?.origin ?? {};
    const candidates = [
      structured.activity,
      structured.item,
      structured.effect,
      structured.actor,
      effect.origin,
      effect.getFlag?.("dnd5e", "dependentOn") ?? effect.flags?.dnd5e?.dependentOn
    ];
    return [...new Set(candidates.map(value => String(value ?? "").trim()).filter(Boolean))];
  }

  static #normalize(document, { sourceActor=null, relative=null }={}) {
    if (!document) return null;
    const documentName = document.documentName ?? document.constructor?.documentName ?? "";

    if (documentName === "Activity") {
      const item = document.item ?? (document.parent?.documentName === "Item" ? document.parent : null);
      return {
        document,
        activity: document,
        item: item?.documentName === "Item" ? item : null,
        actor: sourceActor ?? document.actor ?? item?.actor ?? (item?.parent?.documentName === "Actor" ? item.parent : null),
        effect: null
      };
    }

    if (documentName === "Item") {
      return {
        document,
        activity: null,
        item: document,
        actor: sourceActor ?? document.actor ?? (document.parent?.documentName === "Actor" ? document.parent : null),
        effect: null
      };
    }

    if (documentName === "ActiveEffect") {
      const parentItem = document.parent?.documentName === "Item" ? document.parent : null;
      const parentActor = document.parent?.documentName === "Actor" ? document.parent : null;
      let item = parentItem;
      let actor = sourceActor ?? parentItem?.actor ?? parentActor ?? null;

      // Concentration and other actor-owned effects in migrated/native worlds
      // can identify their source Item through flags.dnd5e.item.
      if (!item && parentActor) {
        const itemRef = document.getFlag?.("dnd5e", "item") ?? document.flags?.dnd5e?.item ?? {};
        item = parentActor.items?.get?.(itemRef.id) ?? this.#fromUuidSync(itemRef.uuid, parentActor);
        if (item?.documentName !== "Item") item = null;
      }

      return { document, activity: null, item, actor, effect: document };
    }

    if (documentName === "Actor") {
      return { document, activity: null, item: null, actor: sourceActor ?? document, effect: null };
    }

    // A few D&D5e source-capable pseudo-documents (for example a Region
    // Behavior) expose actor/item references without being one of the core
    // document types above. Preserve what can be determined without guessing.
    const item = document.item?.documentName === "Item" ? document.item : null;
    const actor = sourceActor ?? document.actor ?? item?.actor ?? null;
    if (item || actor) return { document, activity: null, item, actor, effect: null };

    // Keep relative available for future document types; no heuristic UUID
    // walking is performed here because the public D&D5e helpers are preferred.
    void relative;
    return { document, activity: null, item: null, actor: sourceActor, effect: null };
  }

  static #safeSourceActor(effect) {
    try {
      return effect.getSourceActor?.() ?? null;
    } catch (_error) {
      return null;
    }
  }

  static #sourceId(effect) {
    return String(effect.getFlag?.("dnd5e", "sourceId")
      ?? effect.flags?.dnd5e?.sourceId
      ?? effect._stats?.compendiumSource
      ?? "").trim();
  }

  static #fromUuidSync(uuid, relative) {
    if (!uuid) return null;
    try {
      return globalThis.fromUuidSync?.(uuid, { relative, strict: false }) ?? null;
    } catch (_error) {
      return null;
    }
  }

  static async #fromUuid(uuid, relative) {
    if (!uuid) return null;
    try {
      // Foundry's async helper is the authoritative resolver for absolute UUIDs.
      // Keep the relative-aware synchronous lookup as a defensive fallback for
      // historical/migrated references without depending on optional async args.
      const document = await globalThis.fromUuid?.(uuid);
      return document ?? this.#fromUuidSync(uuid, relative);
    } catch (_error) {
      return this.#fromUuidSync(uuid, relative);
    }
  }

  static #empty() {
    return { document: null, actor: null, item: null, activity: null, effect: null };
  }
}
