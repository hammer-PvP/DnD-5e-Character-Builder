export const MODULE_ID = "dnd5e-supplier";
export const MODULE_VERSION = "0.0.1f";
export const CONFIGURATION_VERSION = 7;

export const RARITIES = [
  { value: "none", label: "DND5E_SUPPLIER.Rarity.none" },
  { value: "common", label: "DND5E_SUPPLIER.Rarity.common" },
  { value: "uncommon", label: "DND5E_SUPPLIER.Rarity.uncommon" },
  { value: "rare", label: "DND5E_SUPPLIER.Rarity.rare" },
  { value: "veryRare", label: "DND5E_SUPPLIER.Rarity.veryRare" },
  { value: "legendary", label: "DND5E_SUPPLIER.Rarity.legendary" },
  { value: "artifact", label: "DND5E_SUPPLIER.Rarity.artifact" }
];

export const SUPPLIER_THEMES = [
  {
    id: "alchemist",
    label: "DND5E_SUPPLIER.Theme.Alchemist",
    icon: "fa-solid fa-flask",
    secondaryIcon: "",
    color: "green"
  },
  {
    id: "blacksmith",
    label: "DND5E_SUPPLIER.Theme.Blacksmith",
    icon: "fa-solid fa-hammer",
    secondaryIcon: "fa-solid fa-cube",
    color: "iron"
  },
  {
    id: "general",
    label: "DND5E_SUPPLIER.Theme.General",
    icon: "fa-solid fa-basket-shopping",
    secondaryIcon: "",
    color: "leather"
  },
  {
    id: "jeweler",
    label: "DND5E_SUPPLIER.Theme.Jeweler",
    icon: "fa-solid fa-ring",
    secondaryIcon: "fa-solid fa-gem",
    color: "gold"
  },
  {
    id: "magic",
    label: "DND5E_SUPPLIER.Theme.Magic",
    icon: "fa-solid fa-wand-magic-sparkles",
    secondaryIcon: "",
    color: "arcane"
  },
  {
    id: "custom",
    label: "DND5E_SUPPLIER.Theme.Custom",
    icon: "fa-solid fa-store",
    secondaryIcon: "",
    color: "neutral"
  }
];

export const RULE_CATEGORIES = [
  { value: "weapon", label: "DND5E_SUPPLIER.Category.Weapons" },
  { value: "equipment", label: "DND5E_SUPPLIER.Category.Equipment" },
  { value: "consumable", label: "DND5E_SUPPLIER.Category.Consumables" },
  { value: "tool", label: "DND5E_SUPPLIER.Category.Tools" },
  { value: "loot", label: "DND5E_SUPPLIER.Category.Loot" },
  { value: "container", label: "DND5E_SUPPLIER.Category.Containers" },
  { value: "healingPotions", label: "DND5E_SUPPLIER.Category.HealingPotions" },
  { value: "spellScroll", label: "DND5E_SUPPLIER.Category.SpellScrolls" },
  { value: "exact", label: "DND5E_SUPPLIER.Category.ExactItem" }
];

export const CATALOG_CATEGORIES = RULE_CATEGORIES.filter(category => [
  "weapon", "equipment", "consumable", "tool", "loot", "container"
].includes(category.value));

export const ARMOR_SUBTYPE_KEYS = ["lightArmor", "mediumArmor", "heavyArmor", "shield"];

export const DEFAULT_PRICE_FALLBACKS = {
  none: 1,
  common: 50,
  uncommon: 200,
  rare: 2000,
  veryRare: 20000,
  legendary: 100000,
  artifact: 100000
};

export const DEFAULT_QUALITY_PRICE_ADDITIONS = {
  0: 0,
  1: 500,
  2: 5000,
  3: 50000
};

export const DEFAULT_LEVEL_BANDS = [
  { id: "band-1", min: 1, max: 4, rarities: ["none", "common"], maxSpellLevel: 2 },
  { id: "band-2", min: 5, max: 8, rarities: ["none", "common", "uncommon"], maxSpellLevel: 4 },
  { id: "band-3", min: 9, max: 12, rarities: ["none", "common", "uncommon", "rare"], maxSpellLevel: 6 },
  { id: "band-4", min: 13, max: 16, rarities: ["none", "common", "uncommon", "rare", "veryRare"], maxSpellLevel: 8 },
  { id: "band-5", min: 17, max: 20, rarities: ["none", "common", "uncommon", "rare", "veryRare", "legendary"], maxSpellLevel: 9 }
];

