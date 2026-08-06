import { MODULE_ID } from "../constants.mjs";
import { ProtectedTransactionDialogService } from "./protected-transaction-dialog-service.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";
import { SharedRollResolutionQueueService } from "./shared-roll-resolution-queue-service.mjs";

const RULE_ID = "bardic-inspiration-post-failure";
const SOURCE_IDENTIFIER = "bardic-inspiration";
const NATIVE_SOURCE_TOKENS = Object.freeze(["phbbrdbardicinsp"]);
const EFFECT_NAME_TOKEN = "bardic inspiration";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_CONSUME_REQUEST = "rulesAssistanceBardicInspirationConsume";
const SOCKET_CONSUME_RESPONSE = "rulesAssistanceBardicInspirationConsumeResult";
const RESPONSE_TIMEOUT_MS = 10000;
const OWNER_LEVEL = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

/**
 * Adds the missing post-failure choice for the native 2024 Bardic Inspiration
 * effect. The source Bard and the official class scale remain authoritative;
 * this layer only offers the recipient a choice, rolls the native die, and
 * consumes the already-applied effect when the recipient chooses to use it.
 */
export class BardicInspirationAssistanceService {
  static #hooksRef = null;
  static #socketReady = false;
  static #handledRolls = new WeakSet();
  static #effectLocks = new Set();
  static #consumedEffects = new Set();
  static #pendingResponses = new Map();
  static #audit = new Map();

