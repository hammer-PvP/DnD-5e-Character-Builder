import { MODULE_ID, DRAFT_FOLDER_NAME } from "../constants.mjs";
import { ActorCommitService } from "./actor-commit-service.mjs";

export class DraftManager {
  static #pendingByActor = new Map();

  static getOrCreate(actor) {
    const key = actor?.uuid ?? actor?.id;
    if (!key) return Promise.reject(new Error("A source Actor is required to create a Character Builder Draft."));

    const pending = this.#pendingByActor.get(key);
    if (pending) return pending;

    const operation = this.#getOrCreate(actor).finally(() => {
      if (this.#pendingByActor.get(key) === operation) this.#pendingByActor.delete(key);
    });
    this.#pendingByActor.set(key, operation);
    return operation;
  }

  static async #getOrCreate(actor) {
    const linked = this.#linkedDraft(actor);
    if (linked) return linked;

    const recovered = this.#recoverableDrafts(actor);
    if (recovered.length) return this.#relinkRecoveredDraft(actor, recovered);

    const lockToken = foundry.utils.randomID?.() ?? `${game.user.id}-${Date.now()}-${Math.random()}`;
    const lock = { token: lockToken, userId: game.user.id, createdAt: Date.now() };
    let ownsWorldLock = false;

    try {
      // This lightweight world flag closes the most common cross-client race.
      // It is not treated as a permanent lock and is always revalidated against
      // actual Draft Actors before any new Actor is created.
      await actor.setFlag(MODULE_ID, "draftCreationLock", lock);
      await new Promise(resolve => setTimeout(resolve, 75));
      ownsWorldLock = actor.getFlag(MODULE_ID, "draftCreationLock")?.token === lockToken;

      if (!ownsWorldLock) {
        const concurrent = await this.#waitForConcurrentDraft(actor);
        if (concurrent) return concurrent;
      }

      const linkedAfterWait = this.#linkedDraft(actor);
      if (linkedAfterWait) return linkedAfterWait;
      const recoveredAfterWait = this.#recoverableDrafts(actor);
      if (recoveredAfterWait.length) return this.#relinkRecoveredDraft(actor, recoveredAfterWait);

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
        creationSessionId: foundry.utils.randomID?.() ?? `${actor.id}-${Date.now()}`,
        createdAt: Date.now(),
        createdByUserId: game.user.id,
        baseCurrency: foundry.utils.deepClone(actor.system.currency ?? {}),
        buildState: {
          step: "abilitiesBackground",
          characterName: actor.name,
          abilityMethod: "pointBuy",
          baseAbilities: { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
          abilityMethodValues: {
            pointBuy: { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
            manual: { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }
          },
          abilitySlotAssignments: {},
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
          editingStages: {
            abilitiesBackground: false,
            species: false,
            class: false,
            spells: false,
            equipment: false
          },
          shop: { cart: [], totalBudgetCp: 0, spentCp: 0, remainingCp: 0 }
        }
      };

      const draft = await Actor.create(data, { renderSheet: false });
      if (!draft) throw new Error("Character Builder could not create the Draft Actor.");

      // Re-scan before linking. If a concurrent client created a Draft in the
      // same interval, converge on one deterministic candidate rather than
      // blindly creating yet another session on the next reload.
      const candidates = this.#recoverableDrafts(actor);
      const selected = this.#selectDraftCandidate(candidates, draft.id);
      await actor.setFlag(MODULE_ID, "draftActorId", selected.id);
      this.#reportDuplicateDrafts(actor, candidates, selected);
      return selected;
    } finally {
      if (actor.getFlag(MODULE_ID, "draftCreationLock")?.token === lockToken) {
        try { await actor.unsetFlag(MODULE_ID, "draftCreationLock"); } catch (_error) { /* best effort */ }
      }
    }
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

  static #linkedDraft(actor) {
    const draftId = actor.getFlag(MODULE_ID, "draftActorId");
    const draft = draftId ? game.actors.get(draftId) : null;
    return this.#isDraftForActor(draft, actor) ? draft : null;
  }

  static #recoverableDrafts(actor) {
    return game.actors.filter(candidate => this.#isDraftForActor(candidate, actor));
  }

  static #isDraftForActor(candidate, actor) {
    return Boolean(candidate
      && candidate.type === "character"
      && candidate.getFlag(MODULE_ID, "isDraft")
      && candidate.getFlag(MODULE_ID, "sourceActorId") === actor.id
      && !candidate.getFlag(MODULE_ID, "isLevelUpDraft"));
  }

  static #selectDraftCandidate(candidates, preferredId = null) {
    if (preferredId) {
      const preferred = candidates.find(candidate => candidate.id === preferredId);
      if (preferred && candidates.length === 1) return preferred;
    }

    return [...candidates].sort((left, right) => {
      const leftTime = Number(left.getFlag(MODULE_ID, "createdAt") ?? left._stats?.createdTime ?? 0);
      const rightTime = Number(right.getFlag(MODULE_ID, "createdAt") ?? right._stats?.createdTime ?? 0);
      if (rightTime !== leftTime) return rightTime - leftTime;
      return String(left.id).localeCompare(String(right.id));
    })[0];
  }

  static async #relinkRecoveredDraft(actor, candidates) {
    const selected = this.#selectDraftCandidate(candidates);
    await actor.setFlag(MODULE_ID, "draftActorId", selected.id);
    this.#reportDuplicateDrafts(actor, candidates, selected);
    console.info(`${MODULE_ID} | Recovered Character Creation Draft ${selected.id} for ${actor.name}.`);
    return selected;
  }

  static #reportDuplicateDrafts(actor, candidates, selected) {
    if (candidates.length < 2) return;
    const orphanIds = candidates.filter(candidate => candidate.id !== selected.id).map(candidate => candidate.id);
    console.warn(`${MODULE_ID} | Multiple Character Creation Drafts were found for ${actor.name}.`, {
      selectedDraftId: selected.id,
      preservedOrphanDraftIds: orphanIds
    });
    if (game.user.isGM) {
      ui.notifications.warn(
        `Character Builder recovered one Draft for ${actor.name} and preserved ${orphanIds.length} older duplicate Draft${orphanIds.length === 1 ? "" : "s"} for GM inspection.`
      );
    }
  }

  static async #waitForConcurrentDraft(actor) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const linked = this.#linkedDraft(actor);
      if (linked) return linked;
      const candidates = this.#recoverableDrafts(actor);
      if (candidates.length) return this.#relinkRecoveredDraft(actor, candidates);
      const lock = actor.getFlag(MODULE_ID, "draftCreationLock");
      if (!lock || (Date.now() - Number(lock.createdAt ?? 0)) > 5000) break;
    }
    return null;
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
