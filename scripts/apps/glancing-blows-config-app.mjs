import { MODULE_ID, GLANCING_BLOW_BAND_DEFINITIONS, defaultSettings } from "../constants.mjs";
import { GlancingBlowsService } from "../services/glancing-blows-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class GlancingBlowsConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(parentApp = null, options = {}) {
    super(options);
    this.parentApp = parentApp;
    this.busy = false;
    this.bands = foundry.utils.deepClone(GlancingBlowsService.configuration().bands);
  }

  static DEFAULT_OPTIONS = {
    id: "character-builder-glancing-blows-config",
    classes: ["dnd5e-character-builder", "character-builder", "glancing-blows-config-app"],
    tag: "form",
    position: { width: 690, height: 520 },
    window: { title: "Configure Glancing Blows", resizable: true, modal: false }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/glancing-blows-config.hbs` }
  };

  async _prepareContext() {
    if (!game.user?.isGM) throw new Error("Only the GM can configure Glancing Blows.");
    const nativeOptions = GlancingBlowsService.multiplierOptions();
    const rows = GLANCING_BLOW_BAND_DEFINITIONS.map(definition => {
      const band = this.bands?.[definition.key] ?? {};
      const multiplier = GlancingBlowsService.normalizeMultiplier(band.multiplier, definition.defaultMultiplier);
      return {
        ...definition,
        enabled: band.enabled !== false,
        multiplier,
        multiplierLabel: GlancingBlowsService.multiplierLabel(multiplier),
        result: GlancingBlowsService.resultLabel(multiplier),
        options: nativeOptions.map(option => ({
          ...option,
          selected: option.value === multiplier
        }))
      };
    });
    return { busy: this.busy, rows };
  }

  _onRender() {
    this.element.querySelector('[data-action="cancel"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.close();
    });
    this.element.querySelector('[data-action="save"]')?.addEventListener("click", event => this.#save(event));
    this.element.querySelector('[data-action="reset"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.bands = foundry.utils.deepClone(GlancingBlowsService.defaultConfiguration().bands);
      this.render({ force: true });
    });

    for (const row of this.element.querySelectorAll("[data-glancing-band]")) {
      const key = String(row.dataset.glancingBand ?? "");
      const checkbox = row.querySelector('input[type="checkbox"]');
      const select = row.querySelector("select");
      checkbox?.addEventListener("change", () => {
        if (!this.bands[key]) return;
        this.bands[key].enabled = Boolean(checkbox.checked);
        row.classList.toggle("disabled", !checkbox.checked);
      });
      select?.addEventListener("change", () => {
        if (!this.bands[key]) return;
        const multiplier = GlancingBlowsService.normalizeMultiplier(select.value, this.bands[key].multiplier);
        this.bands[key].multiplier = multiplier;
        const result = row.querySelector("[data-glancing-result]");
        if (result) result.textContent = GlancingBlowsService.resultLabel(multiplier);
      });
    }
  }

  async #save(event) {
    event.preventDefault();
    if (this.busy || !game.user?.isGM) return;
    this.busy = true;
    try {
      this.#readForm();
      const stored = game.settings.get(MODULE_ID, "settings") ?? {};
      const settings = foundry.utils.mergeObject(defaultSettings(), stored, { inplace: false });
      settings.rulesAssistance ??= {};
      settings.rulesAssistance.glancingBlows ??= {};
      settings.rulesAssistance.glancingBlows.bands = foundry.utils.deepClone(this.bands);
      await game.settings.set(MODULE_ID, "settings", settings);
      ui.notifications.info("Glancing Blows configuration saved.");
      await this.close();
    } catch (error) {
      console.error(`${MODULE_ID} | Could not save Glancing Blows configuration.`, error);
      ui.notifications.error(error.message);
      this.busy = false;
      await this.render({ force: true });
    }
  }

  #readForm() {
    for (const row of this.element.querySelectorAll("[data-glancing-band]")) {
      const key = String(row.dataset.glancingBand ?? "");
      if (!this.bands[key]) continue;
      this.bands[key].enabled = Boolean(row.querySelector('input[type="checkbox"]')?.checked);
      const raw = row.querySelector("select")?.value;
      this.bands[key].multiplier = GlancingBlowsService.normalizeMultiplier(raw, this.bands[key].multiplier);
    }
  }
}
