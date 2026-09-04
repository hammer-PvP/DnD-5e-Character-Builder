import { DRAFT_FOLDER_NAME, MODULE_ID, MODULE_VERSION } from "../constants.mjs";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REQUEST = "temporaryActorRequest";
const SOCKET_RESPONSE = "temporaryActorResponse";
const REQUEST_TIMEOUT_MS = 15000;
const OWNER_LEVEL = 3;

const CREATE_ACTIONS = new Set([
  "create-character-draft",
  "create-level-up-draft",
  "create-safety-backup"
]);

const DELETE_ACTIONS = new Set([
  "delete-character-draft",
  "delete-level-up-draft",
  "delete-safety-backup"
]);

/**
 * GM-authoritative creation and cleanup for temporary Actor documents.
 * Players never receive generic Actor create/delete authority. They request one
 * closed operation, and the active GM reconstructs and validates the document
 * from the live source Actor before performing it.
 */
export class TemporaryActorService {
  static #socketReady = false;
  static #pending = new Map();
  static #locks = new Map();

  static ready() {
    if (this.#socketReady || !globalThis.game?.socket?.on) return;
    this.#socketReady = true;
    game.socket.on(SOCKET_CHANNEL, payload => {
      if (payload?.type === SOCKET_RESPONSE) {
        this.#handleResponse(payload);
        return;
      }
      if (payload?.type !== SOCKET_REQUEST || !this.#isActiveGM()) return;
      void this.#handleRequest(payload);
    });
  }

  static async createCharacterDraft(sourceActor, { buildState, creationSessionId = null } = {}) {
    return this.#create("create-character-draft", sourceActor, {
      buildState: foundry.utils.deepClone(buildState ?? {}),
      creationSessionId: creationSessionId ?? foundry.utils.randomID?.() ?? `${sourceActor.id}-${Date.now()}`
    });
  }

