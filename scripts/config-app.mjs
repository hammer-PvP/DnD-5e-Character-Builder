import {
  ARMOR_SUBTYPE_KEYS,
  CATALOG_CATEGORIES,
  MODULE_ID,
  RARITIES,
  RULE_CATEGORIES,
  SUPPLIER_THEMES,
  createDefaultCatalogRule,
  createDefaultGuaranteedRule,
  createDefaultRandomRule
} from "./constants.mjs";
import {
  banKey,
  buildCatalog,
  clearCatalogCache,
  entriesForProfile,
  nativeSubtypeLabel,
  subtypeOptionsForCategory
} from "./catalog.mjs";
import { calculateRandomTarget, inspectRulePool } from "./generator.mjs";
import { SupplierItemPicker } from "./item-picker.mjs";
import { getConfiguration, saveConfiguration } from "./settings.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function newProfile() {
  const enabledSources = getConfiguration().sources.filter(source => source.enabled).map(source => source.id);
  return {
    id: foundry.utils.randomID(),
    name: game.i18n.localize("DND5E_SUPPLIER.Config.NewProfile"),
    theme: "general",
    icon: "fa-solid fa-basket-shopping",
    customIcon: "fa-solid fa-store",
    description: "",
    sourceIds: enabledSources,
    allowedItemTypes: [],
    stockTotalMode: "fixed",
    stockTotal: 10,
    mundaneCatalogRules: [],
    guaranteedRules: [],
    bannedItems: [],
    randomRules: []
  };
}

function optionRows(values, selected, labelGetter = value => value) {
  const chosen = new Set(selected ?? []);
  return values.map(value => {
    const raw = typeof value === "string" ? value : value.value;
    return { value: raw, label: labelGetter(value), checked: chosen.has(raw) };
  });
}

function quantityFlags(value) {
  return {
    quantityFixed: value === "fixed",
    quantityPlayers: value === "players",
    quantityHalfDown: value === "halfDown",
    quantityHalfUp: value === "halfUp",
    quantityRange: value === "range",
    quantityRemainder: value === "remainder"
  };
}

function rarityFlags(value) {
  return { rarityLevel: value === "level", rarityFixed: value === "fixed" };
}

function qualityFlags(value) {
  return {
    qualitySource: value === "source",
    qualityParty: value === "party",
    qualityMundane: value === "mundane",
    qualityFixed: value === "fixed"
  };
}

function minimumFlags(value) {
  return {
    minimumNone: value === "none",
    minimumFixed: value === "fixed",
    minimumPlayers: value === "players",
    minimumHalfDown: value === "halfDown",
    minimumHalfUp: value === "halfUp"
  };
}

