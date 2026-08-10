import { MODULE_ID, defaultSettings } from "../constants.mjs";
import { ClassProgressionGuard } from "./class-progression-guard.mjs";

const STRUCTURAL_ITEM_TYPES = new Set(["class", "subclass", "race", "background", "feat", "spell"]);
const REFUND_ACTION = "refundResource";

/**
 * Optional player-facing integrity layer. It blocks only native/manual sheet
 * paths that add progression or recover expendable state. Normal activity use,
 * native rests/recovery, GM changes, and Character Builder transactions are
 * not intercepted.
 */
export class PlayerSheetIntegrityService {
  static #initialized = false;

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    Hooks.on("renderChatMessageHTML", (_message, element) => this.#protectChat(element));
    Hooks.on("renderChatMessage", (_message, html) => this.#protectChat(html));
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

  static protectSheet(actor, root) {
    if (!root || !this.protects(actor)) return;
    if (root.dataset?.cbPlayerSheetIntegrity === "true") return;
    root.dataset.cbPlayerSheetIntegrity = "true";

    root.addEventListener("click", event => this.#onSheetClick(event, actor), { capture: true });
    root.addEventListener("change", event => this.#onSheetChange(event, actor), { capture: true });
  }

  /** Called by libWrapper around D&D5e's native Actor-sheet create action. */
  static mayAddDocumentFromNativeSheet(sheet) {
    const actor = sheet?.actor ?? sheet?.inventorySource;
    if (!this.protects(actor)) return true;
    const tab = sheet?.tabGroups?.primary;
    if (tab !== "features" && tab !== "spells") return true;
    this.#warn("Character progression is managed by Character Builder. Ask the GM to add this content.");
    return false;
  }

  /**
   * Filter D&D5e's native Actor-sheet drops. Physical/inventory Items remain
   * untouched; structural character documents are rejected before creation.
   */
  static filterNativeDropItems(sheet, items = []) {
    const actor = sheet?.actor ?? sheet?.inventorySource;
    if (!this.protects(actor)) return items;
    const blocked = items.filter(item => STRUCTURAL_ITEM_TYPES.has(item?.type));
    if (!blocked.length) return items;
    this.#warn("Features, spells, classes, species, and other character progression must be added by the GM or Character Builder.");
    return items.filter(item => !STRUCTURAL_ITEM_TYPES.has(item?.type));
  }

  static blockNativeAdvancement(manager, _updates, toCreate = []) {
    const actor = manager?.actor;
    if (!this.protects(actor) || ClassProgressionGuard.isAuthorized(manager?.options ?? {})) return;
    if (!toCreate.some(data => STRUCTURAL_ITEM_TYPES.has(data?.type))) return;
    this.#warn("Character progression is managed by Character Builder. Ask the GM to make this change.");
    return false;
  }

  /** Called by libWrapper around Activity.refund. */
  static mayRefund(activity) {
    const actor = activity?.actor;
    if (!this.protects(actor)) return true;
    this.#warn("Resource refunds are GM-only while Character Sheet Integrity is enabled.");
    return false;
  }

  static #onSheetClick(event, actor) {
    const action = event.target?.closest?.("[data-action]")?.dataset?.action;
    if (action === "toggleInspiration" && actor.system?.attributes?.inspiration !== true) {
      this.#stop(event);
      this.#warn("Heroic Inspiration can only be granted by the GM or a game feature.");
      return;
    }

    if (action !== "togglePip") return;
    const button = event.target.closest("[data-action='togglePip']");
    const n = Number(button?.closest?.("[data-n]")?.dataset?.n);
    const prop = button?.dataset?.prop ?? button?.closest?.("[data-prop]")?.dataset?.prop;
    if (!Number.isFinite(n) || !this.#managedActorResourcePath(prop)) return;
    const current = Number(foundry.utils.getProperty(actor, prop));
    if (!Number.isFinite(current)) return;
    let next;
    if ((current === n) && prop.endsWith(".spent")) next = current + 1;
    else if (current === n) next = current - 1;
    else next = n;
    const recovers = prop.endsWith(".spent") ? next < current : next > current;
    if (!recovers) return;
    this.#stop(event);
    this.#warn("Players can spend resources, but manual resource recovery is locked to the GM.");
  }

  static #onSheetChange(event, actor) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;

    const name = String(input.name ?? input.dataset?.name ?? "");
    const raw = String(input.value ?? "").trim();

    // Spell slots and Actor resource pools. D&D5e numeric inputs accept relative
    // syntax (+1/-1), so compare the effective value rather than Number(raw).
    if (this.#managedActorResourcePath(name)) {
      const current = Number(foundry.utils.getProperty(actor, name));
      const next = this.#effectiveNumericInput(raw, current);
      if (Number.isFinite(current) && Number.isFinite(next)) {
        const recovers = name.endsWith(".spent") ? next < current : next > current;
        if (recovers) {
          this.#stop(event);
          input.value = String(current);
          this.#warn("Players can spend resources, but manual resource recovery is locked to the GM.");
        }
      }
      return;
    }

    // Item uses shown in the Features list.
    if (input.dataset?.name === "system.uses.value") {
      const itemId = input.closest?.("[data-item-id]")?.dataset?.itemId;
      const item = actor.items?.get?.(itemId);
      const current = Number(item?.system?.uses?.value);
      const next = this.#effectiveNumericInput(raw, current);
      if (Number.isFinite(current) && Number.isFinite(next) && next > current) {
        this.#stop(event);
        input.value = String(current);
        this.#warn("Players can spend Item uses, but manual recovery is locked to the GM.");
      }
      return;
    }

    // Activity uses in any native sheet section that exposes an editable value.
    if (input.dataset?.name === "uses.value") {
      const row = input.closest?.("[data-activity-id]");
      const itemId = row?.closest?.("[data-item-id]")?.dataset?.itemId;
      const activityId = row?.dataset?.activityId;
      const activity = actor.items?.get?.(itemId)?.system?.activities?.get?.(activityId);
      const current = Number(activity?.uses?.value);
      const next = this.#effectiveNumericInput(raw, current);
      if (Number.isFinite(current) && Number.isFinite(next) && next > current) {
        this.#stop(event);
        input.value = String(current);
        this.#warn("Players can spend Activity uses, but manual recovery is locked to the GM.");
      }
    }
  }

  static #effectiveNumericInput(raw, current) {
    if (!Number.isFinite(current)) return NaN;
    raw = String(raw ?? "").trim();
    if (!raw) return NaN;
    if (/^[+-]\d+(?:\.\d+)?$/.test(raw)) return current + Number(raw);
    if (/^=/.test(raw)) raw = raw.slice(1).trim();
    return Number(raw);
  }

  static #managedActorResourcePath(path) {
    path = String(path ?? "");
    return /^system\.spells\.[^.]+\.value$/.test(path)
      || /^system\.resources\.[^.]+\.value$/.test(path)
      || /^system\.resources\.[^.]+\.spent$/.test(path);
  }

  static #protectChat(element) {
    if (!this.enabled() || game.user?.isGM) return;
    const root = element instanceof HTMLElement ? element : element?.[0];
    if (!root) return;
    for (const button of root.querySelectorAll(`[data-action="${REFUND_ACTION}"]`)) {
      button.hidden = true;
      button.disabled = true;
      button.setAttribute("aria-hidden", "true");
    }
  }

  static #stop(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  static #warn(message) {
    ui.notifications.warn(message);
  }
}
