import { MODULE_ID } from "./constants.mjs";
import { confirmCreation } from "./dialogs.mjs";
import { createWorldFolder, generateStock } from "./generator.mjs";
import { getConfiguration } from "./settings.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SupplierApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dnd5e-supplier-generator",
    classes: ["dnd5e-supplier", "dnd5e-supplier-generator"],
    position: { width: 1040, height: 760 },
    window: {
      title: "DND5E_SUPPLIER.Title",
      icon: "fa-solid fa-store",
      resizable: true
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/supplier.hbs` }
  };

  constructor(options = {}) {
    super(options);
    const configuration = getConfiguration();
    this.profileId = configuration.profiles?.[0]?.id ?? null;
    this.level = 1;
    this.players = 4;
    this.preview = [];
    this.warnings = [];
    this.target = 0;
    this.catalogUnits = 0;
    this.guaranteedUnits = 0;
    this.randomUnits = 0;
    this.busy = false;
  }

  async _prepareContext() {
    const configuration = getConfiguration();
    const profile = configuration.profiles.find(entry => entry.id === this.profileId) ?? configuration.profiles[0];
    if (profile && profile.id !== this.profileId) this.profileId = profile.id;

    const totalUnits = this.preview.reduce((total, line) => total + Number(line.quantity || 0), 0);
    const totalCopper = this.preview.reduce((total, line) => {
      return total + this.#toCopper(line.price?.value, line.price?.denomination) * Number(line.quantity || 0);
    }, 0);

    return {
      profiles: configuration.profiles.map(entry => ({ ...entry, themeClass: `theme-${entry.theme || "custom"}`, selected: entry.id === this.profileId })),
      profile: profile ? { ...profile, themeClass: `theme-${profile.theme || "custom"}` } : null,
      level: this.level,
      players: this.players,
      target: this.target,
      catalogUnits: this.catalogUnits,
      guaranteedUnits: this.guaranteedUnits,
      randomUnits: this.randomUnits,
      preview: this.preview.map((line, index) => ({
        ...line,
        index,
        rarityLabel: this.#rarityLabel(line.rarity),
        qualityLabel: line.enhancement > 0 ? `+${line.enhancement}` : "",
        spellLevelLabel: Number.isFinite(Number(line.spellLevel))
          ? game.i18n.format("DND5E_SUPPLIER.SpellLevel", { level: line.spellLevel })
          : "",
        priceOriginLabel: game.i18n.localize(`DND5E_SUPPLIER.PriceOrigin.${line.price.origin}`),
        unitPrice: `${line.price.value} ${String(line.price.denomination || "gp").toUpperCase()}`,
        linePrice: `${line.price.value * line.quantity} ${String(line.price.denomination || "gp").toUpperCase()}`
      })),
      warnings: this.warnings,
      hasPreview: this.preview.length > 0,
      totalUnits,
      distinctItems: this.preview.length,
      totalValue: this.#formatCopper(totalCopper),
      busy: this.busy
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root) return;

    root.querySelectorAll("[data-profile-id]").forEach(button => {
      button.addEventListener("click", () => {
        if (this.busy) return;
        this.#syncInputs();
        this.profileId = button.dataset.profileId;
        this.preview = [];
        this.warnings = [];
        this.target = 0;
        this.catalogUnits = 0;
        this.guaranteedUnits = 0;
        this.randomUnits = 0;
        this.render();
      });
    });

    root.querySelector("[data-action='generate']")?.addEventListener("click", () => this.#generate());
    root.querySelector("[data-action='confirm']")?.addEventListener("click", () => this.#confirm());
    root.querySelector("[data-action='clear']")?.addEventListener("click", () => {
      if (this.busy) return;
      this.preview = [];
      this.warnings = [];
      this.target = 0;
      this.catalogUnits = 0;
      this.guaranteedUnits = 0;
      this.randomUnits = 0;
      this.render();
    });

    root.querySelectorAll("[data-action='remove-line']").forEach(button => {
      button.addEventListener("click", () => {
        if (this.busy) return;
        this.preview.splice(Number(button.dataset.index), 1);
        this.render();
      });
    });

    root.querySelectorAll("[data-quantity-index]").forEach(input => {
      input.addEventListener("change", () => {
        const line = this.preview[Number(input.dataset.quantityIndex)];
        if (!line) return;
        line.quantity = Math.max(1, Number(input.value || 1));
        this.render();
      });
    });
  }

  #syncInputs() {
    const root = this.element;
    if (!root) return;
    this.level = Math.min(20, Math.max(1, Number(root.querySelector("[name='partyLevel']")?.value ?? this.level)));
    this.players = Math.max(1, Number(root.querySelector("[name='partySize']")?.value ?? this.players));
  }

  async #generate() {
    if (this.busy) return;
    this.#syncInputs();
    const configuration = getConfiguration();
    const profile = configuration.profiles.find(entry => entry.id === this.profileId);
    if (!profile) return;

    this.busy = true;
    this.render();
    try {
      const result = await generateStock({ profile, level: this.level, players: this.players });
      this.preview = result.preview;
      this.warnings = result.warnings;
      this.target = result.randomTarget ?? result.target ?? 0;
      this.catalogUnits = result.catalogUnits ?? 0;
      this.guaranteedUnits = result.guaranteedUnits ?? 0;
      this.randomUnits = result.randomUnits ?? 0;
      if (!this.preview.length) ui.notifications.warn(game.i18n.localize("DND5E_SUPPLIER.Errors.NothingGenerated"));
    } catch (error) {
      console.error(`${MODULE_ID} | Generation failed`, error);
      ui.notifications.error(error.message);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async #confirm() {
    if (this.busy || !this.preview.length) return;
    this.#syncInputs();
    const configuration = getConfiguration();
    const profile = configuration.profiles.find(entry => entry.id === this.profileId);
    if (!profile) return;

    const confirmed = await confirmCreation({ profile, level: this.level, players: this.players, preview: this.preview });
    if (!confirmed) return;

    this.busy = true;
    this.render();
    try {
      const { folder } = await createWorldFolder({ profile, level: this.level, players: this.players, preview: this.preview });
      ui.notifications.info(game.i18n.format("DND5E_SUPPLIER.Success.Created", { name: folder.name }));
      this.preview = [];
      this.warnings = [];
      this.target = 0;
      this.catalogUnits = 0;
      this.guaranteedUnits = 0;
      this.randomUnits = 0;
      ui.items?.render(true);
    } catch (error) {
      console.error(`${MODULE_ID} | Commit failed`, error);
      ui.notifications.error(error.message);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  #toCopper(value, denomination) {
    const multipliers = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
    return Math.max(0, Number(value || 0)) * (multipliers[String(denomination || "gp").toLowerCase()] ?? 100);
  }

  #formatCopper(totalCopper) {
    let remaining = Math.max(0, Math.round(totalCopper));
    const parts = [];
    const denominations = [["PP", 1000], ["GP", 100], ["SP", 10], ["CP", 1]];
    for (const [label, value] of denominations) {
      const amount = Math.floor(remaining / value);
      if (amount > 0) parts.push(`${amount} ${label}`);
      remaining %= value;
    }
    return parts.join(" ") || "0 GP";
  }

  #rarityLabel(rarity) {
    return game.i18n.localize(`DND5E_SUPPLIER.Rarity.${rarity || "none"}`);
  }
}