  static initialize() {
    if (this.#hooksRef === globalThis.Hooks) return;
    this.#hooksRef = globalThis.Hooks;

    Hooks.on("dnd5e.postRollAttack", (rolls, data) => {
      void this.#enqueueRolls("attack", rolls, data).catch(error => this.#reportError(error));
    });
    Hooks.on("dnd5e.rollAbilityCheck", (rolls, data) => {
      void this.#enqueueRolls("ability", rolls, data).catch(error => this.#reportError(error));
    });
    Hooks.on("dnd5e.rollSkill", (rolls, data) => {
      void this.#enqueueRolls("skill", rolls, data).catch(error => this.#reportError(error));
    });
    Hooks.on("dnd5e.rollToolCheck", (rolls, data) => {
      void this.#enqueueRolls("tool", rolls, data).catch(error => this.#reportError(error));
    });
    Hooks.on("dnd5e.rollSavingThrow", (rolls, data) => {
      void this.#enqueueRolls("save", rolls, data).catch(error => this.#reportError(error));
    });
  }

  static async ready() {
    this.#initializeSocket();
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static diagnostics(actor) {
    const key = String(actor?.id ?? actor ?? "");
    return (this.#audit.get(key) ?? []).map(row => ({ ...row }));
  }

  static #initializeSocket() {
    if (this.#socketReady || !globalThis.game?.socket?.on) return;
    this.#socketReady = true;
    game.socket.on(SOCKET_CHANNEL, payload => {
      if (payload?.type === SOCKET_CONSUME_REQUEST && this.#isActiveGM()) {
        void this.#handleConsumeRequest(payload).catch(error => {
          console.warn(`${MODULE_ID} | GM Bardic Inspiration consume request failed.`, error);
          this.#sendConsumeResponse(payload, { ok: false, error: error.message });
        });
        return;
      }
      if (payload?.type !== SOCKET_CONSUME_RESPONSE) return;
      if (payload.requesterId !== game.user?.id) return;
      const pending = this.#pendingResponses.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pendingResponses.delete(payload.requestId);
      pending.resolve(payload);
    });
  }

  static async #enqueueRolls(kind, rolls, data) {
    const actor = data?.subject?.actor ?? data?.subject ?? null;
    if (!actor || !this.#isResponsibleClient(actor)) return;

    const candidates = (Array.isArray(rolls) ? rolls : [rolls]).filter(roll => {
      if (!roll || this.#handledRolls.has(roll)) return false;
      this.#handledRolls.add(roll);
      if (roll?.options?.dnd5eCharacterBuilderRulesAssistance?.[RULE_ID]) return false;
      return roll.isFailure === true && Number.isFinite(Number(roll.options?.target));
    });
    if (!candidates.length) return;

    return Promise.all(candidates.map(roll => {
      const actorUuid = actor.uuid ?? `Actor.${actor.id}`;
      const rollType = this.#structuredRollType(kind);
      const originalTotal = Number(roll.total ?? 0);
      const target = Number(roll.options.target);
      const pending = SharedRollResolutionQueueService.markPending({
        roll,
        actorUuid,
        rollType,
        originalTotal,
        currentTotal: originalTotal,
        target,
        succeeded: false
      });

      return SharedRollResolutionQueueService.enqueue({
        roll,
        rollKey: pending.rollKey,
        phase: "character",
        providerId: `${MODULE_ID}:${RULE_ID}`,
        actorUuid,
        rollType,
        originalTotal,
        currentTotal: originalTotal,
        target,
        succeeded: false,
        execute: async context => {
          try {
            if (this.enabled()) await this.#handleFailedRoll(kind, actor, roll, data);
          } catch (error) {
            this.#reportError(error);
          }

          const metadata = roll?.options?.dnd5eCharacterBuilderRulesAssistance?.[RULE_ID] ?? null;
          const resolvedOriginal = Number.isFinite(Number(metadata?.originalTotal))
            ? Number(metadata.originalTotal)
            : Number(context.originalTotal ?? originalTotal);
          const currentTotal = Number.isFinite(Number(metadata?.finalTotal))
            ? Number(metadata.finalTotal)
            : Number(context.currentTotal ?? resolvedOriginal);
          const succeeded = typeof metadata?.success === "boolean"
            ? metadata.success
            : (kind === "attack" && roll.isFumble ? false : currentTotal >= target);
          const adjustments = metadata?.used === true && Number.isFinite(Number(metadata.bonus))
            ? [{ source: "Bardic Inspiration", bonus: Number(metadata.bonus) }]
            : [];

          const finalized = SharedRollResolutionQueueService.finalize({
            roll,
            rollKey: pending.rollKey,
            actorUuid,
            rollType,
            originalTotal: resolvedOriginal,
            currentTotal,
            target,
            succeeded,
            adjustments
          });

          return {
            offered: metadata?.offered === true,
            used: metadata?.used === true,
            consumed: metadata?.consumed === true,
            bonus: Number(metadata?.bonus ?? 0),
            currentTotal: finalized.currentTotal,
            succeeded: finalized.succeeded,
            finalized: true,
            stop: false
          };
        }
      });
    }));
  }

  static async #handleFailedRoll(kind, actor, roll, data) {
    const inspiration = await this.#findNativeInspiration(actor);
    if (!inspiration) return false;

    const { effect, sourceActor, sourceItem } = inspiration;
    const lockKey = `${actor.uuid ?? actor.id}|${effect.id}`;
    if (this.#effectLocks.has(lockKey) || this.#consumedEffects.has(lockKey)) return false;

    const die = this.#resolveInspirationDie(sourceActor);
    if (!die) {
      this.#recordAudit(actor, {
        ruleId: RULE_ID,
        action: "Native Bardic Inspiration effect found, but the source Bard's die could not be resolved",
        effectId: effect.id ?? null,
        sourceActorId: sourceActor?.id ?? null,
        warning: true
      });
      return false;
    }

    if (!this.#canConsumeLocally(effect, actor) && !game.users?.activeGM) {
      ui.notifications.warn("Bardic Inspiration is available, but no active GM can authorize consuming the effect.");
      return false;
    }

    const use = await this.#confirmUse({ actor, sourceActor, die, kind, roll });
    if (!use) {
      const originalTotal = Number(roll.total ?? 0);
      const target = Number(roll.options.target);
      this.#markRoll(roll, {
        offered: true,
        used: false,
        consumed: false,
        effectId: effect.id ?? null,
        sourceActorId: sourceActor?.id ?? null,
        sourceItemId: sourceItem?.id ?? null,
        die: die.formula,
        bonus: 0,
        originalTotal,
        finalTotal: originalTotal,
        target,
        success: false
      });
      this.#recordAudit(actor, {
        ruleId: RULE_ID,
        action: "Player kept Bardic Inspiration after a failed D20 Test",
        effectId: effect.id ?? null,
        sourceActorId: sourceActor?.id ?? null,
        rollType: kind
      });
      return false;
    }

    this.#effectLocks.add(lockKey);
    try {
      const liveEffect = actor.effects?.get?.(effect.id)
        ?? this.#effects(actor).find(row => row.id === effect.id);
      if (!liveEffect || liveEffect.disabled || liveEffect.isSuppressed) {
        ui.notifications.warn("Bardic Inspiration is no longer available on this character.");
        return false;
      }

      const bonusRoll = await this.#rollDie(die.formula, actor, roll);
      const originalTotal = Number(roll.total ?? 0);
      const bonusTotal = Number(bonusRoll.total ?? 0);
      const finalTotal = originalTotal + bonusTotal;
      const target = Number(roll.options.target);
      const success = kind === "attack" && roll.isFumble ? false : finalTotal >= target;

      this.#consumedEffects.add(lockKey);
      const consumed = await this.#consumeEffect(liveEffect, actor);
      if (!consumed) {
        ui.notifications.error("Bardic Inspiration was rolled, but its effect could not be removed. Ask the GM to remove it manually.");
      }

      this.#markRoll(roll, {
        offered: true,
        used: true,
        consumed,
        effectId: effect.id ?? null,
        sourceActorId: sourceActor?.id ?? null,
        sourceItemId: sourceItem?.id ?? null,
        die: die.formula,
        bonus: bonusTotal,
        originalTotal,
        finalTotal,
        success
      });
      await this.#postResult({
        actor,
        sourceActor,
        roll,
        bonusRoll,
        kind,
        originalTotal,
        bonusTotal,
        finalTotal,
        success,
        consumed
      });
      this.#recordAudit(actor, {
        ruleId: RULE_ID,
        action: `Rolled ${die.formula} and ${consumed ? "consumed" : "could not consume"} native Bardic Inspiration`,
        effectId: effect.id ?? null,
        sourceActorId: sourceActor?.id ?? null,
        sourceItemId: sourceItem?.id ?? null,
        rollType: kind,
        originalTotal,
        bonus: bonusTotal,
        finalTotal,
        success,
        warning: !consumed
      });
      return true;
    } finally {
      this.#effectLocks.delete(lockKey);
    }
  }

  static async #confirmUse({ actor, sourceActor, die, kind, roll }) {
    const actorName = foundry.utils.escapeHTML(actor.name ?? "This character");
    const bardName = foundry.utils.escapeHTML(sourceActor?.name ?? "the source Bard");
    const rollLabel = foundry.utils.escapeHTML(this.#rollLabel(kind));
    const total = foundry.utils.escapeHTML(String(roll.total ?? ""));
    const dieLabel = foundry.utils.escapeHTML(die.formula);
    const content = `
      <section class="cb-bardic-inspiration-confirmation">
        <p><strong>${actorName}</strong> failed a ${rollLabel} with a total of <strong>${total}</strong>.</p>
        <p>A native Bardic Inspiration die from <strong>${bardName}</strong> is available: <strong>${dieLabel}</strong>.</p>
        <p>Use it now and remove the effect, or keep it for another failed D20 Test.</p>
      </section>`;

    return ProtectedTransactionDialogService.confirm({
      key: `bardic-inspiration:${actor.id}:${roll.parent?.id ?? foundry.utils.randomID?.(8) ?? Date.now()}`,
      matchClass: "cb-bardic-inspiration-dialog",
      dialogOptions: {
        classes: [
          "dnd5e-character-builder",
          "character-builder",
          "cb-protected-transaction-dialog",
          "cb-bardic-inspiration-dialog"
        ],
        window: { title: "Use Bardic Inspiration?", modal: true },
        content,
        yes: { label: `Use Bardic Inspiration (${die.formula})`, icon: "fa-solid fa-dice" },
        no: { label: "Keep Inspiration", icon: "fa-solid fa-shield-heart" }
      },
      fallback: () => globalThis.Dialog?.confirm?.({
        title: "Use Bardic Inspiration?",
        content,
        defaultYes: false
      }) ?? false
    });
  }

  static async #findNativeInspiration(actor) {
    for (const effect of this.#effects(actor)) {
      if (!effect || effect.disabled || effect.isSuppressed) continue;
      const effectKey = `${actor.uuid ?? actor.id}|${effect.id}`;
      if (this.#consumedEffects.has(effectKey)) continue;
      const source = await this.#resolveEffectSource(effect);
      if (!this.#isNativeBardicSource(source.item, effect)) continue;
      if (!source.actor || !this.#bardLevel(source.actor)) continue;
      return { effect, sourceActor: source.actor, sourceItem: source.item };
    }
    return null;
  }

  static async #resolveEffectSource(effect) {
    let sourceDocument = null;
    const origin = String(effect.origin ?? effect.getFlag?.("dnd5e", "dependentOn") ?? "");
    if (origin) {
      try {
        sourceDocument = await globalThis.fromUuid?.(origin);
      } catch (_error) {
        sourceDocument = globalThis.fromUuidSync?.(origin) ?? null;
      }
    }

    if (sourceDocument?.documentName === "ActiveEffect") {
      const item = sourceDocument.parent?.documentName === "Item" ? sourceDocument.parent : null;
      return { effect: sourceDocument, item, actor: item?.actor ?? item?.parent ?? null };
    }
    if (sourceDocument?.documentName === "Item") {
      return { effect: null, item: sourceDocument, actor: sourceDocument.actor ?? sourceDocument.parent ?? null };
    }

    const sourceId = String(effect.getFlag?.("dnd5e", "sourceId")
      ?? effect.flags?.dnd5e?.sourceId
      ?? effect._stats?.compendiumSource
      ?? "");
    if (sourceId) {
      try {
        const item = await globalThis.fromUuid?.(sourceId);
        if (item?.documentName === "Item") return { effect: null, item, actor: item.actor ?? item.parent ?? null };
      } catch (_error) {
        // The embedded effect still remains a valid candidate if its official source token is present.
      }
    }
    return { effect: null, item: null, actor: null };
  }

  static #isNativeBardicSource(item, effect) {
    const itemIdentifier = String(item?.system?.identifier ?? "").trim().toLowerCase();
    const itemSource = String(item?.getFlag?.("dnd5e", "sourceId")
      ?? item?.flags?.dnd5e?.sourceId
      ?? item?._stats?.compendiumSource
      ?? "").toLowerCase();
    const effectSource = String(effect?.getFlag?.("dnd5e", "sourceId")
      ?? effect?.flags?.dnd5e?.sourceId
      ?? effect?._stats?.compendiumSource
      ?? "").toLowerCase();
    const itemName = String(item?.name ?? "").trim().toLowerCase();
    const effectName = String(effect?.name ?? "").trim().toLowerCase();
    const rules = String(item?.system?.source?.rules ?? "").trim();

    if (item?.type && item.type !== "feat") return false;
    if (rules && rules !== "2024") return false;
    if (NATIVE_SOURCE_TOKENS.some(token => itemSource.includes(token) || effectSource.includes(token))) return true;
    return rules === "2024"
      && itemIdentifier === SOURCE_IDENTIFIER
      && (itemName.includes(EFFECT_NAME_TOKEN) || effectName.includes(EFFECT_NAME_TOKEN));
  }

  static #resolveInspirationDie(sourceActor) {
    const rollData = sourceActor?.getRollData?.() ?? {};
    const candidates = [
      foundry.utils.getProperty(rollData, "scale.bard.inspiration"),
      foundry.utils.getProperty(sourceActor, "system.scale.bard.inspiration"),
      foundry.utils.getProperty(rollData, "scale.bard.inspiration.die"),
      foundry.utils.getProperty(rollData, "scale.bard.bardicInspiration.die"),
      foundry.utils.getProperty(rollData, "scale.bard.bardic-inspiration.die"),
      foundry.utils.getProperty(sourceActor, "system.scale.bard.inspiration.die"),
      foundry.utils.getProperty(sourceActor, "system.scale.bard.bardicInspiration.die"),
      foundry.utils.getProperty(sourceActor, "system.scale.bard.bardic-inspiration.die")
    ];
    for (const candidate of candidates) {
      const parsed = this.#parseDie(candidate);
      if (parsed) return parsed;
    }

    const level = this.#bardLevel(sourceActor);
    if (!level) return null;
    const faces = level >= 15 ? 12 : level >= 10 ? 10 : level >= 5 ? 8 : 6;
    return { formula: `1d${faces}`, faces, source: "bard-level" };
  }

  static #parseDie(value, depth = 0) {
    if (value == null || depth > 4) return null;
    if (typeof value === "number" && Number.isFinite(value) && value >= 2) {
      return { formula: `1d${Math.trunc(value)}`, faces: Math.trunc(value), source: "scale" };
    }
    if (typeof value === "string") {
      const match = value.trim().match(/(?:(\d+)\s*)?d(\d+)/i);
      if (!match) return null;
      const number = Math.max(1, Number(match[1] ?? 1));
      const faces = Number(match[2]);
      if (!Number.isFinite(faces) || faces < 2) return null;
      return { formula: `${number}d${faces}`, faces, source: "scale" };
    }
    if (typeof value !== "object") return null;
    for (const key of ["die", "formula", "value", "faces", "denomination", "current"]) {
      const parsed = this.#parseDie(value[key], depth + 1);
      if (parsed) return parsed;
    }
    return null;
  }

  static #bardLevel(actor) {
    const direct = Number(actor?.classes?.bard?.system?.levels ?? actor?.classes?.bard?.levels ?? 0);
    if (direct > 0) return direct;
    const bardClass = this.#items(actor).find(item => item.type === "class"
      && String(item.system?.identifier ?? "").toLowerCase() === "bard");
    return Math.max(0, Number(bardClass?.system?.levels ?? 0));
  }

  static async #rollDie(formula, actor, originalRoll) {
    const RollClass = globalThis.Roll ?? CONFIG.Dice?.BasicRoll ?? foundry.dice?.Roll;
    if (!RollClass) throw new Error("Foundry Roll class is unavailable.");
    const roll = new RollClass(formula, actor.getRollData?.() ?? {}, {
      rollMode: originalRoll?.options?.rollMode,
      flavor: "Bardic Inspiration"
    });
    await roll.evaluate();
    return roll;
  }

  static async #postResult({
    actor, sourceActor, roll, bonusRoll, kind, originalTotal, bonusTotal, finalTotal, success, consumed
  }) {
    const resultLabel = success ? "Success" : "Still a Failure";
    const escapedActor = foundry.utils.escapeHTML(actor.name ?? "Character");
    const escapedBard = foundry.utils.escapeHTML(sourceActor?.name ?? "Bard");
    const escapedType = foundry.utils.escapeHTML(this.#rollLabel(kind));
    const flavor = `
      <section class="cb-bardic-inspiration-result">
        <p><strong>${escapedActor}</strong> used Bardic Inspiration from <strong>${escapedBard}</strong> on a failed ${escapedType}.</p>
        <p><strong>${originalTotal}</strong> + <strong>${bonusTotal}</strong> = <strong>${finalTotal}</strong> — <strong>${resultLabel}</strong></p>
        ${consumed ? "" : "<p><strong>Warning:</strong> the effect could not be removed automatically.</p>"}
      </section>`;
    const speaker = ChatMessage.getSpeaker({ actor });
    const rollMode = roll?.options?.rollMode ?? CONFIG.Dice?.BasicRoll?.getMessageMode?.();
    const messageData = {
      speaker,
      flavor,
      flags: {
        [MODULE_ID]: {
          rulesAssistance: {
            bardicInspiration: {
              originalMessageId: roll.parent?.id ?? null,
              originalTotal,
              bonus: bonusTotal,
              finalTotal,
              success,
              consumed,
              sourceActorId: sourceActor?.id ?? null
            }
          }
        }
      }
    };
    if (typeof bonusRoll.toMessage === "function") {
      await bonusRoll.toMessage(messageData, { rollMode });
      return;
    }
    await ChatMessage.create({ ...messageData, rolls: [bonusRoll] }, { rollMode });
  }

  static async #consumeEffect(effect, actor) {
    if (this.#canConsumeLocally(effect, actor)) {
      try {
        await effect.delete({ characterBuilderRulesAssistance: true, bardicInspirationConsumed: true });
        return true;
      } catch (error) {
        console.warn(`${MODULE_ID} | Local Bardic Inspiration effect deletion failed.`, error);
      }
    }

    const activeGM = game.users?.activeGM;
    if (!activeGM) return false;
    const requestId = foundry.utils.randomID?.(24) ?? crypto.randomUUID();
    const response = new Promise(resolve => {
      const timeout = setTimeout(() => {
        this.#pendingResponses.delete(requestId);
        resolve({ ok: false, error: "The active GM did not complete the effect removal request." });
      }, RESPONSE_TIMEOUT_MS);
      this.#pendingResponses.set(requestId, { resolve, timeout });
    });
    game.socket.emit(SOCKET_CHANNEL, {
      type: SOCKET_CONSUME_REQUEST,
      requestId,
      requesterId: game.user?.id ?? null,
      actorUuid: actor.uuid ?? `Actor.${actor.id}`,
      effectId: effect.id
    });
    const result = await response;
    return result?.ok === true;
  }

  static async #handleConsumeRequest(payload) {
    if (!this.enabled()) return this.#sendConsumeResponse(payload, { ok: false, error: "Rule disabled." });
    const requester = game.users?.get?.(payload.requesterId);
    const actor = await globalThis.fromUuid?.(payload.actorUuid);
    if (!requester || !actor?.testUserPermission?.(requester, OWNER_LEVEL)) {
      return this.#sendConsumeResponse(payload, { ok: false, error: "Requester does not own the Actor." });
    }
    const effect = actor.effects?.get?.(payload.effectId);
    if (!effect) return this.#sendConsumeResponse(payload, { ok: true, alreadyRemoved: true });
    const source = await this.#resolveEffectSource(effect);
    if (!this.#isNativeBardicSource(source.item, effect) || !source.actor || !this.#bardLevel(source.actor)) {
      return this.#sendConsumeResponse(payload, { ok: false, error: "Effect is not a native Bardic Inspiration." });
    }
    await effect.delete({ characterBuilderRulesAssistance: true, bardicInspirationConsumed: true });
    this.#sendConsumeResponse(payload, { ok: true });
  }

  static #sendConsumeResponse(request, result) {
    game.socket.emit(SOCKET_CHANNEL, {
      type: SOCKET_CONSUME_RESPONSE,
      requestId: request.requestId,
      requesterId: request.requesterId,
      gmUserId: game.user?.id ?? null,
      ...result
    });
  }

  static #canConsumeLocally(effect, actor) {
    return Boolean(game.user?.isGM || effect?.isOwner || actor?.isOwner);
  }

  static #isActiveGM() {
    return Boolean(game.user?.isGM && game.user?.active && game.users?.activeGM?.id === game.user.id);
  }

  static #isResponsibleClient(actor) {
    if (!game.user?.active || !actor?.isOwner) return false;
    const users = game.users?.contents ?? Array.from(game.users ?? []);
    const activePlayerOwners = users
      .filter(user => user.active && !user.isGM && actor.testUserPermission?.(user, OWNER_LEVEL))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    if (activePlayerOwners.length) return game.user.id === activePlayerOwners[0].id;
    return Boolean(game.user.isGM && game.users?.activeGM?.id === game.user.id);
  }

  static #markRoll(roll, metadata) {
    roll.options ??= {};
    roll.options.dnd5eCharacterBuilderRulesAssistance ??= {};
    roll.options.dnd5eCharacterBuilderRulesAssistance[RULE_ID] = {
      at: Date.now(),
      ...metadata
    };
  }

  static #structuredRollType(kind) {
    return {
      attack: "attackRoll",
      ability: "abilityCheck",
      skill: "skillCheck",
      tool: "toolCheck",
      save: "savingThrow"
    }[kind] ?? "d20Test";
  }

  static #rollLabel(kind) {
    return {
      attack: "attack roll",
      ability: "ability check",
      skill: "skill check",
      tool: "tool check",
      save: "saving throw"
    }[kind] ?? "D20 Test";
  }

  static #effects(actor) {
    if (!actor?.effects) return [];
    if (Array.isArray(actor.effects)) return actor.effects;
    if (Array.isArray(actor.effects.contents)) return actor.effects.contents;
    return [...actor.effects];
  }

  static #items(actor) {
    if (!actor?.items) return [];
    if (Array.isArray(actor.items)) return actor.items;
    if (Array.isArray(actor.items.contents)) return actor.items.contents;
    return [...actor.items];
  }

  static #recordAudit(actor, entry) {
    if (!actor?.id) return;
    const key = String(actor.id);
    const rows = this.#audit.get(key) ?? [];
    rows.push({ at: Date.now(), ...entry });
    this.#audit.set(key, rows.slice(-50));
  }

  static #reportError(error) {
    console.warn(`${MODULE_ID} | Bardic Inspiration post-failure assistance failed.`, error);
  }
}

export { RULE_ID as BARDIC_INSPIRATION_ASSISTANCE_RULE_ID };
