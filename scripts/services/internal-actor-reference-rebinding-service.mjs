import { MODULE_ID } from "../constants.mjs";

const ACTOR_ITEM_UUID_PATTERN = /Actor\.([A-Za-z0-9]{16})\.Item\.([A-Za-z0-9]{16})(?:\.Activity\.([A-Za-z0-9]{16}))?/g;

/**
 * Finds and repairs stale self-references left behind when embedded documents
 * are materialized from a temporary Actor onto the authoritative live Actor.
 *
 * The service is deliberately conservative: it only changes the Actor UUID
 * prefix when the referenced Item ID still exists on the current Actor and, if
 * an Activity ID is present, that Activity also exists on that same Item.
 * Repairs write only the exact string fields proven stale; they never rewrite a
 * whole Item/Actor system object just to change one UUID prefix.
 */
export class InternalActorReferenceRebindingService {
  static scan(actor, { excludeValidationFlag = true } = {}) {
    if (!actor?.id || !actor?.items) return [];

    const documentRows = [];
    const actorRaw = actor.toObject?.() ?? actor._source ?? {};
    const actorScope = {
      system: actorRaw.system ?? {},
      flags: actorRaw.flags ?? {},
      prototypeToken: actorRaw.prototypeToken ?? {}
    };
    let actorRefs = this.#collect(actor, actorScope);
    if (excludeValidationFlag) {
      actorRefs = actorRefs.filter(row => !row.path.startsWith(`flags.${MODULE_ID}.characterValidation`));
    }
    if (actorRefs.length) {
      documentRows.push({ documentType: "Actor", documentId: actor.id, name: actor.name, refs: actorRefs });
    }

    for (const item of this.#items(actor)) {
      const raw = item.toObject?.() ?? item._source ?? {};
      const refs = this.#collect(actor, { system: raw.system ?? {}, flags: raw.flags ?? {} });
      if (refs.length) {
        documentRows.push({ documentType: "Item", documentId: item.id, name: item.name, refs });
      }
      for (const effect of this.#effects(item)) {
        const effectRaw = effect.toObject?.() ?? effect._source ?? {};
        const effectRefs = this.#collect(actor, {
          origin: effectRaw.origin,
          description: effectRaw.description,
          flags: effectRaw.flags ?? {}
        });
        if (effectRefs.length) {
          documentRows.push({
            documentType: "ItemActiveEffect",
            documentId: effect.id,
            parentId: item.id,
            name: effect.name,
            refs: effectRefs
          });
        }
      }
    }

    for (const effect of this.#effects(actor)) {
      const effectRaw = effect.toObject?.() ?? effect._source ?? {};
      const refs = this.#collect(actor, {
        origin: effectRaw.origin,
        description: effectRaw.description,
        flags: effectRaw.flags ?? {}
      });
      if (refs.length) {
        documentRows.push({
          documentType: "ActorActiveEffect",
          documentId: effect.id,
          name: effect.name,
          refs
        });
      }
    }

    return documentRows;
  }

  static async rebindActor(actor, { reason = "materialization", render = true } = {}) {
    const rows = this.scan(actor);
    const summary = { checked: rows.length, documents: 0, references: 0, reason };
    for (const row of rows) {
      const result = await this.rebindDocument(actor, row, { reason, render });
      if (!result.changed) continue;
      summary.documents += 1;
      summary.references += result.references;
    }
    return summary;
  }

  static async rebindDocument(actor, row, { reason = "manual", render = true } = {}) {
    const prefixes = this.#provenPrefixes(actor, row?.refs ?? []);
    if (!prefixes.length) return { changed: false, references: 0 };

    const document = this.#resolveDocument(actor, row);
    if (!document) return { changed: false, references: 0 };
    const scope = this.#documentScope(document, row.documentType);
    const paths = [...new Set((row.refs ?? []).map(ref => String(ref?.path ?? "")).filter(Boolean))];
    const updates = {};
    let references = 0;

    for (const path of paths) {
      const current = foundry.utils.getProperty(scope, path);
      if (typeof current !== "string") continue;
      let next = current;
      for (const [from, to] of prefixes) {
        const occurrences = next.split(from).length - 1;
        if (!occurrences) continue;
        references += occurrences;
        next = next.split(from).join(to);
      }
      if (next !== current) updates[path] = next;
    }

    if (!Object.keys(updates).length) return { changed: false, references: 0 };
    await document.update(updates, {
      render,
      characterBuilderActorReferenceRebinding: true,
      characterBuilderActorReferenceRebindingReason: reason
    });
    return { changed: true, references };
  }

  static #collect(actor, value, path = "", rows = []) {
    if (typeof value === "string") {
      ACTOR_ITEM_UUID_PATTERN.lastIndex = 0;
      let match;
      while ((match = ACTOR_ITEM_UUID_PATTERN.exec(value))) {
        const [, actorId, itemId, activityId] = match;
        if (actorId === actor.id) continue;
        const localItem = actor.items.get?.(itemId);
        if (!localItem) continue;
        if (activityId && !this.#activityExists(localItem, activityId)) continue;
        rows.push({ path, value, actorId, itemId, activityId: activityId ?? null });
      }
      return rows;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => this.#collect(actor, child, path ? `${path}.${index}` : String(index), rows));
      return rows;
    }
    if (!value || typeof value !== "object") return rows;
    for (const [key, child] of Object.entries(value)) {
      this.#collect(actor, child, path ? `${path}.${key}` : key, rows);
    }
    return rows;
  }

  static #provenPrefixes(actor, refs) {
    return [...new Map(refs.map(ref => {
      const actorId = String(ref?.actorId ?? "");
      const itemId = String(ref?.itemId ?? "");
      if (!actorId || !itemId || actorId === actor.id) return null;
      const localItem = actor.items.get?.(itemId);
      if (!localItem) return null;
      if (ref?.activityId && !this.#activityExists(localItem, ref.activityId)) return null;
      const activitySuffix = ref?.activityId ? `.Activity.${ref.activityId}` : "";
      return [
        `Actor.${actorId}.Item.${itemId}${activitySuffix}`,
        `Actor.${actor.id}.Item.${itemId}${activitySuffix}`
      ];
    }).filter(Boolean)).entries()];
  }

  static #resolveDocument(actor, row) {
    if (row?.documentType === "Actor") return actor;
    if (row?.documentType === "Item") return actor.items.get?.(row.documentId) ?? null;
    if (row?.documentType === "ItemActiveEffect") {
      return actor.items.get?.(row.parentId)?.effects?.get?.(row.documentId) ?? null;
    }
    if (row?.documentType === "ActorActiveEffect") return actor.effects?.get?.(row.documentId) ?? null;
    return null;
  }

  static #documentScope(document, type) {
    const raw = document.toObject?.() ?? document._source ?? {};
    if (type === "Actor") {
      return {
        system: raw.system ?? {},
        flags: raw.flags ?? {},
        prototypeToken: raw.prototypeToken ?? {}
      };
    }
    if (type === "Item") return { system: raw.system ?? {}, flags: raw.flags ?? {} };
    return {
      origin: raw.origin,
      description: raw.description,
      flags: raw.flags ?? {}
    };
  }

  static #activityExists(item, activityId) {
    if (!activityId) return true;
    if (item.system?.activities?.get?.(activityId)) return true;
    const raw = item.toObject?.() ?? item._source ?? {};
    return Boolean(raw.system?.activities?.[activityId]);
  }

  static #items(actor) {
    if (!actor?.items) return [];
    if (Array.isArray(actor.items)) return actor.items;
    if (Array.isArray(actor.items.contents)) return actor.items.contents;
    return [...actor.items];
  }

  static #effects(document) {
    const effects = document?.effects;
    if (!effects) return [];
    if (Array.isArray(effects)) return effects;
    if (Array.isArray(effects.contents)) return effects.contents;
    return [...effects];
  }
}