  static async createLevelUpDraft(sourceActor, { levelUpState } = {}) {
    return this.#create("create-level-up-draft", sourceActor, {
      levelUpState: foundry.utils.deepClone(levelUpState ?? {})
    });
  }

  static async createSafetyBackup(sourceActor, { draftId = null, transactionToken = null } = {}) {
    if (!transactionToken) throw new Error("A transaction token is required to create a safety backup.");
    return this.#create("create-safety-backup", sourceActor, {
      draftId,
      transactionToken
    });
  }

  static async deleteCharacterDraft(draft, { sourceActorId = null } = {}) {
    return this.#delete("delete-character-draft", draft, { sourceActorId });
  }

  static async deleteLevelUpDraft(draft, { sourceActorId = null, transactionId = null } = {}) {
    return this.#delete("delete-level-up-draft", draft, { sourceActorId, transactionId });
  }

  static async deleteSafetyBackup(backup, { sourceActorId = null, transactionToken = null } = {}) {
    return this.#delete("delete-safety-backup", backup, { sourceActorId, transactionToken });
  }

  static async #create(action, sourceActor, payload) {
    if (!CREATE_ACTIONS.has(action)) throw new Error("Unsupported temporary Actor creation request.");
    if (!sourceActor?.id) throw new Error("A source Actor is required.");
    const response = await this.#dispatch(action, {
      sourceActorId: sourceActor.id,
      ...payload
    });
    return this.#resolveCreatedActor(response.actorId);
  }

  static async #delete(action, actorOrId, payload) {
    if (!DELETE_ACTIONS.has(action)) throw new Error("Unsupported temporary Actor cleanup request.");
    const temporaryActorId = String(actorOrId?.id ?? actorOrId ?? "");
    if (!temporaryActorId) return true;
    await this.#dispatch(action, {
      temporaryActorId,
      ...payload
    });
    return true;
  }

  static async #dispatch(action, payload) {
    this.ready();
    if (game.user?.isGM) {
      return this.#execute({
        action,
        requesterId: game.user.id,
        requestId: foundry.utils.randomID?.(24) ?? crypto.randomUUID(),
        ...payload
      });
    }

    const activeGM = this.#activeGM();
    if (!activeGM) {
      throw new Error("A connected GM is required for Character Builder to create or clean up its protected temporary Actors.");
    }

    const requestId = foundry.utils.randomID?.(24) ?? crypto.randomUUID();
    const request = {
      type: SOCKET_REQUEST,
      action,
      requestId,
      requesterId: game.user.id,
      ...payload
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("The active GM did not complete the protected Character Builder Actor operation in time."));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve, reject, timeout });
      game.socket.emit(SOCKET_CHANNEL, request);
    });
  }

  static async #handleRequest(payload) {
    const response = {
      type: SOCKET_RESPONSE,
      requestId: payload.requestId,
      requesterId: payload.requesterId,
      success: false
    };
    try {
      const result = await this.#execute(payload);
      response.success = true;
      response.result = result ?? {};
    } catch (error) {
      console.warn(`${MODULE_ID} | Protected temporary Actor operation rejected.`, {
        action: payload?.action,
        requesterId: payload?.requesterId,
        error
      });
      response.error = String(error?.message ?? error);
    }
    game.socket.emit(SOCKET_CHANNEL, response);
  }

  static #handleResponse(payload) {
    if (payload.requesterId !== game.user?.id) return;
    const pending = this.#pending.get(payload.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(payload.requestId);
    if (payload.success) pending.resolve(payload.result ?? {});
    else pending.reject(new Error(payload.error || "The GM rejected the protected Character Builder Actor operation."));
  }

  static async #execute(request) {
    const action = String(request?.action ?? "");
    if (!CREATE_ACTIONS.has(action) && !DELETE_ACTIONS.has(action)) {
      throw new Error("The requested temporary Actor operation is not allowed.");
    }
    const lockKey = [action, request.sourceActorId ?? "", request.temporaryActorId ?? "", request.transactionToken ?? ""].join(":");
    const existing = this.#locks.get(lockKey);
    if (existing) return existing;
    const operation = (CREATE_ACTIONS.has(action)
      ? this.#executeCreate(action, request)
      : this.#executeDelete(action, request)
    ).finally(() => {
      if (this.#locks.get(lockKey) === operation) this.#locks.delete(lockKey);
    });
    this.#locks.set(lockKey, operation);
    return operation;
  }

  static async #executeCreate(action, request) {
    const { sourceActor, requester } = this.#validateRequester(request);
    const folder = await this.#getOrCreateFolder();

    if (action === "create-character-draft") {
      const existing = this.#matchingTemporary(sourceActor, "character-draft");
      if (existing) {
        await this.#linkSource(sourceActor, "draftActorId", existing.id);
        return { actorId: existing.id, reused: true };
      }
      const data = this.#cloneActorSource(sourceActor);
      delete data._id;
      data.name = `[Character Builder Draft] ${sourceActor.name}`;
      data.folder = folder.id;
      data.ownership = this.#temporaryOwnership(sourceActor, requester);
      data.flags ??= {};
      data.flags[MODULE_ID] = {
        isDraft: true,
        sourceActorId: sourceActor.id,
        creationSessionId: String(request.creationSessionId ?? foundry.utils.randomID?.() ?? `${sourceActor.id}-${Date.now()}`),
        createdAt: Date.now(),
        createdByUserId: requester.id,
        moduleVersion: MODULE_VERSION,
        baseCurrency: foundry.utils.deepClone(sourceActor.system?.currency ?? {}),
        buildState: foundry.utils.deepClone(request.buildState ?? {})
      };
      const draft = await Actor.create(data, {
        renderSheet: false,
        characterBuilderTemporaryActor: true,
        characterBuilderTemporaryKind: "character-draft"
      });
      if (!draft) throw new Error("Character Builder could not create the Character Creation Draft.");
      await this.#linkSource(sourceActor, "draftActorId", draft.id);
      return { actorId: draft.id };
    }

    if (action === "create-level-up-draft") {
      const existing = this.#matchingTemporary(sourceActor, "level-up-draft");
      if (existing) {
        await this.#linkSource(sourceActor, "levelUpDraftId", existing.id);
        return { actorId: existing.id, reused: true };
      }
      const levelUpState = foundry.utils.deepClone(request.levelUpState ?? {});
      if (!levelUpState?.transactionId) throw new Error("The Level Up Draft request is missing its transaction identity.");
      const data = this.#cloneActorSource(sourceActor);
      delete data._id;
      data.name = `[Character Builder Level Up] ${sourceActor.name}`;
      data.folder = folder.id;
      data.ownership = this.#temporaryOwnership(sourceActor, requester);
      data.flags ??= {};
      data.flags[MODULE_ID] = foundry.utils.mergeObject(data.flags[MODULE_ID] ?? {}, {
        isLevelUpDraft: true,
        sourceActorId: sourceActor.id,
        createdAt: Date.now(),
        createdByUserId: requester.id,
        moduleVersion: MODULE_VERSION,
        levelUpState
      }, {
        inplace: false,
        overwrite: true,
        insertKeys: true,
        insertValues: true
      });
      delete data.flags[MODULE_ID].levelUpDraftId;
      delete data.flags[MODULE_ID].isDraft;
      const draft = await Actor.create(data, {
        renderSheet: false,
        characterBuilderTemporaryActor: true,
        characterBuilderTemporaryKind: "level-up-draft"
      });
      if (!draft) throw new Error("Character Builder could not create the Level Up Draft.");
      await this.#linkSource(sourceActor, "levelUpDraftId", draft.id);
      return { actorId: draft.id };
    }

    if (action === "create-safety-backup") {
      const token = String(request.transactionToken ?? "");
      if (!token) throw new Error("The safety backup request is missing its transaction token.");
      const existing = game.actors.find(candidate => candidate.getFlag(MODULE_ID, "commitSafetyBackup")
        && candidate.getFlag(MODULE_ID, "sourceActorId") === sourceActor.id
        && candidate.getFlag(MODULE_ID, "transactionToken") === token);
      if (existing) return { actorId: existing.id, reused: true };

      const draft = request.draftId ? game.actors.get(request.draftId) : null;
      if (draft && draft.getFlag(MODULE_ID, "sourceActorId") !== sourceActor.id) {
        throw new Error("The requested safety backup Draft does not belong to the source Actor.");
      }
      const data = this.#cloneActorSource(sourceActor);
      delete data._id;
      data.name = `[Character Builder Safety Backup] ${sourceActor.name}`;
      data.folder = draft?.folder?.id ?? draft?.folder ?? sourceActor.folder?.id ?? sourceActor.folder ?? folder.id;
      data.ownership = this.#temporaryOwnership(sourceActor, requester);
      data.flags ??= {};
      data.flags[MODULE_ID] = {
        ...(data.flags[MODULE_ID] ?? {}),
        commitSafetyBackup: true,
        sourceActorId: sourceActor.id,
        transactionToken: token,
        createdAt: Date.now(),
        createdByUserId: requester.id,
        moduleVersion: MODULE_VERSION
      };
      const backup = await Actor.create(data, {
        renderSheet: false,
        characterBuilderSafetyBackup: true,
        characterBuilderTemporaryActor: true,
        characterBuilderTemporaryKind: "safety-backup"
      });
      if (!backup) throw new Error("Character Builder could not create the pre-commit safety backup Actor.");
      return { actorId: backup.id };
    }

    throw new Error("Unsupported temporary Actor creation request.");
  }

  static async #executeDelete(action, request) {
    const temporary = game.actors.get(String(request.temporaryActorId ?? ""));
    if (!temporary) return { deleted: false, alreadyMissing: true };
    const sourceActorId = String(request.sourceActorId ?? temporary.getFlag(MODULE_ID, "sourceActorId") ?? "");
    const { sourceActor } = this.#validateRequester({ ...request, sourceActorId });
    if (temporary.getFlag(MODULE_ID, "sourceActorId") !== sourceActor.id) {
      throw new Error("The temporary Actor is not linked to the requested source Actor.");
    }

    if (action === "delete-character-draft") {
      if (!temporary.getFlag(MODULE_ID, "isDraft") || temporary.getFlag(MODULE_ID, "isLevelUpDraft")) {
        throw new Error("The requested Actor is not a Character Creation Draft.");
      }
      await temporary.delete({ characterBuilderTemporaryActorCleanup: true });
      if (sourceActor.getFlag(MODULE_ID, "draftActorId") === temporary.id) {
        await sourceActor.unsetFlag(MODULE_ID, "draftActorId");
      }
      return { deleted: true };
    }

    if (action === "delete-level-up-draft") {
      if (!temporary.getFlag(MODULE_ID, "isLevelUpDraft")) {
        throw new Error("The requested Actor is not a Level Up Draft.");
      }
      const expectedTransaction = String(request.transactionId ?? "");
      const actualTransaction = String(temporary.getFlag(MODULE_ID, "levelUpState")?.transactionId ?? "");
      if (expectedTransaction && actualTransaction && expectedTransaction !== actualTransaction) {
        throw new Error("The Level Up Draft transaction identity does not match the cleanup request.");
      }
      await temporary.delete({ characterBuilderTemporaryActorCleanup: true });
      if (sourceActor.getFlag(MODULE_ID, "levelUpDraftId") === temporary.id) {
        await sourceActor.unsetFlag(MODULE_ID, "levelUpDraftId");
      }
      return { deleted: true };
    }

    if (action === "delete-safety-backup") {
      if (!temporary.getFlag(MODULE_ID, "commitSafetyBackup")) {
        throw new Error("The requested Actor is not a Character Builder safety backup.");
      }
      const expectedToken = String(request.transactionToken ?? "");
      const actualToken = String(temporary.getFlag(MODULE_ID, "transactionToken") ?? "");
      if (!expectedToken || expectedToken !== actualToken) {
        throw new Error("The safety backup transaction token does not match the cleanup request.");
      }
      const lock = sourceActor.getFlag(MODULE_ID, "commitSafetyLock");
      if (lock?.safetyBackupActorId === temporary.id) {
        throw new Error("The safety backup is protected by an active rollback safety lock.");
      }
      await temporary.delete({ characterBuilderSafetyBackupCleanup: true, characterBuilderTemporaryActorCleanup: true });
      return { deleted: true };
    }

    throw new Error("Unsupported temporary Actor cleanup request.");
  }

  static #validateRequester(request) {
    const requester = game.users.get(String(request.requesterId ?? ""));
    if (!requester) throw new Error("The requesting Foundry user could not be resolved.");
    const sourceActor = game.actors.get(String(request.sourceActorId ?? ""));
    if (!sourceActor || sourceActor.type !== "character") throw new Error("The source Player Character Actor could not be resolved.");
    if (!requester.isGM && !this.#userOwnsActor(requester, sourceActor)) {
      throw new Error("The requesting user does not own the source Actor.");
    }
    return { requester, sourceActor };
  }

  static #userOwnsActor(user, actor) {
    if (typeof actor.testUserPermission === "function") {
      try { return actor.testUserPermission(user, "OWNER"); } catch (_error) { /* fall through */ }
    }
    const explicit = Number(actor.ownership?.[user.id] ?? NaN);
    const fallback = Number(actor.ownership?.default ?? 0);
    return (Number.isFinite(explicit) ? explicit : fallback) >= OWNER_LEVEL;
  }

  static #temporaryOwnership(sourceActor, requester) {
    const ownership = foundry.utils.deepClone(sourceActor.ownership ?? { default: 0 });
    ownership[requester.id] = Math.max(OWNER_LEVEL, Number(ownership[requester.id] ?? 0));
    return ownership;
  }

  static #matchingTemporary(sourceActor, kind) {
    const candidates = game.actors.filter(candidate => {
      if (candidate.type !== "character") return false;
      if (candidate.getFlag(MODULE_ID, "sourceActorId") !== sourceActor.id) return false;
      if (kind === "character-draft") return candidate.getFlag(MODULE_ID, "isDraft") && !candidate.getFlag(MODULE_ID, "isLevelUpDraft");
      if (kind === "level-up-draft") return candidate.getFlag(MODULE_ID, "isLevelUpDraft");
      return false;
    });
    return [...candidates].sort((left, right) => Number(right.getFlag(MODULE_ID, "createdAt") ?? 0)
      - Number(left.getFlag(MODULE_ID, "createdAt") ?? 0))[0] ?? null;
  }

  static async #linkSource(sourceActor, flag, actorId) {
    if (sourceActor.getFlag(MODULE_ID, flag) === actorId) return;
    await sourceActor.setFlag(MODULE_ID, flag, actorId);
  }

  static #cloneActorSource(actor) {
    const data = foundry.utils.deepClone(actor.toObject());
    data.items = actor.items.map(item => foundry.utils.deepClone(item.toObject()));
    data.effects = (actor.effects?.contents ?? [...(actor.effects ?? [])])
      .map(effect => foundry.utils.deepClone(effect.toObject()));
    return data;
  }

  static async #getOrCreateFolder() {
    let folder = game.folders.find(candidate => candidate.type === "Actor"
      && candidate.name === DRAFT_FOLDER_NAME
      && candidate.getFlag(MODULE_ID, "draftFolder"));
    if (folder) return folder;
    folder = await Folder.create({
      name: DRAFT_FOLDER_NAME,
      type: "Actor",
      sorting: "a",
      flags: { [MODULE_ID]: { draftFolder: true } }
    });
    if (!folder) throw new Error("Character Builder could not create its protected Draft folder.");
    return folder;
  }

  static async #resolveCreatedActor(actorId) {
    const id = String(actorId ?? "");
    for (let attempt = 0; attempt < 50; attempt++) {
      const actor = game.actors.get(id);
      if (actor) return actor;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("The GM created the protected temporary Actor, but it was not synchronized to this client.");
  }

  static #activeGM() {
    const preferred = game.users?.activeGM;
    if (preferred?.active && preferred.isGM) return preferred;
    return game.users?.contents?.filter(user => user.active && user.isGM)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
  }

  static #isActiveGM() {
    return Boolean(game.user?.isGM && this.#activeGM()?.id === game.user.id);
  }
}
