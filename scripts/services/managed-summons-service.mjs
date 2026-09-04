import { MODULE_ID, MODULE_VERSION } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";
import { PrimalCompanionAssistanceService } from "./primal-companion-assistance-service.mjs";

const RULE_ID = "managed-summons";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REQUEST = "managedSummonsRequestV1";
const SOCKET_CLEANUP = "managedSummonsConcentrationCleanupV1";
const MANAGED_KIND = "managed-summon";
const FLAG_KEY = "managedSummon";
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

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    Hooks.on("dnd5e.postSummon", (activity, profile, createdTokens, options) => {
      void this.#afterSummon(activity, profile, createdTokens, options).catch(error => {
        console.warn(`${MODULE_ID} | Managed Summons post-summon lifecycle failed.`, error);
        ui.notifications?.error?.(`Managed Summons failed: ${error.message}`);
      });
    });

    // Managed Summons never decides that Concentration has ended. It reacts
    // only to D&D5e's canonical post-end hook after the effect is truly gone.
    Hooks.on("dnd5e.endConcentration", (_actor, effect) => {
      const concentrationUuid = effect?.uuid;
      if (!concentrationUuid || !this.enabled()) return;
      void this.#requestConcentrationCleanup(concentrationUuid).catch(error => {
        console.warn(`${MODULE_ID} | Managed Summons concentration cleanup request failed.`, error);
      });
    });

    // Token presence is not summon existence. Manual Scene deletion, Scene cleanup,
    // or moving between Scenes must not destroy the persistent managed Actor.
    // Managed Actors are deleted only by explicit source lifecycle paths below
    // (exclusive recast/replacement or confirmed concentration ending).
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
      version: 1,
      policyId: String(request?.policyId ?? "native-summon"),
      instanceId: String(request?.instanceId ?? ""),
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
    return managed;
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
