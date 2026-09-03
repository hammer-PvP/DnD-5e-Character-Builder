import { MODULE_ID } from "../constants.mjs";
import { PlayerSheetIntegrityService } from "./player-sheet-integrity-service.mjs";

const ADVANCEMENT_CLOSE_TARGET = "dnd5e.applications.advancement.AdvancementManager.prototype._onClose";
const ACTOR_SHEET_ADD_TARGET = "dnd5e.applications.actor.BaseActorSheet.prototype._addDocument";
const ACTOR_SHEET_DROP_ITEM_TARGET = "dnd5e.applications.actor.BaseActorSheet.prototype._onDropItem";
const ACTOR_SHEET_DROP_TARGET = "dnd5e.applications.actor.BaseActorSheet.prototype._onDropCreateItems";
const ACTOR_DIRECTORY_CONTEXT_TARGET = "foundry.applications.sidebar.tabs.ActorDirectory.prototype._getEntryContextOptions";
const DND5E_ACTOR_MODIFY_TOKEN_ATTRIBUTE_TARGET = "dnd5e.documents.Actor5e.prototype.modifyTokenAttribute";
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
        ACTOR_SHEET_DROP_ITEM_TARGET,
        function (wrapped, event, item, ...args) {
          if (!PlayerSheetIntegrityService.mayHandleNativeItemDrop(this, event, item)) return undefined;
          return wrapped(event, item, ...args);
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
      api.register(
        MODULE_ID,
        DND5E_ACTOR_MODIFY_TOKEN_ATTRIBUTE_TARGET,
        async function (wrapped, attribute, value, isDelta, isBar, ...args) {
          if (!PlayerSheetIntegrityService.mayModifyTokenAttribute(this, attribute)) return this;
          return wrapped(attribute, value, isDelta, isBar, ...args);
        },
        "WRAPPER"
      );
      api.register(
        MODULE_ID,
        ACTOR_DIRECTORY_CONTEXT_TARGET,
        function (wrapped, ...args) {
          const options = wrapped(...args);
          if (!Array.isArray(options) || !game.user?.isGM) return options;
          if (options.some(option => String(option?.classes ?? "").split(/\s+/).includes("cb-validate-character-context"))) {
            return options;
          }
          options.push({
            label: "Validate Character",
            icon: "fa-solid fa-stethoscope",
            classes: "cb-validate-character-context",
            visible: target => {
              const actor = LibWrapperService.#actorFromDirectoryTarget(target);
              return Boolean(actor && actor.type === "character"
                && !actor.getFlag(MODULE_ID, "isDraft")
                && !actor.getFlag(MODULE_ID, "isLevelUpDraft"));
            },
            onClick: (_event, target) => {
              const actor = LibWrapperService.#actorFromDirectoryTarget(target);
              if (!actor) {
                ui.notifications.warn("Character Builder could not resolve that Actor directory entry.");
                return;
              }
              const launch = game.modules.get(MODULE_ID)?.api?.validateCharacter;
              if (typeof launch !== "function") {
                ui.notifications.error("Character Validation is not available yet. Reload the world and try again.");
                return;
              }
              void Promise.resolve(launch(actor)).catch(error => {
                console.error(`${MODULE_ID} | Character Validation could not start.`, error);
                ui.notifications.error(error.message, { permanent: true });
              });
            }
          });
          return options;
        },
        "WRAPPER"
      );
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

  static #actorFromDirectoryTarget(target) {
    const element = target instanceof HTMLElement ? target : target?.[0] ?? null;
    if (!element) return null;
    const entry = element.closest?.("[data-entry-id], [data-document-id], [data-actor-id], [data-entity-id]") ?? element;
    const id = entry.dataset?.entryId
      ?? entry.dataset?.documentId
      ?? entry.dataset?.actorId
      ?? entry.dataset?.entityId
      ?? null;
    return id ? game.actors?.get?.(id) ?? null : null;
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
