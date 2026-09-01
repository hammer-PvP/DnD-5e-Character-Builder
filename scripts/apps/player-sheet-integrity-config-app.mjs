import { MODULE_ID, defaultSettings } from "../constants.mjs";
import { ModalStackService } from "../services/modal-stack-service.mjs";
import { PlayerSheetIntegrityService } from "../services/player-sheet-integrity-service.mjs";
import { PlayerSheetIntegritySettingsService } from "../services/player-sheet-integrity-settings-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PlayerSheetIntegrityConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(parentApp = null, options = {}) {
    super(options);
    this.parentApp = parentApp;
    this.modalStackToken = null;
    this.busy = false;
  }

  static DEFAULT_OPTIONS = {
    id: "character-builder-player-sheet-integrity",
    classes: ["dnd5e-character-builder", "character-builder", "player-sheet-integrity-config-app"],
    tag: "form",
    position: { width: 780, height: 660 },
    window: { title: "Configure Sheet Integrity", resizable: true, modal: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/player-sheet-integrity-config.hbs` }
  };

  async _prepareContext() {
    if (!game.user.isGM) throw new Error("Only the GM can configure Player Character Sheet Integrity.");
    const settings = PlayerSheetIntegritySettingsService.settings();
    const masterInput = this.parentApp?.element?.querySelector?.('[name="playerSheetIntegrity"]');
    const masterEnabled = masterInput ? Boolean(masterInput.checked) : settings.playerSheetIntegrity === true;
    const summary = PlayerSheetIntegritySettingsService.summary(settings);
    return {
      busy: this.busy,
      masterEnabled,
      enabledCount: summary.enabledCount,
      totalCount: summary.totalCount,
      rules: summary.rows,
      unpreparedSpellUsageMode: summary.unpreparedSpellUsageMode,
      unpreparedSpellUsageLabel: summary.unpreparedSpellUsageLabel,
      unpreparedSpellUsageOptions: PlayerSheetIntegritySettingsService.unpreparedSpellUsageOptions(settings)
    };
  }

  _onRender() {
    this.modalStackToken ??= ModalStackService.beginRoot(this, {
      ownerApp: this.parentApp,
      ownerElement: this.parentApp?.element,
      label: "Configure Sheet Integrity",
      message: "Save or close this window to return to Character Builder Settings."
    });
    this.element.querySelector('[data-action="cancel"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.close();
    });
    this.element.querySelector('[data-action="save"]')?.addEventListener("click", event => this.#save(event));
    this.element.querySelector('[data-action="restore-recommended"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.element.querySelectorAll('[data-integrity-rule-key] input[type="checkbox"]').forEach(input => {
        input.checked = true;
      });
      const usage = this.element.querySelector('[name="unpreparedSpellUsage"]');
      if (usage) usage.value = "combatOnly";
      this.#refreshSummary();
    });
    this.element.querySelectorAll('[data-integrity-rule-key] input[type="checkbox"]').forEach(input => {
      input.addEventListener("change", () => this.#refreshSummary());
    });
    this.element.querySelector('[name="unpreparedSpellUsage"]')?.addEventListener("change", () => this.#refreshSummary());
  }

  async _onClose(options = {}) {
    if (this.modalStackToken) {
      ModalStackService.end(this.modalStackToken, { closeDescendants: true });
      this.modalStackToken = null;
    }
    return super._onClose(options);
  }

  #refreshSummary() {
    const inputs = [...this.element.querySelectorAll('[data-integrity-rule-key] input[type="checkbox"]')];
    const enabled = inputs.filter(input => input.checked).length;
    const summary = this.element.querySelector("[data-integrity-rule-summary]");
    const usage = this.element.querySelector('[name="unpreparedSpellUsage"]');
    const usageLabel = usage?.selectedOptions?.[0]?.textContent?.trim?.() ?? "On";
    if (summary) summary.innerHTML = `<strong>${enabled}</strong> of <strong>${inputs.length}</strong> integrity protections enabled. <span>Allow Casting Unprepared Spells: <strong>${usageLabel}</strong>.</span>`;
  }

  async #save(event) {
    event.preventDefault();
    if (this.busy || !game.user.isGM) return;
    this.busy = true;
    try {
      const previousStored = foundry.utils.deepClone(game.settings.get(MODULE_ID, "settings") ?? {});
      const settings = foundry.utils.mergeObject(defaultSettings(), previousStored, { inplace: false });
      settings.playerSheetIntegrityConfig ??= {};
      settings.playerSheetIntegrityConfig.rules ??= {};
      const usageMode = String(this.element.querySelector('[name="unpreparedSpellUsage"]')?.value ?? "off");
      const allowedUsageModes = new Set(PlayerSheetIntegritySettingsService.unpreparedSpellUsageOptions(settings).map(row => row.value));
      settings.playerSheetIntegrityConfig.unpreparedSpellUsage = allowedUsageModes.has(usageMode) ? usageMode : "off";
      for (const row of this.element.querySelectorAll("[data-integrity-rule-key]")) {
        const key = String(row.dataset.integrityRuleKey ?? "");
        if (!PlayerSheetIntegritySettingsService.definition(key)) continue;
        settings.playerSheetIntegrityConfig.rules[key] = Boolean(row.querySelector('input[type="checkbox"]')?.checked);
      }
      await game.settings.set(MODULE_ID, "settings", settings);
      const reconciliation = await PlayerSheetIntegrityService.onSettingsChanged(previousStored, settings);
      this.parentApp?.refreshPlayerSheetIntegritySummary?.(settings);
      const suffix = reconciliation?.preparedSpellsChanged
        ? ` ${reconciliation.preparedSpellsChanged} excess prepared spell${reconciliation.preparedSpellsChanged === 1 ? " was" : "s were"} automatically unprepared.`
        : "";
      ui.notifications.info(`Player Character Sheet Integrity configuration saved.${suffix}`);
      await this.close();
    } catch (error) {
      console.error(`${MODULE_ID} | Could not save Player Character Sheet Integrity rules.`, error);
      ui.notifications.error(error.message);
      this.busy = false;
      await this.render({ force: true });
    }
  }
}
