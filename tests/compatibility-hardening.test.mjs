import test from "node:test";
import assert from "node:assert/strict";

import { firstValue, valuesArray } from "../scripts/utils/safe-collections.mjs";

test("safe collection helpers ignore a poisoned Array.prototype.first", () => {
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, "first");
  Object.defineProperty(Array.prototype, "first", {
    configurable: true,
    value() {
      throw new TypeError("fnMapFind is not a function");
    }
  });

  try {
    assert.equal(firstValue(["cha", "int"]), "cha");
    assert.deepEqual(valuesArray(["cha", "int"]), ["cha", "int"]);
  } finally {
    if (previous) Object.defineProperty(Array.prototype, "first", previous);
    else delete Array.prototype.first;
  }
});

test("safe collection helpers support Set, Map, and empty values", () => {
  assert.equal(firstValue(new Set(["wizard", "cleric"])), "wizard");
  assert.equal(firstValue(new Map([["a", 1], ["b", 2]])), 1);
  assert.equal(firstValue([]), null);
  assert.equal(firstValue(null), null);
  assert.deepEqual(valuesArray(new Set([1, 2])), [1, 2]);
  assert.deepEqual(valuesArray(new Map([["a", 1], ["b", 2]])), [1, 2]);
});

test("libWrapper registration uses a WRAPPER and not a direct prototype patch", async () => {
  let registration = null;
  globalThis.libWrapper = {
    register(packageId, target, wrapper, type) {
      registration = { packageId, target, wrapper, type };
      return 1;
    }
  };

  const { LibWrapperService } = await import("../scripts/services/lib-wrapper-service.mjs?test=registration");
  assert.equal(LibWrapperService.register(), true);
  assert.equal(registration.packageId, "dnd5e-character-builder");
  assert.equal(registration.target, "dnd5e.applications.advancement.AdvancementManager.prototype._onClose");
  assert.equal(registration.type, "WRAPPER");

  const manager = {};
  let observed = 0;
  LibWrapperService.observeAdvancementClose(manager, ({ error }) => {
    assert.equal(error, null);
    observed += 1;
  });

  const result = registration.wrapper.call(manager, value => `closed:${value}`, "ok");
  assert.equal(result, "closed:ok");
  assert.equal(observed, 1);
  delete globalThis.libWrapper;
});

test("guarded Advancement lifecycle does not replace manager.close", async () => {
  const hookMap = new Map();
  let nextHookId = 1;
  globalThis.Hooks = {
    on(name, callback) {
      const id = nextHookId++;
      hookMap.set(id, { name, callback });
      return id;
    },
    off(_name, id) {
      hookMap.delete(id);
    }
  };

  class MockElement {
    constructor() {
      this.className = "";
      this.dataset = {};
      this.style = {};
      this.classList = {
        contains: () => false,
        add: () => {},
        remove: () => {}
      };
      this.isConnected = true;
      this.hidden = false;
      this.inert = false;
    }
    setAttribute() {}
    removeAttribute() {}
    remove() { this.isConnected = false; }
    querySelector() { return null; }
    focus() {}
  }

  globalThis.HTMLElement = MockElement;
  globalThis.document = {
    body: {
      classList: { add() {}, remove() {} },
      append(element) { element.isConnected = true; }
    },
    createElement() { return new MockElement(); },
    querySelectorAll() { return []; }
  };
  globalThis.getComputedStyle = () => ({ display: "block", zIndex: "0" });
  globalThis.requestAnimationFrame = callback => { callback(); return 1; };

  let registration = null;
  globalThis.libWrapper = {
    register(packageId, target, wrapper, type) {
      registration = { packageId, target, wrapper, type };
      return 1;
    }
  };

  const { LibWrapperService } = await import("../scripts/services/lib-wrapper-service.mjs");
  assert.equal(LibWrapperService.register(), true);
  const { NativeAdvancementModalGuard } = await import("../scripts/services/native-advancement-modal-guard.mjs");

  const manager = {
    element: null,
    close: async () => "closed",
    render() {}
  };
  const originalClose = manager.close;
  const resultPromise = NativeAdvancementModalGuard.run(manager);

  assert.equal(manager.close, originalClose);
  assert.equal(Object.hasOwn(manager, "close"), true);

  registration.wrapper.call(manager, () => undefined);
  assert.deepEqual(await resultPromise, { completed: false, cancelled: true });
  assert.equal(NativeAdvancementModalGuard.active, null);

  delete globalThis.libWrapper;
  delete globalThis.Hooks;
  delete globalThis.document;
  delete globalThis.HTMLElement;
  delete globalThis.getComputedStyle;
  delete globalThis.requestAnimationFrame;
});

