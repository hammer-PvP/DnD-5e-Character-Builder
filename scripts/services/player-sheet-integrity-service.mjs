import { MODULE_ID, defaultSettings } from "../constants.mjs";
import { ClassProgressionGuard } from "./class-progression-guard.mjs";

const REFUND_ACTION = "refundResource";
const SAFE_INVENTORY_ACTIONS = new Set([
  "activity-use", "attune", "equip", "prepare", "toggleExpand", "toggleFavorite", "use", "view"
]);
const BLOCKED_SHEET_ACTIONS = new Set([
  "addDocument", "changeMode", "create", "currency", "delete", "deleteDocument", "duplicate", "edit",
  "editDescription", "editDocument", "editImage", "identify", "recharge", "showConfiguration", "toggleCharge",
  "toggleEditInline"
]);
const BLOCKED_EFFECT_ACTIONS = new Set([
  "create", "delete", "duplicate", "edit", "toggle", "toggleCondition"
]);
const BLOCKED_ITEM_CONTEXT_NAMES = new Set([
  "DND5E.ContextMenuActionEdit",
  "DND5E.ContextMenuActionDuplicate",
  "DND5E.ContextMenuActionDelete",
  "DND5E.Scroll.CreateScroll",
  "DND5E.Identify",
  "DND5E.ContextMenuActionCharge",
  "DND5E.ContextMenuActionExpendCharge"
]);
const BLOCKED_ACTIVITY_CONTEXT_NAMES = new Set([
  "DND5E.ContextMenuActionEdit",
  "DND5E.ContextMenuActionDuplicate",
  "DND5E.ContextMenuActionDelete"
]);
const BLOCKED_EFFECT_CONTEXT_NAMES = new Set([
  "DND5E.ContextMenuActionEdit",
  "DND5E.ContextMenuActionDuplicate",
  "DND5E.ContextMenuActionDelete",
  "DND5E.ContextMenuActionEnable",
  "DND5E.ContextMenuActionDisable"
]);

/**
 * Player-facing sheet integrity layer.
 *
 * The protected sheet is an operational interface, not an editor. Players may
 * use Activities and may change the small set of gameplay states intentionally
 * exposed by D&D5e (prepare, equip, attune, favorites, and manual sort), while
 * structural edits, stock/resource edits, native sheet creation/deletion, and
 * chat-card refunds stay GM-only.
 *
 * This service deliberately blocks native/manual UI paths instead of global
 * Document update/create/delete hooks. D&D5e Activity consumption, rests,
 * Item Piles/API transfers, Character Builder transactions, and other
 * programmatic gameplay integrations therefore remain able to update the Actor.
 */
export class PlayerSheetIntegrityService {
  static #initialized = false;
  static #protectedChatRoots = new WeakSet();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    // Render protected Actor and embedded-Item sheet parts in PLAY/read-only
    // structural mode while retaining owner gameplay controls such as prepare,
    // equip, attune, use, and drag sorting.
    Hooks.on("dnd5e.prepareSheetContext", (sheet, _partId, context) => {
      const actor = this.#actorForSheet(sheet);
      if (!this.protects(actor)) return;
      context.editable = false;
      context.locked = true;
      const document = sheet?.document ?? sheet?.actor ?? sheet?.item;
      if (document?.system) context.source = document.system;
    });

    // Context menus are generated outside the Actor-sheet template, so remove
    // structural/resource mutation actions at source rather than relying only
    // on DOM hiding.
    Hooks.on("dnd5e.getItemContextOptions", (item, options) => {
      if (!this.protects(item?.actor) || !Array.isArray(options)) return;
      this.#removeContextOptions(options, BLOCKED_ITEM_CONTEXT_NAMES);
    });
    Hooks.on("dnd5e.getItemActivityContext", (activity, _target, options) => {
      if (!this.protects(activity?.actor) || !Array.isArray(options)) return;
      this.#removeContextOptions(options, BLOCKED_ACTIVITY_CONTEXT_NAMES);
    });
    Hooks.on("dnd5e.getActiveEffectContextOptions", (effect, options) => {
      const actor = effect?.target ?? (effect?.parent instanceof Actor ? effect.parent : effect?.parent?.actor);
      if (!this.protects(actor) || !Array.isArray(options)) return;
      this.#removeContextOptions(options, BLOCKED_EFFECT_CONTEXT_NAMES);
    });

