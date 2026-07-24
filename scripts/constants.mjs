export const MODULE_ID = "dnd5e-character-builder";
export const MODULE_VERSION = "0.9.8b";
export const MODULE_BUILD = "community-beta-098b-live-test-detail-corrections";
export const DRAFT_FOLDER_NAME = "Character Builder Drafts";

export const SOURCE_DEFINITIONS = {
  phb2024: {
    id: "phb2024",
    label: "PLAYER'S HANDBOOK 2024",
    packageId: "dnd-players-handbook",
    sourceBook: null,
    defaultEnabled: true,
    defaultPriority: 0
  },
  srd52: {
    id: "srd52",
    label: "SRD 5.2 MODERN",
    packageId: "dnd5e",
    sourceBook: "SRD 5.2",
    defaultEnabled: true,
    defaultPriority: 1
  },
  srd51: {
    id: "srd51",
    label: "SRD 5.1 LEGACY (UNSUPPORTED)",
    packageId: "dnd5e",
    sourceBook: "SRD 5.1",
    defaultEnabled: false,
    defaultPriority: 2
  }
};

export const ABILITIES = [
  { key: "str", label: "Strength" },
  { key: "dex", label: "Dexterity" },
  { key: "con", label: "Constitution" },
  { key: "int", label: "Intelligence" },
  { key: "wis", label: "Wisdom" },
  { key: "cha", label: "Charisma" }
];

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
export const CUSTOM_ARRAY_SLOT_COUNT = 6;
export const POINT_BUY_BUDGET = 27;
export const POINT_BUY_COSTS = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

export const CURRENCY_CP = Object.freeze({
  pp: 1000,
  gp: 100,
  ep: 50,
  sp: 10,
  cp: 1
});

/**
 * PHB 2024 spell access models. Each class is assigned to a reusable strategy rather than
 * receiving its own implementation. Third-party sources can be supported later through adapters.
 */
export const SPELL_ACCESS_MODELS = {
  fullList: new Set(["cleric", "druid", "paladin", "ranger"]),
  limited: new Set(["bard", "sorcerer", "warlock"]),
  spellbook: new Set(["wizard"])
};

/**
 * Primary abilities used by the 2024 multiclass prerequisite rule. An entry containing
 * multiple arrays means either group qualifies (Fighter: Strength OR Dexterity). A single
 * array containing multiple abilities means every listed ability is required.
 */
export const MULTICLASS_PRIMARY_ABILITIES = Object.freeze({
  barbarian: [["str"]],
  bard: [["cha"]],
  cleric: [["wis"]],
  druid: [["wis"]],
  fighter: [["str"], ["dex"]],
  monk: [["dex", "wis"]],
  paladin: [["str", "cha"]],
  ranger: [["dex", "wis"]],
  rogue: [["dex"]],
  sorcerer: [["cha"]],
  warlock: [["cha"]],
  wizard: [["int"]]
});

export const WIZARD_SCHOOLS = Object.freeze({
  abjuration: "abj",
  conjuration: "con",
  divination: "div",
  enchantment: "enc",
  evocation: "evo",
  illusion: "ill",
  necromancy: "nec",
  transmutation: "trs"
});

export function defaultSettings() {
  return {
    promptOnCreate: true,
    shopBonusGold: 0,
    sources: Object.values(SOURCE_DEFINITIONS).map(source => ({
      id: source.id,
      enabled: source.defaultEnabled,
      priority: source.defaultPriority
    })),
    abilityMethods: {
      pointBuy: true,
      standardArray: true,
      customArray: false,
      roll: true,
      manual: false
    },
    customArray: [15, 14, 13, 12, 10, 8],
    rollAbilityScores: {
      mode: "limited",
      limit: 2
    },
    // Legacy mirror retained so worlds upgrading from older settings remain readable.
    rollSets: 2,
    levelUpMode: "milestone",
    allowMulticlassing: true,
    enforceMulticlassRequirements: true,
    enableFeats: true,
    enableAbilityScoreImprovement: true,
    enableEpicBoons: true,
    enableGrantEpicBoons: false,
    allowSpellScrollScribing: true,
    chargeWizardScribingCosts: true,
    requireArcanaCheckForSpellScrollScribing: true,
    chargeScribingCostOnFailedCheck: true,
    hitPointAdvancement: {
      methods: {
        roll: true,
        average: true,
        maximum: true
      },
      defaultMethod: "average",
      minimumAverageOnRoll: true,
      lockRoll: true
    }
  };
}