export const DEFAULT_ENCHANTMENT_BANDS = [
  { id: "quality-1", min: 1, max: 4, weights: { 0: 100, 1: 0, 2: 0, 3: 0 } },
  { id: "quality-2", min: 5, max: 8, weights: { 0: 70, 1: 30, 2: 0, 3: 0 } },
  { id: "quality-3", min: 9, max: 12, weights: { 0: 45, 1: 45, 2: 10, 3: 0 } },
  { id: "quality-4", min: 13, max: 16, weights: { 0: 20, 1: 45, 2: 30, 3: 5 } },
  { id: "quality-5", min: 17, max: 20, weights: { 0: 10, 1: 25, 2: 45, 3: 20 } }
];

function baseRule() {
  return {
    id: foundry.utils.randomID(),
    enabled: true,
    name: "",
    category: "",
    itemRef: "",
    itemLabel: "",
    itemRefs: [],
    subtypes: [],
    subtypeCategory: "",
    weaponCategories: [],
    weaponModes: [],
    armorCategories: [],
    magicalState: "any",
    rarityMode: "level",
    rarities: ["none", "common"],
    spellLevelMode: "level",
    spellLevels: [0, 1],
    qualityMode: "source",
    fixedBonus: 1,
    enchantedMinimumMode: "none",
    enchantedMinimum: 0,
    quantityMode: "fixed",
    quantity: 1,
    quantityMin: 1,
    quantityMax: 1,
    randomWeight: 1,
    coverageMode: "slots",
    allowDuplicates: true,
    countsTowardTotal: true,
    excludeRefs: [],
    excludeFamilies: []
  };
}

export function createDefaultCatalogRule() {
  return {
    ...baseRule(),
    name: "Mundane Catalog",
    category: "",
    quantityMode: "players",
    quantity: 1,
    magicalState: "mundane",
    rarityMode: "fixed",
    rarities: ["none"],
    qualityMode: "mundane",
    coverageMode: "all",
    allowDuplicates: false,
    countsTowardTotal: false
  };
}

export function createDefaultGuaranteedRule() {
  return {
    ...baseRule(),
    name: "Guaranteed Item",
    quantityMode: "fixed",
    quantity: 1,
    coverageMode: "slots",
    countsTowardTotal: false
  };
}

export function createDefaultRandomRule() {
  return {
    ...baseRule(),
    name: "Random Stock",
    quantityMode: "remainder",
    quantity: 1,
    randomWeight: 1,
    coverageMode: "slots",
    countsTowardTotal: false
  };
}

export const DEFAULT_PROFILE = {
  id: "alpha-alchemist",
  name: "Alchemist",
  theme: "alchemist",
  icon: "fa-solid fa-flask",
  customIcon: "fa-solid fa-store",
  description: "Potions, elixirs, oils, poisons, and other alchemical consumables.",
  sourceIds: [],
  allowedItemTypes: [],
  stockTotalMode: "perPlayer",
  stockTotal: 1,
  mundaneCatalogRules: [],
  guaranteedRules: [
    {
      ...createDefaultGuaranteedRule(),
      id: "alpha-healing-potion",
      name: "Healing Potions",
      category: "healingPotions",
      quantityMode: "players",
      quantity: 1,
      rarityMode: "level",
      qualityMode: "source",
      allowDuplicates: true
    }
  ],
  bannedItems: [],
  randomRules: [
    {
      ...createDefaultRandomRule(),
      id: "alpha-random-potions",
      name: "Random Alchemical Stock",
      category: "consumable",
      subtypes: ["potion"],
      quantityMode: "remainder",
      excludeFamilies: ["healingPotions"]
    }
  ]
};

export function createDefaultSettings() {
  return {
    version: CONFIGURATION_VERSION,
    sources: [],
    priceFallbacks: foundry.utils.deepClone(DEFAULT_PRICE_FALLBACKS),
    qualityPriceAdditions: foundry.utils.deepClone(DEFAULT_QUALITY_PRICE_ADDITIONS),
    levelBands: foundry.utils.deepClone(DEFAULT_LEVEL_BANDS),
    enchantmentBands: foundry.utils.deepClone(DEFAULT_ENCHANTMENT_BANDS),
    profiles: [foundry.utils.deepClone(DEFAULT_PROFILE)],
    folderNameTemplate: "{supplier} — {date} — {time}"
  };
}
