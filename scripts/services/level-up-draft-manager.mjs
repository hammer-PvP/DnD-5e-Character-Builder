import { MODULE_ID, DRAFT_FOLDER_NAME } from "../constants.mjs";
import { LevelUpService } from "./level-up-service.mjs";

export class LevelUpDraftManager {
  static async getOrCreate(actor) {
    const draftId = actor.getFlag(MODULE_ID, "levelUpDraftId");
    const existing = draftId ? game.actors.get(draftId) : null;
    if (existing) return existing;

    const folder = await this.#getOrCreateFolder();
    const data = actor.toObject();
    delete data._id;
    data.name = `[Character Builder Level Up] ${actor.name}`;
    data.folder = folder.id;
    data.ownership = foundry.utils.deepClone(actor.ownership);
    data.flags ??= {};
    data.flags[MODULE_ID] = foundry.utils.mergeObject(data.flags[MODULE_ID] ?? {}, {
      isLevelUpDraft: true,
      sourceActorId: actor.id,
      createdAt: Date.now(),
      levelUpState: this.#initialState(actor)
    }, {
      inplace: false,
      overwrite: true,
      insertKeys: true,
      insertValues: true
    });
    delete data.flags[MODULE_ID].levelUpDraftId;
    delete data.flags[MODULE_ID].isDraft;

    const draft = await Actor.create(data, { renderSheet: false });
    await actor.setFlag(MODULE_ID, "levelUpDraftId", draft.id);
    return draft;
  }

  static getState(draft) {
    return foundry.utils.deepClone(draft.getFlag(MODULE_ID, "levelUpState") ?? {});
  }

  static async setState(draft, changes) {
    const current = this.getState(draft);
    const next = foundry.utils.mergeObject(current, changes, {
      inplace: false,
      insertKeys: true,
      insertValues: true,
      overwrite: true
    });
    for (const [key, value] of Object.entries(changes ?? {})) {
      if (value && value.constructor === Object && Object.keys(value).length === 0) next[key] = {};
      if (Array.isArray(value) && value.length === 0) next[key] = [];
    }
    await draft.setFlag(MODULE_ID, "levelUpState", next);
    return next;
  }


  static async restartClassSelection(actor) {
    if (!actor?.isOwner) throw new Error("You do not own this Actor.");
    const draftId = actor.getFlag(MODULE_ID, "levelUpDraftId");
    const draft = draftId ? game.actors.get(draftId) : null;
    const { HitPointAdvancementService } = await import("./hit-point-advancement-service.mjs");
    const lock = HitPointAdvancementService.lockedRoll(actor);
    if (draft) await draft.delete();
    await actor.unsetFlag(MODULE_ID, "levelUpDraftId");
    const fresh = await this.getOrCreate(actor);
    await this.setState(fresh, {
      transactionId: lock?.transactionId ?? this.getState(fresh).transactionId,
      step: "class",
      restartClassSelection: Boolean(lock),
      retainedHitPointRoll: lock ? {
        raw: Number(lock.result?.raw ?? 0),
        denomination: lock.result?.denomination ?? lock.denomination ?? null
      } : null
    });
    return fresh;
  }

  static async discard(actor, { gmReset = false } = {}) {
    if (!game.user.isGM || !gmReset) {
      throw new Error("Only an explicit GM reset can delete a pending Level Up and release its locked Hit Die result.");
    }
    const draftId = actor.getFlag(MODULE_ID, "levelUpDraftId");
    const draft = draftId ? game.actors.get(draftId) : null;
    const { HitPointAdvancementService } = await import("./hit-point-advancement-service.mjs");
    await HitPointAdvancementService.clearLockedRoll(actor, {
      reason: "gm-reset",
      archive: true
    });
    if (draft) await draft.delete();
    await actor.unsetFlag(MODULE_ID, "levelUpDraftId");
  }

  static #initialState(actor) {
    const sourceCharacterLevel = LevelUpService.actorLevel(actor);
    const hp = actor.system?.attributes?.hp ?? {};
    return {
      transactionId: foundry.utils.randomID(),
      step: "class",
      sourceCharacterLevel,
      targetCharacterLevel: Math.min(20, sourceCharacterLevel + 1),
      sourceHpValue: Number(hp.value ?? 0),
      sourceHpMaximum: Number(hp.effectiveMax ?? hp.max ?? hp.value ?? 0),
      selectedClassId: null,
      selectedClassSourceUuid: null,
      selectedClassIdentifier: null,
      selectedClassName: null,
      multiclass: false,
      sourceClassLevel: null,
      targetClassLevel: null,
      hpMethod: null,
      hpResult: null,
      restartClassSelection: false,
      retainedHitPointRoll: null,
      nativeRunning: false,
      nativeComplete: false,
      itemGrantIntegrity: { items: [], repairedItemIds: [] },
      itemGrantReconciliation: { items: [], repairedItemIds: [] },
      additionalChoices: {},
      additionalComplete: false,
      commitReady: false,
      createdItemIds: [],
      historyPreview: null
    };
  }

  static async #getOrCreateFolder() {
    let folder = game.folders.find(candidate =>
      candidate.type === "Actor" &&
      candidate.name === DRAFT_FOLDER_NAME &&
      candidate.getFlag(MODULE_ID, "draftFolder")
    );
    if (folder) return folder;

    folder = await Folder.create({
      name: DRAFT_FOLDER_NAME,
      type: "Actor",
      sorting: "a",
      flags: { [MODULE_ID]: { draftFolder: true } }
    });
    return folder;
  }
}
