import { MODULE_ID, defaultSettings } from "../constants.mjs";
import { ModalStackService } from "../services/modal-stack-service.mjs";
import { HealingPotionAssistanceService } from "../services/healing-potion-assistance-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class HealingPotionConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(parentApp = null, options = {}) {
    super(options);
    this.parentApp = parentApp;
    this.modalStackToken = null;
    this.rows = foundry.utils.deepClone(HealingPotionAssistanceService.customPotions());
    this.busy = false;
  }

  static DEFAULT_OPTIONS = {
    id: "character-builder-healing-potion-config",
    classes: ["dnd5e-character-builder", "character-builder", "healing-potion-config-app"],
    tag: "form",
    position: { width: 720, height: 620 },
    window: { title: "Configure Maximum-Healing Potions", resizable: true, modal: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/healing-potion-config.hbs` }
  };

  async _prepareContext() {
    return {
      busy: this.busy,
      customPotions: this.rows,
      officialPotions: [
        "Potion of Healing",
        "Potion of Healing (Greater) / Potion of Greater Healing",
        "Potion of Healing (Superior) / Potion of Superior Healing",
        "Potion of Healing (Supreme) / Potion of Supreme Healing"
      ]
    };
  }

  _onRender() {
    this.modalStackToken ??= ModalStackService.beginRoot(this, {
      ownerApp: this.parentApp,
      ownerElement: this.parentApp?.element,
      label: "Configure Maximum-Healing Potions",
      message: "Save or close this window to return to Configure Assistance Rules."
    });
    this.element.querySelector('[data-action="cancel"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.close();
    });
    this.element.querySelector('[data-action="save"]')?.addEventListener("click", event => this.#save(event));
    this.element.querySelectorAll('[data-action="remove-potion"]').forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        const sourceUuid = String(button.dataset.sourceUuid ?? "");
        this.rows = this.rows.filter(row => String(row.sourceUuid ?? "") !== sourceUuid);
        this.render({ force: true });
      });
    });
    const drop = this.element.querySelector("[data-potion-drop-zone]");
    drop?.addEventListener("dragover", event => {
      event.preventDefault();
      drop.classList.add("dragover");
    });
    drop?.addEventListener("dragleave", () => drop.classList.remove("dragover"));
    drop?.addEventListener("drop", event => void this.#drop(event));
  }

  async _onClose(options = {}) {
    if (this.modalStackToken) {
      ModalStackService.end(this.modalStackToken, { closeDescendants: true });
      this.modalStackToken = null;
    }
    return super._onClose(options);
  }

  async #drop(event) {
    event.preventDefault();
    event.currentTarget?.classList?.remove?.("dragover");
    try {
      const data = TextEditor.getDragEventData(event);
      if (String(data?.type ?? "") !== "Item" || !data?.uuid) throw new Error("Drop an Item from the World or a Compendium.");
      const item = await fromUuid(data.uuid);
      if (!item || item.documentName !== "Item") throw new Error("The dropped Item could not be resolved.");
      const inspection = HealingPotionAssistanceService.inspectSource(item);
      if (!inspection.compatible) throw new Error(inspection.reason || "This Item has no compatible Healing Activity.");

      let activity = inspection.compatibleActivities[0];
      if (inspection.compatibleActivities.length > 1) {
        const choice = await DialogV2.wait({
          window: { title: `Select Healing Activity — ${item.name}`, modal: true },
          content: `<p>This Item has more than one compatible Healing Activity. Choose the Activity that represents drinking the potion.</p>`,
          buttons: inspection.compatibleActivities.map(row => ({
            action: row.id,
            label: `${row.name} — ${row.formula}`,
            icon: "fa-solid fa-heart"
          })),
          rejectClose: false
        });
        if (!choice) return;
        activity = inspection.compatibleActivities.find(row => row.id === choice);
        if (!activity) return;
      }

      const sourceUuid = HealingPotionAssistanceService.sourceIdentity(item) || item.uuid;
      const row = {
        sourceUuid,
        name: item.name,
        img: item.img,
        activityId: activity.id,
        activityName: activity.name,
        formula: activity.formula,
        maximumFormula: activity.maximumFormula
      };
      this.rows = this.rows.filter(existing => String(existing.sourceUuid ?? "") !== String(sourceUuid));
      this.rows.push(row);
      this.rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      await this.render({ force: true });
    } catch (error) {
      ui.notifications.error(error.message);
    }
  }

  async #save(event) {
    event.preventDefault();
    if (this.busy || !game.user?.isGM) return;
    this.busy = true;
    try {
      const stored = game.settings.get(MODULE_ID, "settings") ?? {};
      const settings = foundry.utils.mergeObject(defaultSettings(), stored, { inplace: false });
      settings.rulesAssistance ??= {};
      settings.rulesAssistance.healingPotionMaximumAction ??= {};
      settings.rulesAssistance.healingPotionMaximumAction.customPotions = foundry.utils.deepClone(this.rows);
      await game.settings.set(MODULE_ID, "settings", settings);
      await HealingPotionAssistanceService.reconcileWorld();
      ui.notifications.info("Maximum-healing potion configuration saved.");
      await this.close();
    } catch (error) {
      console.error(`${MODULE_ID} | Could not save maximum-healing potion configuration.`, error);
      ui.notifications.error(error.message);
      this.busy = false;
      await this.render({ force: true });
    }
  }
}