function titleCase(value) {
  return String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function packageShortLabel(packageName) {
  const known = {
    dnd5e: "D&D5e Core",
    "dnd-players-handbook": "PHB 2024",
    "dnd-dungeon-masters-guide": "DMG 2024"
  };
  if (known[packageName]) return known[packageName];
  return game.modules.get(packageName)?.title
    ?? (packageName === game.system.id ? game.system.title : titleCase(packageName));
}

function sourceDisplayLabel(source) {
  return `${source.label} — ${packageShortLabel(source.packageName)}`;
}

function ruleSummary(rule, categoryLabel, kind) {
  if (!rule.category) return game.i18n.localize("DND5E_SUPPLIER.Config.ChooseCategory");
  const subtypeLabels = (rule.subtypes ?? []).map(nativeSubtypeLabel);
  const selection = subtypeLabels.length
    ? `${categoryLabel}: ${subtypeLabels.slice(0, 3).join(", ")}${subtypeLabels.length > 3 ? ` +${subtypeLabels.length - 3}` : ""}`
    : categoryLabel;
  if (kind === "random") return `${selection} • ${game.i18n.localize("DND5E_SUPPLIER.Config.WeightShort")} ${Math.max(0.1, Number(rule.randomWeight ?? 1))}`;
  const quantity = rule.quantityMode === "players"
    ? `${Number(rule.quantity ?? 1)} × ${game.i18n.localize("DND5E_SUPPLIER.Config.PlayersShort")}`
    : rule.quantityMode === "halfDown" || rule.quantityMode === "halfUp"
      ? game.i18n.localize("DND5E_SUPPLIER.Config.HalfPartyShort")
      : rule.quantityMode === "range"
        ? `${rule.quantityMin ?? 1}–${rule.quantityMax ?? 1}`
        : String(rule.quantity ?? 1);
  return `${selection} • ${quantity}`;
}

function themeIcon(themeId, customIcon) {
  if (themeId === "custom") return customIcon || "fa-solid fa-store";
  return SUPPLIER_THEMES.find(theme => theme.id === themeId)?.icon ?? "fa-solid fa-store";
}

function ruleList(profile, kind) {
  if (kind === "catalog") return profile?.mundaneCatalogRules;
  if (kind === "guaranteed") return profile?.guaranteedRules;
  return profile?.randomRules;
}

function supportsGeneratedQuality(rule) {
  if (rule.category === "weapon") return true;
  if (rule.category !== "equipment") return false;
  const subtypes = rule.subtypes ?? [];
  return subtypes.length > 0 && subtypes.every(subtype => ARMOR_SUBTYPE_KEYS.includes(subtype));
}

export class SupplierConfigApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dnd5e-supplier-configuration",
    classes: ["dnd5e-supplier", "dnd5e-supplier-config"],
    position: { width: 1160, height: 840 },
    window: {
      title: "DND5E_SUPPLIER.Config.Title",
      icon: "fa-solid fa-gears",
      resizable: true
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/config.hbs` }
  };

  constructor(options = {}) {
    super(options);
    this.draft = foundry.utils.deepClone(getConfiguration());
    this.section = "sources";
    this.selectedProfileId = this.draft.profiles?.[0]?.id ?? null;
    this.profileSection = "stock";
    this.validationLevel = 5;
    this.validationPlayers = 5;
    this.viewState = { scroll: {}, focus: null, openRules: [], knownRules: [], captured: false };
  }

  async _prepareContext() {
    const packs = game.packs
      .filter(pack => pack.documentName === "Item")
      .map(pack => ({
        id: pack.collection,
        label: pack.metadata.label,
        packageName: pack.metadata.packageName,
        displayLabel: sourceDisplayLabel({ label: pack.metadata.label, packageName: pack.metadata.packageName })
      }));

    const sourceMap = new Map((this.draft.sources ?? []).map(source => [source.id, source]));
    const sources = packs.map((pack, index) => {
      const saved = sourceMap.get(pack.id) ?? { id: pack.id, enabled: false, priority: 10000 + index };
      return { ...pack, ...saved };
    }).sort((a, b) => Number(a.priority) - Number(b.priority));

    this.draft.sources = sources.map((source, index) => ({ id: source.id, enabled: Boolean(source.enabled), priority: index }));

    const selectedIndex = Math.max(0, this.draft.profiles.findIndex(profile => profile.id === this.selectedProfileId));
    const selectedProfile = this.draft.profiles[selectedIndex] ?? null;
    const globallyEnabled = sources.filter(source => source.enabled);
    if (selectedProfile && !selectedProfile.sourceIds?.length) selectedProfile.sourceIds = globallyEnabled.map(source => source.id);

    let catalog = { entries: [], familyGroups: new Map(), grouped: new Map(), rawEntries: [] };
    let profileEntries = [];
    try {
      catalog = await buildCatalog({ configurationOverride: this.draft });
      profileEntries = selectedProfile ? entriesForProfile(catalog, selectedProfile, this.draft) : [];
    } catch (error) {
      console.warn(`${MODULE_ID} | Configuration pool preview unavailable`, error);
    }

    const mapRule = (rule, index, kind) => {
      const pathMap = { catalog: "mundaneCatalogRules", guaranteed: "guaranteedRules", random: "randomRules" };
      const path = `profiles.${selectedIndex}.${pathMap[kind]}.${index}`;
      const inspection = inspectRulePool({
        rule,
        catalog,
        profileEntries,
        configuration: this.draft,
        level: this.validationLevel
      });
      const categoryValues = kind === "catalog" ? CATALOG_CATEGORIES : RULE_CATEGORIES;
      const categoryOptions = categoryValues.map(category => ({
        ...category,
        localized: game.i18n.localize(category.label),
        selected: category.value === rule.category
      }));
      const subtypeValues = ["weapon", "equipment", "consumable", "tool", "loot", "container"].includes(rule.category)
        ? subtypeOptionsForCategory(profileEntries, rule.category)
        : [];
      const subtypeOptions = optionRows(subtypeValues, rule.subtypes, option => `${option.label} (${option.count})`);
      const generatedQualityAvailable = supportsGeneratedQuality(rule);
      const categoryLabel = categoryOptions.find(option => option.selected)?.localized ?? game.i18n.localize("DND5E_SUPPLIER.Config.ChooseCategory");
      const poolReason = inspection.reason ? game.i18n.localize(`DND5E_SUPPLIER.PoolReason.${inspection.reason}`) : "";
      const poolSummary = inspection.count
        ? game.i18n.format("DND5E_SUPPLIER.Config.PoolCount", { count: inspection.count })
        : game.i18n.format("DND5E_SUPPLIER.Config.PoolEmpty", { reason: poolReason || game.i18n.localize("DND5E_SUPPLIER.PoolReason.category") });

      return {
        ...rule,
        index,
        kind,
        path,
        isCatalog: kind === "catalog",
        isGuaranteed: kind === "guaranteed",
        isRandom: kind === "random",
        hasCategory: Boolean(rule.category),
        isWeapon: rule.category === "weapon",
        isEquipment: rule.category === "equipment",
        isConsumable: rule.category === "consumable",
        isTool: rule.category === "tool",
        isLoot: rule.category === "loot",
        isContainer: rule.category === "container",
        isHealingPotions: rule.category === "healingPotions",
        isSpellScroll: rule.category === "spellScroll",
        isExact: rule.category === "exact",
        showSubtypeFilters: subtypeOptions.length > 0,
        showQuantity: kind !== "random",
        showRandomWeight: kind === "random",
        showQuality: kind !== "catalog" && generatedQualityAvailable,
        showRarity: kind !== "catalog" && rule.category !== "exact",
        showMagicState: kind !== "catalog"
          && ["weapon", "equipment", "consumable", "tool", "loot", "container"].includes(rule.category)
          && (!generatedQualityAvailable || rule.qualityMode === "source"),
        generatedQualityAvailable,
        showCoverage: false,
        coverageSlots: rule.coverageMode !== "oneEach",
        coverageOneEach: rule.coverageMode === "oneEach",
        categoryOptions,
        categoryLabel,
        subtypeOptions,
        rarityOptions: optionRows(RARITIES, rule.rarities, rarity => game.i18n.localize(rarity.label)),
        spellLevelOptions: Array.from({ length: 10 }, (_, level) => ({ level, checked: (rule.spellLevels ?? []).map(Number).includes(level) })),
        ...quantityFlags(rule.quantityMode),
        ...rarityFlags(rule.rarityMode),
        ...qualityFlags(rule.qualityMode),
        ...minimumFlags(rule.enchantedMinimumMode),
        fixedBonus1: Number(rule.fixedBonus) === 1,
        fixedBonus2: Number(rule.fixedBonus) === 2,
        fixedBonus3: Number(rule.fixedBonus) === 3,
        spellLevelByParty: rule.spellLevelMode === "level",
        spellLevelFixed: rule.spellLevelMode === "fixed",
        magicalAny: rule.magicalState === "any",
        magicalMundane: rule.magicalState === "mundane",
        magicalMagical: rule.magicalState === "magical",
        itemLabel: rule.itemLabel || game.i18n.localize("DND5E_SUPPLIER.Config.NoItemSelected"),
        poolCount: inspection.count,
        poolValid: inspection.count > 0,
        poolSummary,
        poolNames: inspection.names,
        poolBuckets: (inspection.buckets ?? []).map(bucket => ({
          ...bucket,
          label: bucket.key === "all" ? game.i18n.localize("DND5E_SUPPLIER.Config.AllEligibleItems") : nativeSubtypeLabel(bucket.key)
        })),
        hasMultipleBuckets: (inspection.buckets ?? []).length > 1,
        poolReason,
        randomWeight: Math.max(0.1, Number(rule.randomWeight ?? 1)),
        summary: ruleSummary(rule, categoryLabel, kind)
      };
    };

    const stockSections = selectedProfile ? [
      {
        kind: "catalog",
        title: game.i18n.localize("DND5E_SUPPLIER.Config.MundaneCatalog"),
        hint: game.i18n.localize("DND5E_SUPPLIER.Config.MundaneCatalogHint"),
        icon: "fa-solid fa-basket-shopping",
        addLabel: game.i18n.localize("DND5E_SUPPLIER.Config.AddCatalogGroup"),
        rules: (selectedProfile.mundaneCatalogRules ?? []).map((rule, index) => mapRule(rule, index, "catalog"))
      },
      {
        kind: "guaranteed",
        title: game.i18n.localize("DND5E_SUPPLIER.Config.GuaranteedItems"),
        hint: game.i18n.localize("DND5E_SUPPLIER.Config.GuaranteedHumanHint"),
        icon: "fa-solid fa-shield-halved",
        addLabel: game.i18n.localize("DND5E_SUPPLIER.Config.AddGuaranteedType"),
        rules: (selectedProfile.guaranteedRules ?? []).map((rule, index) => mapRule(rule, index, "guaranteed"))
      },
      {
        kind: "random",
        title: game.i18n.localize("DND5E_SUPPLIER.Config.RandomItems"),
        hint: game.i18n.localize("DND5E_SUPPLIER.Config.RandomHumanHint"),
        icon: "fa-solid fa-dice",
        addLabel: game.i18n.localize("DND5E_SUPPLIER.Config.AddRandomType"),
        rules: (selectedProfile.randomRules ?? []).map((rule, index) => mapRule(rule, index, "random"))
      }
    ] : [];

    const levelBands = (this.draft.levelBands ?? []).map((band, index) => ({
      ...band,
      index,
      rarityOptions: optionRows(RARITIES, band.rarities, rarity => game.i18n.localize(rarity.label))
    }));
    const enchantmentBands = (this.draft.enchantmentBands ?? []).map((band, index) => ({
      ...band,
      index,
      weight0: Number(band.weights?.[0] ?? band.weights?.["0"] ?? 0),
      weight1: Number(band.weights?.[1] ?? band.weights?.["1"] ?? 0),
      weight2: Number(band.weights?.[2] ?? band.weights?.["2"] ?? 0),
      weight3: Number(band.weights?.[3] ?? band.weights?.["3"] ?? 0)
    }));

    const currentTheme = SUPPLIER_THEMES.find(theme => theme.id === selectedProfile?.theme) ?? SUPPLIER_THEMES.at(-1);
    return {
      section: this.section,
      isSources: this.section === "sources",
      isProfiles: this.section === "profiles",
      isProgression: this.section === "progression",
      isOutput: this.section === "output",
      profileStockTab: this.profileSection === "stock",
      profileBannedTab: this.profileSection === "banned",
      sources: sources.map((source, index) => ({
        ...source,
        displayLabel: source.displayLabel || sourceDisplayLabel(source),
        index,
        canMoveUp: index > 0,
        canMoveDown: index < sources.length - 1
      })),
      profiles: this.draft.profiles.map(profile => ({
        ...profile,
        icon: themeIcon(profile.theme, profile.customIcon),
        selected: profile.id === this.selectedProfileId,
        themeClass: `theme-${profile.theme || "custom"}`
      })),
      selectedProfile: selectedProfile ? {
        ...selectedProfile,
        icon: themeIcon(selectedProfile.theme, selectedProfile.customIcon),
        isCustomTheme: selectedProfile.theme === "custom",
        themeClass: `theme-${selectedProfile.theme || "custom"}`
      } : null,
      selectedProfileIndex: selectedIndex,
      currentTheme,
      themeOptions: SUPPLIER_THEMES.map(theme => ({
        ...theme,
        localized: game.i18n.localize(theme.label),
        selected: theme.id === selectedProfile?.theme,
        themeClass: `theme-${theme.id}`
      })),
      profileSourceOptions: globallyEnabled.map(source => ({ ...source, displayLabel: source.displayLabel || sourceDisplayLabel(source), checked: selectedProfile?.sourceIds?.includes(source.id) })),
      stockTotalFixed: selectedProfile?.stockTotalMode === "fixed",
      stockTotalPerPlayer: selectedProfile?.stockTotalMode !== "fixed",
      calculatedRandomTarget: selectedProfile ? calculateRandomTarget(selectedProfile, this.validationPlayers) : 0,
      activeCatalogRules: selectedProfile?.mundaneCatalogRules?.filter(rule => rule.enabled && rule.category).length ?? 0,
      activeGuaranteedRules: selectedProfile?.guaranteedRules?.filter(rule => rule.enabled && rule.category).length ?? 0,
      activeRandomRules: selectedProfile?.randomRules?.filter(rule => rule.enabled && rule.category).length ?? 0,
      stockSections,
      validationLevel: this.validationLevel,
      validationPlayers: this.validationPlayers,
      levelBands,
      enchantmentBands,
      rarities: RARITIES.map(rarity => ({ ...rarity, localized: game.i18n.localize(rarity.label), price: this.draft.priceFallbacks?.[rarity.value] ?? 1 })),
      qualityPrices: [1, 2, 3].map(bonus => ({ bonus, price: this.draft.qualityPriceAdditions?.[bonus] ?? 0 })),
      profileBannedItems: (selectedProfile?.bannedItems ?? []).map(item => {
        const equivalentCount = (catalog.rawEntries ?? []).filter(entry => {
          if (selectedProfile?.sourceIds?.length && !selectedProfile.sourceIds.includes(entry.packId)) return false;
          return banKey(entry) === item.key;
        }).length;
        return {
          ...item,
          scopeLabel: game.i18n.localize(item.allSources ? "DND5E_SUPPLIER.Config.AllEquivalentSources" : "DND5E_SUPPLIER.Config.OnlyThisSource"),
          sourceLabel: item.packLabel ? `${item.packLabel} — ${packageShortLabel(item.packageName)}` : game.i18n.localize("DND5E_SUPPLIER.Config.AllSources"),
          normalizedName: String(item.name ?? "").toLowerCase(),
          normalizedType: String(item.type ?? "").toLowerCase(),
          normalizedSource: String(item.packId ?? "").toLowerCase(),
          scopeValue: item.allSources ? "all" : "source",
          equivalentNote: item.allSources
            ? game.i18n.format("DND5E_SUPPLIER.Config.EquivalentVersionsBanned", { count: Math.max(1, equivalentCount) })
            : game.i18n.format("DND5E_SUPPLIER.Config.EquivalentVersionsRemain", { count: Math.max(0, equivalentCount - 1) })
        };
      }),
      bannedTypeOptions: [...new Set((selectedProfile?.bannedItems ?? []).map(item => item.type).filter(Boolean))].sort().map(value => ({ value, label: titleCase(value) })),
      bannedSourceOptions: [...new Map((selectedProfile?.bannedItems ?? []).filter(item => item.packId).map(item => [item.packId, `${item.packLabel} — ${packageShortLabel(item.packageName)}`])).entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
      profileBannedCount: selectedProfile?.bannedItems?.length ?? 0,
      folderNameTemplate: this.draft.folderNameTemplate
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root) return;

    root.querySelectorAll("[data-section]").forEach(button => {
      button.addEventListener("click", () => {
        this.#syncForm();
        this.section = button.dataset.section;
        this.#renderWithState({ resetContent: true });
      });
    });

    root.querySelectorAll("[data-profile-id]").forEach(button => {
      button.addEventListener("click", () => {
        this.#syncForm();
        this.selectedProfileId = button.dataset.profileId;
        this.profileSection = "stock";
        this.#renderWithState({ resetContent: true });
      });
    });

    root.querySelectorAll("[data-rerender]").forEach(input => {
      input.addEventListener("change", () => {
        this.#syncForm();
        this.#renderWithState();
      });
    });

    root.querySelectorAll("[data-theme-id]").forEach(button => {
      button.addEventListener("click", () => {
        this.#syncForm();
        const profile = this.#selectedProfile();
        if (!profile) return;
        profile.theme = button.dataset.themeId;
        profile.icon = themeIcon(profile.theme, profile.customIcon);
        this.#renderWithState();
      });
    });

    root.querySelector("[data-action='add-profile']")?.addEventListener("click", () => {
      this.#syncForm();
      const profile = newProfile();
      this.draft.profiles.push(profile);
      this.selectedProfileId = profile.id;
      this.section = "profiles";
      this.profileSection = "stock";
      this.#renderWithState({ resetContent: true });
    });

    root.querySelector("[data-action='delete-profile']")?.addEventListener("click", () => {
      this.#syncForm();
      if (this.draft.profiles.length <= 1) {
        ui.notifications.warn(game.i18n.localize("DND5E_SUPPLIER.Config.MustKeepProfile"));
        return;
      }
      const index = this.draft.profiles.findIndex(profile => profile.id === this.selectedProfileId);
      if (index >= 0) this.draft.profiles.splice(index, 1);
      this.selectedProfileId = this.draft.profiles[0]?.id ?? null;
      this.#renderWithState({ resetContent: true });
    });

    root.querySelectorAll("[data-action='add-rule']").forEach(button => {
      button.addEventListener("click", () => {
        this.#syncForm();
        const profile = this.#selectedProfile();
        if (!profile) return;
        if (button.dataset.kind === "catalog") profile.mundaneCatalogRules.push(createDefaultCatalogRule());
        else if (button.dataset.kind === "guaranteed") profile.guaranteedRules.push(createDefaultGuaranteedRule());
        else profile.randomRules.push(createDefaultRandomRule());
        this.#renderWithState();
      });
    });

    root.querySelectorAll("[data-action='remove-rule']").forEach(button => {
      button.addEventListener("click", () => {
        this.#syncForm();
        ruleList(this.#selectedProfile(), button.dataset.kind)?.splice(Number(button.dataset.index), 1);
        this.#renderWithState();
      });
    });

    root.querySelectorAll("[data-action='pick-exact']").forEach(button => {
      button.addEventListener("click", () => this.#openItemPicker(button));
    });

    root.querySelectorAll("[data-action='move-source']").forEach(button => {
      button.addEventListener("click", () => {
        this.#syncForm();
        const index = Number(button.dataset.index);
        const target = index + Number(button.dataset.direction);
        if (target < 0 || target >= this.draft.sources.length) return;
        [this.draft.sources[index], this.draft.sources[target]] = [this.draft.sources[target], this.draft.sources[index]];
        this.draft.sources.forEach((source, sourceIndex) => { source.priority = sourceIndex; });
        this.#renderWithState();
      });
    });

    root.querySelector("[data-action='add-band']")?.addEventListener("click", () => {
      this.#syncForm();
      this.draft.levelBands.push({ id: foundry.utils.randomID(), min: 1, max: 20, rarities: ["none", "common"], maxSpellLevel: 1 });
      this.#renderWithState();
    });
    root.querySelectorAll("[data-action='remove-band']").forEach(button => button.addEventListener("click", () => {
      this.#syncForm();
      this.draft.levelBands.splice(Number(button.dataset.index), 1);
      this.#renderWithState();
    }));
    root.querySelectorAll("[data-profile-section]").forEach(button => {
      button.addEventListener("click", () => {
        this.#syncForm();
        this.profileSection = button.dataset.profileSection;
        this.#renderWithState({ resetContent: true });
      });
    });

    root.querySelectorAll("[data-source-toggle]").forEach(input => {
      input.addEventListener("change", () => {
        const index = Number(input.dataset.sourceToggle);
        if (!this.draft.sources[index]) return;
        this.draft.sources[index].enabled = input.checked;
      });
    });

    root.querySelector("[data-action='add-banned-items']")?.addEventListener("click", () => {
      this.#syncForm();
      const profile = this.#selectedProfile();
      if (!profile) return;
      new SupplierItemPicker({
        profile: foundry.utils.deepClone(profile),
        multiple: true,
        includeBanned: true,
        rawSourceDocuments: true,
        banMode: true,
        title: game.i18n.localize("DND5E_SUPPLIER.Config.BannedPickerTitle"),
        configuration: foundry.utils.deepClone(this.draft),
        onSelect: selected => {
          profile.bannedItems ??= [];
          for (const item of selected) {
            if (item.allSources) {
              profile.bannedItems = profile.bannedItems.filter(existing => existing.key !== item.key);
              profile.bannedItems.push({ ...item, id: foundry.utils.randomID(), allSources: true });
              continue;
            }
            if (profile.bannedItems.some(existing => existing.allSources && existing.key === item.key)) continue;
            if (profile.bannedItems.some(existing => existing.uuid === item.uuid)) continue;
            profile.bannedItems.push({ ...item, id: foundry.utils.randomID(), allSources: false });
          }
          this.#renderWithState();
        }
      }).render(true);
    });

    root.querySelectorAll("[data-action='remove-banned-item']").forEach(button => {
      button.addEventListener("click", () => {
        this.#syncForm();
        const profile = this.#selectedProfile();
        profile.bannedItems = (profile?.bannedItems ?? []).filter(item => item.id !== button.dataset.banId);
        this.#renderWithState();
      });
    });

    root.querySelector("[data-action='remove-selected-bans']")?.addEventListener("click", () => {
      this.#syncForm();
      const profile = this.#selectedProfile();
      const selectedIds = new Set([...root.querySelectorAll("[data-ban-select]:checked")].map(input => input.value));
      if (!selectedIds.size || !profile) return;
      profile.bannedItems = (profile.bannedItems ?? []).filter(item => !selectedIds.has(item.id));
      this.#renderWithState();
    });

    const banSearch = root.querySelector("[data-ban-filter='search']");
    const banType = root.querySelector("[data-ban-filter='type']");
    const banSource = root.querySelector("[data-ban-filter='source']");
    const banScope = root.querySelector("[data-ban-filter='scope']");
    const applyBanFilters = () => {
      const query = String(banSearch?.value ?? "").trim().toLowerCase();
      const type = String(banType?.value ?? "").toLowerCase();
      const source = String(banSource?.value ?? "").toLowerCase();
      const scope = String(banScope?.value ?? "");
      let visible = 0;
      for (const row of root.querySelectorAll("[data-banned-row]")) {
        row.hidden = Boolean(
          (query && !row.dataset.name.includes(query))
          || (type && row.dataset.type !== type)
          || (source && row.dataset.source !== source)
          || (scope && row.dataset.scope !== scope)
        );
        if (!row.hidden) visible += 1;
      }
      const counter = root.querySelector("[data-visible-bans]");
      if (counter) counter.textContent = String(visible);
    };
    banSearch?.addEventListener("input", applyBanFilters);
    banType?.addEventListener("change", applyBanFilters);
    banSource?.addEventListener("change", applyBanFilters);
    banScope?.addEventListener("change", applyBanFilters);
    applyBanFilters();

    root.querySelector("[data-action='add-quality-band']")?.addEventListener("click", () => {
      this.#syncForm();
      this.draft.enchantmentBands.push({ id: foundry.utils.randomID(), min: 1, max: 20, weights: { 0: 100, 1: 0, 2: 0, 3: 0 } });
      this.#renderWithState();
    });
    root.querySelectorAll("[data-action='remove-quality-band']").forEach(button => button.addEventListener("click", () => {
      this.#syncForm();
      this.draft.enchantmentBands.splice(Number(button.dataset.index), 1);
      this.#renderWithState();
    }));

    root.querySelector("[data-action='save']")?.addEventListener("click", async () => {
      this.#syncForm();
      this.draft.sources.forEach((source, index) => { source.priority = index; });
      await saveConfiguration(this.draft);
      clearCatalogCache();
      ui.notifications.info(game.i18n.localize("DND5E_SUPPLIER.Config.Saved"));
      this.#renderWithState();
    });

    this.#restoreViewState();
  }

  #captureViewState() {
    const root = this.element;
    if (!root) return;
    const scroll = {};
    for (const element of root.querySelectorAll("[data-scroll-key]")) {
      scroll[element.dataset.scrollKey] = { top: element.scrollTop, left: element.scrollLeft };
    }

    let focus = null;
    const active = root.ownerDocument?.activeElement;
    if (active && root.contains(active)) {
      focus = {
        path: active.dataset?.path ?? "",
        arrayPath: active.dataset?.arrayPath ?? "",
        value: active.value ?? "",
        name: active.name ?? "",
        selectionStart: Number.isInteger(active.selectionStart) ? active.selectionStart : null,
        selectionEnd: Number.isInteger(active.selectionEnd) ? active.selectionEnd : null
      };
    }
    const ruleDetails = [...root.querySelectorAll("details[data-rule-id]")];
    const openRules = ruleDetails.filter(details => details.open).map(details => details.dataset.ruleId);
    const knownRules = ruleDetails.map(details => details.dataset.ruleId);
    this.viewState = { scroll, focus, openRules, knownRules, captured: true };
  }

  #restoreViewState() {
    const state = this.viewState;
    if (!state) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const root = this.element;
      if (!root) return;
      for (const [key, position] of Object.entries(state.scroll ?? {})) {
        const element = root.querySelector(`[data-scroll-key="${CSS.escape(key)}"]`);
        if (!element) continue;
        element.scrollTop = Number(position.top ?? 0);
        element.scrollLeft = Number(position.left ?? 0);
      }

      if (state.captured) {
        const openRules = new Set(state.openRules ?? []);
        const knownRules = new Set(state.knownRules ?? []);
        for (const details of root.querySelectorAll("details[data-rule-id]")) {
          if (knownRules.has(details.dataset.ruleId)) details.open = openRules.has(details.dataset.ruleId);
        }
      }

      const focus = state.focus;
      if (!focus) return;
      let element = null;
      if (focus.path) element = root.querySelector(`[data-path="${CSS.escape(focus.path)}"]`);
      else if (focus.arrayPath) {
        element = [...root.querySelectorAll(`[data-array-path="${CSS.escape(focus.arrayPath)}"]`)]
          .find(candidate => String(candidate.value) === String(focus.value));
      } else if (focus.name) element = root.querySelector(`[name="${CSS.escape(focus.name)}"]`);
      if (!element) return;
      element.focus({ preventScroll: true });
      if (focus.selectionStart !== null && typeof element.setSelectionRange === "function") {
        element.setSelectionRange(focus.selectionStart, focus.selectionEnd ?? focus.selectionStart);
      }
    }));
  }

  #renderWithState({ resetContent = false } = {}) {
    this.#captureViewState();
    if (resetContent) {
      this.viewState.scroll ??= {};
      this.viewState.scroll["config-content"] = { top: 0, left: 0 };
      this.viewState.focus = null;
      this.viewState.openRules = [];
      this.viewState.knownRules = [];
      this.viewState.captured = false;
    }
    this.render();
  }

  #selectedProfile() {
    return this.draft.profiles.find(profile => profile.id === this.selectedProfileId) ?? this.draft.profiles[0];
  }

  #openItemPicker(button) {
    this.#syncForm();
    const rule = ruleList(this.#selectedProfile(), button.dataset.kind)?.[Number(button.dataset.index)];
    if (!rule) return;
    new SupplierItemPicker({
      profile: foundry.utils.deepClone(this.#selectedProfile()),
      configuration: foundry.utils.deepClone(this.draft),
      onSelect: selected => {
        rule.itemRef = selected.uuid;
        rule.itemLabel = selected.name;
        rule.itemRefs = [selected];
        this.#renderWithState();
      }
    }).render(true);
  }

  #normalizeRuleDependencies() {
    const profile = this.#selectedProfile();
    if (!profile) return;
    profile.icon = themeIcon(profile.theme, profile.customIcon);
    for (const kind of ["catalog", "guaranteed", "random"]) {
      for (const rule of ruleList(profile, kind) ?? []) {
        rule.weaponCategories = [];
        rule.weaponModes = [];
        rule.armorCategories = [];
        if (rule.subtypeCategory !== rule.category) {
          rule.subtypes = [];
          rule.subtypeCategory = rule.category;
        }
        if (!["weapon", "equipment", "consumable", "tool", "loot", "container"].includes(rule.category)) rule.subtypes = [];
        if (rule.category !== "exact") {
          rule.itemRef = "";
          rule.itemLabel = "";
          rule.itemRefs = [];
        }
        if (rule.category !== "spellScroll") rule.spellLevels = [0, 1];
        if (kind === "catalog") {
          rule.countsTowardTotal = false;
          rule.magicalState = "mundane";
          rule.qualityMode = "mundane";
          rule.rarityMode = "fixed";
          rule.rarities = ["none"];
          rule.coverageMode = "all";
        }
        if (kind === "guaranteed") {
          rule.countsTowardTotal = false;
          rule.coverageMode = "slots";
        }
        if (kind === "random") {
          rule.countsTowardTotal = false;
          rule.quantityMode = "remainder";
          rule.randomWeight = Math.max(0.1, Number(rule.randomWeight ?? 1));
          rule.coverageMode = "slots";
        }
        if (!supportsGeneratedQuality(rule)) {
          rule.qualityMode = "source";
          rule.enchantedMinimumMode = "none";
          rule.enchantedMinimum = 0;
        } else if (["party", "mundane", "fixed"].includes(rule.qualityMode)) {
          rule.magicalState = "mundane";
        }
        if (rule.category === "healingPotions") {
          rule.allowDuplicates = true;
          rule.coverageMode = "slots";
        }
      }
    }
  }

  #syncForm() {
    const root = this.element;
    if (!root) return;

    root.querySelectorAll("[data-path]").forEach(input => {
      let value;
      if (input.type === "checkbox") value = input.checked;
      else if (input.type === "number") value = Number(input.value);
      else value = input.value;
      foundry.utils.setProperty(this.draft, input.dataset.path, value);
    });

    const arrayPaths = new Set([...root.querySelectorAll("[data-array-path]")].map(input => input.dataset.arrayPath));
    for (const path of arrayPaths) {
      const values = [...root.querySelectorAll(`[data-array-path="${CSS.escape(path)}"]`)]
        .filter(input => input.checked)
        .map(input => input.type === "number" ? Number(input.value) : input.value);
      foundry.utils.setProperty(this.draft, path, values);
    }

    for (const band of this.draft.enchantmentBands ?? []) {
      band.weights ??= { 0: 0, 1: 0, 2: 0, 3: 0 };
      for (const bonus of [0, 1, 2, 3]) band.weights[bonus] = Number(band.weights[bonus] ?? 0);
    }
    this.validationLevel = Math.min(20, Math.max(1, Number(root.querySelector("[name='validationLevel']")?.value ?? this.validationLevel)));
    this.validationPlayers = Math.max(1, Number(root.querySelector("[name='validationPlayers']")?.value ?? this.validationPlayers));
    this.#normalizeRuleDependencies();
  }
}