test("completed Advancement waits for native close before releasing the next operation", async () => {
  const hookMap = new Map();
  let nextHookId = 1;
  globalThis.Hooks = {
    on(name, callback) {
      const id = nextHookId++;
      hookMap.set(id, { name, callback });
      return id;
    },
    off(_name, id) {
      hookMap.delete(id);
    }
  };

  class MockElement {
    constructor() {
      this.className = "";
      this.dataset = {};
      this.style = {};
      this.classList = { contains: () => false, add() {}, remove() {} };
      this.isConnected = true;
      this.hidden = false;
      this.inert = false;
    }
    setAttribute() {}
    removeAttribute() {}
    remove() { this.isConnected = false; }
    querySelector() { return null; }
    focus() {}
  }

  globalThis.HTMLElement = MockElement;
  globalThis.document = {
    body: {
      classList: { add() {}, remove() {} },
      append(element) { element.isConnected = true; }
    },
    createElement() { return new MockElement(); },
    querySelectorAll() { return []; }
  };
  globalThis.getComputedStyle = () => ({ display: "block", zIndex: "0" });
  globalThis.requestAnimationFrame = callback => { callback(); return 1; };

  const { NativeAdvancementModalGuard } = await import("../scripts/services/native-advancement-modal-guard.mjs?test=completion-waits-close");

  const manager = { element: new MockElement(), rendered: true, render() {} };
  let postProcessed = false;
  const resultPromise = NativeAdvancementModalGuard.run(manager, {
    onComplete: async () => {
      await Promise.resolve();
      postProcessed = true;
    }
  });

  const completion = [...hookMap.values()].find(entry => entry.name === "dnd5e.advancementManagerComplete");
  assert.ok(completion);
  completion.callback(manager);
  await Promise.resolve();
  assert.equal(postProcessed, true);
  assert.equal(NativeAdvancementModalGuard.busy, true);

  const close = [...hookMap.values()].find(entry => entry.name === "closeApplicationV2");
  assert.ok(close);
  close.callback(manager);
  assert.deepEqual(await resultPromise, { completed: true });
  assert.equal(NativeAdvancementModalGuard.busy, false);

  delete globalThis.libWrapper;
  delete globalThis.Hooks;
  delete globalThis.document;
  delete globalThis.HTMLElement;
  delete globalThis.getComputedStyle;
  delete globalThis.requestAnimationFrame;
});

test("native Advancement reservations block competing workflows between sequential windows", async () => {
  const { NativeAdvancementBusyError, NativeAdvancementModalGuard } = await import(
    "../scripts/services/native-advancement-modal-guard.mjs?test=reservation-lane"
  );

  const token = NativeAdvancementModalGuard.reserve("test sequence");
  assert.equal(NativeAdvancementModalGuard.busy, true);
  assert.equal(NativeAdvancementModalGuard.assertAvailable(token), true);
  assert.throws(
    () => NativeAdvancementModalGuard.assertAvailable(),
    error => NativeAdvancementBusyError.is(error)
  );
  assert.equal(NativeAdvancementModalGuard.releaseReservation(Symbol("wrong")), false);
  assert.equal(NativeAdvancementModalGuard.releaseReservation(token), true);
  assert.equal(NativeAdvancementModalGuard.busy, false);
});
