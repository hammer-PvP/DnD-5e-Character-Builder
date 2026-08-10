import { MODULE_ID } from "../constants.mjs";
import { PlayerSheetIntegrityService } from "./player-sheet-integrity-service.mjs";

const ADVANCEMENT_CLOSE_TARGET = "dnd5e.applications.advancement.AdvancementManager.prototype._onClose";
const ACTOR_SHEET_ADD_TARGET = "dnd5e.applications.actor.BaseActorSheet.prototype._addDocument";
const ACTOR_SHEET_DROP_TARGET = "dnd5e.applications.actor.BaseActorSheet.prototype._onDropCreateItems";
const ACTIVITY_REFUND_TARGETS = Object.freeze([
  "AttackActivity", "CastActivity", "CheckActivity", "DamageActivity", "EnchantActivity",
  "ForwardActivity", "HealActivity", "OrderActivity", "SaveActivity", "SummonActivity",
  "TransformActivity", "UtilityActivity"
].map(name => `dnd5e.documents.activity.${name}.prototype.refund`));

/**
 * Central libWrapper integration point.
 *
 * Character Builder never replaces Foundry or D&D5e prototype methods
 * directly. Any required interception is registered here so libWrapper can
 * coordinate wrapper order and report conflicts to the GM.
 */
export class LibWrapperService {
  static #registered = false;
  static #advancementCloseObservers = new WeakMap();

  static get registered() {
    return this.#registered;
  }

  /**
   * Register all package wrappers. Safe to call more than once.
   *
   * @returns {boolean} Whether registration is available and complete.
   */
  static register() {
    if (this.#registered) return true;

    const api = globalThis.libWrapper;
    if (!api?.register) {
      console.error(`${MODULE_ID} | Required dependency libWrapper is not active.`);
      return false;
    }

    try {
      api.register(
        MODULE_ID,
        ADVANCEMENT_CLOSE_TARGET,
        function (wrapped, ...args) {
          let result;
          try {
            result = wrapped(...args);
          } catch (error) {
            LibWrapperService.#notifyAdvancementClosed(this, error);
            throw error;
          }

          // AdvancementManager._onClose is currently synchronous, but preserve
          // a future asynchronous return without changing its semantics.
          if (result && typeof result.then === "function") {
            return Promise.resolve(result).then(
              value => {
                LibWrapperService.#notifyAdvancementClosed(this, null);
                return value;
              },
              error => {
                LibWrapperService.#notifyAdvancementClosed(this, error);
                throw error;
              }
            );
          }

          LibWrapperService.#notifyAdvancementClosed(this, null);
          return result;
        },
        "WRAPPER"
      );
      api.register(
        MODULE_ID,
        ACTOR_SHEET_ADD_TARGET,
        function (wrapped, ...args) {
          if (!PlayerSheetIntegrityService.mayAddDocumentFromNativeSheet(this)) return undefined;
          return wrapped(...args);
        },
        "WRAPPER"
      );
      api.register(
        MODULE_ID,
        ACTOR_SHEET_DROP_TARGET,
        function (wrapped, event, items, behavior, ...args) {
          const allowed = PlayerSheetIntegrityService.filterNativeDropItems(this, items ?? []);
          if (!allowed.length) return [];
          return wrapped(event, allowed, behavior, ...args);
        },
        "WRAPPER"
      );
      for (const target of ACTIVITY_REFUND_TARGETS) {
        try {
          api.register(
            MODULE_ID,
            target,
            function (wrapped, ...args) {
              if (!PlayerSheetIntegrityService.mayRefund(this)) return undefined;
              return wrapped(...args);
            },
            "WRAPPER"
          );
        } catch (error) {
          // Some activity classes inherit the method without libWrapper exposing
          // an independent target. UI protection still applies; log the exact
          // class so conflict reports remain actionable.
          console.warn(`${MODULE_ID} | Could not register resource-refund wrapper for ${target}.`, error);
        }
      }
      this.#registered = true;
      return true;
    } catch (error) {
      console.error(`${MODULE_ID} | Could not register the AdvancementManager close-lifecycle wrapper.`, error);
      return false;
    }
  }

  /**
   * Observe the close lifecycle of one native AdvancementManager instance.
   * The returned function removes only this observer.
   *
   * @param {object} manager
   * @param {(data: {error: Error|null}) => void} callback
   * @returns {() => void}
   */
  static observeAdvancementClose(manager, callback) {
    if (!manager || typeof callback !== "function") return () => {};

    let callbacks = this.#advancementCloseObservers.get(manager);
    if (!callbacks) {
      callbacks = new Set();
      this.#advancementCloseObservers.set(manager, callbacks);
    }
    callbacks.add(callback);

    return () => {
      const current = this.#advancementCloseObservers.get(manager);
      if (!current) return;
      current.delete(callback);
      if (!current.size) this.#advancementCloseObservers.delete(manager);
    };
  }

  static #notifyAdvancementClosed(manager, error) {
    const callbacks = this.#advancementCloseObservers.get(manager);
    if (!callbacks?.size) return;
    this.#advancementCloseObservers.delete(manager);

    for (const callback of [...callbacks]) {
      try {
        callback({ error: error ?? null });
      } catch (observerError) {
        console.error(`${MODULE_ID} | Advancement close observer failed.`, observerError);
      }
    }
  }
}
