import { MODULE_ID, MODULE_VERSION } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "ranger-primal-companion";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REQUEST = "primalCompanionAssistanceRequest";
const MANAGED_KIND = "primal-companion";
const FOLDER_NAME = "Character Builder Companions";

/**
 * Completes only the lifecycle gaps observed in D&D5e 5.3.3's native Primal
 * Companion summon. Native D&D5e remains authoritative for PB, AC, attacks,
 * damage, and maximum HP. Character Builder snapshots the finalized synthetic
 * summon into a Ranger-specific Actor, gives that Actor the Ranger's owners,
 * starts a newly summoned Beast at its already-derived maximum HP, and removes
 * only the previous managed companion belonging to that Ranger.
 */
export class PrimalCompanionAssistanceService {
  static #initialized = false;
  static #socketReady = false;

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    Hooks.on("dnd5e.postSummon", (activity, profile, createdTokens) => {
      void this.#afterSummon(activity, profile, createdTokens).catch(error => {
        console.warn(`${MODULE_ID} | Primal Companion assistance failed.`, error);
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
    const tokens = [...(createdTokens ?? [])].filter(token => token?.id && token?.parent?.id);
    if (!ranger?.id || !tokens.length) return;

    const payload = {
      rangerActorId: ranger.id,
      requesterId: game.user?.id ?? null,
      tokenUuids: tokens.map(token => token.uuid),
      sourceFeatureUuid: activity?.item?.uuid ?? null,
      activityId: activity?.id ?? null,
      profileId: profile?.id ?? profile?._id ?? null,
      companionType: this.#companionType(profile, tokens[0])
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
    if (!this.enabled()) return;
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

    // Create the replacement first. If anything fails, the native summon stays
    // usable rather than being deleted as part of a partial cleanup.
    const sourceToken = tokenDocs[0];
    const synthetic = sourceToken.actor;
    // Clone the native summon base Actor, not the synthetic Actor. The native
    // ActorDelta already contains the summon-time PB/AC/HP/attack changes and
    // is preserved on the Token; cloning the synthetic Actor would bake those
    // changes into the base and risk applying them twice.
    const baseActor = game.actors?.get?.(sourceToken.actorId) ?? sourceToken.baseActor ?? synthetic;
    const data = baseActor.toObject();
    delete data._id;
    delete data.folder;
    data.name = synthetic.name;
    data.ownership = this.#ownershipFromRanger(ranger);
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

    // Capture the exact native summon delta. D&D5e has already derived hp.max
    // on the synthetic Actor. X2 only SETS current HP to that maximum for this
    // newly summoned Beast; it never adds HP and never heals an existing Beast.
    const deltaData = sourceToken.delta?.toObject?.()
      ?? foundry.utils.deepClone(sourceToken.toObject?.().delta ?? {});
    const hpMax = Number(synthetic.system?.attributes?.hp?.max ?? 0);
    const hpValue = Number(synthetic.system?.attributes?.hp?.value ?? 0);
    if (Number.isFinite(hpMax) && hpMax > 0 && hpValue < hpMax) {
      foundry.utils.setProperty(deltaData, "system.attributes.hp.value", hpMax);
    }

    const folder = await this.#folder();
    data.folder = folder?.id ?? null;
    const managed = await Actor.create(data, {
      renderSheet: false,
      characterBuilderPrimalCompanion: true,
      rangerActorId: ranger.id
    });
    if (!managed) throw new Error("Character Builder could not create the Ranger-specific Primal Companion Actor.");

    try {
      for (const token of tokenDocs) {
        const tokenDelta = token.id === sourceToken.id
          ? foundry.utils.deepClone(deltaData)
          : foundry.utils.deepClone(token.delta?.toObject?.() ?? token.toObject?.().delta ?? {});
        const tokenMax = Number(token.actor?.system?.attributes?.hp?.max ?? 0);
        const tokenValue = Number(token.actor?.system?.attributes?.hp?.value ?? 0);
        if (Number.isFinite(tokenMax) && tokenMax > 0 && tokenValue < tokenMax) {
          foundry.utils.setProperty(tokenDelta, "system.attributes.hp.value", tokenMax);
        }
        await token.update({
          actorId: managed.id,
          actorLink: false,
          delta: tokenDelta
        }, { characterBuilderPrimalCompanion: true });
      }
    } catch (error) {
      await managed.delete({ characterBuilderPrimalCompanionRollback: true }).catch(() => {});
      throw error;
    }

    await this.#removePrevious(ranger, managed.id);
    await this.#removeOrphanedNativeBase(baseActor, managed.id);
  }

  static async #removePrevious(ranger, keepActorId) {
    const previous = [...(game.actors ?? [])].filter(actor => actor?.id !== keepActorId
      && actor.getFlag?.(MODULE_ID, "managedKind") === MANAGED_KIND
      && String(actor.getFlag?.(MODULE_ID, "rangerActorId") ?? "") === String(ranger.id));
    if (!previous.length) return;
    const ids = new Set(previous.map(actor => actor.id));
    for (const scene of game.scenes ?? []) {
      const tokenIds = [...(scene.tokens ?? [])].filter(token => ids.has(token.actorId)).map(token => token.id);
      if (tokenIds.length) await scene.deleteEmbeddedDocuments("Token", tokenIds, { characterBuilderPrimalCompanion: true });
    }
    await Actor.implementation.deleteDocuments([...ids], {
      characterBuilderPrimalCompanion: true,
      rangerActorId: ranger.id
    });
  }

  static #ownershipFromRanger(ranger) {
    // Inherit the Ranger's complete ownership map. In ordinary worlds this
    // means the same player OWNER entries gain full control of the companion;
    // preserving lower explicit levels/default also avoids silently changing a
    // table's existing sharing policy.
    const ownership = foundry.utils.deepClone(ranger?.ownership ?? { default: 0 });
    ownership.default ??= 0;
    return ownership;
  }

  static async #removeOrphanedNativeBase(baseActor, keepActorId) {
    if (!baseActor?.id || baseActor.id === keepActorId) return;
    const autoImported = baseActor.getFlag?.("dnd5e", "isAutoImported") === true
      || baseActor.getFlag?.("dnd5e", "summonedCopy") === true;
    if (!autoImported) return;

    // D&D5e imports/reuses summon templates in the World. Once every token has
    // been rebound to a Ranger-specific managed Actor, remove only an orphaned
    // auto-import. If another summon still references it, leave it alone.
    const referenced = [...(game.scenes ?? [])].some(scene =>
      [...(scene.tokens ?? [])].some(token => String(token.actorId ?? "") === String(baseActor.id))
    );
    if (referenced) return;
    await baseActor.delete({
      characterBuilderPrimalCompanion: true,
      reason: "orphaned-native-summon-template"
    });
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
