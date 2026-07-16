import { MODULE_ID, ABILITIES } from "../constants.mjs";

export const CUSTOM_BACKGROUND_UUID = "CharacterBuilder.CustomBackground";

const ADVANCEMENT_IDS = {
  ability: "cbCustomAbility1",
  skills: "cbCustomSkills01",
  tool: "cbCustomTool0001",
  feat: "cbCustomFeat0001",
  languages: "cbCustomLang0001"
};

export class CustomBackgroundService {
  static option(registry) {
    return {
      id: "custom-background",
      uuid: CUSTOM_BACKGROUND_UUID,
      name: "Custom Background",
      img: this.icon,
      type: "background",
      identifier: "custom-background",
      sourceId: "custom",
      sourceLabel: "CUSTOM",
      sourceRank: -1,
      search: "custom background",
      system: { identifier: "custom-background" },
      custom: true
    };
  }

  static get icon() {
    return game.modules.get("dnd-players-handbook")?.active
      ? "systems/dnd5e/ui/inspiration.webp"
      : `modules/${MODULE_ID}/assets/custom-background.svg`;
  }

  static async document(registry) {
    const data = this.data(registry);
    return new Item.implementation(data, { temporary: true });
  }

  static data(registry) {
    const originFeats = registry.optionsByType("feat")
      .flatMap(group => group.items)
      .filter(option => option.system?.type?.subtype === "origin")
      .map(option => ({ uuid: option.uuid }));

    const fixed = Object.fromEntries(ABILITIES.map(ability => [ability.key, 0]));
    return {
      name: "Custom Background",
      type: "background",
      img: this.icon,
      system: {
        description: {
          value: [
            "<p>This generic Background exchanges a normal equipment package for complete freedom when choosing its Ability Scores, Origin Feat, skills, and tool proficiency.</p>",
            "<p><strong>Ability Scores:</strong> Any three-point distribution using +2/+1 or +1/+1/+1.</p>",
            "<p><strong>Origin Feat:</strong> Choose one Origin Feat from enabled content sources.</p>",
            "<p><strong>Skill Proficiencies:</strong> Choose two different skills.</p>",
            "<p><strong>Tool Proficiency:</strong> Choose one tool proficiency.</p>",
            "<p><strong>Equipment:</strong> 1 GP and no equipment package.</p>"
          ].join(""),
          chat: ""
        },
        source: { custom: "Character Builder", rules: "2024", revision: 1 },
        identifier: "custom-background",
        advancement: {
          [ADVANCEMENT_IDS.ability]: {
            _id: ADVANCEMENT_IDS.ability,
            type: "AbilityScoreImprovement",
            configuration: {
              cap: 2,
              fixed,
              locked: [],
              points: 3,
              recommendation: null
            },
            value: { type: "asi", assignments: {} },
            level: 0,
            title: "Background Ability Score Improvement",
            hint: "Increase one Ability by 2 and a different Ability by 1, or increase three different Abilities by 1.",
            flags: {}
          },
          [ADVANCEMENT_IDS.skills]: {
            _id: ADVANCEMENT_IDS.skills,
            type: "Trait",
            configuration: {
              mode: "default",
              allowReplacements: false,
              grants: [],
              choices: [{ count: 2, pool: ["skills:*"] }]
            },
            value: { chosen: [] },
            level: 0,
            title: "Skill Proficiencies",
            hint: "Choose two different skills.",
            flags: {}
          },
          [ADVANCEMENT_IDS.tool]: {
            _id: ADVANCEMENT_IDS.tool,
            type: "Trait",
            configuration: {
              mode: "default",
              allowReplacements: false,
              grants: [],
              choices: [{ count: 1, pool: ["tool:*"] }]
            },
            value: { chosen: [] },
            level: 0,
            title: "Tool Proficiency",
            hint: "Choose one tool proficiency.",
            flags: {}
          },
          [ADVANCEMENT_IDS.feat]: {
            _id: ADVANCEMENT_IDS.feat,
            type: "ItemChoice",
            configuration: {
              choices: { "0": { count: 1, replacement: false } },
              allowDrops: false,
              type: "feat",
              pool: originFeats,
              spell: null,
              restriction: { type: "feat", subtype: "origin", list: [] }
            },
            value: { added: {}, replaced: {} },
            level: 0,
            title: "Origin Feat",
            hint: "Choose one Origin Feat from enabled content sources.",
            flags: {}
          },
          [ADVANCEMENT_IDS.languages]: {
            _id: ADVANCEMENT_IDS.languages,
            type: "Trait",
            configuration: {
              mode: "default",
              allowReplacements: false,
              grants: ["languages:standard:common"],
              choices: [{ count: 2, pool: ["languages:standard:*"] }]
            },
            value: { chosen: ["languages:standard:common"] },
            level: 0,
            title: "Choose Languages",
            hint: "Your character knows Common plus two Standard Languages.",
            flags: {}
          }
        },
        startingEquipment: [{
          type: "currency",
          count: 1,
          key: "gp",
          requiresProficiency: false,
          _id: "cbCustomGold0001",
          group: null,
          sort: 100000
        }],
        wealth: ""
      },
      effects: [],
      flags: {
        [MODULE_ID]: { customBackground: true }
      }
    };
  }

  static isCustom(uuid) {
    return uuid === CUSTOM_BACKGROUND_UUID;
  }
}
