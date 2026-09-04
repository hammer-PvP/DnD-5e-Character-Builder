import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "temporary-transformation-actor-cleanup";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REQUEST = "temporaryTransformationActorCleanupRequest";

/**
 * Completes the native D&D5e transformation lifecycle for player-initiated
 * reverts. D&D5e 5.3.3 deletes transformed Actor documents when a GM performs
 * the revert, but player reverts can only clear their polymorph flags. This
 * service captures the native transformation chain before revert and asks the
 * active GM to delete only the proven temporary Actor documents after the
 * native player branch has completed.
 */
export class TransformationActorCleanupService {
  static #initialized = false;
  static #socketReady = false;
  static #pending = new Map();
  static #requested = new Set();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    Hooks.on("dnd5e.revertOriginalForm", actor => this.#capture(actor));
    Hooks.on("updateActor", (actor, _changes, options, userId) => {
      if (options?.characterBuilderTransformationCleanup) return;
      this.#completePlayerRevert(actor, userId);
    });
    Hooks.on("deleteActor", actor => {
      this.#pending.delete(String(actor?.id ?? ""));
      this.#requested.delete(String(actor?.id ?? ""));
    });
    Hooks.on("updateUser", () => this.#retryReadyRequests());
  }

  static ready() {
    if (this.#socketReady || !globalThis.game?.socket?.on) return;
    this.#socketReady = true;
    game.socket.on(SOCKET_CHANNEL, payload => {
      if (payload?.type !== SOCKET_REQUEST || !this.#isActiveGM()) return;
      void this.#handleRequest(payload).catch(error => {
        console.warn(`${MODULE_ID} | Temporary transformation Actor cleanup request failed.`, error);
      });
    });
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static #capture(actor) {
    if (!this.enabled() || !actor || game.user?.isGM) return;
    const originalActorId = String(actor.getFlag?.("dnd5e", "originalActor") ?? "").trim();
    if (!originalActorId || !actor.getFlag?.("dnd5e", "isPolymorphed")) return;

    const previousActorIds = this.#values(actor.getFlag?.("dnd5e", "previousActorIds"));
    const candidateIds = [...new Set([...previousActorIds, actor.id]
      .map(String).filter(id => id && id !== originalActorId))];
    const temporaryActorIds = candidateIds.filter(id => {
      const candidate = game.actors?.get?.(id);
      if (!candidate) return false;
      return String(candidate.getFlag?.("dnd5e", "originalActor") ?? "") === originalActorId;
    });
    if (!temporaryActorIds.length) return;

    this.#pending.set(String(actor.id), {
      transformedActorId: String(actor.id),
      originalActorId,
      temporaryActorIds,
      requesterId: game.user?.id ?? null,
      capturedAt: Date.now()
    });
  }

  static #completePlayerRevert(actor, userId) {
    if (!actor?.id || userId !== game.user?.id || game.user?.isGM) return;
    const key = String(actor.id);
    const pending = this.#pending.get(key);
    if (!pending || this.#requested.has(key)) return;

    // Native player revert removes isPolymorphed/previousActorIds but deliberately
    // leaves originalActor on the temporary Actor. That post-update state is the
    // lifecycle barrier proving tokens have already been restored to the source
    // character before any GM deletion is requested.
    if (actor.getFlag?.("dnd5e", "isPolymorphed")) return;
    if (this.#values(actor.getFlag?.("dnd5e", "previousActorIds")).length) return;
    if (String(actor.getFlag?.("dnd5e", "originalActor") ?? "") !== pending.originalActorId) return;

    pending.readyForCleanup = true;
    if (!this.#dispatch(pending)) return;
    this.#requested.add(key);
    this.#pending.delete(key);
  }

  static #dispatch(pending) {
    this.ready();
    const activeGM = this.#activeGM();
    if (!activeGM) return false;
    if (game.user?.id === activeGM.id) {
      void this.#execute(pending).catch(error => console.warn(`${MODULE_ID} | Transformation Actor cleanup failed.`, error));
      return true;
    }
    game.socket.emit(SOCKET_CHANNEL, {
      type: SOCKET_REQUEST,
      requestId: foundry.utils.randomID?.(24) ?? crypto.randomUUID(),
      ...pending
    });
    return true;
  }

  static #retryReadyRequests() {
    if (!this.enabled() || game.user?.isGM) return;
    for (const [key, pending] of this.#pending) {
      if (!pending?.readyForCleanup || this.#requested.has(key)) continue;
      if (!this.#dispatch(pending)) continue;
      this.#requested.add(key);
      this.#pending.delete(key);
    }
  }

  static async #handleRequest(payload) {
    if (!this.enabled()) return;
    await this.#execute(payload);
  }

  static async #execute(request) {
    const requester = game.users?.get?.(String(request?.requesterId ?? ""));
    const originalActorId = String(request?.originalActorId ?? "").trim();
    const original = game.actors?.get?.(originalActorId);
    if (!requester || !original) throw new Error("The requesting user or original Actor could not be resolved.");
    if (!requester.isGM && !original.testUserPermission?.(requester, "OWNER")) {
      throw new Error("The requesting user does not own the original transformed Actor.");
    }

    const requestedIds = [...new Set(this.#values(request?.temporaryActorIds).map(String))];
    const safeIds = requestedIds.filter(id => {
      if (!id || id === originalActorId) return false;
      const candidate = game.actors?.get?.(id);
      if (!candidate) return false;
      // originalActor survives the native player's flag cleanup and is the
      // authoritative proof that this document belongs to this transformation
      // chain. Never infer temporary status from name/type/folder/ownership.
      return String(candidate.getFlag?.("dnd5e", "originalActor") ?? "") === originalActorId;
    });
    if (!safeIds.length) return { status: "already-clean", deleted: [] };

    await Actor.implementation.deleteDocuments(safeIds, {
      characterBuilderTransformationCleanup: true,
      originalActorId,
      requesterId: requester.id
    });
    return { status: "cleaned", deleted: safeIds };
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

  static #values(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return [...value];
    if (typeof value.values === "function") return [...value.values()];
    if (typeof value === "object") return Object.values(value);
    return [];
  }
}
