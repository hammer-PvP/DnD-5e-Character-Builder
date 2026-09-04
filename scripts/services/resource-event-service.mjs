import { MODULE_ID } from "../constants.mjs";

const PROTOCOL_SYMBOL = Symbol.for("dnd5e.resource-events.v1");
const PROTOCOL_VERSION = 1;

/**
 * Publishes semantic resource-consumption events after D&D5e has completed its
 * native consumption transaction. Consumers receive the resource that actually
 * changed, rather than having to infer consumption from the Activity that was
 * clicked.
 */
export class ResourceEventService {
  static #initialized = false;
  static #subscribers = new Set();
  static #api = null;

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    Hooks.on("dnd5e.postActivityConsumption", (activity, usageConfig, messageConfig, updates) => {
      this.#publishConsumption(activity, usageConfig, messageConfig, updates);
    });
  }

  static api() {
    if (this.#api) return this.#api;
    this.#api = Object.freeze({
      protocol: "dnd5e-resource-events",
      version: PROTOCOL_VERSION,
      symbol: PROTOCOL_SYMBOL,
      subscribe: listener => this.subscribe(listener)
    });
    globalThis[PROTOCOL_SYMBOL] ??= this.#api;
    return this.#api;
  }

  static subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  static #publishConsumption(activity, usageConfig, messageConfig) {
    const actor = activity?.actor;
    if (!actor) return;
    const deltas = foundry.utils.getProperty(messageConfig, "data.system.deltas") ?? null;
    if (!deltas) return;

    const events = [];
    for (const row of deltas.actor ?? []) {
      const event = this.#actorDeltaEvent(actor, row);
      if (event) events.push(event);
    }
    for (const [itemId, rows] of Object.entries(deltas.item ?? {})) {
      const item = actor.items?.get?.(itemId);
      for (const row of rows ?? []) {
        const event = this.#itemDeltaEvent(actor, item, itemId, row);
        if (event) events.push(event);
      }
    }

    for (const resource of events) {
      const payload = Object.freeze({
        type: "resource-consumed",
        schema: PROTOCOL_VERSION,
        at: Date.now(),
        actorUuid: actor.uuid ?? `Actor.${actor.id}`,
        amount: resource.amount,
        resource: Object.freeze(resource.resource),
        cause: Object.freeze({
          actorUuid: actor.uuid ?? `Actor.${actor.id}`,
          itemUuid: activity.item?.uuid ?? null,
          itemId: activity.item?.id ?? null,
          itemIdentifier: activity.item?.system?.identifier ?? null,
          itemName: activity.item?.name ?? null,
          activityUuid: activity.uuid ?? null,
          activityId: activity.id ?? null,
          activityName: activity.name ?? null,
          activityType: activity.type ?? null,
          linkedActivity: usageConfig?.cause?.activity ?? null
        })
      });
      this.#emit(payload);
    }
  }

  static #actorDeltaEvent(actor, row) {
    const keyPath = String(row?.keyPath ?? "");
    const delta = Number(row?.delta);
    if (!Number.isFinite(delta) || delta === 0) return null;

    let amount = 0;
    let kind = "actorAttribute";
    if (keyPath.endsWith(".spent")) amount = delta > 0 ? delta : 0;
    else if (keyPath.endsWith(".value")) amount = delta < 0 ? -delta : 0;
    if (!(amount > 0)) return null;

    if (/^system\.spells\.[^.]+\.value$/.test(keyPath)) kind = "spellSlot";
    else if (/^system\.resources\.[^.]+\.(?:value|spent)$/.test(keyPath)) kind = "actorResource";
    else if (/^system\.attributes\./.test(keyPath)) kind = "actorAttribute";

    return {
      amount,
      resource: {
        kind,
        keyPath,
        documentUuid: actor.uuid ?? `Actor.${actor.id}`,
        itemUuid: null,
        itemId: null,
        identifier: keyPath,
        name: this.#actorResourceLabel(actor, keyPath)
      }
    };
  }

  static #itemDeltaEvent(actor, item, itemId, row) {
    const keyPath = String(row?.keyPath ?? "");
    const delta = Number(row?.delta);
    if (!Number.isFinite(delta) || delta === 0) return null;

    let amount = 0;
    if (keyPath.endsWith(".spent")) amount = delta > 0 ? delta : 0;
    else if (keyPath.endsWith(".value")) amount = delta < 0 ? -delta : 0;
    if (!(amount > 0)) return null;

    const activityMatch = keyPath.match(/^system\.activities\.([^.]+)\.uses\.(?:spent|value)$/);
    const activity = activityMatch ? item?.system?.activities?.get?.(activityMatch[1]) : null;
    const kind = activityMatch ? "activityUses" : "itemUses";
    return {
      amount,
      resource: {
        kind,
        keyPath,
        documentUuid: activity?.uuid ?? item?.uuid ?? null,
        itemUuid: item?.uuid ?? null,
        itemId,
        activityId: activity?.id ?? null,
        identifier: item?.system?.identifier ?? itemId,
        name: activity?.name || item?.name || itemId
      }
    };
  }

  static #actorResourceLabel(actor, keyPath) {
    const resource = keyPath.match(/^system\.resources\.([^.]+)\./)?.[1];
    if (resource) return actor.system?.resources?.[resource]?.label || resource;
    const slot = keyPath.match(/^system\.spells\.([^.]+)\./)?.[1];
    if (slot) return actor.system?.spells?.[slot]?.label || slot;
    return keyPath;
  }

  static #emit(payload) {
    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber(payload);
      } catch (error) {
        console.warn(`${MODULE_ID} | Resource event subscriber failed.`, error);
      }
    }
    Hooks.callAll(`${MODULE_ID}.resourceConsumed`, payload);
  }
}
