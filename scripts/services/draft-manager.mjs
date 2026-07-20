import { MODULE_ID, DRAFT_FOLDER_NAME } from "../constants.mjs";
import { ActorCommitService } from "./actor-commit-service.mjs";

export class DraftManager {
  static async getOrCreate(actor) {
    const draftId = actor.getFlag(MODULE_ID, "draftActorId");
    const existing = draftId ? game.actors.get(draftId) : null;
    if (existing) return existing;

    const folder = await this.#getOrCreateFolder();
    const data = actor.toObject();
    delete data._id;
    data.name = `[Character Builder Draft] ${actor.name}`;
    data.folder = folder.id;
    data.ownership = foundry.utils.deepClone(actor.ownership);
    data.flags ??= {};
    data.flags[MODULE_ID] = {
      isDraft: true,
      sourceActorId: actor.id,
      createdAt: Date.now(),
      baseCurrency: foundry.utils.deepClone(actor.system.currency ?? {}),
      buildState: {
        step: "abilitiesBackground",
        characterName: actor.name,
        abilityMethod: "pointBuy",
        baseAbilities: { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
        selectedBackgroundUuid: null,
        backgroundAbilityAssignments: {},
        abilityBackgroundFingerprint: null,
        rollSets: [],
        selectedRollSet: null,
        abilitiesSaved: false,
        spellAccess: {},
        spellAccessSaved: false,
        equipment: {},
        equipmentSaved: false,
        shop: { cart: [], totalBudgetCp: 0, spentCp: 0, remainingCp: 0 }
      }
    };

    const draft = await Actor.create(data, { renderSheet: false });
    await actor.setFlag(MODULE_ID, "draftActorId", draft.id);
    return draft;
  }

  static async discard(actor) {
    const draftId = actor.getFlag(MODULE_ID, "draftActorId");
    const draft = draftId ? game.actors.get(draftId) : null;
    if (draft) await draft.delete();
    await actor.unsetFlag(MODULE_ID, "draftActorId");
  }

  static async commit(actor, draft, options = {}) {
    return ActorCommitService.commit(actor, draft, options);
  }

  static getBuildState(draft) {
    return foundry.utils.deepClone(draft.getFlag(MODULE_ID, "buildState") ?? {});
  }

  static async setBuildState(draft, changes) {
    const current = this.getBuildState(draft);
    const next = foundry.utils.mergeObject(current, changes, {
      inplace: false,
      insertKeys: true,
      insertValues: true,
      overwrite: true
    });

    // Foundry's recursive merge intentionally retains nested keys when an
    // empty object is supplied. In the Build Plan, an explicit empty top-level
    // object means “clear this stage state” (for example after changing Class).
    for (const [key, value] of Object.entries(changes ?? {})) {
      if (value && value.constructor === Object && Object.keys(value).length === 0) next[key] = {};
    }
    await draft.setFlag(MODULE_ID, "buildState", next);
    return next;
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
