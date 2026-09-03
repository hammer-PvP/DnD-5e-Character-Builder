import { MODULE_ID, defaultSettings } from "../constants.mjs";
import { RulesAssistanceService } from "../services/rules-assistance-service.mjs";
import { RulesAssistanceSettingsService } from "../services/rules-assistance-settings-service.mjs";
import { HealingPotionConfigApp } from "./healing-potion-config-app.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class RulesAssistanceConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(parentApp = null, options = {}) {
    super(options);
    this.parentApp = parentApp;
    this.busy = false;
  }

  static DEFAULT_OPTIONS = {
    id: "character-builder-rules-assistance",
    classes: ["dnd5e-character-builder", "character-builder", "rules-assistance-app"],
    tag: "form",
    position: { width: 760, height: 650 },
    window: { title: "Configure Assistance Rules", resizable: true, modal: false }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/rules-assistance-config.hbs` }
  };

  async _prepareContext() {
    if (!game.user.isGM) throw new Error("Only the GM can configure Rules Automation Assistance.");
    const settings = RulesAssistanceSettingsService.settings();
    const masterInput = this.parentApp?.element?.querySelector?.('[name="assistWithDiceAutomation"]');
    const masterEnabled = masterInput ? Boolean(masterInput.checked) : settings.assistWithDiceAutomation === true;
    const summary = RulesAssistanceSettingsService.summary(settings);
    return {
      busy: this.busy,
      masterEnabled,
      enabledCount: summary.enabledCount,
      totalCount: summary.totalCount,
      rules: summary.rows,
      organizeManagedSummonFolders: RulesAssistanceSettingsService.managedSummonFoldersEnabled(settings)
    };
  }

  _onRender() {
    this.element.querySelector('[data-action="cancel"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.close();
    });
    this.element.querySelector('[data-action="save"]')?.addEventListener("click", event => this.#save(event));
    this.element.querySelectorAll('[data-rule-key] input[type="checkbox"]').forEach(input => {
      input.addEventListener("change", () => this.#refreshSummary());
    });
    this.element.querySelectorAll('[data-action="configure-potions"]').forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        const app = new HealingPotionConfigApp(this);
        app.render({ force: true });
      });
    });
  }



  #refreshSummary() {
    const inputs = [...this.element.querySelectorAll('[data-rule-key] input[type="checkbox"]')];
    const enabled = inputs.filter(input => input.checked).length;
    const summary = this.element.querySelector("[data-assistance-rule-summary]");
    if (summary) summary.innerHTML = `<strong>${enabled}</strong> of <strong>${inputs.length}</strong> assistance rules enabled.`;
  }

  async #save(event) {
    event.preventDefault();
    if (this.busy || !game.user.isGM) return;
    this.busy = true;
    try {
      const stored = game.settings.get(MODULE_ID, "settings") ?? {};
      const settings = foundry.utils.mergeObject(defaultSettings(), stored, { inplace: false });
      settings.rulesAssistance ??= {};
      settings.rulesAssistance.rules ??= {};
      settings.rulesAssistance.managedSummons ??= {};
      settings.rulesAssistance.managedSummons.organizeFolders = Boolean(
        this.element.querySelector('[name="managedSummons.organizeFolders"]')?.checked
      );
      for (const row of this.element.querySelectorAll("[data-rule-key]")) {
        const key = String(row.dataset.ruleKey ?? "");
        if (!RulesAssistanceSettingsService.definition(key)) continue;
        settings.rulesAssistance.rules[key] = Boolean(row.querySelector('input[type="checkbox"]')?.checked);
      }
      await game.settings.set(MODULE_ID, "settings", settings);
      await RulesAssistanceService.refresh();
      this.parentApp?.refreshRulesAssistanceSummary?.(settings);
      ui.notifications.info("Rules Automation Assistance configuration saved.");
      await this.close();
    } catch (error) {
      console.error(`${MODULE_ID} | Could not save assistance rules.`, error);
      ui.notifications.error(error.message);
      this.busy = false;
      await this.render({ force: true });
    }
  }
}
