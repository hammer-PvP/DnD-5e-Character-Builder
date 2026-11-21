import { guardWarcraftItemGrantRender } from "./warcraft-item-grant-compatibility.mjs";
import { activeWarcraft } from "./warcraft-progression-service.mjs";
import { registerBeacon } from "./warcraft-beacon-service.mjs";
import { registerRestDice } from "./warcraft-rest-dice-service.mjs";
import { LevelUpFeatureService } from "./level-up-feature-service.mjs";
import { MODULE_ID } from "../constants.mjs";
import { PlayerSheetIntegrityService } from "./player-sheet-integrity-service.mjs";
import { TransformationActorCleanupService } from "./transformation-actor-cleanup-service.mjs";
import { AmmunitionRequirementService } from "./ammunition-requirement-service.mjs";
import { WeaponMasteryAssistanceService } from "./weapon-mastery-assistance-service.mjs";
import { GlancingBlowsService } from "./glancing-blows-service.mjs";

const ADVANCEMENT_CLOSE_TARGET = "dnd5e.applications.advancement.AdvancementManager.prototype._onClose";
const ACTOR_SHEET_ADD_TARGET = "dnd5e.applications.actor.BaseActorSheet.prototype._addDocument";
const ACTOR_SHEET_DROP_ITEM_TARGET = "dnd5e.applications.actor.BaseActorSheet.prototype._onDropItem";
const ACTOR_SHEET_DROP_TARGET = "dnd5e.applications.actor.BaseActorSheet.prototype._onDropCreateItems";
const ACTOR_DIRECTORY_CONTEXT_TARGET = "foundry.applications.sidebar.tabs.ActorDirectory.prototype._getEntryContextOptions";
const DND5E_ACTOR_MODIFY_TOKEN_ATTRIBUTE_TARGET = "dnd5e.documents.Actor5e.prototype.modifyTokenAttribute";
const DND5E_ACTOR_REVERT_ORIGINAL_FORM_TARGET = "dnd5e.documents.Actor5e.prototype.revertOriginalForm";
const DND5E_TRANSFORM_ACTIVITY = "dnd5e.documents.activity.TransformActivity.prototype";
const DND5E_ATTACK_ROLL_TARGET = "dnd5e.documents.activity.AttackActivity.prototype.rollAttack";
const DND5E_ATTACK_CHAT_ACTION_TARGET = "dnd5e.documents.activity.AttackActivity.prototype._onChatAction";
const DND5E_DAMAGE_TARGET_OPTIONS_TARGET = "dnd5e.applications.components.DamageApplicationElement.prototype.getTargetOptions";
/**
 * Central libWrapper integration point.
 *
 * Character Builder never replaces Foundry or D&D5e prototype methods
 * directly. Any required interception is registered here so libWrapper can
 * coordinate wrapper order and report conflicts to the GM.
 */
export class LibWrapperService {
  static #registered = false;
  static #targets = new Set();
  static #warcraftReady = false;
  static failure = "";

  static #install(moduleId, target, fn, mode) {
    if (this.#targets.has(target)) return;
    try {
      globalThis.libWrapper.register(moduleId, target, fn, mode);
      this.#targets.add(target);
    } catch (error) {
      throw new Error(target + ": " + error.message, { cause: error });
    }
  }

