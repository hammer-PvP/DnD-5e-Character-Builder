import { MODULE_ID, SOURCE_DEFINITIONS, CUSTOM_ARRAY_SLOT_COUNT, defaultSettings } from "../constants.mjs";

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
    const storedSettings = game.settings.get(MODULE_ID, "settings") ?? {};
    const settings = foundry.utils.mergeObject(defaultSettings(), storedSettings, {
      inplace: false
    });
    const legacyRollSets = Number(storedSettings.rollSets ?? settings.rollSets ?? 2);
    const configuredRollMode = String(storedSettings.rollAbilityScores?.mode ?? "");
    const rollMode = ["single", "limited", "unlimited"].includes(configuredRollMode)
      ? configuredRollMode
      : legacyRollSets === 0 ? "unlimited" : legacyRollSets === 1 ? "single" : "limited";
    const rollLimit = rollMode === "single" ? 1 : Math.max(1, Math.trunc(Number(
      settings.rollAbilityScores?.limit ?? (legacyRollSets > 0 ? legacyRollSets : 2)
    ) || 2));
    settings.rollAbilityScores = { mode: rollMode, limit: rollLimit };
    settings.customArray = Array.from({ length: CUSTOM_ARRAY_SLOT_COUNT }, (_, index) => {
      const value = Number(settings.customArray?.[index] ?? [15, 14, 13, 12, 10, 8][index]);
      return Number.isInteger(value) ? Math.min(20, Math.max(1, value)) : [15, 14, 13, 12, 10, 8][index];
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
    root.querySelector('[name="requireArcanaCheckForSpellScrollScribing"]')?.addEventListener("change", () => this.#refreshScribeSettings());
    root.querySelector('[name="customArray"]')?.addEventListener("change", () => this.#refreshCustomArraySettings());
    root.querySelector('[name="rollMode"]')?.addEventListener("change", () => this.#refreshRollSettings());
    root.querySelector('[name="enableEpicBoons"]')?.addEventListener("change", () => this.#refreshEpicBoonSettings());
    this.#refreshHpDefaults();
    this.#refreshMulticlassRequirements();
    this.#refreshScribeSettings();
    this.#refreshCustomArraySettings();
    this.#refreshRollSettings();
    this.#refreshEpicBoonSettings();
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

    const rollMode = String(form.querySelector('[name="rollMode"]')?.value ?? "limited");
    const rawRollLimit = Number(form.querySelector('[name="rollLimit"]')?.value ?? 2);
    const rollLimit = Math.max(1, Math.trunc(Number.isFinite(rawRollLimit) ? rawRollLimit : 2));
    const rollSets = rollMode === "unlimited" ? 0 : rollMode === "single" ? 1 : rollLimit;
    const customArray = Array.from({ length: CUSTOM_ARRAY_SLOT_COUNT }, (_, index) =>
      Number(form.querySelector(`[name="customArray.${index}"]`)?.value)
    );
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
        customArray: form.querySelector('[name="customArray"]')?.checked ?? false,
        roll: form.querySelector('[name="roll"]')?.checked ?? false,
        manual: form.querySelector('[name="manual"]')?.checked ?? false
      },
      customArray,
      rollAbilityScores: { mode: rollMode, limit: rollLimit },
      rollSets,
      shopBonusGold,
      levelUpMode: String(form.querySelector('[name="levelUpMode"]')?.value ?? "milestone"),
      allowMulticlassing: form.querySelector('[name="allowMulticlassing"]')?.checked ?? false,
      enforceMulticlassRequirements: form.querySelector('[name="enforceMulticlassRequirements"]')?.checked ?? true,
      enableFeats: form.querySelector('[name="enableFeats"]')?.checked ?? true,
      enableAbilityScoreImprovement: form.querySelector('[name="enableAbilityScoreImprovement"]')?.checked ?? true,
      enableEpicBoons: form.querySelector('[name="enableEpicBoons"]')?.checked ?? true,
      enableGrantEpicBoons: (form.querySelector('[name="enableEpicBoons"]')?.checked ?? true)
        && (form.querySelector('[name="enableGrantEpicBoons"]')?.checked ?? false),
      allowSpellScrollScribing: form.querySelector('[name="allowSpellScrollScribing"]')?.checked ?? true,
      chargeWizardScribingCosts: form.querySelector('[name="chargeWizardScribingCosts"]')?.checked ?? true,
      requireArcanaCheckForSpellScrollScribing: form.querySelector('[name="requireArcanaCheckForSpellScrollScribing"]')?.checked ?? true,
      chargeScribingCostOnFailedCheck: form.querySelector('[name="chargeScribingCostOnFailedCheck"]')?.checked ?? true,
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
    if (settings.abilityMethods.customArray
      && customArray.some(value => !Number.isInteger(value) || value < 1 || value > 20)) {
      return ui.notifications.error("Every Custom Array slot must be a whole number from 1 to 20.");
    }
    if (!["single", "limited", "unlimited"].includes(rollMode)) {
      return ui.notifications.error("Choose a valid Ability Score roll mode.");
    }
    if (rollMode === "limited" && (!Number.isInteger(rawRollLimit) || rawRollLimit < 1)) {
      return ui.notifications.error("Limited Rolls requires a positive whole-number set limit.");
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

  #refreshCustomArraySettings() {
    const enabled = this.element?.querySelector?.('[name="customArray"]')?.checked ?? false;
    this.element?.querySelectorAll?.('[name^="customArray."]').forEach(input => {
      input.disabled = !enabled;
      input.closest("label")?.classList.toggle("disabled", !enabled);
    });
  }

  #refreshRollSettings() {
    const mode = String(this.element?.querySelector?.('[name="rollMode"]')?.value ?? "limited");
    const limit = this.element?.querySelector?.('[name="rollLimit"]');
    if (!limit) return;
    const limited = mode === "limited";
    limit.disabled = !limited;
    limit.closest("label")?.classList.toggle("disabled", !limited);
  }

  #refreshEpicBoonSettings() {
    const enabled = this.element?.querySelector?.('[name="enableEpicBoons"]')?.checked ?? true;
    const grant = this.element?.querySelector?.('[name="enableGrantEpicBoons"]');
    if (!grant) return;
    grant.disabled = !enabled;
    grant.closest("label")?.classList.toggle("disabled", !enabled);
  }

  #refreshMulticlassRequirements() {
    const allow = this.element?.querySelector?.('[name="allowMulticlassing"]');
    const enforce = this.element?.querySelector?.('[name="enforceMulticlassRequirements"]');
    if (!allow || !enforce) return;
    enforce.disabled = !allow.checked;
    enforce.closest("label")?.classList.toggle("disabled", !allow.checked);
  }

  #refreshScribeSettings() {
    const requireCheck = this.element?.querySelector?.('[name="requireArcanaCheckForSpellScrollScribing"]');
    const chargeFailure = this.element?.querySelector?.('[name="chargeScribingCostOnFailedCheck"]');
    if (!requireCheck || !chargeFailure) return;
    chargeFailure.disabled = !requireCheck.checked;
    chargeFailure.closest("label")?.classList.toggle("disabled", !requireCheck.checked);
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
