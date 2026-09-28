import { MODULE_ID, MODULE_VERSION } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";
import { PrimalCompanionAssistanceService } from "./primal-companion-assistance-service.mjs";
import { FindSteedAssistanceService } from "./find-steed-assistance-service.mjs";

const RULE_ID = "managed-summons";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REQUEST = "managedSummonsRequestV1";
const SOCKET_CLEANUP = "managedSummonsConcentrationCleanupV1";
const MANAGED_KIND = "managed-summon";
const FLAG_KEY = "managedSummon";
const DECISION_FLAG_KEY = "managedSummonDecision";
const ACTION_RESOLVE_DECISION = "resolve-managed-summon-decision";
const DEFAULT_POLICY = Object.freeze({ policyId: "native-summon", exclusive: false });

function normalizedSourceIdentity(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sourceIdentityMatches(activity, expected) {
  const item = activity?.item ?? null;
  if (!item) return false;
  const identities = new Set([
    item?.system?.identifier,
    item?.identifier,
    item?.name
  ].map(normalizedSourceIdentity).filter(Boolean));
  return expected.some(value => identities.has(normalizedSourceIdentity(value)));
}

// Source-specific policies are intentionally narrow. Generic native summons
// remain non-exclusive unless their D&D rule explicitly requires one active
// instance per caster/source. This avoids turning Managed Summons into a
// replacement for D&D5e's own quantity and concentration lifecycle.
const FIND_FAMILIAR_POLICY = Object.freeze({
  policyId: "find-familiar",
  exclusive: true,
  enabled: () => true,
  matches: activity => sourceIdentityMatches(activity, ["find-familiar", "Find Familiar"])
});

const MAGE_HAND_POLICY = Object.freeze({
  policyId: "mage-hand",
  exclusive: true,
  enabled: () => true,
  matches: activity => sourceIdentityMatches(activity, ["mage-hand", "Mage Hand"])
});

/**
 * Generic administrative lifecycle for native D&D5e Summon Activities.
 *
 * D&D5e remains authoritative for placement, quantity, profiles, ActorDelta,
 * attacks, damage, AC, PB, derived statistics, and concentration itself. This
 * service starts only after dnd5e.postSummon and materializes each finalized
 * synthetic summon as its own linked Actor so ownership and lifecycle can be
 * managed without modifying the source profile Actor.
 */
export class ManagedSummonsService {
  static #initialized = false;
  static #socketReady = false;
  static #executing = new Set();
  static #cleaning = new Set();
  static #confirmedConcentrationEnds = new Set();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    Hooks.on("dnd5e.postSummon", (activity, profile, createdTokens, options) => {
      void this.#afterSummon(activity, profile, createdTokens, options).catch(error => {
        console.warn(`${MODULE_ID} | Managed Summons post-summon lifecycle failed.`, error);
        ui.notifications?.error?.(`Managed Summons failed: ${error.message}`);
      });
    });

    Hooks.on("renderChatMessageHTML", (message, element) => this.#decorateDecisionMessage(message, element));

    Hooks.on("updateActor", (actor, changes, options, userId) => {
      void this.#onManagedActorUpdated(actor, changes, options, userId).catch(error => {
        console.warn(`${MODULE_ID} | Managed Summons zero-HP lifecycle failed.`, error);
      });
    });

    // Managed Summons never decides that Concentration has ended. It reacts
    // only to D&D5e's canonical post-end hook after the effect is truly gone.
    Hooks.on("dnd5e.endConcentration", (_actor, effect) => {
      this.#onConfirmedConcentrationEnd(effect, "dnd5e.endConcentration");
    });

    // Foundry v14's ActiveEffectRegistry owns finite World-Time expiry. When
    // it deletes a concentration effect directly, D&D5e's endConcentration()
    // method is intentionally not called. This post-delete hook is therefore
    // a confirmation bridge only: Character Builder never deletes or expires
    // the effect itself, it merely lets Managed Summons react after the
    // concentrating ActiveEffect is already gone.
    Hooks.on("deleteActiveEffect", (effect, _options, userId) => {
      if (userId !== game.user?.id) return;
      if (!this.#isConcentrationEffect(effect)) return;
      this.#onConfirmedConcentrationEnd(effect, "deleteActiveEffect");
    });

    // Token presence is not summon existence. Manual Scene deletion, Scene cleanup,
    // or moving between Scenes must not destroy the persistent managed Actor.
    // Managed Actors are deleted only by explicit source lifecycle paths below:
    // confirmed concentration ending, known exclusive replacement, or a GM
    // decision for an ambiguous duplicate/zero-HP lifecycle.
  }

  static ready() {
    if (this.#socketReady || !globalThis.game?.socket?.on) return;
    this.#socketReady = true;
    game.socket.on(SOCKET_CHANNEL, payload => {
      if (!this.#isActiveGM()) return;
      if (payload?.type === SOCKET_REQUEST) {
        void this.#execute(payload).catch(error => {
          console.warn(`${MODULE_ID} | Managed Summons GM request failed.`, error);
        });
      } else if (payload?.type === SOCKET_CLEANUP) {
        void this.#cleanupConcentration(String(payload?.concentrationUuid ?? "")).catch(error => {
          console.warn(`${MODULE_ID} | Managed Summons GM concentration cleanup failed.`, error);
        });
      }
    });

    if (this.#isActiveGM()) {
      setTimeout(() => {
        void this.#recoverZeroHpDecisions().catch(error => {
          console.warn(`${MODULE_ID} | Managed Summons zero-HP recovery scan failed.`, error);
        });
      }, 750);
    }
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static async #afterSummon(activity, profile, createdTokens, _options) {
    if (!this.enabled()) return;
    const summoner = activity?.actor ?? activity?.item?.actor;
    const tokens = [...(createdTokens ?? [])].filter(token => token?.id && token?.parent?.id && token?.actor);
    if (!summoner?.id || !tokens.length) return;

    const sourceItem = activity?.item ?? null;
    const policy = this.#policyForActivity(activity);
    const policyId = policy.policyId;
    const concentration = this.#concentrationForSourceItem(summoner, sourceItem);
    const instanceId = foundry.utils.randomID?.(24) ?? crypto.randomUUID();
    const payload = {
      requesterId: game.user?.id ?? null,
      summonerActorId: summoner.id,
      summonerActorUuid: summoner.uuid ?? null,
      tokenUuids: tokens.map(token => token.uuid),
      sourceItemUuid: sourceItem?.uuid ?? null,
      sourceFeatureUuid: sourceItem?.uuid ?? null,
      sourceItemName: sourceItem?.name ?? null,
      activityId: String(activity?.id ?? ""),
      activityName: String(activity?.name ?? ""),
      profileId: String(profile?.id ?? profile?._id ?? ""),
      profileName: String(profile?.name ?? profile?.label ?? ""),
      profileSourceUuids: this.#profileSourceUuids(activity),
      policyId,
      instanceId,
      concentrationUuid: concentration?.uuid ?? null
    };

    if (this.#isActiveGM()) return this.#execute(payload);
    const activeGM = this.#activeGM();
    if (!activeGM) {
      ui.notifications?.warn?.("Summons were created, but a connected GM is required to finish Managed Summons ownership and lifecycle setup.");
      return;
    }
    game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_REQUEST, ...payload });
  }

  static async #execute(request) {
    if (!this.enabled() || !this.#isActiveGM()) return;
    const requestKey = `${request?.summonerActorId ?? ""}:${request?.instanceId ?? ""}:${(request?.tokenUuids ?? []).join(",")}`;
    if (!requestKey || this.#executing.has(requestKey)) return;
    this.#executing.add(requestKey);

    try {
      const summoner = await this.#resolveSummoner(request);
      const requester = game.users?.get?.(String(request?.requesterId ?? ""));
      if (!summoner || !requester) throw new Error("The summoner or requesting user could not be resolved.");
      if (!requester.isGM && !summoner.testUserPermission?.(requester, "OWNER")) {
        throw new Error("The requesting user does not own the Actor that created these summons.");
      }

      const tokenDocs = [];
      for (const uuid of request?.tokenUuids ?? []) {
        const token = await fromUuid(uuid);
        if (token?.documentName === "Token" && token.actor) tokenDocs.push(token);
      }
      if (!tokenDocs.length) return;

      const keepActorIds = new Set();
      const keepTokenUuids = new Set(tokenDocs.map(token => String(token.uuid)));
      const nativeBases = new Set();
      const policy = this.#policyById(request?.policyId);
      const effectiveRequest = { ...request, policyId: policy.policyId };

      for (const token of tokenDocs) {
        const synthetic = token.actor;
        const baseActor = game.actors?.get?.(String(token.actorId ?? "")) ?? token.baseActor ?? null;
        if (baseActor?.id) nativeBases.add(baseActor);

        const managed = await this.#createManagedActor({ summoner, synthetic, token, request: effectiveRequest, policy });
        keepActorIds.add(managed.id);

        // A linked Token needs only the new Actor id. Never write a partial
        // ActorDelta back into Foundry 14's complete embedded ActorDelta schema.
        await token.update({ actorId: managed.id, actorLink: true }, {
          characterBuilderManagedSummon: true,
          managedSummonInstanceId: effectiveRequest.instanceId
        });
      }

      if (policy.exclusive === true) {
        await this.#removePreviousExclusiveInstances({
          summoner,
          keepActorIds,
          keepTokenUuids,
          sourceFeatureUuid: effectiveRequest?.sourceFeatureUuid,
          policyId: effectiveRequest.policyId
        });
      } else if (!effectiveRequest?.concentrationUuid && policy.policyId === DEFAULT_POLICY.policyId) {
        const previous = this.#previousSameSourceActors({
          summoner,
          sourceItemUuid: effectiveRequest?.sourceItemUuid,
          activityId: effectiveRequest?.activityId,
          instanceId: effectiveRequest?.instanceId,
          keepActorIds
        });
        if (previous.length) {
          await this.#requestDuplicateDecision({
            summoner,
            request: effectiveRequest,
            currentActorIds: [...keepActorIds],
            previousActors: previous
          });
        }
      }

      for (const baseActor of nativeBases) await this.#removeOrphanedNativeBase(baseActor);
      await this.#removeOrphanedProfileImports(effectiveRequest?.profileSourceUuids ?? []);
    } finally {
      this.#executing.delete(requestKey);
    }
  }

  static async #createManagedActor({ summoner, synthetic, token, request, policy }) {
    const data = synthetic.toObject?.() ?? foundry.utils.deepClone(synthetic?._source ?? {});
    delete data._id;
    delete data.folder;
    delete data.sort;
    delete data._stats;
    data.name = token?.name ?? synthetic.name;
    data.ownership = this.#ownershipFromSummoner(summoner);
    data.prototypeToken ??= {};
    data.prototypeToken.actorLink = true;
    data.prototypeToken.name = data.name;

    policy?.prepareManagedActorData?.(data, synthetic);

    const metadata = {
      version: 2,
      policyId: String(request?.policyId ?? "native-summon"),
      instanceId: String(request?.instanceId ?? ""),
      sourceKey: this.#sourceKey({
        summonerActorUuid: summoner.uuid ?? summoner.id,
        sourceItemUuid: request?.sourceItemUuid,
        activityId: request?.activityId
      }),
      summonerActorId: summoner.id,
      summonerActorUuid: summoner.uuid ?? null,
      sourceItemUuid: request?.sourceItemUuid ?? null,
      sourceItemName: request?.sourceItemName ?? null,
      activityId: request?.activityId ?? null,
      activityName: request?.activityName ?? null,
      profileId: request?.profileId ?? null,
      profileName: request?.profileName ?? null,
      concentrationUuid: request?.concentrationUuid ?? null,
      nativeTokenUuid: token?.uuid ?? null,
      moduleVersion: MODULE_VERSION,
      createdAt: Date.now()
    };

    if (request?.policyId === PrimalCompanionAssistanceService.policyId) {
      metadata.companionType = PrimalCompanionAssistanceService.companionType(request?.profileName, token?.name);
    }

    data.flags ??= {};
    data.flags[MODULE_ID] = {
      ...(data.flags[MODULE_ID] ?? {}),
      managedKind: request?.policyId === PrimalCompanionAssistanceService.policyId ? "primal-companion" : MANAGED_KIND,
      [FLAG_KEY]: metadata,
      moduleVersion: MODULE_VERSION,
      // Preserve the X3 compatibility keys so the first X4 summon can clean
      // existing Primal Companion Actors created by the stable baseline.
      ...(request?.policyId === PrimalCompanionAssistanceService.policyId ? {
        rangerActorId: summoner.id,
        sourceFeatureUuid: request?.sourceFeatureUuid ?? null,
        activityId: request?.activityId ?? null,
        profileId: request?.profileId ?? null,
        companionType: metadata.companionType ?? "unknown",
        createdAt: metadata.createdAt
      } : {})
    };

    const folder = await this.#managedFolder(summoner);
    data.folder = folder?.id ?? null;
    const managed = await Actor.create(data, {
      renderSheet: false,
      characterBuilderManagedSummon: true,
      managedSummonInstanceId: request?.instanceId ?? null,
      summonerActorId: summoner.id
    });
    if (!managed) throw new Error("Character Builder could not create a managed summon Actor.");
    await this.#reconcileFreshHitPoints(managed);
    return managed;
  }

  static #sourceKey({ summonerActorUuid, sourceItemUuid, activityId } = {}) {
    const summoner = String(summonerActorUuid ?? "").trim();
    const source = String(sourceItemUuid ?? "").trim();
    const activity = String(activityId ?? "").trim();
    if (!summoner || !source || !activity) return "";
    return `${summoner}::${source}::${activity}`;
  }

  static async #reconcileFreshHitPoints(actor) {
    if (!actor?.id) return;
    const hpMax = Number(actor.system?.attributes?.hp?.max ?? 0);
    const hpValue = Number(actor.system?.attributes?.hp?.value ?? 0);
    if (!Number.isFinite(hpMax) || hpMax <= 0 || !Number.isFinite(hpValue) || hpValue === hpMax) return;

    // The native Summon Activity has already resolved profile, ActorDelta,
    // spell-slot scaling, Effects, and every derived bonus. Managed Summons
    // only reconciles a fresh instance to that final maximum. SET, never ADD.
    await actor.update({ "system.attributes.hp.value": hpMax }, {
      characterBuilderManagedSummon: true,
      managedSummonFreshHpReconcile: true
    });
  }

  static #previousSameSourceActors({ summoner, sourceItemUuid, activityId, instanceId, keepActorIds = new Set() } = {}) {
    const source = String(sourceItemUuid ?? "").trim();
    const activity = String(activityId ?? "").trim();
    if (!summoner?.id || !source || !activity) return [];

    return [...(game.actors ?? [])].filter(actor => {
      if (!actor?.id || keepActorIds.has(actor.id)) return false;
      const metadata = actor.getFlag?.(MODULE_ID, FLAG_KEY);
      if (!metadata) return false;
      if (String(metadata.summonerActorId ?? "") !== String(summoner.id)) return false;
      if (String(metadata.sourceItemUuid ?? "") !== source) return false;
      if (String(metadata.activityId ?? "") !== activity) return false;
      if (instanceId && String(metadata.instanceId ?? "") === String(instanceId)) return false;
      return true;
    });
  }

  static async #requestDuplicateDecision({ summoner, request, currentActorIds, previousActors } = {}) {
    if (!this.#isActiveGM() || !previousActors?.length || !currentActorIds?.length) return null;
    const currentInstanceId = String(request?.instanceId ?? "");
    const existing = [...(game.messages ?? [])].find(message => {
      const row = message.getFlag?.(MODULE_ID, DECISION_FLAG_KEY);
      return row?.type === "duplicate-source"
        && row?.status === "pending"
        && String(row?.currentInstanceId ?? "") === currentInstanceId;
    });
    if (existing) return existing;

    const decision = {
      version: 1,
      id: foundry.utils.randomID?.(24) ?? crypto.randomUUID(),
      type: "duplicate-source",
      status: "pending",
      summonerActorId: summoner.id,
      summonerActorUuid: summoner.uuid ?? null,
      summonerName: summoner.name ?? "Summoner",
      sourceItemUuid: request?.sourceItemUuid ?? null,
      sourceItemName: request?.sourceItemName ?? "Summon source",
      activityId: request?.activityId ?? null,
      activityName: request?.activityName ?? "Summon",
      currentInstanceId,
      currentActorIds: [...new Set(currentActorIds.map(String).filter(Boolean))],
      previousActorIds: previousActors.map(actor => String(actor.id)),
      previousActorNames: previousActors.map(actor => String(actor.name ?? "Summon")),
      requestedAt: Date.now(),
      resolvedAt: null,
      resolvedBy: null,
      resolution: null
    };

    return ChatMessage.implementation.create({
      speaker: ChatMessage.getSpeaker?.({ actor: summoner }) ?? { actor: summoner.id, alias: summoner.name },
      whisper: this.#gmRecipientIds(),
      content: this.#decisionContent(decision),
      flags: { [MODULE_ID]: { [DECISION_FLAG_KEY]: decision } }
    });
  }

  static async #onManagedActorUpdated(actor, changes, options = {}, _userId = null) {
    if (!this.enabled() || !this.#isActiveGM() || !actor?.id) return;
    if (options?.managedSummonZeroHpState === true || options?.managedSummonDecisionResolution === true) return;
    const metadata = actor.getFlag?.(MODULE_ID, FLAG_KEY);
    if (!metadata) return;

    const hpChanged = Object.prototype.hasOwnProperty.call(changes ?? {}, "system.attributes.hp.value")
      || foundry.utils.hasProperty?.(changes ?? {}, "system.attributes.hp.value") === true;
    if (!hpChanged) return;

    const hpValue = Number(actor.system?.attributes?.hp?.value ?? 0);
    const hpMax = Number(actor.system?.attributes?.hp?.max ?? 0);
    if (!Number.isFinite(hpValue) || !Number.isFinite(hpMax) || hpMax <= 0) return;

    if (hpValue > 0) {
      if (metadata.zeroHpEvent) {
        await actor.update({ [`flags.${MODULE_ID}.${FLAG_KEY}.zeroHpEvent`]: null }, {
          characterBuilderManagedSummon: true,
          managedSummonZeroHpState: true
        });
      }
      return;
    }

    if (metadata.zeroHpEvent?.id) return;
    const eventId = foundry.utils.randomID?.(24) ?? crypto.randomUUID();
    const zeroHpEvent = {
      id: eventId,
      status: "pending",
      reachedAt: Date.now(),
      resolvedAt: null,
      resolvedBy: null,
      resolution: null
    };
    await actor.update({ [`flags.${MODULE_ID}.${FLAG_KEY}.zeroHpEvent`]: zeroHpEvent }, {
      characterBuilderManagedSummon: true,
      managedSummonZeroHpState: true
    });
    await this.#requestZeroHpDecision(actor, { ...metadata, zeroHpEvent });
  }

  static async #recoverZeroHpDecisions() {
    if (!this.enabled() || !this.#isActiveGM()) return;
    for (const actor of game.actors ?? []) {
      const metadata = actor?.getFlag?.(MODULE_ID, FLAG_KEY);
      if (!metadata) continue;
      const hpValue = Number(actor.system?.attributes?.hp?.value ?? 0);
      const hpMax = Number(actor.system?.attributes?.hp?.max ?? 0);
      if (!Number.isFinite(hpValue) || !Number.isFinite(hpMax) || hpMax <= 0) continue;

      if (hpValue > 0) {
        if (metadata.zeroHpEvent) {
          await actor.update({ [`flags.${MODULE_ID}.${FLAG_KEY}.zeroHpEvent`]: null }, {
            characterBuilderManagedSummon: true,
            managedSummonZeroHpState: true
          });
        }
        continue;
      }

      if (metadata.zeroHpEvent?.status === "resolved") continue;
      let nextMetadata = metadata;
      if (!metadata.zeroHpEvent?.id) {
        const zeroHpEvent = {
          id: foundry.utils.randomID?.(24) ?? crypto.randomUUID(),
          status: "pending",
          reachedAt: Date.now(),
          recoveredByScan: true,
          resolvedAt: null,
          resolvedBy: null,
          resolution: null
        };
        await actor.update({ [`flags.${MODULE_ID}.${FLAG_KEY}.zeroHpEvent`]: zeroHpEvent }, {
          characterBuilderManagedSummon: true,
          managedSummonZeroHpState: true
        });
        nextMetadata = { ...metadata, zeroHpEvent };
      }
      await this.#requestZeroHpDecision(actor, nextMetadata);
    }
  }

  static async #requestZeroHpDecision(actor, metadata) {
    if (!this.#isActiveGM() || !actor?.id || !metadata?.zeroHpEvent?.id) return null;
    const eventId = String(metadata.zeroHpEvent.id);
    const existing = [...(game.messages ?? [])].find(message => {
      const row = message.getFlag?.(MODULE_ID, DECISION_FLAG_KEY);
      return row?.type === "zero-hp" && String(row?.zeroHpEventId ?? "") === eventId;
    });
    if (existing) return existing;

    const summoner = await this.#resolveSummonerFromMetadata(metadata);
    const primal = String(metadata.policyId ?? "") === String(PrimalCompanionAssistanceService.policyId);
    const decision = {
      version: 1,
      id: foundry.utils.randomID?.(24) ?? crypto.randomUUID(),
      type: "zero-hp",
      status: "pending",
      zeroHpEventId: eventId,
      actorId: actor.id,
      actorUuid: actor.uuid ?? null,
      actorName: actor.name ?? "Summon",
      summonerActorId: metadata.summonerActorId ?? null,
      summonerActorUuid: metadata.summonerActorUuid ?? null,
      summonerName: summoner?.name ?? "Summoner",
      sourceItemName: metadata.sourceItemName ?? "Summon source",
      activityName: metadata.activityName ?? "Summon",
      policyId: metadata.policyId ?? DEFAULT_POLICY.policyId,
      canRevivePrimalCompanion: primal,
      spellSlots: primal ? this.#availableSpellSlots(summoner) : [],
      requestedAt: Date.now(),
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
      slotKey: null
    };

    return ChatMessage.implementation.create({
      speaker: ChatMessage.getSpeaker?.({ actor }) ?? { actor: actor.id, alias: actor.name },
      whisper: this.#gmRecipientIds(),
      content: this.#decisionContent(decision),
      flags: { [MODULE_ID]: { [DECISION_FLAG_KEY]: decision } }
    });
  }

  static #decorateDecisionMessage(message, html) {
    const root = this.#element(html);
    const decision = message?.getFlag?.(MODULE_ID, DECISION_FLAG_KEY);
    if (!root || !decision) return;

    const canResolve = decision.status === "pending" && this.#isActiveGM();
    const slotSelect = root.querySelector?.("[data-cb-managed-summon-slot]");
    if (slotSelect) slotSelect.disabled = !canResolve;

    for (const button of root.querySelectorAll?.(`[data-action="${ACTION_RESOLVE_DECISION}"]`) ?? []) {
      const choice = String(button.dataset.decision ?? "");
      button.disabled = !canResolve || (choice === "revive" && !(decision.spellSlots ?? []).length);
      if (!this.#isActiveGM()) button.title = "Waiting for the active GM decision";
      if (button.dataset.cbManagedSummonDecisionBound === "true") continue;
      button.dataset.cbManagedSummonDecisionBound = "true";
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const slotKey = choice === "revive" ? String(slotSelect?.value ?? "") : null;
        void this.#resolveDecision(message, choice, { slotKey });
      });
    }
  }

  static async #resolveDecision(message, choice, { slotKey = null } = {}) {
    if (!this.#isActiveGM()) {
      ui.notifications?.warn?.("Only the active GM can resolve Managed Summon decisions.");
      return;
    }
    if (!message?.id || this.#executing.has(`decision:${message.id}`)) return;

    const decision = foundry.utils.deepClone(message.getFlag?.(MODULE_ID, DECISION_FLAG_KEY) ?? {});
    if (decision.status !== "pending") return;
    const allowed = decision.type === "duplicate-source"
      ? new Set(["replace", "keep-both"])
      : new Set(decision.canRevivePrimalCompanion ? ["revive", "remove", "keep"] : ["remove", "keep"]);
    if (!allowed.has(choice)) return;

    const executionKey = `decision:${message.id}`;
    this.#executing.add(executionKey);
    try {
      if (decision.type === "duplicate-source") {
        if (choice === "replace") {
          const protectedIds = new Set((decision.currentActorIds ?? []).map(String));
          const removable = (decision.previousActorIds ?? []).map(String).filter(id => !protectedIds.has(id))
            .filter(id => {
              const actor = game.actors?.get?.(id);
              const metadata = actor?.getFlag?.(MODULE_ID, FLAG_KEY);
              return Boolean(actor && metadata
                && String(metadata.summonerActorId ?? "") === String(decision.summonerActorId ?? "")
                && String(metadata.sourceItemUuid ?? "") === String(decision.sourceItemUuid ?? "")
                && String(metadata.activityId ?? "") === String(decision.activityId ?? ""));
            });
          await this.#removeManagedActorIds(removable, "gm-replace-previous-source-instance", {
            decisionId: decision.id,
            summonerActorId: decision.summonerActorId
          });
        }
      } else if (decision.type === "zero-hp") {
        const actor = await this.#resolveDecisionActor(decision);
        if (choice === "remove") {
          if (actor?.id) {
            await this.#removeManagedActorIds([actor.id], "gm-zero-hp-remove", { decisionId: decision.id });
          }
        } else if (choice === "keep") {
          if (!actor) throw new Error("The managed summon no longer exists.");
          await this.#markZeroHpEventResolved(actor, decision, "keep");
        } else if (choice === "revive") {
          if (!actor) throw new Error("The Primal Companion no longer exists.");
          await this.#revivePrimalCompanion(actor, decision, slotKey);
        }
      }

      const next = {
        ...decision,
        status: "resolved",
        resolution: choice,
        slotKey: choice === "revive" ? slotKey : null,
        resolvedAt: Date.now(),
        resolvedBy: game.user.id
      };
      await message.update({
        content: this.#decisionContent(next),
        [`flags.${MODULE_ID}.${DECISION_FLAG_KEY}`]: next
      });
    } catch (error) {
      console.warn(`${MODULE_ID} | Managed Summon decision failed.`, error);
      ui.notifications?.error?.(`Managed Summon decision failed: ${error.message}`);
    } finally {
      this.#executing.delete(executionKey);
    }
  }

  static async #resolveDecisionActor(decision) {
    if (decision?.actorUuid) {
      try {
        const actor = await fromUuid(decision.actorUuid);
        if (actor?.documentName === "Actor") return actor;
      } catch (_error) {}
    }
    return decision?.actorId ? game.actors?.get?.(String(decision.actorId)) ?? null : null;
  }

  static async #resolveSummonerFromMetadata(metadata) {
    if (metadata?.summonerActorUuid) {
      try {
        const actor = await fromUuid(metadata.summonerActorUuid);
        if (actor?.documentName === "Actor") return actor;
      } catch (_error) {}
    }
    return metadata?.summonerActorId ? game.actors?.get?.(String(metadata.summonerActorId)) ?? null : null;
  }

  static #availableSpellSlots(actor) {
    if (!actor) return [];
    const spells = actor.system?.spells ?? {};
    const rows = [];
    for (let level = 1; level <= 9; level += 1) {
      const key = `spell${level}`;
      const value = Number(spells?.[key]?.value ?? 0);
      if (!Number.isFinite(value) || value <= 0) continue;
      rows.push({ key, label: `Level ${level} Spell Slot`, available: Math.trunc(value) });
    }
    const pactValue = Number(spells?.pact?.value ?? 0);
    if (Number.isFinite(pactValue) && pactValue > 0) {
      const pactLevel = Number(spells?.pact?.level ?? 0);
      rows.push({
        key: "pact",
        label: pactLevel > 0 ? `Pact Magic Slot (Level ${pactLevel})` : "Pact Magic Slot",
        available: Math.trunc(pactValue)
      });
    }
    return rows;
  }

  static async #revivePrimalCompanion(actor, decision, slotKey) {
    if (String(decision?.policyId ?? "") !== String(PrimalCompanionAssistanceService.policyId)) {
      throw new Error("This summon is not a Primal Companion.");
    }
    if (!/^(?:spell[1-9]|pact)$/.test(String(slotKey ?? ""))) {
      throw new Error("Choose an available spell slot.");
    }
    const metadata = actor.getFlag?.(MODULE_ID, FLAG_KEY) ?? {};
    if (String(metadata.zeroHpEvent?.id ?? "") !== String(decision.zeroHpEventId ?? "")) {
      throw new Error("This zero-HP event is no longer current.");
    }
    const hpValue = Number(actor.system?.attributes?.hp?.value ?? 0);
    const hpMax = Number(actor.system?.attributes?.hp?.max ?? 0);
    if (!Number.isFinite(hpMax) || hpMax <= 0 || hpValue > 0) {
      throw new Error("The companion is no longer at 0 HP or has no valid maximum HP.");
    }

    const summoner = await this.#resolveSummonerFromMetadata(metadata);
    if (!summoner) throw new Error("The Ranger that owns this companion could not be resolved.");
    const slotPath = `system.spells.${slotKey}.value`;
    const before = Number(foundry.utils.getProperty(summoner, slotPath) ?? 0);
    if (!Number.isFinite(before) || before <= 0) throw new Error("That spell slot is no longer available.");

    await summoner.update({ [slotPath]: before - 1 }, {
      characterBuilderManagedSummon: true,
      managedSummonPrimalRevive: true
    });
    try {
      await actor.update({
        "system.attributes.hp.value": hpMax,
        [`flags.${MODULE_ID}.${FLAG_KEY}.zeroHpEvent`]: null
      }, {
        characterBuilderManagedSummon: true,
        managedSummonDecisionResolution: true,
        managedSummonPrimalRevive: true
      });
    } catch (error) {
      try {
        const current = Number(foundry.utils.getProperty(summoner, slotPath) ?? 0);
        if (current === before - 1) {
          await summoner.update({ [slotPath]: before }, {
            characterBuilderManagedSummon: true,
            managedSummonPrimalReviveRollback: true
          });
        }
      } catch (rollbackError) {
        console.warn(`${MODULE_ID} | Could not refund Primal Companion revive spell slot after failure.`, rollbackError);
      }
      throw error;
    }
  }

  static async #markZeroHpEventResolved(actor, decision, resolution) {
    const metadata = actor.getFlag?.(MODULE_ID, FLAG_KEY) ?? {};
    const event = metadata.zeroHpEvent ?? {};
    if (String(event.id ?? "") !== String(decision.zeroHpEventId ?? "")) return;
    await actor.update({
      [`flags.${MODULE_ID}.${FLAG_KEY}.zeroHpEvent`]: {
        ...event,
        status: "resolved",
        resolution,
        resolvedAt: Date.now(),
        resolvedBy: game.user.id
      }
    }, {
      characterBuilderManagedSummon: true,
      managedSummonZeroHpState: true,
      managedSummonDecisionResolution: true
    });
  }

  static async #removeManagedActorIds(actorIds, reason, context = {}) {
    const ids = [...new Set((actorIds ?? []).map(String).filter(Boolean))].filter(id => {
      const actor = game.actors?.get?.(id);
      return Boolean(actor?.getFlag?.(MODULE_ID, FLAG_KEY));
    });
    if (!ids.length) return;
    const idSet = new Set(ids);

    for (const scene of game.scenes ?? []) {
      const tokenIds = [...(scene.tokens ?? [])]
        .filter(token => idSet.has(String(token.actorId ?? "")))
        .map(token => token.id);
      if (tokenIds.length) {
        await scene.deleteEmbeddedDocuments("Token", tokenIds, {
          characterBuilderManagedSummon: true,
          reason,
          ...context
        });
      }
    }

    await Actor.implementation.deleteDocuments(ids, {
      characterBuilderManagedSummon: true,
      reason,
      ...context
    });
  }

  static #decisionContent(decision) {
    const esc = value => this.#escape(value);
    const resolved = decision.status === "resolved";
    let body = "";

    if (decision.type === "duplicate-source") {
      const previous = (decision.previousActorNames ?? []).map(name => `<li>${esc(name)}</li>`).join("");
      body = `
        <p><strong>${esc(decision.summonerName)}</strong> created another summon from <strong>${esc(decision.sourceItemName)}</strong>${decision.activityName ? ` — ${esc(decision.activityName)}` : ""}.</p>
        <p>An earlier managed instance from this same Summon Activity is still active.</p>
        ${previous ? `<ul>${previous}</ul>` : ""}
        ${resolved ? this.#decisionResolvedStatus(decision) : `
          <div class="cb-managed-summon-actions">
            <button type="button" class="danger" data-action="${ACTION_RESOLVE_DECISION}" data-decision="replace"><i class="fa-solid fa-arrows-rotate"></i> Replace Previous</button>
            <button type="button" data-action="${ACTION_RESOLVE_DECISION}" data-decision="keep-both"><i class="fa-solid fa-clone"></i> Keep Both</button>
          </div>`}`;
    } else if (decision.type === "zero-hp") {
      const slots = (decision.spellSlots ?? []).map(slot => `<option value="${esc(slot.key)}">${esc(slot.label)} — ${Number(slot.available) || 0} available</option>`).join("");
      body = `
        <p><strong>${esc(decision.actorName)}</strong> reached <strong>0 HP</strong>.</p>
        <p><strong>Summoner:</strong> ${esc(decision.summonerName)}<br><strong>Source:</strong> ${esc(decision.sourceItemName)}</p>
        ${resolved ? this.#decisionResolvedStatus(decision) : `
          ${decision.canRevivePrimalCompanion ? `
            <label class="cb-managed-summon-slot-picker"><span>Primal Companion revival slot</span>
              <select data-cb-managed-summon-slot>${slots || `<option value="">No spell slots available</option>`}</select>
            </label>` : ""}
          <div class="cb-managed-summon-actions">
            ${decision.canRevivePrimalCompanion ? `<button type="button" data-action="${ACTION_RESOLVE_DECISION}" data-decision="revive"><i class="fa-solid fa-heart-pulse"></i> Spend Slot & Revive</button>` : ""}
            <button type="button" class="danger" data-action="${ACTION_RESOLVE_DECISION}" data-decision="remove"><i class="fa-solid fa-trash"></i> Remove Summon</button>
            <button type="button" data-action="${ACTION_RESOLVE_DECISION}" data-decision="keep"><i class="fa-solid fa-hand"></i> Keep Summon</button>
          </div>
          ${decision.canRevivePrimalCompanion ? `<p class="notes">The Primal Companion rule still requires the in-world revival time; this button handles the spell-slot cost and restores the existing managed companion.</p>` : ""}`}`;
    }

    return `
      <section class="cb-managed-summon-decision-card" data-cb-managed-summon-decision>
        <header><i class="fa-solid fa-paw"></i><div><strong>Managed Summon</strong><small>GM decision</small></div></header>
        <div class="cb-managed-summon-decision-body">${body}</div>
      </section>`;
  }

  static #decisionResolvedStatus(decision) {
    const labels = {
      replace: "Previous summon removed; the new instance was kept.",
      "keep-both": "Both summon instances were kept.",
      remove: "Summon removed by the GM.",
      keep: "Summon kept at 0 HP by the GM.",
      revive: "Primal Companion revived using a spell slot."
    };
    return `<p class="cb-managed-summon-resolution"><i class="fa-solid fa-circle-check"></i> ${this.#escape(labels[decision.resolution] ?? "Decision resolved.")}</p>`;
  }

  static async #removePreviousExclusiveInstances({ summoner, keepActorIds, keepTokenUuids, sourceFeatureUuid, policyId }) {
    const previousManaged = [...(game.actors ?? [])].filter(actor => {
      if (keepActorIds.has(actor?.id)) return false;
      const metadata = actor?.getFlag?.(MODULE_ID, FLAG_KEY) ?? {};
      const sameSummoner = String(metadata.summonerActorId ?? "") === String(summoner.id);
      const modernMatch = String(metadata.policyId ?? "") === String(policyId) && sameSummoner;
      // X4 created Find Familiar and Mage Hand under the generic native-summon
      // policy. The first X5 recast must absorb and clean those already-managed
      // instances rather than leaving test/live leftovers behind. Source UUID is
      // the canonical embedded spell/feature identity; profile/form names are
      // deliberately ignored.
      const previousGenericSourceMatch = sameSummoner
        && String(metadata.policyId ?? "") === DEFAULT_POLICY.policyId
        && Boolean(sourceFeatureUuid)
        && String(metadata.sourceItemUuid ?? "") === String(sourceFeatureUuid);
      const legacyMatch = actor?.getFlag?.(MODULE_ID, "managedKind") === "primal-companion"
        && String(actor.getFlag?.(MODULE_ID, "rangerActorId") ?? "") === String(summoner.id);
      return modernMatch || previousGenericSourceMatch || legacyMatch;
    });
    const previousManagedIds = new Set(previousManaged.map(actor => String(actor.id)));

    for (const scene of game.scenes ?? []) {
      const tokenIds = [];
      for (const token of scene.tokens ?? []) {
        if (keepTokenUuids.has(String(token.uuid))) continue;
        if (previousManagedIds.has(String(token.actorId ?? ""))) {
          tokenIds.push(token.id);
          continue;
        }
        if (sourceFeatureUuid && this.#tokenSummonOrigin(token) === String(sourceFeatureUuid)) tokenIds.push(token.id);
      }
      if (tokenIds.length) {
        await scene.deleteEmbeddedDocuments("Token", [...new Set(tokenIds)], {
          characterBuilderManagedSummon: true,
          reason: "exclusive-source-policy-replacement",
          summonerActorId: summoner.id
        });
      }
    }

    if (previousManagedIds.size) {
      await Actor.implementation.deleteDocuments([...previousManagedIds], {
        characterBuilderManagedSummon: true,
        reason: "exclusive-source-policy-replacement",
        summonerActorId: summoner.id
      });
    }
  }

  static #onConfirmedConcentrationEnd(effect, source) {
    const concentrationUuid = String(effect?.uuid ?? "");
    if (!concentrationUuid || !this.enabled() || !this.#isConcentrationEffect(effect)) return;
    if (this.#confirmedConcentrationEnds.has(concentrationUuid)) return;
    this.#confirmedConcentrationEnds.add(concentrationUuid);
    setTimeout(() => this.#confirmedConcentrationEnds.delete(concentrationUuid), 2500);

    void this.#requestConcentrationCleanup(concentrationUuid).catch(error => {
      console.warn(`${MODULE_ID} | Managed Summons concentration cleanup request failed after ${source}.`, error);
    });
  }

  static #isConcentrationEffect(effect) {
    const concentrating = CONFIG.DND5E?.specialStatusEffects?.CONCENTRATING
      ?? CONFIG.specialStatusEffects?.CONCENTRATING
      ?? "concentrating";
    return Boolean(effect?.documentName === "ActiveEffect"
      && (effect.statuses?.has?.(concentrating)
        || Array.from(effect.statuses ?? []).includes(concentrating)));
  }

  static async #requestConcentrationCleanup(concentrationUuid) {
    if (!concentrationUuid || !this.enabled()) return;
    if (game.user?.isGM && this.#isActiveGM()) return this.#cleanupConcentration(concentrationUuid);
    const activeGM = this.#activeGM();
    if (!activeGM) {
      ui.notifications?.warn?.("Concentration ended, but Managed Summons cleanup is waiting for a connected GM.");
      return;
    }
    game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_CLEANUP, concentrationUuid });
  }

  static async #cleanupConcentration(concentrationUuid) {
    if (!concentrationUuid || !this.enabled() || !this.#isActiveGM()) return;
    if (this.#cleaning.has(concentrationUuid)) return;
    this.#cleaning.add(concentrationUuid);
    try {
      const actors = [...(game.actors ?? [])].filter(actor =>
        String(actor?.getFlag?.(MODULE_ID, FLAG_KEY)?.concentrationUuid ?? "") === String(concentrationUuid)
      );
      if (!actors.length) return;
      const actorIds = new Set(actors.map(actor => String(actor.id)));

      for (const scene of game.scenes ?? []) {
        const tokenIds = [...(scene.tokens ?? [])]
          .filter(token => actorIds.has(String(token.actorId ?? "")))
          .map(token => token.id);
        if (tokenIds.length) {
          await scene.deleteEmbeddedDocuments("Token", tokenIds, {
            characterBuilderManagedSummon: true,
            reason: "confirmed-concentration-ended",
            concentrationUuid
          });
        }
      }

      await Actor.implementation.deleteDocuments([...actorIds], {
        characterBuilderManagedSummon: true,
        reason: "confirmed-concentration-ended",
        concentrationUuid
      });
    } finally {
      this.#cleaning.delete(concentrationUuid);
    }
  }

  static #policyForActivity(activity) {
    const policies = [
      PrimalCompanionAssistanceService,
      FindSteedAssistanceService,
      FIND_FAMILIAR_POLICY,
      MAGE_HAND_POLICY
    ];
    return policies.find(policy => policy.enabled?.() && policy.matches?.(activity)) ?? DEFAULT_POLICY;
  }

  static #policyById(policyId) {
    const id = String(policyId ?? "");
    if (id === PrimalCompanionAssistanceService.policyId && PrimalCompanionAssistanceService.enabled()) {
      return PrimalCompanionAssistanceService;
    }
    if (id === FindSteedAssistanceService.policyId && FindSteedAssistanceService.enabled()) {
      return FindSteedAssistanceService;
    }
    if (id === FIND_FAMILIAR_POLICY.policyId) return FIND_FAMILIAR_POLICY;
    if (id === MAGE_HAND_POLICY.policyId) return MAGE_HAND_POLICY;
    return DEFAULT_POLICY;
  }


  static #concentrationForSourceItem(actor, sourceItem) {
    if (!actor || !sourceItem) return null;
    const concentrating = CONFIG.DND5E?.specialStatusEffects?.CONCENTRATING
      ?? CONFIG.specialStatusEffects?.CONCENTRATING
      ?? "concentrating";
    const effects = Array.from(actor.concentration?.effects ?? actor.effects ?? []);
    return effects.find(candidate => {
      if (!candidate || candidate.disabled || candidate.isSuppressed) return false;
      if (concentrating && !candidate.statuses?.has?.(concentrating)) return false;
      const itemRef = candidate.getFlag?.("dnd5e", "item") ?? candidate.flags?.dnd5e?.item ?? {};
      return itemRef.id === sourceItem.id || itemRef.uuid === sourceItem.uuid;
    }) ?? null;
  }

  static async #managedFolder(summoner) {
    if (!RulesAssistanceSettingsService.managedSummonFoldersEnabled()) return null;
    const firstName = String(summoner?.name ?? "Character").trim().split(/\s+/)[0] || "Character";
    const name = `${firstName} - Companions`;
    const existing = game.folders?.find?.(folder => folder.type === "Actor"
      && folder.getFlag?.(MODULE_ID, "managedSummonFolder") === true
      && String(folder.getFlag?.(MODULE_ID, "summonerActorId") ?? "") === String(summoner.id));
    if (existing) return existing;
    return Folder.create({
      name,
      type: "Actor",
      sorting: "a",
      flags: {
        [MODULE_ID]: {
          managedSummonFolder: true,
          summonerActorId: summoner.id,
          summonerActorUuid: summoner.uuid ?? null
        }
      }
    });
  }

  static #ownershipFromSummoner(summoner) {
    const ownership = foundry.utils.deepClone(summoner?.ownership ?? { default: 0 });
    ownership.default ??= 0;
    return ownership;
  }

  static async #removeOrphanedNativeBase(baseActor) {
    if (!baseActor?.id || baseActor.getFlag?.(MODULE_ID, FLAG_KEY)) return;
    const autoImported = baseActor.getFlag?.("dnd5e", "isAutoImported") === true
      || baseActor.getFlag?.("dnd5e", "summonedCopy") === true;
    if (!autoImported || this.#actorReferencedByAnyToken(baseActor.id)) return;
    await baseActor.delete({ characterBuilderManagedSummon: true, reason: "orphaned-native-summon-base" });
  }

  static async #removeOrphanedProfileImports(profileSourceUuids) {
    const sources = new Set((profileSourceUuids ?? []).map(value => String(value ?? "")).filter(Boolean));
    if (!sources.size) return;
    const candidates = [...(game.actors ?? [])].filter(actor => {
      if (actor.getFlag?.(MODULE_ID, FLAG_KEY)) return false;
      const autoImported = actor.getFlag?.("dnd5e", "isAutoImported") === true
        || actor.getFlag?.("dnd5e", "summonedCopy") === true;
      if (!autoImported || this.#actorReferencedByAnyToken(actor.id)) return false;
      const source = String(actor?._stats?.compendiumSource ?? actor?._stats?.duplicateSource ?? "");
      return sources.has(source);
    });
    for (const actor of candidates) {
      await actor.delete({ characterBuilderManagedSummon: true, reason: "orphaned-native-summon-profile-import" });
    }
  }

  static #tokenSummonOrigin(token) {
    const direct = token?.actor?.getFlag?.("dnd5e", "summon")?.origin;
    if (direct) return String(direct);
    const delta = token?.delta?.toObject?.() ?? token?.toObject?.().delta ?? token?.delta ?? {};
    return String(foundry.utils.getProperty(delta, "flags.dnd5e.summon.origin") ?? "");
  }

  static #actorReferencedByAnyToken(actorId) {
    return [...(game.scenes ?? [])].some(scene =>
      [...(scene.tokens ?? [])].some(token => String(token.actorId ?? "") === String(actorId))
    );
  }

  static #profileSourceUuids(activity) {
    const profiles = activity?.profiles?.values ? [...activity.profiles.values()] : [...(activity?.profiles ?? [])];
    return [...new Set(profiles.map(profile => String(profile?.uuid ?? "")).filter(Boolean))];
  }

  static async #resolveSummoner(request) {
    if (request?.summonerActorUuid) {
      try {
        const actor = await fromUuid(request.summonerActorUuid);
        if (actor?.documentName === "Actor") return actor;
      } catch (_error) {}
    }
    return game.actors?.get?.(String(request?.summonerActorId ?? "")) ?? null;
  }

  static #gmRecipientIds() {
    const recipients = ChatMessage.getWhisperRecipients?.("GM") ?? game.users?.contents?.filter(user => user.isGM) ?? [];
    return recipients.map(user => user?.id ?? user).filter(Boolean);
  }

  static #escape(value) {
    const text = String(value ?? "");
    if (foundry.utils?.escapeHTML) return foundry.utils.escapeHTML(text);
    return text.replace(/[&<>'"]/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[character]);
  }

  static #element(value) {
    const HTMLElementCtor = globalThis.HTMLElement;
    return HTMLElementCtor && value instanceof HTMLElementCtor ? value : null;
  }

  static #activeGM() {
    const preferred = game.users?.activeGM;
    if (preferred?.active && preferred.isGM) return preferred;
    return game.users?.contents?.filter(user => user.active && user.isGM)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
  }

  static #isActiveGM() {
    return Boolean(game.user?.isGM && this.#activeGM()?.id === game.user.id);
  }
}

export const MANAGED_SUMMONS_RULE_ID = RULE_ID;