    Hooks.on("renderChatMessageHTML", (message, element) => this.#protectChat(message, element));
    Hooks.on("renderChatMessage", (message, html) => this.#protectChat(message, html));
  }

  static enabled() {
    const settings = foundry.utils.mergeObject(
      defaultSettings(),
      game.settings.get(MODULE_ID, "settings") ?? {},
      { inplace: false }
    );
    return settings.playerSheetIntegrity === true;
  }

  static protects(actor) {
    return this.enabled()
      && !game.user?.isGM
      && ClassProgressionGuard.isProtectedActor(actor)
      && actor?.isOwner;
  }

  /** Protect a live Actor sheet after each render. */
  static protectSheet(actor, root, app = null) {
    if (!root || !this.protects(actor)) return;
    this.#forcePlayMode(app);
    this.#applySheetDomProtection(root);

    if (root.dataset?.cbPlayerSheetIntegrity === "true") return;
    root.dataset.cbPlayerSheetIntegrity = "true";

    root.addEventListener("click", event => this.#onSheetClick(event, actor), { capture: true });
    root.addEventListener("change", event => this.#onSheetChange(event, actor), { capture: true });
    root.addEventListener("inventory", event => this.#onInventoryAction(event), { capture: true });
    root.addEventListener("effect", event => this.#onEffectAction(event), { capture: true });
  }

  /** Protect an embedded Item sheet belonging to a protected live Actor. */
  static protectEmbeddedItemSheet(app, root) {
    const item = app?.item ?? app?.document;
    const actor = item?.actor ?? item?.parent;
    if (!root || item?.documentName !== "Item" || !this.protects(actor)) return;

    this.#forcePlayMode(app);
    this.#applyEmbeddedItemDomProtection(root);
    if (root.dataset?.cbPlayerItemIntegrity === "true") return;
    root.dataset.cbPlayerItemIntegrity = "true";

    root.addEventListener("click", event => this.#onEmbeddedItemSheetClick(event), { capture: true });
    root.addEventListener("change", event => this.#onEmbeddedItemSheetChange(event), { capture: true });
  }

  /** Called by libWrapper around D&D5e's native Actor-sheet create action. */
  static mayAddDocumentFromNativeSheet(sheet) {
    const actor = sheet?.actor ?? sheet?.inventorySource;
    if (!this.protects(actor)) return true;
    this.#warn("Adding content directly to this character sheet is GM-only. Use approved gameplay sources such as Item Piles for inventory transfers.");
    return false;
  }

  /**
   * Decide whether a single D&D5e Actor-sheet Item drop is an allowed internal
   * move/sort. External drops are blocked before D&D5e can create/copy the Item.
   */
  static mayHandleNativeItemDrop(sheet, event, item) {
    const actor = sheet?.actor ?? sheet?.inventorySource;
    if (!this.protects(actor)) return true;
    const behavior = event?._behavior;
    const sameActor = actor?.uuid && item?.parent?.uuid === actor.uuid;
    if (behavior === "move" && sameActor) return true;
    this.#warn("Dragging Items onto this character sheet is GM-only. Inventory received through approved gameplay systems remains supported.");
    return false;
  }

  /**
   * Filter D&D5e's native Actor-sheet create-from-drop path. This path is only
   * for creating/copying Items; same-Actor sorting is handled earlier by D&D5e
   * and never reaches this method.
   */
  static filterNativeDropItems(sheet, items = []) {
    const actor = sheet?.actor ?? sheet?.inventorySource;
    if (!this.protects(actor)) return items;
    if (!items.length) return items;
    this.#warn("Dragging Items onto this character sheet is GM-only. Inventory received through approved gameplay systems remains supported.");
    return [];
  }

  static blockNativeAdvancement(manager, updates = {}, toCreate = [], toUpdate = [], toDelete = []) {
    const actor = manager?.actor;
    if (!this.protects(actor) || ClassProgressionGuard.isAuthorized(manager?.options ?? {})) return;
    const hasChanges = !foundry.utils.isEmpty(updates ?? {}) || toCreate.length || toUpdate.length || toDelete.length;
    if (!hasChanges) return;
    this.#warn("Character progression is managed by Character Builder. Ask the GM to make this change.");
    return false;
  }

  static #onInventoryAction(event) {
    const action = String(event.detail ?? "");
    if (!action || SAFE_INVENTORY_ACTIONS.has(action)) return;
    if (!BLOCKED_SHEET_ACTIONS.has(action)) return;
    this.#stop(event);
    this.#warn("Direct Item editing is GM-only. You can still use, prepare, equip, attune, and organize your existing Items.");
  }

  static #onEffectAction(event) {
    const action = String(event.detail ?? "");
    if (!BLOCKED_EFFECT_ACTIONS.has(action)) return;
    this.#stop(event);
    this.#warn("Direct Active Effect editing is GM-only for this character.");
  }

  static #onSheetClick(event, actor) {
    const actionElement = event.target?.closest?.("[data-action]");
    const action = actionElement?.dataset?.action;

    if (BLOCKED_SHEET_ACTIONS.has(action)) {
      this.#stop(event);
      this.#warn(this.#blockedActionMessage(action));
      return;
    }

    // Heroic Inspiration is character state, not a manual player-managed
    // counter. Legitimate features/GM workflows can still update it through the
    // document API because this guard exists only on the sheet UI path.
    if (action === "toggleInspiration") {
      this.#stop(event);
      this.#warn("Heroic Inspiration changes are handled by the GM or game features.");
      return;
    }

    // Spell slots and Actor resource pips are display-only for protected
    // players. Native Activity.consume() and rest recovery bypass this UI guard.
    if (action === "togglePip") {
      const button = actionElement;
      const prop = button?.dataset?.prop ?? button?.closest?.("[data-prop]")?.dataset?.prop;
      if (!this.#managedActorResourcePath(prop)) return;
      this.#stop(event);
      this.#warn("Resource counters are read-only. Use the spell or feature normally; only the GM may edit counters directly.");
      return;
    }

    // +/- controls on Item quantity/uses are manual stock edits.
    if ((action === "increase" || action === "decrease") && actionElement?.closest?.("[data-item-id]")) {
      const property = String(actionElement.dataset?.property ?? "");
      if (property === "system.quantity" || property.includes("uses")) {
        this.#stop(event);
        this.#warn("Item quantity and uses are read-only. Consume Items normally or ask the GM to change the stock.");
      }
    }
  }

  static #onSheetChange(event, actor) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;

    const name = String(input.name ?? input.dataset?.name ?? "");

    if (this.#managedActorResourcePath(name)) {
      this.#restoreActorInput(input, actor, name);
      this.#stop(event);
      this.#warn("Resource counters are read-only. Use the spell or feature normally; only the GM may edit counters directly.");
      return;
    }

    if (/^system\.currency\.[^.]+$/.test(name)) {
      this.#restoreActorInput(input, actor, name);
      this.#stop(event);
      this.#warn("Currency is read-only on the player sheet. Use the GM or an approved gameplay system such as Item Piles.");
      return;
    }

    const itemId = input.closest?.("[data-item-id]")?.dataset?.itemId;
    const item = actor.items?.get?.(itemId);
    const dataName = String(input.dataset?.name ?? "");
    if (dataName === "system.quantity") {
      if (item) input.value = String(item.system?.quantity ?? 0);
      this.#stop(event);
      this.#warn("Item quantity is read-only. Consume the Item normally or ask the GM to change the stock.");
      return;
    }

    if (dataName === "system.uses.value") {
      const current = Number(item?.system?.uses?.value);
      if (Number.isFinite(current)) input.value = String(current);
      this.#stop(event);
      this.#warn("Item uses are read-only. Use the Item normally; only the GM may edit the counter directly.");
      return;
    }

    if (dataName === "uses.value") {
      const row = input.closest?.("[data-activity-id]");
      const activityId = row?.dataset?.activityId;
      const activity = item?.system?.activities?.get?.(activityId);
      const current = Number(activity?.uses?.value);
      if (Number.isFinite(current)) input.value = String(current);
      this.#stop(event);
      this.#warn("Activity uses are read-only. Use the Activity normally; only the GM may edit the counter directly.");
    }
  }

  static #onEmbeddedItemSheetClick(event) {
    const action = event.target?.closest?.("[data-action]")?.dataset?.action;
    // Embedded Item sheets are view-only for protected players. `showDocument`
    // and ordinary navigation/expansion remain available; edit/configuration
    // paths and the sheet mode switch do not.
    if (!BLOCKED_SHEET_ACTIONS.has(action) && action !== "deleteDocument") return;
    this.#stop(event);
    this.#warn("Direct Item editing is GM-only. Use the Item from your character sheet instead.");
  }

  static #onEmbeddedItemSheetChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
    if (target.closest?.("[data-application-part]")?.querySelector?.("item-list-controls")?.contains?.(target)) return;
    this.#stop(event);
    this.#warn("Direct Item editing is GM-only. Use the Item from your character sheet instead.");
  }

  static #applySheetDomProtection(root) {
    // PLAY mode only: remove the edit-mode toggle and any native create button.
    root.querySelectorAll(".mode-slider, .create-child, [data-action='addDocument']").forEach(el => el.remove());

    // Defensive cleanup for partial/legacy renders. Modern templates should
    // already omit these because dnd5e.prepareSheetContext forces editable=false.
    root.querySelectorAll([
      "[data-action='editDocument']", "[data-action='deleteDocument']",
      ".item-action[data-action='edit']", ".item-action[data-action='delete']",
      ".item-action[data-action='duplicate']"
    ].join(",")).forEach(el => el.remove());

    // Read-only manual stock/resource inputs. They remain visually readable;
    // programmatic D&D5e/API changes are unaffected and will refresh on render.
    for (const input of root.querySelectorAll("input")) {
      const name = String(input.name ?? input.dataset?.name ?? "");
      if (this.#managedActorResourcePath(name)
        || /^system\.currency\.[^.]+$/.test(name)
        || name === "system.quantity"
        || name === "system.uses.value"
        || name === "uses.value") {
        input.readOnly = true;
        input.setAttribute("aria-readonly", "true");
      }
    }

    root.querySelectorAll(".adjustment-button[data-property='system.quantity']").forEach(el => {
      el.hidden = true;
      el.setAttribute("aria-hidden", "true");
    });
  }

  static #applyEmbeddedItemDomProtection(root) {
    root.querySelectorAll(".mode-slider, .create-child, [data-action='addDocument'], [data-action='deleteDocument']")
      .forEach(el => el.remove());
  }

