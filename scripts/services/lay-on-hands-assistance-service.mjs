import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "lay-on-hands-remove-poison";
const LAY_ON_HANDS_IDENTIFIER = "lay-on-hands";
const REMOVE_POISON_ACTIVITY = "remove poison";
const POISONED_STATUS = "poisoned";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REMOVE = "rulesAssistanceLayOnHandsRemovePoison";

/**
 * Completes the official Lay on Hands "Remove Poison" Activity after D&D5e has
 * successfully consumed its native 5-point cost. Only the native Poisoned
 * status is removed, through Actor.toggleStatusEffect; arbitrary Active Effects
 * are never searched for or deleted.
 */
export class LayOnHandsAssistanceService {
  static #hooksRef = null;
  static #socketReady = false;
  static #locks = new Map();
  static #audit = new Map();

  static initialize() {
    if (this.#hooksRef === globalThis.Hooks) return;
    this.#hooksRef = globalThis.Hooks;

    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => {
      void this.#handleUse(activity, usageConfig, results).catch(error => {
        console.warn(`${MODULE_ID} | Lay on Hands Remove Poison assistance failed.`, error);
      });
    });
  }

  static async ready() {
    this.#initializeSocket();
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static diagnostics(actor) {
    const id = String(actor?.id ?? actor ?? "");
    return (this.#audit.get(id) ?? []).map(row => ({ ...row }));
  }

  static #initializeSocket() {
    if (this.#socketReady || !globalThis.game?.socket?.on) return;
    this.#socketReady = true;
    game.socket.on(SOCKET_CHANNEL, payload => {
      if (payload?.type !== SOCKET_REMOVE || !this.#isActiveGM()) return;
      void this.#handleSocketRemove(payload).catch(error => {
        console.warn(`${MODULE_ID} | GM Lay on Hands Remove Poison request failed.`, error);
      });
    });
  }

  static async #handleUse(activity, _usageConfig, results) {
    if (!this.enabled() || !this.#qualifies(activity)) return;

    const targetUuids = this.#messageTargetUuids(results?.message);
    if (targetUuids.length !== 1) {
      this.#recordAudit(activity.actor, {
        action: targetUuids.length
          ? "Remove Poison did not resolve exactly one target"
          : "Remove Poison completed without a recorded target",
        warning: true,
        targetCount: targetUuids.length
      });
      return;
    }

    const target = await this.#resolveActor(targetUuids[0]);
    if (!target) {
      this.#recordAudit(activity.actor, {
        action: "Remove Poison target could not be resolved",
        warning: true,
        targetActorUuid: targetUuids[0]
      });
      return;
    }

    if (!target.statuses?.has?.(POISONED_STATUS)) {
      this.#recordAudit(activity.actor, {
        action: "Remove Poison target was not carrying the native Poisoned status",
        targetActorUuid: target.uuid ?? targetUuids[0]
      });
      return;
    }

    const request = {
      sourceActorUuid: activity.actor?.uuid ?? `Actor.${activity.actor?.id ?? ""}`,
      sourceItemId: activity.item?.id ?? null,
      sourceActivityId: activity.id ?? null,
      targetActorUuid: target.uuid ?? targetUuids[0],
      messageId: results?.message?.id ?? results?.message?._id ?? null,
      requesterId: game.user?.id ?? null
    };

    if (game.user?.isGM || target.isOwner) {
      await this.#removeFromRequest(request);
      return;
    }

    const activeGM = game.users?.activeGM;
    if (!activeGM) {
      ui.notifications.warn("Lay on Hands spent its points, but Poisoned could not be removed automatically because no active GM can update the target.");
      return;
    }
    game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_REMOVE, ...request });
  }

  static async #handleSocketRemove(payload) {
    if (!this.enabled()) return;
    await this.#removeFromRequest(payload, { validateMessage: true });
  }

  static async #removeFromRequest(request, { validateMessage = false } = {}) {
    const sourceActor = await this.#resolveActor(request.sourceActorUuid);
    const sourceItem = sourceActor?.items?.get?.(request.sourceItemId) ?? null;
    const sourceActivity = this.#activities(sourceItem).find(activity => activity.id === request.sourceActivityId) ?? null;
    if (!sourceActor || !this.#qualifies(sourceActivity)) return false;

    const target = await this.#resolveActor(request.targetActorUuid);
    if (!target) return false;

    if (validateMessage && !this.#messageAuthorizes(request, sourceActor, sourceItem, sourceActivity, target)) {
      console.warn(`${MODULE_ID} | Rejected unverified Lay on Hands Remove Poison socket request.`);
      return false;
    }
    if (!target.statuses?.has?.(POISONED_STATUS)) return false;

    const key = String(target.id ?? target.uuid);
    if (this.#locks.has(key)) return this.#locks.get(key);
    const operation = (async () => {
      await target.toggleStatusEffect(POISONED_STATUS, { active: false });
      if (target.statuses?.has?.(POISONED_STATUS)) {
        throw new Error(`The native Poisoned status remained active on ${target.name}.`);
      }
      this.#recordAudit(sourceActor, {
        action: "Removed native Poisoned status after Lay on Hands: Remove Poison",
        targetActorUuid: target.uuid ?? request.targetActorUuid,
        targetActorId: target.id ?? null,
        sourceItemId: sourceItem.id,
        sourceActivityId: sourceActivity.id,
        messageId: request.messageId ?? null
      });
      return true;
    })().finally(() => {
      if (this.#locks.get(key) === operation) this.#locks.delete(key);
    });
    this.#locks.set(key, operation);
    return operation;
  }

  static #messageAuthorizes(request, sourceActor, sourceItem, sourceActivity, target) {
    const message = request.messageId ? game.messages?.get?.(request.messageId) : null;
    if (!message) return false;
    if (request.requesterId && message.author?.id && message.author.id !== request.requesterId) return false;

    const dnd5e = message.flags?.dnd5e ?? {};
    const itemId = dnd5e.item?.id ?? null;
    const activityId = dnd5e.activity?.id ?? null;
    if (itemId && itemId !== sourceItem.id) return false;
    if (activityId && activityId !== sourceActivity.id) return false;

    const associatedActor = message.getAssociatedActor?.() ?? null;
    if (associatedActor && associatedActor.id !== sourceActor.id) return false;
    const targets = this.#messageTargetUuids(message);
    return targets.length === 1 && targets[0] === (target.uuid ?? request.targetActorUuid);
  }

  static #messageTargetUuids(message) {
    const raw = message?.flags?.dnd5e?.targets
      ?? message?.getFlag?.("dnd5e", "targets")
      ?? [];
    const rows = Array.isArray(raw) ? raw : [...(raw ?? [])];
    return [...new Set(rows.map(row => typeof row === "string" ? row : row?.uuid).filter(Boolean))];
  }

  static #qualifies(activity) {
    const item = activity?.item;
    return Boolean(item
      && String(item.system?.identifier ?? "").trim().toLowerCase() === LAY_ON_HANDS_IDENTIFIER
      && String(activity.name ?? "").trim().toLowerCase() === REMOVE_POISON_ACTIVITY);
  }

  static #activities(item) {
    if (!item?.system?.activities) return [];
    const activities = item.system.activities;
    if (Array.isArray(activities)) return activities;
    if (Array.isArray(activities.contents)) return activities.contents;
    if (typeof activities.values === "function") return [...activities.values()];
    return Object.values(activities);
  }

  static async #resolveActor(uuid) {
    if (!uuid) return null;
    try {
      const document = await fromUuid(uuid);
      if (document?.documentName === "Actor" || document?.type === "character" || document?.type === "npc") return document;
      return document?.actor ?? null;
    } catch (_error) {
      return null;
    }
  }

  static #isActiveGM() {
    if (!game.user?.isGM) return false;
    const activeGM = game.users?.activeGM;
    return !activeGM || activeGM.id === game.user.id;
  }

  static #recordAudit(actor, data) {
    const id = String(actor?.id ?? actor ?? "");
    if (!id) return;
    const rows = this.#audit.get(id) ?? [];
    rows.push({ ruleId: RULE_ID, at: Date.now(), ...data });
    this.#audit.set(id, rows.slice(-30));
  }
}
