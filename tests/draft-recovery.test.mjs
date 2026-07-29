import test from "node:test";
import assert from "node:assert/strict";

function actorCollection(rows) {
  return {
    get(id) { return rows.find(row => row.id === id) ?? null; },
    filter(predicate) { return rows.filter(predicate); },
    [Symbol.iterator]() { return rows[Symbol.iterator](); }
  };
}

function draftActor(id, sourceId, createdAt = 1) {
  const flags = {
    "dnd5e-character-builder": {
      isDraft: true,
      sourceActorId: sourceId,
      isLevelUpDraft: false,
      createdAt
    }
  };
  return {
    id,
    type: "character",
    _stats: { createdTime: createdAt },
    getFlag(scope, key) { return flags[scope]?.[key]; }
  };
}

function sourceActor(id, rows) {
  const moduleFlags = {};
  return {
    id,
    uuid: `Actor.${id}`,
    name: "Test Hero",
    type: "character",
    ownership: { default: 0 },
    system: { currency: {} },
    getFlag(scope, key) {
      if (scope !== "dnd5e-character-builder") return undefined;
      return moduleFlags[key];
    },
    async setFlag(scope, key, value) {
      assert.equal(scope, "dnd5e-character-builder");
      moduleFlags[key] = structuredClone(value);
      return value;
    },
    async unsetFlag(scope, key) {
      assert.equal(scope, "dnd5e-character-builder");
      delete moduleFlags[key];
    },
    toObject() {
      return {
        name: this.name,
        type: this.type,
        ownership: structuredClone(this.ownership),
        system: structuredClone(this.system),
        flags: {}
      };
    },
    _moduleFlags: moduleFlags,
    _rows: rows
  };
}

function installGlobals(rows) {
  let random = 0;
  globalThis.foundry = {
    utils: {
      deepClone: value => structuredClone(value),
      randomID: () => `random-${++random}`,
      mergeObject: (left, right) => ({ ...structuredClone(left), ...structuredClone(right) })
    }
  };
  globalThis.game = {
    user: { id: "user-1", isGM: true },
    actors: actorCollection(rows),
    folders: { find: () => ({ id: "draft-folder" }) }
  };
  globalThis.ui = { notifications: { warn() {} } };
  globalThis.Folder = { create: async () => ({ id: "draft-folder" }) };
}

test("reload recovery relinks an orphaned Character Creation Draft instead of creating another Actor", async () => {
  const rows = [];
  const source = sourceActor("source-1", rows);
  const orphan = draftActor("draft-existing", source.id, 25);
  rows.push(source, orphan);
  installGlobals(rows);

  let creates = 0;
  globalThis.Actor = {
    async create() {
      creates += 1;
      throw new Error("Actor.create must not run when a recoverable Draft exists");
    }
  };

  const { DraftManager } = await import("../scripts/services/draft-manager.mjs?test=recover-orphan");
  const result = await DraftManager.getOrCreate(source);

  assert.equal(result, orphan);
  assert.equal(source._moduleFlags.draftActorId, orphan.id);
  assert.equal(creates, 0);
});

test("concurrent same-client opens share one atomic Draft creation", async () => {
  const rows = [];
  const source = sourceActor("source-2", rows);
  rows.push(source);
  installGlobals(rows);

  let creates = 0;
  globalThis.Actor = {
    async create(data) {
      creates += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      const created = draftActor("draft-new", source.id, Number(data.flags["dnd5e-character-builder"].createdAt));
      rows.push(created);
      return created;
    }
  };

  const { DraftManager } = await import("../scripts/services/draft-manager.mjs?test=single-flight");
  const [left, right] = await Promise.all([
    DraftManager.getOrCreate(source),
    DraftManager.getOrCreate(source)
  ]);

  assert.equal(creates, 1);
  assert.equal(left.id, "draft-new");
  assert.equal(right, left);
  assert.equal(source._moduleFlags.draftActorId, "draft-new");
  assert.equal(source._moduleFlags.draftCreationLock, undefined);
});
