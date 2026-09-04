import { MODULE_ID } from "../constants.mjs";
import { WarBondManagementService } from "../services/war-bond-management-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Standalone War Bond maintenance surface shared by the native Activity intercept and Character Keeper. */
export class WarBondManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instances = new Map();

  constructor(actor, { featureItemId = null, activityId = null, options = {} } = {}) {
    super(options);
    this.actor = actor;
    this.featureItemId = featureItemId;
    this.activityId = activityId;
    this.busy = false;
  }

  static DEFAULT_OPTIONS = {
    id: "dnd5e-character-builder-war-bond-manager",
    classes: ["dnd5e-character-builder", "character-builder", "war-bond-manager-app"],
    tag: "section",
    position: { width: 960, height: 700 },
    window: { title: "Manage War Bonds", resizable: true, modal: false }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/war-bond-manager.hbs` }
  };

  get id() {
    return `dnd5e-character-builder-war-bond-manager-${this.actor?.id ?? "actor"}`;
  }

  static async launch(actor, options = {}) {
    if (!actor || actor.type !== "character" || !actor.isOwner) {
      ui.notifications.warn("You do not have permission to manage War Bond for this character.");
      return null;
    }
    if (!WarBondManagementService.canManage(actor)) {
      ui.notifications.warn("This Actor does not currently have a usable source-native War Bond / Bond with Weapon Activity.");
      return null;
    }
    const existing = this.#instances.get(actor.id);
    if (existing && !existing._stateIsClosing) {
      existing.featureItemId = options.featureItemId ?? existing.featureItemId;
      existing.activityId = options.activityId ?? existing.activityId;
      existing.bringToFront?.();
      await existing.render({ force: true });
      return existing;
    }
    const app = new this(actor, options);
    this.#instances.set(actor.id, app);
    await app.render({ force: true });
    return app;
  }

  async _onClose(options = {}) {
    super._onClose(options);
    WarBondManagerApp.#instances.delete(this.actor?.id);
  }

  async _prepareContext() {
    const context = await WarBondManagementService.context(this.actor, {
      featureItemId: this.featureItemId,
      activityId: this.activityId
    });
    this.featureItemId = context.featureItemId;
    this.activityId = context.activityId;
    return { ...context, busy: this.busy };
  }

  _onRender() {
    const root = this.element;
    root.querySelector('[data-action="close-war-bond-manager"]')?.addEventListener("click", event => {
      event.preventDefault();
      void this.close();
    });
    root.querySelectorAll('[data-action="break-war-bond"]').forEach(button => {
      button.addEventListener("click", event => void this.#breakBond(event));
    });
    root.querySelectorAll('[data-action="release-broken-war-bond"]').forEach(button => {
      button.addEventListener("click", event => void this.#releaseBroken(event));
    });
    root.querySelectorAll("[data-war-bond-weapon]").forEach(row => {
      row.addEventListener("dragstart", event => this.#dragWeapon(event));
    });
    root.querySelectorAll("[data-war-bond-slot]").forEach(slot => {
      slot.addEventListener("dragover", event => {
        if (slot.dataset.slotKind === "bound") return;
        event.preventDefault();
        slot.classList.add("dragover");
      });
      slot.addEventListener("dragleave", () => slot.classList.remove("dragover"));
      slot.addEventListener("drop", event => void this.#dropWeapon(event));
    });
    const search = root.querySelector("[data-war-bond-search]");
    search?.addEventListener("input", () => this.#filterWeapons(search.value));
  }

  #dragWeapon(event) {
    const row = event.currentTarget;
    const weaponId = row.dataset.weaponId;
    if (!weaponId || !event.dataTransfer) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-dnd5e-character-builder-war-bond", JSON.stringify({ weaponId }));
    event.dataTransfer.setData("text/plain", weaponId);
  }

  async #dropWeapon(event) {
    event.preventDefault();
    const slot = event.currentTarget;
    slot.classList.remove("dragover");
    if (this.busy || slot.dataset.slotKind === "bound") return;
    try {
      let payload = null;
      const raw = event.dataTransfer?.getData?.("application/x-dnd5e-character-builder-war-bond");
      if (raw) payload = JSON.parse(raw);
      const weaponId = payload?.weaponId ?? event.dataTransfer?.getData?.("text/plain") ?? "";
      if (!weaponId) throw new Error("Drag an eligible weapon from the Available Weapons list.");
      await this.#withBusy(async () => {
        const result = await WarBondManagementService.bind(this.actor, weaponId, {
          replaceBroken: slot.dataset.slotKind === "broken",
          featureItemId: this.featureItemId,
          activityId: this.activityId
        });
        ui.notifications.info(`${result.weaponName} is now War Bonded.`);
      });
    } catch (error) {
      console.error(`${MODULE_ID} | War Bond bind failed.`, error);
      ui.notifications.error(error.message);
    }
  }

  async #breakBond(event) {
    event.preventDefault();
    const effectUuid = event.currentTarget.dataset.effectUuid;
    if (!effectUuid || this.busy) return;
    try {
      await this.#withBusy(async () => {
        const result = await WarBondManagementService.breakBond(this.actor, effectUuid, {
          featureItemId: this.featureItemId,
          activityId: this.activityId
        });
        ui.notifications.info(`War Bond broken for ${result.weaponName}.`);
      });
    } catch (error) {
      console.error(`${MODULE_ID} | War Bond removal failed.`, error);
      ui.notifications.error(error.message);
    }
  }

  async #releaseBroken(event) {
    event.preventDefault();
    if (this.busy) return;
    try {
      await this.#withBusy(async () => {
        await WarBondManagementService.releaseBroken(this.actor, {
          featureItemId: this.featureItemId,
          activityId: this.activityId
        });
        ui.notifications.info("Broken War Bond capacity released.");
      });
    } catch (error) {
      console.error(`${MODULE_ID} | Broken War Bond release failed.`, error);
      ui.notifications.error(error.message);
    }
  }

  async #withBusy(callback) {
    if (this.busy) return;
    this.busy = true;
    await this.render({ force: true });
    try { await callback(); }
    finally {
      this.busy = false;
      await this.render({ force: true });
    }
  }

  #filterWeapons(value) {
    const query = String(value ?? "").trim().toLowerCase();
    for (const row of this.element?.querySelectorAll?.("[data-war-bond-weapon]") ?? []) {
      row.hidden = Boolean(query && !String(row.dataset.search ?? row.textContent ?? "").toLowerCase().includes(query));
    }
  }
}
