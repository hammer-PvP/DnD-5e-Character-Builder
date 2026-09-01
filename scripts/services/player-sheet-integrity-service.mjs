import { MODULE_ID } from "../constants.mjs";
import { ClassProgressionGuard } from "./class-progression-guard.mjs";
import { PlayerSheetIntegritySettingsService } from "./player-sheet-integrity-settings-service.mjs";
import { PreparedSpellLimitService } from "./prepared-spell-limit-service.mjs";
import { SpellPreparationCadenceService } from "./spell-preparation-cadence-service.mjs";

const REFUND_ACTION = "refundResource";
const RULES = Object.freeze({
  CHARACTER_DATA: "characterDataProficiencies",
  INVENTORY: "inventoryItemEditing",
  CONTENT: "characterContentProgression",
  RESOURCES: "resourcesSpellSlots",
  CURRENCY: "currency",
  PREPARED: "preparedSpellLimit"
});

const SAFE_INVENTORY_ACTIONS = new Set([
  "activity-use", "attune", "equip", "prepare", "toggleExpand", "toggleFavorite", "use", "view"
]);
const BLOCKED_ITEM_ACTIONS = new Set([
  "addDocument", "create", "delete", "deleteDocument", "duplicate", "edit", "editDescription", "editDocument", "editImage",
  "identify", "recharge", "showConfiguration", "toggleCharge", "toggleEditInline"
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
const CONTENT_ITEM_TYPES = new Set(["spell", "feat", "class", "subclass", "race", "background"]);
const INVENTORY_ITEM_TYPES = new Set(["weapon", "equipment", "consumable", "container", "loot", "tool", "backpack"]);

/**
 * Player-facing sheet integrity layer.
 *
 * The master switch enables a small set of deliberately coarse protection
 * packages. Each package guards only direct player-sheet UI paths. Native D&D5e
 * consumption/recovery, GM actions, Character Builder transactions, Item Piles,
 * and other authorized programmatic integrations are not globally intercepted.
 */
export class PlayerSheetIntegrityService {
  static #initialized = false;
  static #protectedChatRoots = new WeakSet();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    // Preserve the strongest legacy read-only rendering only when every package
    // affected by D&D5e's global `locked` state is enabled. If the GM disables
    // one package, the sheet remains editable and targeted guards enforce the
    // still-enabled packages without hiding the newly-permitted controls.
    Hooks.on("dnd5e.prepareSheetContext", (sheet, _partId, context) => {
      const actor = this.#actorForSheet(sheet);
      if (!this.protects(actor) || !this.#useGlobalStructuralLock()) return;
      context.editable = false;
      context.locked = true;
      const document = sheet?.document ?? sheet?.actor ?? sheet?.item;
      if (document?.system) context.source = document.system;
    });

    Hooks.on("dnd5e.getItemContextOptions", (item, options) => {
      if (!this.protects(item?.actor) || !Array.isArray(options)) return;
      const rule = this.#itemProtectionRule(item);
      if (!rule || !this.ruleEnabled(rule)) return;
      this.#removeContextOptions(options, BLOCKED_ITEM_CONTEXT_NAMES);
    });
    Hooks.on("dnd5e.getItemActivityContext", (activity, _target, options) => {
      if (!this.protects(activity?.actor) || !Array.isArray(options)) return;
      const rule = this.#itemProtectionRule(activity?.item);
      if (!rule || !this.ruleEnabled(rule)) return;
      this.#removeContextOptions(options, BLOCKED_ACTIVITY_CONTEXT_NAMES);
    });
    Hooks.on("dnd5e.getActiveEffectContextOptions", (effect, options) => {
      const actor = effect?.target ?? (effect?.parent instanceof Actor ? effect.parent : effect?.parent?.actor);
      if (!this.ruleProtects(actor, RULES.CONTENT) || !Array.isArray(options)) return;
      this.#removeContextOptions(options, BLOCKED_EFFECT_CONTEXT_NAMES);
    });

    Hooks.on("renderChatMessageHTML", (message, element) => this.#protectChat(message, element));
    Hooks.on("renderChatMessage", (message, html) => this.#protectChat(message, html));

    // Usage Guard authority lives at the Activity boundary, before D&D5e opens
    // an upcast/configuration dialog or consumes spell slots/resources. This
    // protects sheet buttons, hotbar usage, and macros without relocking the
    // ActivityUsageDialog itself.
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => this.guardUnpreparedSpellUse(activity, usageConfig));
  }

  static async ready() {
    if (!game.user?.isGM) return { migrated: false, preparedSpellsChanged: 0 };
    const raw = foundry.utils.deepClone(game.settings.get(MODULE_ID, "settings") ?? {});
    if (raw.playerSheetIntegrity !== true || PlayerSheetIntegritySettingsService.hasStoredRule(RULES.PREPARED, raw)) {
      return { migrated: false, preparedSpellsChanged: 0 };
    }

    // One-time migration for worlds that already had the former all-or-nothing
    // protection enabled. Persist the recommended package defaults, then bring
    // any pre-existing prepared-list excess into the newly active limit.
    const resolved = PlayerSheetIntegritySettingsService.settings(raw);
    const settings = foundry.utils.deepClone(raw);
    settings.playerSheetIntegrityConfig = foundry.utils.deepClone(resolved.playerSheetIntegrityConfig);
    await game.settings.set(MODULE_ID, "settings", settings);
    const result = await PreparedSpellLimitService.reconcileWorld();
    const changed = Number(result?.changed ?? 0);
    if (changed) {
      ui.notifications.info(`${changed} excess prepared spell${changed === 1 ? " was" : "s were"} automatically unprepared while migrating Player Character Sheet Integrity.`);
    }
    return { migrated: true, preparedSpellsChanged: changed };
  }

  static enabled(candidate = null) {
    return PlayerSheetIntegritySettingsService.masterEnabled(candidate);
  }

  static ruleEnabled(ruleKey, candidate = null) {
    return PlayerSheetIntegritySettingsService.ruleEnabled(ruleKey, candidate);
  }

  static protects(actor) {
    return this.enabled()
      && !game.user?.isGM
      && ClassProgressionGuard.isProtectedActor(actor)
      && actor?.isOwner;
  }

  static ruleProtects(actor, ruleKey) {
    return this.protects(actor) && this.ruleEnabled(ruleKey);
  }

  /**
   * Authoritative Unprepared Spell Usage guard. Returning false cancels the
   * D&D5e Activity before configuration, scaling, consumption, or chat output.
   */
  static guardUnpreparedSpellUse(activity, usageConfig = {}) {
    const item = activity?.item ?? activity?.parent ?? null;
    const actor = activity?.actor ?? item?.actor ?? item?.parent ?? null;
    if (!this.protects(actor)) return true;

    const mode = PlayerSheetIntegritySettingsService.unpreparedSpellUsageMode();
    if (mode === "off") return true;
    if (!this.#isRestrictedUnpreparedSpell(actor, item)) return true;

    const inCombat = this.#actorInCombat(actor);
    if (mode === "combatOnly" && !inCombat) return true;

    // Wizard Ritual Adept is the one rules-authorized exception to Always:
    // outside combat an unprepared ritual from that Wizard's spellbook is
    // converted to an actual slot-free ritual use instead of being treated as
    // a normal unprepared cast. Combat never receives this exception.
    if (mode === "always" && !inCombat && this.#wizardRitualAdeptEligible(actor, item)) {
      if (usageConfig.consume && typeof usageConfig.consume === "object") usageConfig.consume.spellSlot = false;
      usageConfig.scaling = false;
      usageConfig.characterBuilderRitualAdept = true;
      return true;
    }

    const message = mode === "combatOnly"
      ? `${item.name} is not prepared and cannot be cast while this character is in combat.`
      : `${item.name} is not prepared. Prepare this spell during a rule-authorized preparation window before casting it.`;
    this.#warn(message);
    return false;
  }

  /**
   * Called after world settings are saved. Activating Prepared Spell Limit is
   * the only package that performs an immediate reconciliation. All other
   * packages change UI permissions only.
   */
  static async onSettingsChanged(previousStored = {}, nextSettings = null) {
    const hadPreviousPreparedRule = PlayerSheetIntegritySettingsService.hasStoredRule(RULES.PREPARED, previousStored);
    const previousActive = previousStored?.playerSheetIntegrity === true
      && hadPreviousPreparedRule
      && previousStored?.playerSheetIntegrityConfig?.rules?.[RULES.PREPARED] !== false;
    const nextActive = PlayerSheetIntegritySettingsService.ruleEnabled(RULES.PREPARED, nextSettings);
    if (previousActive || !nextActive) return { preparedSpellsChanged: 0 };

    const result = await PreparedSpellLimitService.reconcileWorld();
    return { preparedSpellsChanged: Number(result?.changed ?? 0), preparedSpellResult: result };
  }

  /** Protect a live Actor sheet after each render. */
  static protectSheet(actor, root, app = null) {
    if (!root || !this.protects(actor)) return;
    if (this.#useGlobalStructuralLock()) this.#forcePlayMode(app);
    this.#applySheetDomProtection(actor, root);

    if (root.dataset?.cbPlayerSheetIntegrity === "true") return;
    root.dataset.cbPlayerSheetIntegrity = "true";

    root.addEventListener("click", event => this.#onSheetClick(event, actor), { capture: true });
    root.addEventListener("change", event => this.#onSheetChange(event, actor), { capture: true });
    root.addEventListener("inventory", event => this.#onInventoryAction(event, actor), { capture: true });
    root.addEventListener("effect", event => this.#onEffectAction(event, actor), { capture: true });
  }

  /** Protect an embedded Item sheet belonging to a protected live Actor. */
  static protectEmbeddedItemSheet(app, root) {
    // Only protect an actual Item document sheet. ActivityUsageDialog and other
    // gameplay applications expose an `item` getter too, but their form fields
    // (spell slot/upcast, scaling value, consumption choices, etc.) are runtime
    // action parameters and must remain interactive for protected players.
    const item = app?.document;
    const actor = item?.actor ?? item?.parent;
    if (!root || item?.documentName !== "Item" || !this.protects(actor)) return;

    const itemRule = this.#itemProtectionRule(item);
    const itemRuleProtected = itemRule && this.ruleEnabled(itemRule);
    const hasIndependentCurrency = item?.system?.currency && !this.ruleEnabled(RULES.CURRENCY);
    if (itemRuleProtected && !hasIndependentCurrency) this.#forcePlayMode(app);
    this.#applyEmbeddedItemDomProtection(item, root);

    if (root.dataset?.cbPlayerItemIntegrity === "true") return;
    root.dataset.cbPlayerItemIntegrity = "true";
    root.addEventListener("click", event => this.#onEmbeddedItemSheetClick(event, item), { capture: true });
    root.addEventListener("change", event => this.#onEmbeddedItemSheetChange(event, item), { capture: true });
  }

  /** Called by libWrapper around D&D5e's native Actor-sheet create action. */
  static mayAddDocumentFromNativeSheet(sheet) {
    const actor = sheet?.actor ?? sheet?.inventorySource;
    if (!this.protects(actor)) return true;
    const tab = String(sheet?.tabGroups?.primary ?? "");
    const rule = tab === "inventory" ? RULES.INVENTORY : ["features", "spells", "effects"].includes(tab) ? RULES.CONTENT : null;
    if (!rule || !this.ruleEnabled(rule)) return true;
    this.#warn(rule === RULES.INVENTORY
      ? "Adding inventory content directly to this character sheet is GM-only. Approved gameplay transfers such as Item Piles remain available."
      : "Adding character content directly to this sheet is GM-only while Character Content & Progression protection is enabled.");
    return false;
  }

  /**
   * Allow same-Actor sorting. External drops are filtered by the protection
   * package that owns the dropped Item type.
   */
  static mayHandleNativeItemDrop(sheet, event, item) {
    const actor = sheet?.actor ?? sheet?.inventorySource;
    if (!this.protects(actor)) return true;
    const behavior = event?._behavior;
    const sameActor = actor?.uuid && item?.parent?.uuid === actor.uuid;
    if (behavior === "move" && sameActor) return true;
    const rule = this.#itemProtectionRule(item);
    if (!rule || !this.ruleEnabled(rule)) return true;
    this.#warn(rule === RULES.INVENTORY
      ? "Dragging inventory Items onto this character sheet is GM-only. Approved gameplay transfers such as Item Piles remain available."
      : "Dragging spells, feats, or other character content onto this sheet is GM-only while Character Content & Progression protection is enabled.");
    return false;
  }

  /** Filter only the external drop rows owned by an enabled package. */
  static filterNativeDropItems(sheet, items = []) {
    const actor = sheet?.actor ?? sheet?.inventorySource;
    if (!this.protects(actor) || !items.length) return items;
    const allowed = [];
    let blockedInventory = false;
    let blockedContent = false;
    for (const item of items) {
      const rule = this.#itemProtectionRule(item);
      if (!rule || !this.ruleEnabled(rule)) {
        allowed.push(item);
        continue;
      }
      if (rule === RULES.INVENTORY) blockedInventory = true;
      else blockedContent = true;
    }
    if (blockedInventory || blockedContent) {
      const label = blockedInventory && blockedContent ? "inventory and character content"
        : blockedInventory ? "inventory Items" : "character content";
      this.#warn(`Dragging ${label} onto this character sheet is restricted by Player Character Sheet Integrity.`);
    }
    return allowed;
  }

  static blockNativeAdvancement(manager, updates = {}, toCreate = [], toUpdate = [], toDelete = []) {
    const actor = manager?.actor;
    if (!this.ruleProtects(actor, RULES.CONTENT) || ClassProgressionGuard.isAuthorized(manager?.options ?? {})) return;
    const hasChanges = !foundry.utils.isEmpty(updates ?? {}) || toCreate.length || toUpdate.length || toDelete.length;
    if (!hasChanges) return;
    this.#warn("Direct native Advancement changes are GM-only while Character Content & Progression protection is enabled.");
    return false;
  }

  static #onInventoryAction(event, actor) {
    const action = String(event.detail ?? "");
    if (!action) return;

    if (action === "prepare") {
      const item = this.#itemFromEvent(actor, event);
      const timing = this.#mayChangePreparationFromSheet(actor, item);
      if (!timing.allowed) {
        this.#stop(event);
        this.#warn(timing.message);
        return;
      }
      if (this.ruleEnabled(RULES.PREPARED) && item?.type === "spell" && Number(item.system?.prepared ?? 0) === 0) {
        const decision = PreparedSpellLimitService.mayPrepare(actor, item);
        if (!decision.allowed) {
          this.#stop(event);
          this.#warn(decision.message);
          return;
        }
      }
    }

    if (SAFE_INVENTORY_ACTIONS.has(action)) return;
    if (!BLOCKED_ITEM_ACTIONS.has(action)) return;
    const item = this.#itemFromEvent(actor, event);
    const rule = this.#itemProtectionRule(item);
    if (!rule || !this.ruleEnabled(rule)) return;
    this.#stop(event);
    this.#warn(this.#itemBlockedMessage(rule));
  }

  static #onEffectAction(event, actor) {
    const action = String(event.detail ?? "");
    if (!this.ruleEnabled(RULES.CONTENT) || !BLOCKED_EFFECT_ACTIONS.has(action)) return;
    this.#stop(event);
    this.#warn("Direct Active Effect editing is GM-only while Character Content & Progression protection is enabled.");
  }

  static #onSheetClick(event, actor) {
    const directProficiencyControl = event.target?.closest?.(".proficiency-toggle, .trait-selector");
    if (directProficiencyControl && this.ruleEnabled(RULES.CHARACTER_DATA)) {
      this.#stop(event);
      this.#warn("Character data and proficiencies are GM-only while this protection is enabled.");
      return;
    }

    const actionElement = event.target?.closest?.("[data-action]");
    const action = String(actionElement?.dataset?.action ?? "");
    if (!action) return;

    const item = this.#itemFromActionElement(actor, actionElement);
    if (item && BLOCKED_ITEM_ACTIONS.has(action)) {
      const rule = this.#itemProtectionRule(item);
      if (rule && this.ruleEnabled(rule)) {
        this.#stop(event);
        this.#warn(this.#itemBlockedMessage(rule));
        return;
      }
    }

    if (action === "changeMode" && this.#useGlobalStructuralLock()) {
      this.#stop(event);
      this.#warn("Direct sheet editing is disabled by the configured integrity protections.");
      return;
    }

    if (["editDescription", "editImage", "toggleEditInline", "setSpellcastingAbility", "senses", "tool", "flags", "type", "configure"].includes(action)
      && this.ruleEnabled(RULES.CHARACTER_DATA)) {
      this.#stop(event);
      this.#warn("Character data and proficiencies are GM-only while this protection is enabled.");
      return;
    }

    if (action === "showConfiguration") {
      const rule = this.#configurationProtectionRule(actionElement);
      if (rule && this.ruleEnabled(rule)) {
        this.#stop(event);
        this.#warn(rule === RULES.RESOURCES
          ? "Spell-slot and resource configuration is GM-only while Resources & Spell Slots protection is enabled."
          : "Character data and proficiency configuration is GM-only while Character Data & Proficiencies protection is enabled.");
        return;
      }
    }

    if (action === "toggleInspiration" && this.ruleEnabled(RULES.RESOURCES)) {
      this.#stop(event);
      this.#warn("Heroic Inspiration changes are handled by the GM or game features while Resources & Spell Slots protection is enabled.");
      return;
    }

    if (action === "togglePip" && this.ruleEnabled(RULES.RESOURCES)) {
      const prop = actionElement?.dataset?.prop ?? actionElement?.closest?.("[data-prop]")?.dataset?.prop;
      if (!this.#managedActorResourcePath(prop)) return;
      this.#stop(event);
      this.#warn("Resource counters are read-only. Use the spell or feature normally; only the GM may edit counters directly.");
      return;
    }

    if ((action === "increase" || action === "decrease") && item) {
      const property = String(actionElement.dataset?.property ?? "");
      if (property === "system.quantity" || property.includes("uses")) {
        const rule = this.#itemProtectionRule(item);
        if (rule && this.ruleEnabled(rule)) {
          this.#stop(event);
          this.#warn(this.#itemBlockedMessage(rule));
        }
      }
    }
  }

  static #onSheetChange(event, actor) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
    const name = String(input.name ?? input.dataset?.name ?? "");
    const item = this.#itemFromControl(actor, input);

    // Container currency is governed only by the Currency package, independent
    // of whether the rest of that inventory Item is structurally locked.
    if (item && /^system\.currency\.[^.]+$/.test(name)) {
      if (!this.ruleEnabled(RULES.CURRENCY)) return;
      this.#restoreDocumentControl(input, item, name);
      this.#stop(event);
      this.#warn("Currency amounts in containers are read-only. Use the native Currency Manager or an approved gameplay transfer.");
      return;
    }

    if (!item && this.ruleEnabled(RULES.RESOURCES) && this.#managedActorResourcePath(name)) {
      this.#restoreDocumentControl(input, actor, name);
      this.#stop(event);
      this.#warn("Resource counters are read-only. Use the spell or feature normally; only the GM may edit counters directly.");
      return;
    }

    if (!item && this.ruleEnabled(RULES.CURRENCY) && /^system\.currency\.[^.]+$/.test(name)) {
      this.#restoreDocumentControl(input, actor, name);
      this.#stop(event);
      this.#warn("Currency amounts are read-only. Use the native Currency Manager, the GM, or an approved gameplay system such as Item Piles.");
      return;
    }

    if (item) {
      const rule = this.#itemProtectionRule(item);
      if (rule && this.ruleEnabled(rule)) {
        const path = String(input.dataset?.name ?? input.name ?? "");
        this.#restoreItemControl(input, item, path);
        this.#stop(event);
        this.#warn(this.#itemBlockedMessage(rule));
      }
      return;
    }

    if (this.ruleEnabled(RULES.CONTENT) && this.#progressionActorPath(name)) {
      this.#restoreDocumentControl(input, actor, name);
      this.#stop(event);
      this.#warn("Character progression fields are GM-only while Character Content & Progression protection is enabled.");
      return;
    }

    if (this.ruleEnabled(RULES.CHARACTER_DATA) && this.#characterDataPath(name)) {
      this.#restoreDocumentControl(input, actor, name);
      this.#stop(event);
      this.#warn("Character data and proficiencies are GM-only while this protection is enabled.");
    }
  }

  static #onEmbeddedItemSheetClick(event, item) {
    const actionElement = event.target?.closest?.("[data-action]");
    const action = String(actionElement?.dataset?.action ?? "");
    const rule = this.#itemProtectionRule(item);
    if (!rule || !this.ruleEnabled(rule)) return;
    const hasIndependentCurrency = item?.system?.currency && !this.ruleEnabled(RULES.CURRENCY);
    if (action === "changeMode" && hasIndependentCurrency) return;
    if (!BLOCKED_ITEM_ACTIONS.has(action) && action !== "changeMode" && action !== "deleteDocument"
      && action !== "addDocument" && action !== "toggleEditInline") return;
    this.#stop(event);
    this.#warn(this.#itemBlockedMessage(rule));
  }

  static #onEmbeddedItemSheetChange(event, item) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
    const name = String(target.name ?? target.dataset?.name ?? "");

    if (/^system\.currency\.[^.]+$/.test(name)) {
      if (!this.ruleEnabled(RULES.CURRENCY)) return;
      this.#restoreDocumentControl(target, item, name);
      this.#stop(event);
      this.#warn("Currency amounts in containers are read-only. Use the native Currency Manager or an approved gameplay transfer.");
      return;
    }

    const rule = this.#itemProtectionRule(item);
    if (!rule || !this.ruleEnabled(rule)) return;
    if (target.closest?.("[data-application-part]")?.querySelector?.("item-list-controls")?.contains?.(target)) return;
    this.#restoreItemControl(target, item, name);
    this.#stop(event);
    this.#warn(this.#itemBlockedMessage(rule));
  }

  static #applySheetDomProtection(actor, root) {
    const globalLock = this.#useGlobalStructuralLock();
    if (globalLock) {
      root.querySelectorAll(".mode-slider, .create-child, [data-action='addDocument']").forEach(el => el.remove());
    }

    if (this.ruleEnabled(RULES.CHARACTER_DATA)) {
      root.querySelectorAll("[data-action='editImage'], [data-action='editDescription']").forEach(el => el.remove());
    }

    // Hide structural item controls only on rows owned by an enabled package.
    for (const row of root.querySelectorAll("[data-item-id]")) {
      const item = actor.items?.get?.(row.dataset.itemId);
      const rule = this.#itemProtectionRule(item);
      if (!rule || !this.ruleEnabled(rule)) continue;
      row.querySelectorAll([
        "[data-action='editDocument']", "[data-action='deleteDocument']",
        ".item-action[data-action='edit']", ".item-action[data-action='delete']",
        ".item-action[data-action='duplicate']"
      ].join(",")).forEach(el => el.remove());
    }

    if (this.ruleEnabled(RULES.CONTENT)) {
      root.querySelectorAll("[data-effect-id] [data-action='edit'], [data-effect-id] [data-action='delete'], [data-effect-id] [data-action='duplicate']")
        .forEach(el => el.remove());
    }

    for (const control of root.querySelectorAll("input, select, textarea")) {
      const name = String(control.name ?? control.dataset?.name ?? "");
      const item = this.#itemFromControl(actor, control);
      if (item) {
        if (/^system\.currency\.[^.]+$/.test(name)) {
          if (this.ruleEnabled(RULES.CURRENCY)) this.#setControlReadOnly(control);
          continue;
        }
        const rule = this.#itemProtectionRule(item);
        if (rule && this.ruleEnabled(rule)) this.#setControlReadOnly(control);
        continue;
      }
      if (this.ruleEnabled(RULES.RESOURCES) && this.#managedActorResourcePath(name)) this.#setControlReadOnly(control);
      else if (this.ruleEnabled(RULES.CURRENCY) && /^system\.currency\.[^.]+$/.test(name)) this.#setControlReadOnly(control);
      else if (this.ruleEnabled(RULES.CONTENT) && this.#progressionActorPath(name)) this.#setControlReadOnly(control);
      else if (this.ruleEnabled(RULES.CHARACTER_DATA) && this.#characterDataPath(name)) this.#setControlReadOnly(control);
    }

    for (const button of root.querySelectorAll(".adjustment-button[data-property='system.quantity'], .adjustment-button[data-property*='uses']")) {
      const item = this.#itemFromActionElement(actor, button);
      const rule = this.#itemProtectionRule(item);
      if (!rule || !this.ruleEnabled(rule)) continue;
      button.hidden = true;
      button.setAttribute("aria-hidden", "true");
    }

    if (this.ruleEnabled(RULES.CURRENCY)) this.#ensureCurrencyManagerButtons(root, actor);
    this.#applyUnpreparedSpellUsageDom(actor, root);
  }

  static #applyUnpreparedSpellUsageDom(actor, root) {
    // This layer is deliberately visual only. Combat membership and world
    // settings can change while an Actor sheet remains open; an actual DOM
    // `disabled` attribute could therefore become stale and incorrectly block
    // a later legal use. dnd5e.preUseActivity remains the sole authority.
    for (const row of root.querySelectorAll(".cb-unprepared-spell-usage-blocked")) {
      row.classList.remove("cb-unprepared-spell-usage-blocked");
    }
    const mode = PlayerSheetIntegritySettingsService.unpreparedSpellUsageMode();
    if (mode === "off") return;
    for (const row of root.querySelectorAll("[data-item-id]")) {
      const item = actor.items?.get?.(row.dataset.itemId);
      if (!this.#wouldBlockUnpreparedSpellUse(actor, item, mode)) continue;
      row.classList.add("cb-unprepared-spell-usage-blocked");
    }
  }

  static #applyEmbeddedItemDomProtection(item, root) {
    const rule = this.#itemProtectionRule(item);
    const itemLocked = rule && this.ruleEnabled(rule);
    const hasIndependentCurrency = item?.system?.currency && !this.ruleEnabled(RULES.CURRENCY);
    if (itemLocked) {
      const selector = hasIndependentCurrency
        ? ".create-child, [data-action='addDocument'], [data-action='deleteDocument']"
        : ".mode-slider, .create-child, [data-action='addDocument'], [data-action='deleteDocument']";
      root.querySelectorAll(selector).forEach(el => el.remove());
    }

    for (const control of root.querySelectorAll("input, select, textarea")) {
      const name = String(control.name ?? control.dataset?.name ?? "");
      if (/^system\.currency\.[^.]+$/.test(name)) {
        if (this.ruleEnabled(RULES.CURRENCY)) this.#setControlReadOnly(control);
        continue;
      }
      if (itemLocked) this.#setControlReadOnly(control);
    }
    if (this.ruleEnabled(RULES.CURRENCY)) this.#ensureCurrencyManagerButtons(root, item);
  }

  static #ensureCurrencyManagerButtons(root, document) {
    if (!document?.system?.currency) return;
    for (const section of root.querySelectorAll("section.currency")) {
      if (section.querySelector('[data-action="currency"]')) continue;
      const button = section.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "item-action unbutton always-interactive";
      button.dataset.action = "currency";
      button.dataset.cbNativeCurrencyManager = "true";
      button.setAttribute("aria-label", game.i18n?.localize?.("DND5E.CurrencyManager.Title") ?? "Currency Manager");
      button.innerHTML = '<i class="fa-solid fa-coins" inert></i>';

      // D&D5e binds inventory-element actions during connectedCallback(). Under
      // the global protected-sheet lock the native currency control is omitted,
      // so this replacement is necessarily inserted after that binding pass.
      // Open the system's own CurrencyManager directly rather than recreating a
      // transfer workflow or mutating currency through Character Builder.
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const CurrencyManager = globalThis.dnd5e?.applications?.CurrencyManager;
        if (!CurrencyManager) {
          this.#warn("The native D&D5e Currency Manager is unavailable.");
          return;
        }
        new CurrencyManager({ document }).render({ force: true });
      });
      section.prepend(button);
    }
  }

  static #mayChangePreparationFromSheet(actor, spell) {
    if (!actor || spell?.type !== "spell" || Number(spell.system?.level ?? 0) <= 0) return { allowed: true };
    if (PreparedSpellLimitService.isExcludedGrant(spell)) return { allowed: true };
    const cls = PreparedSpellLimitService.owningClassForSpell(actor, spell);
    if (!cls) return { allowed: true };
    const mode = PlayerSheetIntegritySettingsService.unpreparedSpellUsageMode();
    if (mode === "off") return { allowed: true };
    if (mode === "combatOnly" && !this.#actorInCombat(actor)) return { allowed: true };

    const cadence = SpellPreparationCadenceService.forClass(cls);
    if (mode === "combatOnly") {
      return {
        allowed: false,
        message: `${cls.name} prepared spells cannot be changed from the character sheet while this Actor is in combat.`
      };
    }
    if (mode === "always") {
      const message = cadence === SpellPreparationCadenceService.LONG_REST
        ? `${cls.name} prepared spells are managed through Character Keeper during a Long Rest while Unprepared Spell Usage is set to Always.`
        : cadence === SpellPreparationCadenceService.LEVEL_UP
          ? `${cls.name} prepared spells are changed through Character Builder Level Up while Unprepared Spell Usage is set to Always.`
          : `${cls.name} spell preparation cannot be changed directly from the sheet while Unprepared Spell Usage is set to Always.`;
      return { allowed: false, message };
    }
    return { allowed: true };
  }

  static #wouldBlockUnpreparedSpellUse(actor, spell, mode = PlayerSheetIntegritySettingsService.unpreparedSpellUsageMode()) {
    if (!this.#isRestrictedUnpreparedSpell(actor, spell) || mode === "off") return false;
    const inCombat = this.#actorInCombat(actor);
    if (mode === "combatOnly") return inCombat;
    if (mode === "always" && !inCombat && this.#wizardRitualAdeptEligible(actor, spell)) return false;
    return mode === "always";
  }

  static #isRestrictedUnpreparedSpell(actor, spell) {
    if (spell?.type !== "spell") return false;
    if (Number(spell.system?.level ?? 0) <= 0) return false;
    if (Number(spell.system?.prepared ?? 0) !== 0) return false;
    if (PreparedSpellLimitService.isExcludedGrant(spell)) return false;

    // Class provenance is stronger than the current casting method. In
    // particular, a class-owned Item whose method happens to be `ritual` does
    // not become a generic bypass; the only intentional unprepared ritual
    // exception is Wizard Ritual Adept below.
    if (PreparedSpellLimitService.owningClassForSpell(actor, spell)) return true;

    const method = String(spell.system?.method ?? "").trim().toLowerCase();
    const derived = spell.system?.canPrepare;
    if (derived === true) return true;
    if (derived === false) return false;
    const model = globalThis.CONFIG?.DND5E?.spellcasting?.[method];
    if (model?.prepares === true) return true;
    if (model?.prepares === false) return false;
    return ["spell", "pact"].includes(method);
  }

  static #wizardRitualAdeptEligible(actor, spell) {
    if (!actor || spell?.type !== "spell") return false;
    const properties = spell.system?.properties;
    const hasRitual = properties?.has?.("ritual") === true
      || Array.isArray(properties) && properties.includes("ritual")
      || Object.values(properties ?? {}).includes("ritual");
    if (!hasRitual) return false;
    const cls = PreparedSpellLimitService.owningClassForSpell(actor, spell);
    if (String(cls?.system?.identifier ?? "").trim().toLowerCase() !== "wizard") return false;
    return [...(actor.items ?? [])].some(item => item?.type === "feat"
      && String(item.system?.identifier ?? "").trim().toLowerCase() === "ritual-adept");
  }

  static #actorInCombat(actor) {
    if (!actor) return false;
    const combats = [...(globalThis.game?.combats ?? [])];
    return combats.some(combat => {
      if (!combat?.started) return false;
      const combatants = [...(combat.combatants ?? [])];
      return combatants.some(combatant => combatant?.actor?.id === actor.id
        || combatant?.actorId === actor.id
        || combatant?.token?.actorId === actor.id);
    });
  }

  static #protectChat(message, element) {
    if (!this.enabled() || game.user?.isGM || !this.ruleEnabled(RULES.RESOURCES)) return;
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
      this.#warn("Resource refunds are GM-only while Resources & Spell Slots protection is enabled.");
    }, { capture: true });
  }

  static #useGlobalStructuralLock(candidate = null) {
    return [RULES.CHARACTER_DATA, RULES.INVENTORY, RULES.CONTENT, RULES.RESOURCES, RULES.CURRENCY]
      .every(rule => this.ruleEnabled(rule, candidate));
  }

  static #itemProtectionRule(item) {
    const type = String(item?.type ?? item?.document?.type ?? item?._source?.type ?? "").trim();
    if (!type) return null;
    if (CONTENT_ITEM_TYPES.has(type)) return RULES.CONTENT;
    if (INVENTORY_ITEM_TYPES.has(type)) return RULES.INVENTORY;
    // Unknown embedded Item types are treated as character content rather than
    // silently falling through an enabled protection package.
    return RULES.CONTENT;
  }

  static #itemBlockedMessage(rule) {
    return rule === RULES.INVENTORY
      ? "Direct inventory Item editing is GM-only while Inventory & Item Editing protection is enabled. Normal use, consumption, equip, attune, favorites, and sorting remain available."
      : "Direct spell, feat, feature, and character-content editing is GM-only while Character Content & Progression protection is enabled. Normal casting and feature use remain available.";
  }

  static #configurationProtectionRule(element) {
    if (element?.dataset?.trait) return RULES.CHARACTER_DATA;
    const config = String(element?.dataset?.config ?? "");
    if (["spellSlots", "hitDice"].includes(config)) return RULES.RESOURCES;
    if (["ability", "armorClass", "creatureType", "initiative", "movement", "senses", "skill", "tool", "skills",
      "source", "hitPoints", "death", "concentration"].includes(config)) return RULES.CHARACTER_DATA;
    // Unknown Actor configuration panels are structural by default. This keeps
    // the Character Data package fail-closed as D&D5e adds new configuration
    // actions without forcing the entire sheet back into global locked mode.
    return config ? RULES.CHARACTER_DATA : null;
  }

  static #characterDataPath(path) {
    path = String(path ?? "");
    if (!path) return false;
    if (path === "name" || path === "img") return true;
    if (/^system\.(abilities|skills|tools|traits|bonuses|bastion)(\.|$)/.test(path)) return true;
    if (/^system\.details\.(?!xp(?:\.|$))/.test(path)) return true;
    return /^system\.attributes\.(ac|init|movement|senses|attunement|concentration|loyalty|spellcasting)(\.|$)/.test(path);
  }

  static #progressionActorPath(path) {
    path = String(path ?? "");
    return /^system\.details\.xp(\.|$)/.test(path);
  }

  static #managedActorResourcePath(path) {
    path = String(path ?? "");
    return /^system\.spells\.[^.]+\.value$/.test(path)
      || /^system\.resources\.[^.]+\.value$/.test(path)
      || /^system\.resources\.[^.]+\.spent$/.test(path);
  }

  static #itemFromEvent(actor, event) {
    return this.#itemFromActionElement(actor, event?.target);
  }

  static #itemFromActionElement(actor, element) {
    const itemId = element?.closest?.("[data-item-id]")?.dataset?.itemId;
    return itemId ? actor?.items?.get?.(itemId) ?? null : null;
  }

  static #itemFromControl(actor, control) {
    const itemId = control?.closest?.("[data-item-id]")?.dataset?.itemId;
    return itemId ? actor?.items?.get?.(itemId) ?? null : null;
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

  static #restoreItemControl(control, item, path) {
    if (!control || !item || !path) return;
    if (path === "uses.value") {
      const activityId = control.closest?.("[data-activity-id]")?.dataset?.activityId;
      const activity = activityId ? item.system?.activities?.get?.(activityId) : null;
      const current = activity?.uses?.value;
      if (current !== undefined && current !== null) control.value = String(current);
      return;
    }
    this.#restoreDocumentControl(control, item, path);
  }

  static #restoreDocumentControl(control, document, path) {
    if (!path || !document) return;
    const current = foundry.utils.getProperty(document, path);
    if (current === undefined || current === null) return;
    if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
      control.checked = Boolean(current);
      return;
    }
    if (Array.isArray(current)) return;
    control.value = String(current);
  }

  static #setControlReadOnly(control) {
    control.setAttribute("aria-readonly", "true");
    if (control instanceof HTMLInputElement && !["checkbox", "radio", "file", "button", "submit"].includes(control.type)) {
      control.readOnly = true;
      return;
    }
    if (control instanceof HTMLTextAreaElement) {
      control.readOnly = true;
      return;
    }
    if (control instanceof HTMLSelectElement || control instanceof HTMLInputElement) {
      // `inert` blocks pointer/keyboard interaction without removing the field
      // from form submission the way `disabled` would. The capture/change
      // guards remain the authoritative fallback.
      control.setAttribute("inert", "");
      control.setAttribute("aria-disabled", "true");
      control.tabIndex = -1;
    }
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