  static ready() {
    if (!this.register() || !activeWarcraft() || this.#warcraftReady) return;
    this.#warcraftReady = true;
    const api = { register: (...args) => this.#install(...args) };
    for (const [name, setup] of [["Pet Specialization", guardWarcraftItemGrantRender], ["Short Rest Hit Dice", registerRestDice], ["Beacon of Light", registerBeacon]]) {
      try { setup(api, MODULE_ID); }
      catch (error) {
        console.error(MODULE_ID + " | Warcraft " + name, error);
        if (game.user.isGM) ui.notifications.warn("Character Builder: Warcraft " + name + " could not initialize. " + error.message);
      }
    }
  }
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
      this.#install(
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
      this.#install(
        MODULE_ID,
        ACTOR_SHEET_ADD_TARGET,
        function (wrapped, ...args) {
          if (!PlayerSheetIntegrityService.mayAddDocumentFromNativeSheet(this)) return undefined;
          return wrapped(...args);
        },
        "WRAPPER"
      );
      this.#install(
        MODULE_ID,
        ACTOR_SHEET_DROP_ITEM_TARGET,
        function (wrapped, event, item, ...args) {
          if (!PlayerSheetIntegrityService.mayHandleNativeItemDrop(this, event, item)) return undefined;
          return wrapped(event, item, ...args);
        },
        "WRAPPER"
      );
      this.#install(
        MODULE_ID,
        ACTOR_SHEET_DROP_TARGET,
        function (wrapped, event, items, behavior, ...args) {
          const allowed = PlayerSheetIntegrityService.filterNativeDropItems(this, items ?? []);
          if (!allowed.length) return [];
          return wrapped(event, allowed, behavior, ...args);
        },
        "WRAPPER"
      );
      this.#install(
        MODULE_ID,
        DND5E_ACTOR_MODIFY_TOKEN_ATTRIBUTE_TARGET,
        async function (wrapped, attribute, value, isDelta, isBar, ...args) {
          if (!PlayerSheetIntegrityService.mayModifyTokenAttribute(this, attribute)) return this;
          return wrapped(attribute, value, isDelta, isBar, ...args);
        },
        "WRAPPER"
      );
      this.#install(
        MODULE_ID,
        DND5E_ACTOR_REVERT_ORIGINAL_FORM_TARGET,
        function (wrapped, ...args) {
          return TransformationActorCleanupService.wrapRevertOriginalForm(this, wrapped, args);
        },
        "WRAPPER"
      );
      if (globalThis.dnd5e?.documents?.activity?.TransformActivity?.prototype?.queryActor) {
        this.#install(MODULE_ID, `${DND5E_TRANSFORM_ACTIVITY}.use`,
          async function (wrapped, ...args) {
            if (LevelUpFeatureService.isTrackedWildShapeActivity(this) && this.item.isOwner && this.canUse
              && !(await LevelUpFeatureService.availableWildShapeForms(this)).length) {
              ui.notifications.warn("Choose Known Wild Shape Forms through Level Up before using this activity.");
              return;
            }
            return wrapped(...args);
          }, "MIXED");
        this.#install(MODULE_ID, `${DND5E_TRANSFORM_ACTIVITY}.queryActor`,
          function (wrapped, ...args) {
            if (!LevelUpFeatureService.isTrackedWildShapeActivity(this)) return wrapped(...args);
            return LevelUpFeatureService.availableWildShapeForms(this)
              .then(forms => LevelUpFeatureService.chooseWildShapeForm(forms));
          }, "MIXED");
        this.#install(MODULE_ID, `${DND5E_TRANSFORM_ACTIVITY}.onChatAction`,
          async function (wrapped, event, target, message, ...args) {
            const action = target.dataset.action ?? message.system?.getButton?.(target)?.action;
            const selected = message.getFlag("dnd5e", "transform.uuid");
            if (action === "transformActor" && selected && LevelUpFeatureService.isTrackedWildShapeActivity(this)
              && !(await LevelUpFeatureService.availableWildShapeForms(this)).some(row => row.uuid === selected)) {
              ui.notifications.warn("This form is no longer a known Wild Shape form. Use Wild Shape again to choose a known form.");
              return;
            }
            return wrapped(event, target, message, ...args);
          }, "MIXED");
      }
      this.#install(
        MODULE_ID,
        DND5E_ATTACK_ROLL_TARGET,
        function (wrapped, config = {}, dialog = {}, message = {}) {
          return AmmunitionRequirementService.wrapRollAttack(this, wrapped, config, dialog, message);
        },
        // Require Ammunition is intentionally a gate: when no eligible stack
        // exists it must be allowed to stop the roll instead of chaining.
        "MIXED"
      );
      this.#install(
        MODULE_ID,
        DND5E_ATTACK_CHAT_ACTION_TARGET,
        async function (wrapped, event, target, message, ...args) {
          if (await WeaponMasteryAssistanceService.handleChatAction(this, event, target, message)) return undefined;
          return wrapped(event, target, message, ...args);
        },
        "MIXED"
      );
      this.#install(
        MODULE_ID,
        DND5E_DAMAGE_TARGET_OPTIONS_TARGET,
        function (wrapped, targetUuid, ...args) {
          return GlancingBlowsService.wrapGetTargetOptions(this, wrapped, targetUuid, ...args);
        },
        "WRAPPER"
      );
      this.#install(
        MODULE_ID,
        ACTOR_DIRECTORY_CONTEXT_TARGET,
        function (wrapped, ...args) {
          const options = wrapped(...args);
          if (!Array.isArray(options) || !game.user?.isGM) return options;
          LibWrapperService.addRecoveryControl(options);
          return options;
        },
        "WRAPPER"
      );
      this.#registered = true;
      return true;
    } catch (error) {
      this.failure = error.message;
      console.error(MODULE_ID + " | Could not initialize a core wrapper.", error);
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

  static addRecoveryControl(options) {
    if (options.some(option => option.classes === "cb-recover-level-up")) return;
    options.push({
      label: "Recover Failed Level Up",
      icon: "fa-solid fa-rotate-left",
      classes: "cb-recover-level-up",
      visible: target => Boolean(game.user.isGM && LibWrapperService.#actorFromDirectoryTarget(target)?.getFlag(MODULE_ID, "commitSafetyLock")?.safetyBackupActorId),
      onClick: (_event, target) => game.modules.get(MODULE_ID)?.api?.recoverFailedLevelUp?.(LibWrapperService.#actorFromDirectoryTarget(target))
    });
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