  static #protectChat(message, element) {
    if (!this.enabled() || game.user?.isGM) return;
    const actor = this.#messageActor(message);
    if (!this.protects(actor)) return;
    const root = element?.querySelectorAll ? element : element?.[0];
    if (!root?.querySelectorAll) return;

    for (const button of root.querySelectorAll(`[data-action="${REFUND_ACTION}"]`)) {
      button.hidden = true;
      button.disabled = true;
      button.setAttribute("aria-hidden", "true");
    }

    if (this.#protectedChatRoots.has(root)) return;
    this.#protectedChatRoots.add(root);
    root.addEventListener("click", event => {
      const button = event.target?.closest?.(`[data-action="${REFUND_ACTION}"]`);
      if (!button) return;
      this.#stop(event);
      this.#warn("Resource refunds are GM-only for this character.");
    }, { capture: true });
  }

  static #forcePlayMode(app) {
    if (!app) return;
    const modes = app.constructor?.MODES;
    if (!modes?.PLAY) return;
    app._mode = modes.PLAY;
  }

  static #messageActor(message) {
    try {
      const associated = message?.getAssociatedActor?.();
      if (associated) return associated;
    } catch (_error) {}
    const id = message?.speaker?.actor;
    return id ? game.actors?.get?.(id) ?? null : null;
  }

  static #actorForSheet(sheet) {
    const doc = sheet?.document ?? sheet?.actor ?? sheet?.item;
    if (doc?.documentName === "Actor") return doc;
    if (doc?.documentName === "Item") return doc.actor ?? doc.parent ?? null;
    return sheet?.actor ?? sheet?.item?.actor ?? null;
  }

  static #removeContextOptions(options, blockedNames) {
    for (let i = options.length - 1; i >= 0; i--) {
      const name = String(options[i]?.name ?? "");
      if (blockedNames.has(name)) options.splice(i, 1);
    }
  }

  static #restoreActorInput(input, actor, path) {
    const current = foundry.utils.getProperty(actor, path);
    if (current !== undefined && current !== null) input.value = String(current);
  }

  static #managedActorResourcePath(path) {
    path = String(path ?? "");
    return /^system\.spells\.[^.]+\.value$/.test(path)
      || /^system\.resources\.[^.]+\.value$/.test(path)
      || /^system\.resources\.[^.]+\.spent$/.test(path);
  }

  static #blockedActionMessage(action) {
    if (action === "delete" || action === "deleteDocument") return "Deleting character content is GM-only.";
    if (action === "edit" || action === "editDocument" || action === "changeMode") return "Direct character and Item editing is GM-only.";
    if (action === "recharge" || action === "toggleCharge") return "Manual resource changes are GM-only. Use the Item or feature normally.";
    if (action === "currency") return "Currency editing is GM-only. Approved gameplay systems such as Item Piles can still transfer currency normally.";
    return "This character-sheet change is GM-only.";
  }

  static #stop(event) {
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
  }

  static #warn(message) {
    ui.notifications.warn(message);
  }
}
