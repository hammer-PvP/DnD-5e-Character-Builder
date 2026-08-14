export const MODULE_ID = "dnd5e-character-builder";
export const MODULE_VERSION = "0.9.9r";
export const MODULE_BUILD = "community-beta-099r-advancement-and-validator-stabilization";
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
    label: "SRD 5.1 LEGACY",
    packageId: "dnd5e",
    sourceBook: "SRD 5.1",
    defaultEnabled: false,
    defaultPriority: 2
  }
};


export const RULES_MODES = Object.freeze({
  modern2024: {
    id: "modern2024",
    label: "Modern D&D (2024 / SRD 5.2)",
    subclassLevelFloor: 3
  },
  legacy2014: {
    id: "legacy2014",
    label: "D&D 5th Edition (2014 / SRD 5.1)",
    subclassLevelFloor: null
  }
});

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


export const RULES_ASSISTANCE_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "greatWeaponFighting",
    ruleId: "great-weapon-fighting",
    label: "Great Weapon Fighting",
    description: "Treats eligible weapon damage die results of 1 or 2 as 3.",
    tag: "Damage"
  }),
  Object.freeze({
    key: "thrownWeaponFighting",
    ruleId: "thrown-weapon-fighting",
    label: "Thrown Weapon Fighting",
    description: "Adds the fighting style damage bonus to eligible thrown weapon attacks.",
    tag: "Damage"
  }),
  Object.freeze({
    key: "clericPotentSpellcasting",
    ruleId: "cleric-potent-spellcasting",
    label: "Cleric — Blessed Strikes: Potent Spellcasting",
    description: "Adds Wisdom to eligible Cleric cantrip damage rolls.",
    tag: "Damage"
  }),
  Object.freeze({
    key: "druidPotentSpellcasting",
    ruleId: "druid-potent-spellcasting",
    label: "Druid — Elemental Fury: Potent Spellcasting",
    description: "Adds Wisdom to eligible Druid cantrip damage rolls.",
    tag: "Damage"
  }),
  Object.freeze({
    key: "empoweredEvocation",
    ruleId: "empowered-evocation",
    label: "Wizard — Empowered Evocation",
    description: "Adds Intelligence to one eligible damage roll of a Wizard Evocation spell.",
    tag: "Damage"
  }),
  Object.freeze({
    key: "bardicInspirationPostFailure",
    ruleId: "bardic-inspiration-post-failure",
    label: "Bard — Bardic Inspiration",
    description: "Offers the recipient the source Bard's current inspiration die after every eligible D20 Test without revealing hidden success or failure; consumes the effect only when used.",
    tag: "Post-Roll"
  }),
  Object.freeze({
    key: "mageArmorEffectApplication",
    ruleId: "mage-armor-effect-application",
    label: "Mage Armor Effect Application",
    description: "Applies and maintains the native Mage Armor effect on eligible targets.",
    tag: "Effect"
  }),
  Object.freeze({
    key: "agonizingBlastNativeBinding",
    ruleId: "agonizing-blast-native-binding",
    label: "Agonizing Blast Native Binding",
    description: "Maintains the native enchantment on the cantrip selected by the Invocation.",
    tag: "Native Binding"
  }),
  Object.freeze({
    key: "layOnHandsRemovePoison",
    ruleId: "lay-on-hands-remove-poison",
    label: "Paladin — Lay on Hands: Remove Poison",
    description: "After the native Remove Poison activity spends its Lay on Hands cost, removes the native Poisoned status from the selected target.",
    tag: "Effect"
  }),
  Object.freeze({
    key: "contextualRollModifiers",
    ruleId: "contextual-roll-modifiers",
    label: "Contextual Roll Modifiers",
    description: "Applies ephemeral roll modifiers declared by active effects on the roller or target. Blade Ward and save-gated debuffs use the same generic runtime; future class, spell, and item effects can reuse it.",
    tag: "Roll Context"
  }),
  Object.freeze({
    key: "sourceTargetDamageRiders",
    ruleId: "source-target-damage-riders",
    label: "Source-to-Target Damage Riders",
    description: "Adds native damage rider Activities when the attacker's own mark or curse is active on the selected target. Hunter's Mark and Hex use this generic relationship.",
    tag: "Damage Context"
  }),
  Object.freeze({
    key: "cuttingWordsReaction",
    ruleId: "cutting-words-reaction",
    label: "Bard — Cutting Words",
    description: "Supports manual Cutting Words against the latest eligible hostile D20 roll or final pending damage to a friendly target, without automatic result-revealing prompts.",
    tag: "Reaction"
  }),
  Object.freeze({
    key: "concentrationEffectLifecycle",
    ruleId: "concentration-effect-lifecycle",
    label: "Concentration & Dependent Effects",
    description: "Keeps Concentration checks attached to the concentrating Actor, resolves them after post-roll bonuses, ends native concentration on final failure, and lets D&D5e remove only bound dependent effects.",
    tag: "Effect Lifecycle"
  })
]);

export function defaultRulesAssistanceRules() {
  return Object.fromEntries(RULES_ASSISTANCE_DEFINITIONS.map(rule => [rule.key, true]));
}

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
    rulesMode: "modern2024",
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
    halfLongRestRecoveryOnShortRest: false,
    shortRestHomebrewCooldownMinutes: 5,
    gmManagedRestAccess: false,
    playerSheetIntegrity: false,
    assistWithDiceAutomation: false,
    rulesAssistance: {
      rules: defaultRulesAssistanceRules()
    },
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
