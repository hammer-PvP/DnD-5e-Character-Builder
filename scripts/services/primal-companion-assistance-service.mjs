import { MODULE_ID, MODULE_VERSION } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "ranger-primal-companion";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REQUEST = "primalCompanionAssistanceRequestV3";
const MANAGED_KIND = "primal-companion";
const FOLDER_NAME = "Character Builder Companions";

/**
 * Completes only the lifecycle gaps observed in D&D5e 5.3.3's native Primal
 * Companion summon. D&D5e remains authoritative for the summon profile, PB,
 * AC, attacks, damage, effects, and derived maximum HP.
 *
 * X3 deliberately never writes a partial ActorDelta back to a Token. Instead,
 * after the native summon is fully materialized, it snapshots the finalized
 * synthetic Actor into a Ranger-specific linked Actor, sets only that new
 * Actor's current HP to the already-derived maximum, inherits ownership from
 * the Ranger, rebinds the new Token to that Actor, and then removes the prior
 * companion belonging to the same Ranger.
 */
export class PrimalCompanionAssistanceService {
  static #initialized = false;
  static #socketReady = false;
  static #executing = new Set();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    Hooks.on("dnd5e.postSummon", (activity, profile, createdTokens) => {
      void this.#afterSummon(activity, profile, createdTokens).catch(error => {
        console.warn(`${MODULE_ID} | Primal Companion assistance failed.`, error);
        ui.notifications?.error?.(`Primal Companion assistance failed: ${error.message}`);
      });
    });
  }

  static ready() {
    if (this.#socketReady || !globalThis.game?.socket?.on) return;
    this.#socketReady = true;
    game.socket.on(SOCKET_CHANNEL, payload => {
      if (payload?.type !== SOCKET_REQUEST || !this.#isActiveGM()) return;
      void this.#execute(payload).catch(error => {
        console.warn(`${MODULE_ID} | Primal Companion GM assistance request failed.`, error);
      });
    });
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static async #afterSummon(activity, profile, createdTokens) {
    if (!this.enabled() || !this.#isPrimalCompanionActivity(activity)) return;
    const ranger = activity?.actor ?? activity?.item?.actor;
    const tokens = [...(createdTokens ?? [])].filter(token => token?.id && token?.parent?.id && token?.actor);
    if (!ranger?.id || !tokens.length) return;

    const profileSourceUuids = this.#profileSourceUuids(activity);
    const payload = {
      rangerActorId: ranger.id,
      requesterId: game.user?.id ?? null,
      tokenUuids: tokens.map(token => token.uuid),
      sourceFeatureUuid: activity?.item?.uuid ?? null,
      activityId: String(activity?.id ?? ""),
      profileId: String(profile?.id ?? profile?._id ?? ""),
      companionType: this.#companionType(profile, tokens[0]),
      profileSourceUuids
    };

    if (game.user?.isGM) return this.#execute(payload);
    const activeGM = this.#activeGM();
    if (!activeGM) {
      ui.notifications?.warn?.("Primal Companion was summoned, but a connected GM is required to finish ownership and companion cleanup.");
      return;
    }
    game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_REQUEST, ...payload });
  }

  static async #execute(request) {
    if (!this.enabled() || !this.#isActiveGM()) return;
    const requestKey = `${request?.rangerActorId ?? ""}:${(request?.tokenUuids ?? []).join(",")}`;
    if (!requestKey || this.#executing.has(requestKey)) return;
    this.#executing.add(requestKey);
    try {
      const ranger = game.actors?.get?.(String(request?.rangerActorId ?? ""));
      const requester = game.users?.get?.(String(request?.requesterId ?? ""));
      if (!ranger || !requester) throw new Error("The Ranger or requesting user could not be resolved.");
      if (!requester.isGM && !ranger.testUserPermission?.(requester, "OWNER")) {
        throw new Error("The requesting user does not own the Ranger that created this companion.");
      }

      const tokenDocs = [];
      for (const uuid of request?.tokenUuids ?? []) {
        const token = await fromUuid(uuid);
        if (token?.documentName === "Token" && token.actor) tokenDocs.push(token);
      }
      if (!tokenDocs.length) return;

      // Primal Companion creates one Beast. If a future system version creates
      // more than one token, each receives its own managed Actor so linked-token
      // state cannot bleed between summons.
      const keepActorIds = new Set();
      const keepTokenUuids = new Set(tokenDocs.map(token => String(token.uuid)));
      const nativeBases = new Set();
      for (const token of tokenDocs) {
        const synthetic = token.actor;
        const baseActor = game.actors?.get?.(String(token.actorId ?? "")) ?? token.baseActor ?? null;
        if (baseActor?.id) nativeBases.add(baseActor);

        const managed = await this.#createManagedActor({ ranger, synthetic, request });
        keepActorIds.add(managed.id);

        // Critical X3 change: do not send a reconstructed/partial `delta` to
        // TokenDocument.update(). Foundry 14 validates ActorDelta as a complete
        // embedded schema and X2's partial delta caused _id/items/effects/flags
        // validation failures. A linked Token needs only the new Actor id.
        await token.update({
          actorId: managed.id,
          actorLink: true
        }, { characterBuilderPrimalCompanion: true });
      }

      await this.#removePrevious({
        ranger,
        keepActorIds,
        keepTokenUuids,
        sourceFeatureUuid: request?.sourceFeatureUuid
      });

      for (const baseActor of nativeBases) {
        await this.#removeOrphanedNativeBase(baseActor);
      }
      await this.#removeOrphanedProfileImports(request?.profileSourceUuids ?? []);
    } finally {
      this.#executing.delete(requestKey);
    }
  }

  static async #createManagedActor({ ranger, synthetic, request }) {
    // Synthetic Actor source contains the native summon-time ActorDelta already
    // applied (effects, item changes, PB matching, attack modifications, etc.).
    // Materializing this resolved source once and linking the token means those
    // changes are not re-applied by a second ActorDelta.
    const data = synthetic.toObject?.() ?? foundry.utils.deepClone(synthetic?._source ?? {});
    delete data._id;
    delete data.folder;
    delete data.sort;
    delete data._stats;
    data.name = synthetic.name;
    data.ownership = this.#ownershipFromRanger(ranger);
    data.prototypeToken ??= {};
    data.prototypeToken.actorLink = true;

    const hpMax = Number(synthetic.system?.attributes?.hp?.max ?? 0);
    const hpValue = Number(synthetic.system?.attributes?.hp?.value ?? 0);
    if (Number.isFinite(hpMax) && hpMax > 0 && hpValue !== hpMax) {
      // SET, never add. If D&D5e later fixes fresh-summon current HP itself,
      // this becomes a no-op and can never produce 2x maximum HP.
      foundry.utils.setProperty(data, "system.attributes.hp.value", hpMax);
    }

    data.flags ??= {};
    data.flags[MODULE_ID] = {
      ...(data.flags[MODULE_ID] ?? {}),
      managedKind: MANAGED_KIND,
      rangerActorId: ranger.id,
      sourceFeatureUuid: request?.sourceFeatureUuid ?? null,
      activityId: request?.activityId ?? null,
      profileId: request?.profileId ?? null,
      companionType: request?.companionType ?? "unknown",
      moduleVersion: MODULE_VERSION,
      createdAt: Date.now()
    };

    const folder = await this.#folder();
    data.folder = folder?.id ?? null;
    const managed = await Actor.create(data, {
      renderSheet: false,
      characterBuilderPrimalCompanion: true,
      rangerActorId: ranger.id
    });
    if (!managed) throw new Error("Character Builder could not create the Ranger-specific Primal Companion Actor.");
    return managed;
  }

  static async #removePrevious({ ranger, keepActorIds, keepTokenUuids, sourceFeatureUuid }) {
    const previousManaged = [...(game.actors ?? [])].filter(actor =>
      !keepActorIds.has(actor?.id)
      && actor?.getFlag?.(MODULE_ID, "managedKind") === MANAGED_KIND
      && String(actor.getFlag?.(MODULE_ID, "rangerActorId") ?? "") === String(ranger.id)
    );
    const previousManagedIds = new Set(previousManaged.map(actor => String(actor.id)));

    for (const scene of game.scenes ?? []) {
      const tokenIds = [];
      for (const token of scene.tokens ?? []) {
        if (keepTokenUuids.has(String(token.uuid))) continue;
        if (previousManagedIds.has(String(token.actorId ?? ""))) {
          tokenIds.push(token.id);
          continue;
        }
        // Also clean up a native pre-X3 Primal Companion token belonging to
        // this exact Ranger feature. The native summon origin is unique to the
        // embedded Primal Companion Item on that Ranger.
        if (sourceFeatureUuid && this.#tokenSummonOrigin(token) === String(sourceFeatureUuid)) tokenIds.push(token.id);
      }
      if (tokenIds.length) {
        await scene.deleteEmbeddedDocuments("Token", [...new Set(tokenIds)], {
          characterBuilderPrimalCompanion: true,
          rangerActorId: ranger.id
        });
      }
    }

    if (previousManagedIds.size) {
      await Actor.implementation.deleteDocuments([...previousManagedIds], {
        characterBuilderPrimalCompanion: true,
        rangerActorId: ranger.id
      });
    }
  }

  static #tokenSummonOrigin(token) {
    const direct = token?.actor?.getFlag?.("dnd5e", "summon")?.origin;
    if (direct) return String(direct);
    const delta = token?.delta?.toObject?.() ?? token?.toObject?.().delta ?? token?.delta ?? {};
    return String(foundry.utils.getProperty(delta, "flags.dnd5e.summon.origin") ?? "");
  }

  static #ownershipFromRanger(ranger) {
    const ownership = foundry.utils.deepClone(ranger?.ownership ?? { default: 0 });
    ownership.default ??= 0;
    return ownership;
  }

  static async #removeOrphanedNativeBase(baseActor) {
    if (!baseActor?.id || baseActor.getFlag?.(MODULE_ID, "managedKind") === MANAGED_KIND) return;
    const autoImported = baseActor.getFlag?.("dnd5e", "isAutoImported") === true
      || baseActor.getFlag?.("dnd5e", "summonedCopy") === true;
    if (!autoImported || this.#actorReferencedByAnyToken(baseActor.id)) return;
    await baseActor.delete({
      characterBuilderPrimalCompanion: true,
      reason: "orphaned-native-primal-companion-template"
    });
  }

  static async #removeOrphanedProfileImports(profileSourceUuids) {
    const sources = new Set((profileSourceUuids ?? []).map(value => String(value ?? "")).filter(Boolean));
    if (!sources.size) return;
    const candidates = [...(game.actors ?? [])].filter(actor => {
      if (actor.getFlag?.(MODULE_ID, "managedKind") === MANAGED_KIND) return false;
      const autoImported = actor.getFlag?.("dnd5e", "isAutoImported") === true
        || actor.getFlag?.("dnd5e", "summonedCopy") === true;
      if (!autoImported || this.#actorReferencedByAnyToken(actor.id)) return false;
      const source = String(actor?._stats?.compendiumSource ?? actor?._stats?.duplicateSource ?? "");
      return sources.has(source);
    });
    for (const actor of candidates) {
      await actor.delete({
        characterBuilderPrimalCompanion: true,
        reason: "orphaned-primal-companion-profile-import"
      });
    }
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

  static #isPrimalCompanionActivity(activity) {
    const item = activity?.item;
    const identifier = String(item?.system?.identifier ?? "").trim().toLowerCase();
    if (identifier === "primal-companion") return true;
    const source = String(item?.getFlag?.("dnd5e", "sourceId") ?? item?._stats?.compendiumSource ?? "").toLowerCase();
    return source.includes("primal") && String(activity?.name ?? "").trim().toLowerCase() === "summon companion";
  }

  static #companionType(profile, token) {
    const value = `${profile?.name ?? ""} ${profile?.label ?? ""} ${token?.name ?? ""}`.toLowerCase();
    if (value.includes("sky")) return "sky";
    if (value.includes("sea")) return "sea";
    if (value.includes("land")) return "land";
    return "unknown";
  }

  static async #folder() {
    let folder = game.folders?.find?.(entry => entry.type === "Actor" && entry.name === FOLDER_NAME);
    if (folder) return folder;
    return Folder.create({ name: FOLDER_NAME, type: "Actor", sorting: "a" });
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
