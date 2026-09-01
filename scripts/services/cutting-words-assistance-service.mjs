import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";
import { RecentRollRegistryService } from "./recent-roll-registry-service.mjs";

const RULE_ID = "cutting-words-reaction";
const SOURCE_IDENTIFIER = "cutting-words";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_DAMAGE_REQUEST = "cuttingWordsDamageReduction";
const SOCKET_DAMAGE_ACCEPTED = "cuttingWordsDamageAccepted";
const OWNER_LEVEL = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
const PENDING_MS = 60000;

/**
 * Manual Cutting Words assistance. The Bard chooses when to use the native
 * Activity. No success/failure popup is generated. Hostile targets bind to the
 * most recent eligible D20 roll; friendly targets bind to the most recent
 * damage message and reduce its final calculated damage immediately before HP.
 */
export class CuttingWordsAssistanceService {
  static #initialized = false;
  static #socketReady = false;
  static #pendingUses = new Map();
  static #gmPendingDamage = [];
  static #audit = new Map();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    RecentRollRegistryService.initialize();
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => this.#captureUse(activity, usageConfig));
    Hooks.on("dnd5e.rollFormula", (rolls, data) => {
      void this.#resolveFormula(rolls, data).catch(error => this.#report(error));
    });
    Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) =>
      this.#applyPendingDamage(actor, amount, updates, options)
    );
  }

  static ready() {
    this.#initializeSocket();
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static diagnostics(actor) {
    const key = String(actor?.id ?? actor ?? "");
    return (this.#audit.get(key) ?? []).map(row => ({ ...row }));
  }

  static #captureUse(activity) {
    if (!this.enabled() || !this.#isCuttingWords(activity)) return;
    const targetToken = Array.from(game.user?.targets ?? [])[0];
    if (!targetToken || (game.user?.targets?.size ?? 0) !== 1) {
      ui.notifications.warn("Cutting Words requires exactly one target.");
      return false;
    }

    const targetActor = targetToken.actor;
    if (!targetActor) return false;
    const friendly = this.#isFriendlyTarget(activity.actor, targetToken);
    const recent = friendly
      ? RecentRollRegistryService.latestDamage({ maxAgeMs: PENDING_MS })
      : RecentRollRegistryService.latestD20(targetActor.uuid ?? `Actor.${targetActor.id}`, { maxAgeMs: PENDING_MS });
    if (!recent) {
      ui.notifications.warn(friendly
        ? "No recent damage roll is available for Cutting Words."
        : "No recent eligible Attack Roll or Ability Check is available for that target.");
      return false;
    }

    const key = this.#pendingKey(activity);
    this.#pendingUses.set(key, {
      actorUuid: activity.actor?.uuid ?? null,
      activityUuid: activity.uuid ?? null,
      targetActorUuid: targetActor.uuid ?? `Actor.${targetActor.id}`,
      targetName: targetActor.name,
      mode: friendly ? "damage" : "d20",
      recent,
      at: Date.now()
    });
  }

  static async #resolveFormula(rolls, data) {
    if (!this.enabled()) return;
    const activity = data?.subject;
    if (!this.#isCuttingWords(activity)) return;
    const key = this.#pendingKey(activity);
    const pending = this.#pendingUses.get(key);
    this.#pendingUses.delete(key);
    if (!pending || (Date.now() - pending.at > PENDING_MS)) return;

    const reduction = Number(Array.from(rolls ?? [])[0]?.total);
    if (!Number.isFinite(reduction) || reduction < 0) return;
    if (pending.mode === "d20") {
      const original = Number(pending.recent.currentTotal ?? pending.recent.total ?? 0);
      const adjusted = original - reduction;
      const rollLabel = this.#rollLabel(pending.recent.rollType);
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: activity.actor }),
        flavor: `${foundry.utils.escapeHTML(activity.item?.name ?? "Cutting Words")} — Roll Adjustment`,
        content: `<div class="dnd5e chat-card"><p><strong>${foundry.utils.escapeHTML(pending.targetName ?? "Target")}</strong> — ${foundry.utils.escapeHTML(rollLabel)}</p><p>Resolved total: <strong>${original}</strong></p><p>Cutting Words: <strong>−${reduction}</strong></p><p>Adjusted total: <strong>${adjusted}</strong></p><p class="notes">Success or failure remains for the GM to adjudicate.</p></div>`,
        flags: {
          [MODULE_ID]: {
            cuttingWords: {
              mode: "d20",
              originalMessageId: pending.recent.messageId,
              targetActorUuid: pending.targetActorUuid,
              originalTotal: original,
              reduction,
              adjustedTotal: adjusted
            }
          }
        }
      });
      this.#record(activity.actor, {
        action: "Adjusted recent D20 roll",
        targetActorUuid: pending.targetActorUuid,
        original,
        reduction,
        adjusted
      });
      return;
    }

    const request = {
      type: SOCKET_DAMAGE_REQUEST,
      requesterId: game.user?.id ?? null,
      bardActorUuid: activity.actor?.uuid ?? null,
      cuttingWordsItemUuid: activity.item?.uuid ?? null,
      targetActorUuid: pending.targetActorUuid,
      targetName: pending.targetName,
      damageMessageId: pending.recent.messageId,
      reduction,
      at: Date.now()
    };
    if (this.#isActiveGM()) this.#acceptDamageRequest(request);
    else game.socket?.emit?.(SOCKET_CHANNEL, request);
    ui.notifications.info(`Cutting Words will reduce the pending damage to ${pending.targetName} by ${reduction}.`);
    this.#record(activity.actor, {
      action: "Armed final damage reduction",
      targetActorUuid: pending.targetActorUuid,
      damageMessageId: pending.recent.messageId,
      reduction
    });
  }

  static #initializeSocket() {
    if (this.#socketReady || !globalThis.game?.socket?.on) return;
    this.#socketReady = true;
    game.socket.on(SOCKET_CHANNEL, payload => {
      if (payload?.type === SOCKET_DAMAGE_REQUEST && this.#isActiveGM()) {
        this.#acceptDamageRequest(payload);
        return;
      }
      if (payload?.type === SOCKET_DAMAGE_ACCEPTED) {
        const activeGmId = game.users?.activeGM?.id ?? null;
        if (!activeGmId || payload.gmId !== activeGmId) return;
        this.#storeDamagePending(payload);
      }
    });
  }

  static #acceptDamageRequest(payload) {
    if (!this.enabled()) return;
    const requester = game.users?.get?.(payload.requesterId);
    const bard = globalThis.fromUuidSync?.(payload.bardActorUuid, { strict: false });
    const item = globalThis.fromUuidSync?.(payload.cuttingWordsItemUuid, { strict: false });
    const target = globalThis.fromUuidSync?.(payload.targetActorUuid, { strict: false });
    const reduction = Number(payload.reduction);
    if (!requester || !bard || !target || !Number.isFinite(reduction) || reduction < 0) return;
    if (!bard.testUserPermission?.(requester, OWNER_LEVEL)) return;
    if (item?.actor?.uuid !== bard.uuid || item?.system?.identifier !== SOURCE_IDENTIFIER) return;
    const accepted = {
      type: SOCKET_DAMAGE_ACCEPTED,
      gmId: game.user?.id ?? null,
      bardActorUuid: bard.uuid,
      targetActorUuid: target.uuid,
      damageMessageId: payload.damageMessageId ?? null,
      reduction,
      at: Date.now()
    };
    this.#storeDamagePending(accepted);
    game.socket?.emit?.(SOCKET_CHANNEL, accepted);
  }

  static #storeDamagePending(payload) {
    const reduction = Number(payload?.reduction);
    if (!payload?.targetActorUuid || !Number.isFinite(reduction) || reduction < 0) return;
    this.#pruneGmPending();
    const key = `${payload.targetActorUuid}:${payload.damageMessageId ?? ""}:${payload.bardActorUuid ?? ""}`;
    const existing = this.#gmPendingDamage.findIndex(row =>
      `${row.targetActorUuid}:${row.damageMessageId ?? ""}:${row.bardActorUuid ?? ""}` === key
    );
    const row = {
      bardActorUuid: payload.bardActorUuid ?? null,
      targetActorUuid: payload.targetActorUuid,
      damageMessageId: payload.damageMessageId ?? null,
      reduction,
      at: Number(payload.at) || Date.now()
    };
    if (existing >= 0) this.#gmPendingDamage.splice(existing, 1, row);
    else this.#gmPendingDamage.push(row);
  }

  static #applyPendingDamage(actor, amount, updates, options) {
    if (!this.enabled() || !(Number(amount) > 0)) return;
    this.#pruneGmPending();
    const originId = options?.origin?.id ?? options?.origin?._id ?? null;
    const index = this.#gmPendingDamage.findIndex(row => row.targetActorUuid === actor.uuid
      && (!row.damageMessageId || !originId || row.damageMessageId === originId));
    if (index < 0) return;
    const [pending] = this.#gmPendingDamage.splice(index, 1);
    const originalAmount = Number(amount);
    const adjustedAmount = Math.max(0, originalAmount - pending.reduction);
    this.#rewriteHpUpdates(actor, adjustedAmount, updates);
    options.dnd5eCharacterBuilderCuttingWords = {
      originalAmount,
      reduction: pending.reduction,
      adjustedAmount,
      bardActorUuid: pending.bardActorUuid,
      targetActorUuid: pending.targetActorUuid,
      damageMessageId: pending.damageMessageId
    };
    void ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: "Cutting Words — Final Damage Reduction",
      content: `<div class="dnd5e chat-card"><p>${originalAmount} − ${pending.reduction} = <strong>${adjustedAmount}</strong> damage to ${foundry.utils.escapeHTML(actor.name)}.</p></div>`,
      flags: { [MODULE_ID]: { cuttingWords: foundry.utils.deepClone(options.dnd5eCharacterBuilderCuttingWords) } }
    });
    this.#record(actor, {
      action: "Reduced final pending damage before HP",
      originalAmount,
      reduction: pending.reduction,
      adjustedAmount
    });
  }

  static #rewriteHpUpdates(actor, adjustedAmount, updates) {
    const hp = actor.system?.attributes?.hp;
    const hpSource = actor.system?._source?.attributes?.hp ?? hp;
    if (!hp || !updates) return;
    const tempMaxDelta = Number(hpSource?.tempmax ?? 0) - Number(updates["system.attributes.hp.tempmax"] ?? hpSource?.tempmax ?? 0);
    const nativeTempUpdate = Number(updates["system.attributes.hp.temp"] ?? 0);
    const deltaTemp = adjustedAmount > 0 ? Math.min(Number(hp.temp ?? 0), adjustedAmount) : 0;
    const maxHpDamage = Number(hp.damage ?? Math.max(0, Number(hp.max ?? 0) - Number(hp.value ?? 0)));
    const deltaHP = Math.clamp(
      adjustedAmount - deltaTemp,
      -maxHpDamage + tempMaxDelta,
      Number(hp.value ?? 0) - tempMaxDelta
    );
    // Preserve any temporary-HP grant D&D5e already folded into the native
    // update while allowing the smaller adjusted damage to leave more current
    // temporary HP unspent.
    updates["system.attributes.hp.temp"] = Math.max(Number(hp.temp ?? 0) - deltaTemp, nativeTempUpdate);
    updates["system.attributes.hp.tempmax"] = Number(hpSource?.tempmax ?? 0) - tempMaxDelta;
    updates["system.attributes.hp.value"] = Number(hp.value ?? 0) - deltaHP;
  }

  static #isCuttingWords(activity) {
    return activity?.item?.system?.identifier === SOURCE_IDENTIFIER && activity.type === "utility";
  }

  static #pendingKey(activity) {
    return `${activity?.actor?.uuid ?? ""}:${activity?.uuid ?? activity?.id ?? ""}`;
  }

  static #isFriendlyTarget(actor, targetToken) {
    const dispositions = globalThis.CONST?.TOKEN_DISPOSITIONS ?? {};
    if (targetToken?.actor?.uuid === actor?.uuid) return true;
    const targetDisposition = targetToken?.document?.disposition ?? targetToken?.disposition;
    if (targetDisposition === dispositions.FRIENDLY) return true;
    const sourceToken = actor?.getActiveTokens?.(true, true)?.[0];
    const sourceDisposition = sourceToken?.document?.disposition ?? sourceToken?.disposition;
    return sourceDisposition != null && targetDisposition != null && sourceDisposition === targetDisposition
      && targetDisposition !== dispositions.HOSTILE;
  }

  static #pruneGmPending() {
    const cutoff = Date.now() - PENDING_MS;
    this.#gmPendingDamage = this.#gmPendingDamage.filter(row => row.at >= cutoff);
  }

  static #isActiveGM() {
    return Boolean(game.user?.isGM && game.user?.active && game.users?.activeGM?.id === game.user.id);
  }

  static #rollLabel(type) {
    switch (String(type ?? "")) {
      case "attack": return "Attack Roll";
      case "ability": return "Ability Check";
      case "skill": return "Skill Check";
      case "tool": return "Tool Check";
      default: return "D20 Roll";
    }
  }

  static #record(actor, row) {
    const key = String(actor?.id ?? "");
    if (!key) return;
    const rows = this.#audit.get(key) ?? [];
    rows.push({ ruleId: RULE_ID, at: Date.now(), ...row });
    this.#audit.set(key, rows.slice(-50));
  }

  static #report(error) {
    console.warn(`${MODULE_ID} | Cutting Words assistance failed.`, error);
  }
}
