import { MODULE_ID, SOURCE_DEFINITIONS, defaultSettings } from "../constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CharacterBuilderSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _settingsScrollTop = 0;

  static DEFAULT_OPTIONS = {
    id: "character-builder-settings",
    classes: ["character-builder", "settings-app"],
    tag: "form",
    position: { width: 900, height: 820 },
    window: { title: "Character Builder Settings", resizable: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/settings.hbs` }
  };

  async _prepareContext() {
    const settings = foundry.utils.mergeObject(defaultSettings(), game.settings.get(MODULE_ID, "settings") ?? {}, {
      inplace: false
    });
    const ordered = [...settings.sources].sort((a, b) => Number(a.priority) - Number(b.priority));
    return {
      settings,
      sources: ordered.map((row, index) => ({
        ...row,
        index,
        label: SOURCE_DEFINITIONS[row.id]?.label ?? row.id,
        legacy: row.id === "srd51",
        installed: SOURCE_DEFINITIONS[row.id]?.packageId === "dnd5e" ||
          game.modules.get(SOURCE_DEFINITIONS[row.id]?.packageId)?.active
      }))
    };
  }

  _onRender() {
    const root = this.element;
    const body = root.querySelector(".cb-settings-body");
    if (body) {
      body.scrollTop = this._settingsScrollTop;
      body.addEventListener("scroll", () => {
        this._settingsScrollTop = body.scrollTop;
      }, { passive: true });
    }
    root.querySelector('[data-action="cancel"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.close();
    });
    root.querySelector('[data-action="save"]')?.addEventListener("click", event => this.#save(event));
    root.querySelectorAll('[data-action="move-source"]').forEach(button => {
      button.addEventListener("click", event => this.#moveSource(event));
    });
    root.querySelectorAll('[name^="hpMethod."]').forEach(input => {
      input.addEventListener("change", () => this.#refreshHpDefaults());
    });
    root.querySelector('[name="allowMulticlassing"]')?.addEventListener("change", () => this.#refreshMulticlassRequirements());
    this.#refreshHpDefaults();
    this.#refreshMulticlassRequirements();
  }

  async #save(event) {
    event.preventDefault();
    const form = this.element;
    const sourceRows = [...form.querySelectorAll("[data-source-id]")];
    const sources = sourceRows.map((row, priority) => ({
      id: row.dataset.sourceId,
      enabled: row.querySelector('input[type="checkbox"]')?.checked ?? false,
      priority
    }));

    const rollSetsValue = form.querySelector('[name="rollSets"]')?.value ?? "2";
    const rollSets = rollSetsValue === "unlimited" ? 0 : Number(rollSetsValue);
    const rawShopBonusGold = Number(form.querySelector('[name="shopBonusGold"]')?.value ?? 0);
    const shopBonusGold = Number.isFinite(rawShopBonusGold)
      ? Math.max(0, Math.trunc(rawShopBonusGold))
      : 0;

    const hpMethods = {
      roll: form.querySelector('[name="hpMethod.roll"]')?.checked ?? false,
      average: form.querySelector('[name="hpMethod.average"]')?.checked ?? false,
      maximum: form.querySelector('[name="hpMethod.maximum"]')?.checked ?? false
    };
    const enabledHpMethods = Object.entries(hpMethods).filter(([, enabled]) => enabled).map(([id]) => id);
    const requestedDefault = String(form.querySelector('[name="hpDefaultMethod"]')?.value ?? "average");
    const defaultMethod = enabledHpMethods.includes(requestedDefault) ? requestedDefault : enabledHpMethods[0];

    const settings = {
      promptOnCreate: form.querySelector('[name="promptOnCreate"]')?.checked ?? true,
      sources,
      abilityMethods: {
        pointBuy: form.querySelector('[name="pointBuy"]')?.checked ?? false,
        standardArray: form.querySelector('[name="standardArray"]')?.checked ?? false,
        roll: form.querySelector('[name="roll"]')?.checked ?? false,
        manual: form.querySelector('[name="manual"]')?.checked ?? false
      },
      rollSets,
      shopBonusGold,
      levelUpMode: String(form.querySelector('[name="levelUpMode"]')?.value ?? "milestone"),
      allowMulticlassing: form.querySelector('[name="allowMulticlassing"]')?.checked ?? false,
      enforceMulticlassRequirements: form.querySelector('[name="enforceMulticlassRequirements"]')?.checked ?? true,
      enableGrantEpicBoons: form.querySelector('[name="enableGrantEpicBoons"]')?.checked ?? false,
      chargeWizardScribingCosts: form.querySelector('[name="chargeWizardScribingCosts"]')?.checked ?? true,
      hitPointAdvancement: {
        methods: hpMethods,
        defaultMethod,
        minimumAverageOnRoll: form.querySelector('[name="minimumAverageOnRoll"]')?.checked ?? false,
        lockRoll: true
      }
    };

    if (!Object.values(settings.abilityMethods).some(Boolean)) {
      return ui.notifications.error("Enable at least one Ability Score method.");
    }
    if (!settings.sources.some(source => source.enabled)) {
      return ui.notifications.error("Enable at least one content source.");
    }
    if (!enabledHpMethods.length) {
      return ui.notifications.error("Enable at least one Hit Point advancement method.");
    }
    if (!['xp', 'milestone'].includes(settings.levelUpMode)) {
      return ui.notifications.error("Choose a valid Level Up mode.");
    }

    await game.settings.set(MODULE_ID, "settings", settings);
    ui.notifications.info("Character Builder settings saved.");
    this.close();
  }

  #refreshMulticlassRequirements() {
    const allow = this.element?.querySelector?.('[name="allowMulticlassing"]');
    const enforce = this.element?.querySelector?.('[name="enforceMulticlassRequirements"]');
    if (!allow || !enforce) return;
    enforce.disabled = !allow.checked;
    enforce.closest("label")?.classList.toggle("disabled", !allow.checked);
  }

  #refreshHpDefaults() {
    const select = this.element?.querySelector?.('[name="hpDefaultMethod"]');
    if (!select) return;
    for (const option of select.options) {
      const checkbox = this.element.querySelector(`[name="hpMethod.${option.value}"]`);
      option.disabled = !checkbox?.checked;
    }
    if (select.selectedOptions[0]?.disabled) {
      const first = [...select.options].find(option => !option.disabled);
      if (first) select.value = first.value;
    }
  }

  #moveSource(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const row = button.closest("[data-source-id]");
    if (!row) return;
    const direction = button.dataset.direction;
    const target = direction === "up" ? row.previousElementSibling : row.nextElementSibling;
    if (!target) return;
    if (direction === "up") row.parentElement.insertBefore(row, target);
    else row.parentElement.insertBefore(target, row);
  }
}
