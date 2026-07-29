import { MODULE_ID, defaultSettings } from "../constants.mjs";
import { ContentSourceService } from "../services/content-source-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ContentSourcesApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(parentApp = null, options = {}) {
    super(options);
    this.parentApp = parentApp;
    this.rows = null;
    this.busy = false;
  }

  static DEFAULT_OPTIONS = {
    id: "character-builder-content-sources",
    classes: ["dnd5e-character-builder", "character-builder", "content-sources-app"],
    tag: "form",
    position: { width: 940, height: 780 },
    window: { title: "Character Builder Content Sources", resizable: true, modal: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/content-sources.hbs` }
  };

  async _prepareContext() {
    if (!game.user.isGM) throw new Error("Only the GM can configure Character Builder content sources.");
    if (!this.rows) {
      const stored = game.settings.get(MODULE_ID, "settings") ?? {};
      const merged = foundry.utils.mergeObject(defaultSettings(), stored, { inplace: false });
      this.rows = await ContentSourceService.synchronizedRows(merged.sources, { force: true });
    }
    const enabledCount = this.rows.filter(row => row.enabled && row.installed !== false).length;
    return {
      busy: this.busy,
      enabledCount,
      totalCount: this.rows.length,
      sources: this.rows.map((row, index) => ({
        ...row,
        index,
        unavailable: row.installed === false,
        legacy: row.id === "srd51",
        packageLabel: this.#packageLabel(row)
      }))
    };
  }

  _onRender() {
    const root = this.element;
    root.querySelector('[data-action="cancel"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.close();
    });
    root.querySelector('[data-action="save"]')?.addEventListener("click", event => this.#save(event));
    root.querySelector('[data-action="refresh"]')?.addEventListener("click", event => this.#refresh(event));
    root.querySelector('[data-action="enable-all"]')?.addEventListener("click", event => this.#setAll(event, true));
    root.querySelector('[data-action="disable-all"]')?.addEventListener("click", event => this.#setAll(event, false));
    root.querySelectorAll('[data-action="move-source"]').forEach(button => {
      button.addEventListener("click", event => this.#moveSource(event));
    });
    root.querySelector('[data-source-filter]')?.addEventListener("input", event => this.#filter(event));
  }

  async #save(event) {
    event.preventDefault();
    if (this.busy) return;
    const rows = [...this.element.querySelectorAll("[data-source-id]")].map((element, priority) => {
      const previous = this.rows.find(row => row.id === element.dataset.sourceId) ?? {};
      return {
        ...previous,
        enabled: Boolean(element.querySelector('input[type="checkbox"]')?.checked),
        priority
      };
    });
    if (!rows.some(row => row.enabled && row.installed !== false)) {
      return ui.notifications.error("Enable at least one installed content source.");
    }

    this.busy = true;
    try {
      const stored = game.settings.get(MODULE_ID, "settings") ?? {};
      const settings = foundry.utils.mergeObject(defaultSettings(), stored, { inplace: false });
      settings.sources = rows;
      await game.settings.set(MODULE_ID, "settings", settings);
      this.rows = rows;
      ui.notifications.info("Character Builder content sources saved.");
      await this.close();
      await this.parentApp?.render?.({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Could not save content sources.`, error);
      ui.notifications.error(error.message);
      this.busy = false;
      await this.render({ force: true });
    }
  }

  async #refresh(event) {
    event.preventDefault();
    if (this.busy) return;
    this.busy = true;
    try {
      this.#captureRows();
      this.rows = await ContentSourceService.synchronizedRows(this.rows, { force: true });
      ui.notifications.info("Available Item compendiums were scanned again.");
    } catch (error) {
      console.error(`${MODULE_ID} | Content source refresh failed.`, error);
      ui.notifications.error(error.message);
    } finally {
      this.busy = false;
      await this.render({ force: true });
    }
  }

  #captureRows() {
    const elements = [...this.element?.querySelectorAll?.("[data-source-id]") ?? []];
    if (!elements.length) return;
    this.rows = elements.map((element, priority) => {
      const previous = this.rows.find(row => row.id === element.dataset.sourceId) ?? {};
      return {
        ...previous,
        enabled: Boolean(element.querySelector('input[type="checkbox"]')?.checked),
        priority
      };
    });
  }

  #setAll(event, enabled) {
    event.preventDefault();
    this.element.querySelectorAll('[data-source-id] input[type="checkbox"]:not(:disabled)').forEach(input => {
      input.checked = enabled;
    });
  }

  #moveSource(event) {
    event.preventDefault();
    const row = event.currentTarget.closest("[data-source-id]");
    if (!row) return;
    const target = event.currentTarget.dataset.direction === "up"
      ? row.previousElementSibling
      : row.nextElementSibling;
    if (!target?.matches?.("[data-source-id]")) return;
    if (event.currentTarget.dataset.direction === "up") row.parentElement.insertBefore(row, target);
    else row.parentElement.insertBefore(target, row);
  }

  #filter(event) {
    const query = String(event.currentTarget.value ?? "").trim().toLowerCase();
    this.element.querySelectorAll("[data-source-id]").forEach(row => {
      row.hidden = Boolean(query && !String(row.dataset.search ?? "").includes(query));
    });
  }

  #packageLabel(row) {
    if (row.packageType === "world") return "World Compendiums";
    if (row.packageType === "system") return `System: ${row.packageId}`;
    return row.packageId ? `Module: ${row.packageId}` : "Compendium Source";
  }
}
