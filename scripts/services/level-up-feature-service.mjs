import { MODULE_ID, SOURCE_DEFINITIONS } from "../constants.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";
import { SourceRegistry } from "./source-registry.mjs";
import { FeatureSpellOwnershipService } from "./feature-spell-ownership-service.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";

const LAND_SPELLS = Object.freeze({
  arid: {
    3: ["Compendium.dnd-players-handbook.spells.Item.phbsplBlur000000", "Compendium.dnd-players-handbook.spells.Item.phbsplBurningHan", "Compendium.dnd-players-handbook.spells.Item.phbsplFireBolt00"],
    5: ["Compendium.dnd-players-handbook.spells.Item.phbsplFireball00"],
    7: ["Compendium.dnd-players-handbook.spells.Item.phbsplBlight0000"],
    9: ["Compendium.dnd-players-handbook.spells.Item.phbsplWallofSton"]
  },
  polar: {
    3: ["Compendium.dnd-players-handbook.spells.Item.phbsplFogCloud00", "Compendium.dnd-players-handbook.spells.Item.phbsplHoldPerson", "Compendium.dnd-players-handbook.spells.Item.phbsplRayofFrost"],
    5: ["Compendium.dnd-players-handbook.spells.Item.phbsplSleetStorm"],
    7: ["Compendium.dnd-players-handbook.spells.Item.phbsplIceStorm00"],
    9: ["Compendium.dnd-players-handbook.spells.Item.phbsplConeofCold"]
  },
  temperate: {
    3: ["Compendium.dnd-players-handbook.spells.Item.phbsplMistyStep0", "Compendium.dnd-players-handbook.spells.Item.phbsplShockingGr", "Compendium.dnd-players-handbook.spells.Item.phbsplSleep00000"],
    5: ["Compendium.dnd-players-handbook.spells.Item.phbsplLightningB"],
    7: ["Compendium.dnd-players-handbook.spells.Item.phbsplFreedomofM"],
    9: ["Compendium.dnd-players-handbook.spells.Item.phbsplTreeStride"]
  },
  tropical: {
    3: ["Compendium.dnd-players-handbook.spells.Item.phbsplAcidSplash", "Compendium.dnd-players-handbook.spells.Item.phbsplRayofSickn", "Compendium.dnd-players-handbook.spells.Item.phbsplWeb0000000"],
    5: ["Compendium.dnd-players-handbook.spells.Item.phbsplStinkingCl"],
    7: ["Compendium.dnd-players-handbook.spells.Item.phbsplPolymorph0"],
    9: ["Compendium.dnd-players-handbook.spells.Item.phbsplInsectPlag"]
  }
});

const LAND_RESISTANCES = Object.freeze({
  arid: "fire",
  polar: "cold",
  temperate: "lightning",
  tropical: "poison"
});

/**
 * Module-managed Level Up handlers for source features whose complete choice is
 * described in rules text rather than represented by a native Advancement.
 * Runtime triggers are deliberately excluded from this service.
 */
export class LevelUpFeatureService {
  static async buildContext(draft, cls, registry, {
    oldClassLevel,
    newClassLevel,
    maximumSpellLevel,
    pendingSpellOptions = []
  }) {
    const state = LevelUpDraftManager.getState(draft);
    const saved = state.additionalChoices?.features ?? {};
    const identifier = cls.system?.identifier;
    const spellSections = [];
    const targetSpellSections = [];
    const replacementSections = [];
    const optionSections = [];
    let wildShape = this.#emptyWildShape();
    let land = this.#emptyLand();

    if (identifier === "bard") {
      const discoveries = this.#feature(draft, "magical-discoveries");
      if (discoveries && oldClassLevel < 6 && newClassLevel >= 6) {
        const pool = await this.#spellListUnion(["cleric", "druid", "wizard"], registry);
        spellSections.push(this.#spellSection({
          id: "magical-discoveries",
          title: "Magical Discoveries",
          note: "Choose two cantrips or leveled spells from the Cleric, Druid, or Wizard lists. Leveled spells must be available to this Bard level. These spells are always prepared and do not count against normal Bard prepared spells.",
          count: 2,
          pool: pool.filter(option => Number(option.system?.level ?? 0) <= maximumSpellLevel),
          selected: saved.spells?.["magical-discoveries"] ?? [],
          featureItemId: discoveries.id,
          category: "magical-discoveries",
          alwaysPrepared: true,
          sourceItem: "subclass:lore"
        }, registry));
      } else if (discoveries && oldClassLevel >= 6) {
        const pool = await this.#spellListUnion(["cleric", "druid", "wizard"], registry);
        replacementSections.push(this.#featureSpellReplacement({
          id: "magical-discoveries",
          title: "Optional Magical Discoveries Replacement",
          note: "Replace at most one active Magical Discoveries spell with another eligible option.",
          draft,
          pool: pool.filter(option => Number(option.system?.level ?? 0) <= maximumSpellLevel),
          category: "magical-discoveries",
          featureItemId: discoveries.id,
          selected: saved.replacements?.["magical-discoveries"] ?? null
        }));
      }
    }

    if (["paladin", "ranger"].includes(identifier) && oldClassLevel > 0) {
      const config = identifier === "paladin"
        ? { feature: "blessed-warrior", list: "cleric", title: "Optional Blessed Warrior Cantrip Replacement", ability: "cha" }
        : { feature: "druidic-warrior", list: "druid", title: "Optional Druidic Warrior Cantrip Replacement", ability: "wis" };
      const feature = this.#feature(draft, config.feature);
      if (feature) {
        const pool = (await this.#classSpellPool(config.list, registry))
          .filter(option => Number(option.system?.level ?? 0) === 0);
        replacementSections.push(this.#featureSpellReplacement({
          id: config.feature,
          title: config.title,
          note: `Replace at most one cantrip granted by ${feature.name}.`,
          draft,
          pool,
          category: config.feature,
          featureItemId: feature.id,
          selected: saved.replacements?.[config.feature] ?? null,
          alwaysPrepared: true,
          sourceItem: `class:${identifier}`,
          ability: config.ability,
          exactSpellLevel: 0
        }));
      }
    }

    if (identifier === "warlock") {
      const arcanumLevel = this.#mysticArcanumLevel(newClassLevel, oldClassLevel);
      const arcanumFeature = this.#feature(draft, "mystic-arcanum");
      if (arcanumLevel && arcanumFeature) {
        const pool = await this.#classSpellPool("warlock", registry);
        spellSections.push(this.#spellSection({
          id: `mystic-arcanum-${arcanumLevel}`,
          title: `Mystic Arcanum — Spell Level ${arcanumLevel}`,
          note: `Choose exactly one level ${arcanumLevel} Warlock spell. It is separate from Pact Magic and is cast once per Long Rest without a Pact Slot.`,
          count: 1,
          pool: pool.filter(option => Number(option.system?.level ?? 0) === arcanumLevel),
          selected: saved.spells?.[`mystic-arcanum-${arcanumLevel}`] ?? [],
          featureItemId: arcanumFeature.id,
          category: "mystic-arcanum",
          alwaysPrepared: true,
          exactSpellLevel: arcanumLevel,
          special: "mystic-arcanum",
          sourceItem: "class:warlock"
        }, registry));
      } else if (arcanumFeature && oldClassLevel >= 11) {
        const pool = await this.#classSpellPool("warlock", registry);
        replacementSections.push(this.#featureSpellReplacement({
          id: "mystic-arcanum",
          title: "Optional Mystic Arcanum Replacement",
          note: "Replace at most one Mystic Arcanum. The new spell must have the same spell level as the selected Arcanum.",
          draft,
          pool: pool.filter(option => Number(option.system?.level ?? 0) >= 6),
          category: "mystic-arcanum",
          featureItemId: arcanumFeature.id,
          selected: saved.replacements?.["mystic-arcanum"] ?? null,
          sameLevel: true
        }));
      }
    }

    if (identifier === "wizard") {
      const mastery = this.#feature(draft, "spell-mastery");
      if (mastery && oldClassLevel < 18 && newClassLevel >= 18) {
        targetSpellSections.push(this.#targetSpellSection({
          id: "spell-mastery-1",
          title: "Spell Mastery — Level 1 Spell",
          note: "Choose a level 1 Wizard spell in this spellbook with a casting time of an Action.",
          count: 1,
          items: await this.#wizardSpellbookTargets(draft, cls, { level: 1, actionOnly: true, pendingSpellOptions }),
          selected: saved.targets?.["spell-mastery-1"] ?? [],
          featureItemId: mastery.id,
          category: "spell-mastery",
          special: "spell-mastery",
          exactSpellLevel: 1
        }));
        targetSpellSections.push(this.#targetSpellSection({
          id: "spell-mastery-2",
          title: "Spell Mastery — Level 2 Spell",
          note: "Choose a level 2 Wizard spell in this spellbook with a casting time of an Action.",
          count: 1,
          items: await this.#wizardSpellbookTargets(draft, cls, { level: 2, actionOnly: true, pendingSpellOptions }),
          selected: saved.targets?.["spell-mastery-2"] ?? [],
          featureItemId: mastery.id,
          category: "spell-mastery",
          special: "spell-mastery",
          exactSpellLevel: 2
        }));
      }

      const signature = this.#feature(draft, "signature-spells");
      if (signature && oldClassLevel < 20 && newClassLevel >= 20) {
        targetSpellSections.push(this.#targetSpellSection({
          id: "signature-spells",
          title: "Signature Spells",
          note: "Choose two different level 3 Wizard spells in this spellbook. Native Signature preparation and first/second use trackers are preserved.",
          count: 2,
          items: await this.#wizardSpellbookTargets(draft, cls, { level: 3, pendingSpellOptions }),
          selected: saved.targets?.["signature-spells"] ?? [],
          featureItemId: signature.id,
          category: "signature-spell",
          special: "signature-spells",
          exactSpellLevel: 3
        }));
      }
    }

    if (identifier === "druid") {
      const magician = this.primalOrderMagicianFeature(draft);
      const magicianNeedsCantrip = magician && !this.#hasExactFeatureSpellOwner(draft, {
        category: "primal-order-magician",
        classItemId: cls.id,
        featureItemId: magician.id
      });
      if (magician && ((oldClassLevel < 1 && newClassLevel >= 1) || magicianNeedsCantrip)) {
        const pool = (await this.#classSpellPool("druid", registry))
          .filter(option => Number(option.system?.level ?? 0) === 0);
        spellSections.push(this.#spellSection({
          id: "primal-order-magician",
          title: magicianNeedsCantrip && oldClassLevel >= 1
            ? "Repair Missing Primal Order: Magician Cantrip"
            : "Primal Order: Magician",
          note: magicianNeedsCantrip && oldClassLevel >= 1
            ? "This Actor owns Primal Order: Magician but has no exact Magician-owned cantrip. Choose one Druid cantrip to repair that missing acquisition without changing other spell ownership."
            : "Choose one additional Druid cantrip granted by Primal Order: Magician. This does not consume a normal Druid cantrip choice.",
          count: 1,
          pool,
          selected: saved.spells?.["primal-order-magician"] ?? [],
          featureItemId: magician.id,
          category: "primal-order-magician",
          prepared: SpellPreparationPolicyService.ALWAYS_PREPARED,
          alwaysPrepared: true,
          sourceItem: "class:druid",
          repair: magicianNeedsCantrip && oldClassLevel >= 1
        }, registry));
      }

      wildShape = await this.#wildShapeContext(draft, cls, registry, {
        oldClassLevel, newClassLevel,
        selected: saved.wildShapeForms ?? []
      });
      land = await this.#landContext(draft, cls, registry, {
        oldClassLevel, newClassLevel,
        selected: saved.land ?? ""
      });
      // Focused existing-Actor reconciliation is applied only to the Level Up
      // Draft. The live Actor remains untouched until the protected commit.
      if (land.current) await this.#activateNaturesWard(draft, land.current);
    }

    if (identifier === "ranger") {
      const huntersPrey = this.#feature(draft, "hunters-prey");
      if (huntersPrey && (oldClassLevel < 3 && newClassLevel >= 3 || !huntersPrey.getFlag(MODULE_ID, "managedFeatureChoice"))) {
        optionSections.push(this.#optionSection({
          id: "hunters-prey",
          title: "Hunter's Prey",
          note: "Choose the active Hunter's Prey option. Rest-based changes belong to Runtime Character Management.",
          featureItemId: huntersPrey.id,
          selected: saved.options?.["hunters-prey"] ?? huntersPrey.getFlag(MODULE_ID, "managedFeatureChoice")?.value ?? "",
          options: [
            { value: "colossus-slayer", label: "Colossus Slayer" },
            { value: "horde-breaker", label: "Horde Breaker" }
          ]
        }));
      }
      const defensive = this.#feature(draft, "defensive-tactics");
      if (defensive && (oldClassLevel < 7 && newClassLevel >= 7 || !defensive.getFlag(MODULE_ID, "managedFeatureChoice"))) {
        optionSections.push(this.#optionSection({
          id: "defensive-tactics",
          title: "Defensive Tactics",
          note: "Choose the active Defensive Tactics option. Rest-based changes belong to Runtime Character Management.",
          featureItemId: defensive.id,
          selected: saved.options?.["defensive-tactics"] ?? defensive.getFlag(MODULE_ID, "managedFeatureChoice")?.value ?? "",
          options: [
            { value: "escape-the-horde", label: "Escape the Horde" },
            { value: "multiattack-defense", label: "Multiattack Defense" }
          ]
        }));
      }
    }

    const required = spellSections.reduce((sum, section) => sum + section.count, 0)
      + targetSpellSections.reduce((sum, section) => sum + section.count, 0)
      + optionSections.length
      + Number(wildShape.count ?? 0)
      + (land.required ? 1 : 0);
    const selected = spellSections.reduce((sum, section) => sum + section.selectedCount, 0)
      + targetSpellSections.reduce((sum, section) => sum + section.selectedCount, 0)
      + optionSections.filter(section => section.selected).length
      + Number(wildShape.selectedCount ?? 0)
      + (land.required && land.selected ? 1 : 0);
    const replacementsComplete = replacementSections.every(section =>
      Boolean(section.selectedRemoveId) === Boolean(section.selectedAddValue)
    );
    const complete = selected === required && replacementsComplete;
    const hasChoices = required > 0 || replacementSections.some(section => section.available);
    const hasAutomatic = Boolean(land.hasAutomatic);

    return {
      spellSections,
      targetSpellSections,
      replacementSections,
      optionSections,
      wildShape,
      land,
      required,
      selected,
      complete,
      hasChoices,
      hasAutomatic,
      noWork: !hasChoices && !hasAutomatic
    };
  }

  static async apply(draft, cls, registry, formData, context, state) {
    const featureChoices = { spells: {}, targets: {}, replacements: {}, options: {}, wildShapeForms: [], land: "" };
    const createdItemIds = [];
    let deleted = 0;

    for (const section of context.spellSections) {
      const values = [...new Set(formData.getAll(`levelUp.featureSpell.${section.id}`).map(String))];
      this.#validateExact(values, section.count, section.options, section.title);
      if (section.category === "primal-order-magician") {
        const normalDruidCantrips = new Set(formData.getAll("levelUp.cantrips").map(String));
        const duplicate = values.find(identifier => normalDruidCantrips.has(identifier));
        if (duplicate) {
          throw new Error("Primal Order: Magician must grant a different acquisition from the normal Druid cantrip selected during this Level Up.");
        }
      }
      featureChoices.spells[section.id] = values;
      for (const identifier of values) {
        const option = section.options.find(row => row.identifier === identifier);
        const item = await this.#ensureFeatureSpell(draft, cls, section, option, state);
        if (item.created) createdItemIds.push(item.spell.id);
      }
    }

    for (const section of context.targetSpellSections) {
      const values = [...new Set(formData.getAll(`levelUp.featureTarget.${section.id}`).map(String))];
      this.#validateExact(values, section.count, section.items, section.title, "id");
      featureChoices.targets[section.id] = values;
      const chosen = values.map(id => {
        if (!String(id).startsWith("pending:")) return draft.items.get(id);
        const identifier = String(id).slice("pending:".length);
        return draft.items.find(item => item.type === "spell" && item.system?.identifier === identifier);
      });
      if (chosen.some(item => !item)) throw new Error(`${section.title} contains a spell that no longer exists after Level Up spell creation.`);
      for (let index = 0; index < chosen.length; index++) {
        await this.#applyTargetSpell(draft, cls, section, chosen[index], state, index);
      }
    }

    for (const section of context.replacementSections) {
      if (!section.available) continue;
      const removeId = String(formData.get(`levelUp.featureReplace.${section.id}.remove`) ?? "");
      const addValue = String(formData.get(`levelUp.featureReplace.${section.id}.add`) ?? "");
      if (Boolean(removeId) !== Boolean(addValue)) {
        throw new Error(`Choose both sides of ${section.title}, or leave both blank.`);
      }
      if (!removeId) continue;
      const existing = section.existing.find(row => row.id === removeId);
      const option = section.options.find(row => row.identifier === addValue);
      if (!existing || !option) throw new Error(`${section.title} contains an ineligible spell.`);
      if (section.sameLevel && Number(existing.level) !== Number(option.system?.level ?? 0)) {
        throw new Error(`${section.title} requires a replacement spell of level ${existing.level}.`);
      }
      const oldSpell = draft.items.get(removeId);
      if (!oldSpell) throw new Error(`The spell selected for ${section.title} no longer exists.`);
      const remaining = await FeatureSpellOwnershipService.removeOwner(oldSpell, owner =>
        owner.category === section.category && (!section.featureItemId || owner.featureItemId === section.featureItemId)
      );
      if (!remaining.length && oldSpell.getFlag(MODULE_ID, "levelUpSpell")?.category === section.category) {
        await draft.deleteEmbeddedDocuments("Item", [oldSpell.id]);
        deleted++;
      }
      const replacementSection = {
        ...section,
        id: `${section.id}-replacement`,
        alwaysPrepared: section.alwaysPrepared ?? true,
        special: section.category === "mystic-arcanum" ? "mystic-arcanum" : null,
        exactSpellLevel: section.exactSpellLevel ?? Number(option.system?.level ?? 0),
        sourceItem: section.sourceItem
          ?? (section.category === "mystic-arcanum" ? "class:warlock" : "subclass:lore"),
        ability: section.ability ?? null
      };
      const result = await this.#ensureFeatureSpell(draft, cls, replacementSection, option, state);
      if (result.created) createdItemIds.push(result.spell.id);
      featureChoices.replacements[section.id] = { removeId, addIdentifier: addValue };
    }

    for (const section of context.optionSections) {
      const value = String(formData.get(`levelUp.featureOption.${section.id}`) ?? "");
      if (!section.options.some(option => option.value === value)) throw new Error(`Choose ${section.title}.`);
      const feature = draft.items.get(section.featureItemId);
      if (!feature) throw new Error(`${section.title} feature Item is missing.`);
      const selected = section.options.find(option => option.value === value);
      await feature.setFlag(MODULE_ID, "managedFeatureChoice", {
        value,
        label: selected.label,
        classIdentifier: cls.system?.identifier,
        classItemId: cls.id,
        featureItemId: feature.id,
        transactionId: state.transactionId,
        acquiredAtCharacterLevel: state.targetCharacterLevel,
        acquiredAtClassLevel: state.targetClassLevel
      });
      featureChoices.options[section.id] = value;
    }

    if (context.wildShape.count > 0) {
      const values = [...new Set(formData.getAll("levelUp.wildShapeForms").map(String))];
      this.#validateExact(values, context.wildShape.count, context.wildShape.options, "Known Wild Shape Forms", "uuid");
      const feature = draft.items.get(context.wildShape.featureItemId);
      if (!feature) throw new Error("Wild Shape feature Item is missing.");
      const invalidUuids = new Set(context.wildShape.invalidUuids ?? []);
      const existing = (feature.getFlag(MODULE_ID, "knownWildShapeForms") ?? [])
        .filter(row => !invalidUuids.has(row.uuid));
      const additions = values.map(uuid => context.wildShape.options.find(option => option.uuid === uuid));
      await feature.setFlag(MODULE_ID, "knownWildShapeForms", [...existing, ...additions].map(row => ({
        uuid: row.uuid, name: row.name, img: row.img, cr: row.cr, fly: row.fly,
        sourceLabel: row.sourceLabel
      })));
      featureChoices.wildShapeForms = values;
      if (context.wildShape.repairCount) {
        featureChoices.wildShapeRepair = {
          removed: context.wildShape.invalidForms,
          replacements: additions.map(row => ({ uuid: row.uuid, name: row.name, cr: row.cr }))
        };
      }
    }

    const selectedLand = context.land.required
      ? String(formData.get("levelUp.land") ?? "")
      : context.land.current;
    if (context.land.required && !Object.keys(LAND_SPELLS).includes(selectedLand)) {
      throw new Error("Choose a Circle of the Land environment.");
    }
    if (context.land.featureItemId && selectedLand) {
      const feature = draft.items.get(context.land.featureItemId);
      await feature?.setFlag(MODULE_ID, "circleLand", {
        land: selectedLand,
        label: this.#humanize(selectedLand),
        classIdentifier: "druid",
        classItemId: cls.id,
        featureItemId: feature.id,
        transactionId: state.transactionId,
        configuredAtDruidLevel: state.targetClassLevel
      });
      const landCreated = await this.#applyLandSpells(draft, cls, registry, feature, selectedLand, state);
      createdItemIds.push(...landCreated);
      await this.#activateNaturesWard(draft, selectedLand);
      featureChoices.land = selectedLand;
    }

    return { createdItemIds: [...new Set(createdItemIds)], deleted, featureChoices };
  }

  static magicalSecretsActive(draft, newClassLevel) {
    return Number(newClassLevel) >= 10 || Boolean(this.#feature(draft, "magical-secrets"));
  }

  static primalOrderMagicianFeature(draft) {
    return draft.items.find(item => item.type === "feat" && (
      item.system?.identifier === "magician"
      || this.#slug(item.name) === "magician"
      || String(item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? "").endsWith(".Item.phbPrimalOrderMa")
    ));
  }

  static hasPrimalOrderMagician(draft) {
    return Boolean(this.primalOrderMagicianFeature(draft));
  }

  static async magicalSecretsPool(registry) {
    return this.#spellListUnion(["bard", "cleric", "druid", "wizard"], registry);
  }

  static async bardBasePool(registry) {
    return this.#classSpellPool("bard", registry);
  }

  static subclassCaster(draft, classIdentifier) {
    const subclass = draft.items.find(item => {
      if (item.type !== "subclass") return false;
      const parent = item.system?.classIdentifier ?? item.system?.class?.identifier ?? item.system?.class;
      return !parent || parent === classIdentifier;
    });
    const identifier = subclass?.system?.identifier;
    if (classIdentifier === "fighter" && identifier === "eldritch-knight") {
      return { subclass, identifier, spellList: "wizard", ability: "int", sourceItem: "subclass:eldritch-knight" };
    }
    if (classIdentifier === "rogue" && identifier === "arcane-trickster") {
      return { subclass, identifier, spellList: "wizard", ability: "int", sourceItem: "subclass:arcane-trickster" };
    }
    return null;
  }

  static subclassCasterCantripCount(caster, oldLevel, newLevel) {
    if (!caster) return 0;
    const known = level => {
      if (level < 3) return 0;
      if (caster.identifier === "arcane-trickster") return level >= 10 ? 4 : 3;
      return level >= 10 ? 3 : 2;
    };
    let count = Math.max(0, known(newLevel) - known(oldLevel));
    if (caster.identifier === "arcane-trickster" && oldLevel < 3 && newLevel >= 3) count -= 1; // Mage Hand is a native fixed grant.
    return Math.max(0, count);
  }

  static subclassCasterPreparedCount(caster, oldLevel, newLevel) {
    if (!caster) return 0;
    const scale = caster.subclass?.toObject().system?.advancement ?? {};
    const advancement = Object.values(scale).find(entry => entry.type === "ScaleValue"
      && String(entry.configuration?.identifier ?? entry.title ?? "").toLowerCase().includes("prepared"));
    const value = level => {
      const rows = Object.entries(advancement?.configuration?.scale ?? {})
        .map(([minimum, row]) => [Number(minimum), Number(row?.value ?? 0)])
        .filter(([minimum]) => minimum <= level)
        .sort((a, b) => a[0] - b[0]);
      return rows.at(-1)?.[1] ?? 0;
    };
    return Math.max(0, value(newLevel) - value(oldLevel));
  }

  static #spellSection(config, registry) {
    const selected = new Set(config.selected ?? []);
    const options = config.pool.map(option => ({
      ...option,
      checked: selected.has(option.identifier),
      levelLabel: this.#levelLabel(option.system?.level),
      school: option.system?.school ?? ""
    }));
    return {
      ...config,
      options,
      groups: registry.groupOptions(options),
      levelGroups: this.#groupSpellsByLevel(options, registry),
      selectedCount: selected.size
    };
  }

  static #targetSpellSection(config) {
    const selected = new Set(config.selected ?? []);
    return {
      ...config,
      items: config.items.map(item => ({ ...item, checked: selected.has(item.id) })),
      selectedCount: selected.size
    };
  }

  static #featureSpellReplacement({
    id, title, note, draft, pool, category, featureItemId, selected,
    sameLevel = false, alwaysPrepared = true, sourceItem = null, ability = null,
    exactSpellLevel = null
  }) {
    const existing = draft.items.filter(item => item.type === "spell"
      && (item.getFlag(MODULE_ID, "featureSpellOwners") ?? []).some(owner =>
        owner.category === category && (!featureItemId || owner.featureItemId === featureItemId)
      )).map(item => ({ id: item.id, name: item.name, img: item.img, level: Number(item.system?.level ?? 0) }));
    const existingIdentifiers = new Set(draft.items.filter(item => item.type === "spell").map(item => item.system?.identifier));
    const options = pool.filter(option => !existingIdentifiers.has(option.identifier)).map(option => ({
      ...option,
      level: Number(option.system?.level ?? 0),
      levelLabel: this.#levelLabel(option.system?.level)
    }));
    return {
      id, title, note, category, featureItemId, sameLevel,
      alwaysPrepared, sourceItem, ability, exactSpellLevel,
      available: existing.length > 0 && options.length > 0,
      existing,
      options,
      selectedRemoveId: selected?.removeId ?? "",
      selectedAddValue: selected?.addIdentifier ?? ""
    };
  }

  static #optionSection(config) {
    return config;
  }

  static async #wildShapeContext(draft, cls, _registry, { oldClassLevel, newClassLevel, selected }) {
    const feature = this.#feature(draft, "wild-shape");
    if (!feature || newClassLevel < 2) return this.#emptyWildShape();
    const oldKnown = this.#scaleValue(cls, oldClassLevel, "known forms");
    const newKnown = this.#scaleValue(cls, newClassLevel, "known forms");
    const growthCount = Math.max(0, newKnown - oldKnown);
    const knownRows = foundry.utils.deepClone(feature.getFlag(MODULE_ID, "knownWildShapeForms") ?? []);
    const invalidForms = [];
    const validExisting = new Set();
    for (const row of knownRows) {
      const document = row?.uuid ? await fromUuid(row.uuid) : null;
      const sourceCr = document ? this.#crNumber(foundry.utils.getProperty(document, "system.details.cr")) : null;
      if (sourceCr === null) {
        invalidForms.push({
          uuid: row?.uuid ?? "",
          name: row?.name ?? document?.name ?? "Unknown form",
          reason: document ? "The source document has no explicit numeric CR." : "The source document can no longer be resolved."
        });
      } else if (row?.uuid) {
        validExisting.add(row.uuid);
      }
    }
    const repairCount = invalidForms.length;
    const count = growthCount + repairCount;
    if (!count) return { ...this.#emptyWildShape(), featureItemId: feature.id };
    const maxCr = this.#crNumber(this.#scaleRawValue(cls, newClassLevel, "wild shape cr"));
    if (maxCr === null) throw new Error("Wild Shape Known Forms cannot be offered because the class Wild Shape CR scale is missing or non-numeric.");
    const options = (await this.#beastOptions()).filter(option =>
      option.cr <= maxCr && (newClassLevel >= 8 || !option.fly) && !validExisting.has(option.uuid)
    ).map(option => ({ ...option, checked: selected.includes(option.uuid) }));
    const repairText = repairCount
      ? ` Replace ${repairCount} incompatible stored form${repairCount === 1 ? "" : "s"}: ${invalidForms.map(row => row.name).join(", ")}.`
      : "";
    const growthText = growthCount
      ? ` Choose ${growthCount} newly learned form${growthCount === 1 ? "" : "s"}.`
      : "";
    return {
      featureItemId: feature.id,
      count,
      growthCount,
      repairCount,
      invalidForms,
      invalidUuids: invalidForms.map(row => row.uuid).filter(Boolean),
      selectedCount: selected.length,
      maxCrLabel: this.#crLabel(maxCr),
      flyAllowed: newClassLevel >= 8,
      options,
      groups: this.#groupBySource(options),
      note: `${repairText}${growthText} Maximum CR ${this.#crLabel(maxCr)}.${newClassLevel >= 8 ? " Flying forms are eligible." : " Flying forms are not eligible yet."}`.trim()
    };
  }

  static async #landContext(draft, _cls, registry, { oldClassLevel, newClassLevel, selected }) {
    const feature = this.#feature(draft, "circle-of-the-land-spells");
    if (!feature) return this.#emptyLand();
    const current = feature.getFlag(MODULE_ID, "circleLand")?.land ?? "";
    const required = oldClassLevel < 3 && newClassLevel >= 3 || !current;
    const resolved = selected || current;
    const previews = [];
    for (const value of Object.keys(LAND_SPELLS)) {
      previews.push({
        value,
        label: this.#humanize(value),
        selected: resolved === value,
        levels: await this.#landProgressionCards(value, registry)
      });
    }
    const unlockedLevels = [3, 5, 7, 9].filter(level => oldClassLevel < level && newClassLevel >= level);
    const newSpells = resolved
      ? previews.find(row => row.value === resolved)?.levels.filter(row => unlockedLevels.includes(row.level)) ?? []
      : [];
    return {
      featureItemId: feature.id,
      required,
      current,
      currentLabel: this.#humanize(current),
      selected: resolved,
      selectedLabel: this.#humanize(resolved),
      options: previews.map(({ value, label, selected }) => ({ value, label, selected })),
      previews,
      newSpells,
      hasAutomatic: newSpells.some(row => row.spells.length),
      note: "Choose the land whose Circle Spells are always prepared. Later Long Rest changes belong to Runtime Character Management."
    };
  }

  static async #landProgressionCards(land, registry) {
    const levels = [];
    for (const [level, configuredUuids] of Object.entries(LAND_SPELLS[land] ?? {})) {
      const spells = [];
      for (const configuredUuid of configuredUuids) {
        let uuid = configuredUuid;
        if (!registry.isUuidAllowed(uuid)) {
          const source = await fromUuid(configuredUuid);
          const preferred = source?.system?.identifier ? registry.preferredOption("spell", source.system.identifier) : null;
          if (!preferred) continue;
          uuid = preferred.uuid;
        }
        const option = registry.findOption(uuid) ?? await this.#optionFromUuid(uuid, registry);
        if (!option) continue;
        spells.push({
          uuid: option.uuid,
          name: option.name,
          img: option.img,
          level: Number(option.system?.level ?? 0),
          levelLabel: this.#levelLabel(option.system?.level),
          sourceLabel: option.sourceLabel ?? option.source?.label ?? "Enabled Source"
        });
      }
      levels.push({
        level: Number(level),
        label: `Druid Level ${level}`,
        spells
      });
    }
    return levels.sort((a, b) => a.level - b.level);
  }

  static async #applyLandSpells(draft, cls, registry, feature, land, state) {
    const uuids = Object.entries(LAND_SPELLS[land] ?? {})
      .filter(([level]) => Number(level) <= Number(state.targetClassLevel))
      .flatMap(([, rows]) => rows);
    const created = [];
    for (const configuredUuid of uuids) {
      let uuid = configuredUuid;
      if (!registry.isUuidAllowed(uuid)) {
        const source = await fromUuid(configuredUuid);
        const preferred = source?.system?.identifier ? registry.preferredOption("spell", source.system.identifier) : null;
        if (!preferred) throw new Error(`A required ${this.#humanize(land)} Circle Spell is unavailable from enabled sources.`);
        uuid = preferred.uuid;
      }
      const option = registry.findOption(uuid) ?? await this.#optionFromUuid(uuid, registry);
      const section = {
        id: `circle-land-${land}`,
        title: `${this.#humanize(land)} Land Spells`,
        category: "circle-of-the-land-spells",
        featureItemId: feature.id,
        alwaysPrepared: true,
        sourceItem: "subclass:land"
      };
      const result = await this.#ensureFeatureSpell(draft, cls, section, option, state);
      if (result.created) created.push(result.spell.id);
    }
    return created;
  }

  static async #activateNaturesWard(draft, land) {
    const expectedResistance = LAND_RESISTANCES[land];
    if (!expectedResistance) throw new Error("Nature's Ward cannot be configured because the Circle of the Land selection is invalid.");
    const feature = this.#feature(draft, "natures-ward");
    if (!feature) return false;

    const effects = feature.effects?.contents ?? [...(feature.effects ?? [])];
    const landEffects = effects.filter(effect => /^Nature's Ward:/i.test(effect.name ?? ""));
    const matching = landEffects.find(effect => {
      const namedLand = String(effect.name ?? "").split(":").at(-1)?.trim().toLowerCase();
      const changes = effect.system?.changes?.values ? [...effect.system.changes.values()] : (effect.system?.changes ?? []);
      return namedLand === land || changes.some(change =>
        change.key === "system.traits.dr.value" && String(change.value).toLowerCase() === expectedResistance
      );
    });
    if (!matching) {
      throw new Error(`Nature's Ward does not contain the official ${this.#humanize(land)} (${this.#humanize(expectedResistance)}) resistance effect.`);
    }

    const updates = landEffects.map(effect => ({
      _id: effect.id,
      disabled: effect.id !== matching.id
    }));
    if (updates.length) await feature.updateEmbeddedDocuments("ActiveEffect", updates, {
      characterBuilderNatureWard: true
    });
    const active = (feature.effects?.contents ?? [...(feature.effects ?? [])]).filter(effect =>
      /^Nature's Ward:/i.test(effect.name ?? "") && !effect.disabled
    );
    if (active.length !== 1 || active[0].id !== matching.id) {
      throw new Error("Nature's Ward could not activate exactly one official land-resistance effect.");
    }
    return true;
  }

  static async #ensureFeatureSpell(draft, cls, section, option, state) {
    if (!option) throw new Error(`${section.title} contains an unavailable spell.`);
    const owner = this.#ownerRecord(cls, section, state, option);
    let spell = draft.items.find(item => item.type === "spell"
      && item.system?.identifier === option.identifier
      && (item.getFlag(MODULE_ID, "featureSpellOwners") ?? []).some(existing =>
        existing.category === owner.category
        && existing.classItemId === owner.classItemId
        && existing.subclassItemId === owner.subclassItemId
        && existing.featureItemId === owner.featureItemId
      ));
    let created = false;
    if (!spell) {
      const document = await fromUuid(option.uuid);
      if (!document) throw new Error(`Unable to load ${option.name}.`);
      const data = document.toObject();
      delete data._id;
      data.system ??= {};
      data.system.ability = this.#spellAbility(cls.system?.identifier, section);
      data.system.method = cls.system?.identifier === "warlock" ? "pact" : "spell";
      SpellPreparationPolicyService.applyToData(data, {
        alwaysPrepared: section.alwaysPrepared,
        explicitPrepared: section.prepared,
        category: section.category,
        accessModel: section.accessModel ?? ""
      });
      data.system.sourceItem = section.sourceItem ?? `class:${cls.system?.identifier}`;
      data.flags ??= {};
      data.flags.dnd5e ??= {};
      data.flags.dnd5e.sourceId = document.uuid;
      data.flags[MODULE_ID] ??= {};
      data.flags[MODULE_ID].featureGrantedSpell = true;
      data.flags[MODULE_ID].featureSpellOwners = [owner];
      data.flags[MODULE_ID].levelUpSpell = {
        transactionId: state.transactionId,
        classIdentifier: cls.system?.identifier,
        classItemId: cls.id,
        acquiredAtCharacterLevel: state.targetCharacterLevel,
        acquiredAtClassLevel: state.targetClassLevel,
        category: section.category,
        featureItemId: section.featureItemId ?? null,
        sourceUuid: document.uuid
      };
      if (section.special === "mystic-arcanum") this.#configureMysticArcanum(data);
      [spell] = await draft.createEmbeddedDocuments("Item", [data]);
      created = true;
    } else {
      await FeatureSpellOwnershipService.addOwner(spell, owner, {
        prepared: section.alwaysPrepared ? 2 : null
      });
      if (section.special === "mystic-arcanum") {
        const data = spell.toObject();
        this.#configureMysticArcanum(data);
        await spell.update({
          "system.uses": data.system.uses,
          "system.activities": data.system.activities,
          "system.prepared": 2
        });
      }
    }
    return { spell, created };
  }

  static async #applyTargetSpell(draft, cls, section, spell, state, index) {
    const sourceUuid = spell.getFlag("dnd5e", "sourceId") ?? spell._stats?.compendiumSource ?? null;
    const owner = this.#ownerRecord(cls, section, state, {
      uuid: sourceUuid,
      identifier: spell.system?.identifier,
      name: spell.name,
      system: { level: spell.system?.level }
    });
    if (section.special === "signature-spells") {
      const feature = draft.items.get(section.featureItemId);
      const trackers = this.#signatureTrackers(feature);
      owner.signaturePosition = index + 1;
      owner.trackerActivityId = trackers[index]?.id ?? null;
      owner.trackerActivityName = trackers[index]?.name ?? null;
    }
    if (section.special === "spell-mastery") {
      owner.freeCastAtBaseLevel = true;
      owner.unlimitedFreeCast = true;
      owner.requireSlot = false;
    }
    await FeatureSpellOwnershipService.addOwner(spell, owner, { prepared: 2 });
    const feature = draft.items.get(section.featureItemId);
    if (feature && ["spell-mastery", "signature-spells"].includes(section.special)) {
      await this.#applyNativeEnchantment(spell, feature, section.special);
    }
  }

  static async #applyNativeEnchantment(spell, feature, special) {
    const existing = spell.effects?.find(effect => effect.getFlag(MODULE_ID, "managedEnchantment") === special);
    if (existing) return;
    const profile = feature.effects?.find(effect => effect.type === "enchantment")
      ?? feature.effects?.contents?.find(effect => effect.type === "enchantment");
    if (!profile) return;
    const data = profile.toObject();
    const profileId = data._id;
    delete data._id;
    data.disabled = false;
    data.flags ??= {};
    data.flags.dnd5e ??= {};
    data.flags.dnd5e.enchantmentProfile = profileId;
    const sourceActorId = feature.actor?.getFlag(MODULE_ID, "sourceActorId") ?? feature.actor?.id;
    const liveFeatureUuid = sourceActorId ? `Actor.${sourceActorId}.Item.${feature.id}` : feature.uuid;
    data.origin = liveFeatureUuid;
    data.flags.core ??= {};
    data.flags.core.originText = liveFeatureUuid;
    data.flags[MODULE_ID] ??= {};
    data.flags[MODULE_ID].managedEnchantment = special;
    await spell.createEmbeddedDocuments("ActiveEffect", [data], {
      characterBuilderManagedEnchantment: true
    });
  }

  static #configureMysticArcanum(data) {
    data.system.uses ??= {};
    data.system.uses.max = "1";
    data.system.uses.spent = 0;
    data.system.uses.recovery = [{ period: "lr", type: "recoverAll" }];
    for (const activity of Object.values(data.system.activities ?? {})) {
      if (!activity.consumption) activity.consumption = {};
      if (!activity.consumption.spellSlot) continue;
      activity.consumption.spellSlot = false;
      activity.consumption.targets ??= [];
      if (!activity.consumption.targets.some(target => target.type === "itemUses")) {
        activity.consumption.targets.push({ type: "itemUses", target: "", value: "1", scaling: {} });
      }
      activity.consumption.scaling ??= { allowed: false };
      activity.consumption.scaling.allowed = false;
    }
  }

  static #ownerRecord(cls, section, state, option) {
    const classOwnedCategories = new Set([
      "spell-mastery", "signature-spell", "mystic-arcanum", "primal-order-magician"
    ]);
    const subclassItemId = classOwnedCategories.has(section.category)
      ? null
      : this.subclassCaster(cls.actor, cls.system?.identifier)?.subclass?.id ?? null;
    return {
      category: section.category,
      label: section.title,
      classIdentifier: cls.system?.identifier,
      classItemId: cls.id,
      subclassItemId,
      featureItemId: section.featureItemId ?? null,
      ownerItemId: section.featureItemId ?? cls.id,
      transactionId: state.transactionId,
      acquiredAtCharacterLevel: Number(state.targetCharacterLevel),
      acquiredAtClassLevel: Number(state.targetClassLevel),
      sourceUuid: option.uuid ?? null,
      spellLevel: Number(option.system?.level ?? section.exactSpellLevel ?? 0),
      alwaysPrepared: Boolean(section.alwaysPrepared),
      requireSlot: section.special === "mystic-arcanum" ? false : null
    };
  }

  static async #wizardSpellbookTargets(draft, cls, { level, actionOnly = false, pendingSpellOptions = [] }) {
    const rows = draft.items.filter(item => item.type === "spell"
      && Number(item.system?.level ?? 0) === Number(level)
      && this.#spellBelongsToWizard(item, cls)
      && (!actionOnly || this.#isActionSpell(item))
    ).map(item => ({
      id: item.id,
      identifier: item.system?.identifier,
      name: item.name,
      img: item.img,
      level: Number(item.system?.level ?? 0),
      levelLabel: this.#levelLabel(item.system?.level),
      sourceUuid: item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? null,
      pending: false
    }));
    const existingIdentifiers = new Set(rows.map(row => row.identifier));
    for (const option of pendingSpellOptions ?? []) {
      if (Number(option.system?.level ?? 0) !== Number(level) || existingIdentifiers.has(option.identifier)) continue;
      if (actionOnly) {
        const document = await fromUuid(option.uuid);
        if (!document || !this.#isActionSpell(document)) continue;
      }
      rows.push({
        id: `pending:${option.identifier}`,
        identifier: option.identifier,
        name: option.name,
        img: option.img,
        level: Number(option.system?.level ?? 0),
        levelLabel: this.#levelLabel(option.system?.level),
        sourceUuid: option.uuid,
        pending: true
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  }

  static #spellBelongsToWizard(item, cls) {
    const classIdentifier = item.getFlag(MODULE_ID, "classSpellAccess")?.classIdentifier
      ?? item.getFlag(MODULE_ID, "levelUpSpell")?.classIdentifier
      ?? (String(item.system?.sourceItem ?? "").startsWith("class:") ? String(item.system.sourceItem).slice(6) : null);
    return classIdentifier === "wizard" && (!cls?.id || item.getFlag(MODULE_ID, "classSpellAccess")?.classItemId === cls.id
      || item.getFlag(MODULE_ID, "levelUpSpell")?.classItemId === cls.id
      || !item.getFlag(MODULE_ID, "classSpellAccess")?.classItemId);
  }

  static #isActionSpell(item) {
    if (String(item.system?.activation?.type ?? "") === "action") return true;
    const activities = item.system?.activities?.values ? [...item.system.activities.values()] : Object.values(item.system?.activities ?? {});
    return activities.some(activity => String(activity.activation?.type ?? "") === "action");
  }

  static #signatureTrackers(feature) {
    const activities = feature?.system?.activities?.values
      ? [...feature.system.activities.values()]
      : Object.values(feature?.system?.activities ?? {});
    return activities.filter(activity => /expend (first|second) spell/i.test(activity.name ?? ""))
      .sort((a, b) => /first/i.test(a.name ?? "") ? -1 : /first/i.test(b.name ?? "") ? 1 : 0)
      .map(activity => ({ id: activity.id ?? activity._id, name: activity.name }));
  }

  static async #classSpellPool(identifier, registry) {
    const spellLists = globalThis.dnd5e?.registry?.spellLists;
    if (!spellLists) throw new Error("The D&D5e spell-list registry is unavailable.");
    for (let attempt = 0; attempt < 20 && !spellLists.ready; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    const list = spellLists.forType("class", identifier);
    if (!list) return [];
    const options = new Map();
    for (const index of list.indexes) {
      const spellIdentifier = index.system?.identifier;
      if (!spellIdentifier) continue;
      const preferred = registry.preferredOption("spell", spellIdentifier);
      if (preferred) options.set(spellIdentifier, preferred);
    }
    return [...options.values()].sort((a, b) => Number(a.system?.level ?? 0) - Number(b.system?.level ?? 0)
      || a.name.localeCompare(b.name, game.i18n.lang));
  }

  static async #spellListUnion(identifiers, registry) {
    const rows = await Promise.all(identifiers.map(identifier => this.#classSpellPool(identifier, registry)));
    const byIdentifier = new Map();
    for (const option of rows.flat()) {
      const current = byIdentifier.get(option.identifier);
      if (!current || option.sourceRank < current.sourceRank) byIdentifier.set(option.identifier, option);
    }
    return [...byIdentifier.values()].sort((a, b) => Number(a.system?.level ?? 0) - Number(b.system?.level ?? 0)
      || a.name.localeCompare(b.name, game.i18n.lang));
  }

  static async #optionFromUuid(uuid, registry) {
    const document = await fromUuid(uuid);
    if (!document) return null;
    const source = registry.sourceForUuid(uuid);
    return {
      id: document.id,
      uuid,
      name: document.name,
      img: document.img,
      type: document.type,
      identifier: document.system?.identifier ?? this.#slug(document.name),
      sourceId: source?.sourceId ?? "world",
      sourceLabel: source?.sourceLabel ?? document.pack ?? "World",
      sourceRank: source?.sourceRank ?? 999,
      system: document.system?.toObject ? document.system.toObject() : foundry.utils.deepClone(document.system ?? {})
    };
  }

  static #hasExactFeatureSpellOwner(draft, { category, classItemId, featureItemId }) {
    return draft.items.some(item => item.type === "spell"
      && (item.getFlag(MODULE_ID, "featureSpellOwners") ?? []).some(owner =>
        owner.category === category
        && owner.classItemId === classItemId
        && owner.featureItemId === featureItemId
      ));
  }

  static async #beastOptions() {
    const options = [];
    const sources = SourceRegistry.orderedSources();
    for (let rank = 0; rank < sources.length; rank++) {
      const source = sources[rank];
      if (source.packageId !== "dnd5e" && !game.modules.get(source.packageId)?.active) continue;
      const packs = [...game.packs].filter(pack => {
        if (pack.documentName !== "Actor") return false;
        const packageId = pack.metadata.packageName ?? pack.metadata.package ?? pack.collection.split(".")[0];
        if (packageId !== source.packageId) return false;
        if (!source.sourceBook) return true;
        return foundry.utils.getProperty(pack.metadata, "flags.dnd5e.sourceBook") === source.sourceBook;
      });
      for (const pack of packs) {
        let index;
        try {
          index = await pack.getIndex({ fields: [
            "name", "img", "type", "system.details.type.value", "system.details.cr", "system.attributes.movement.fly"
          ] });
        } catch (_error) { continue; }
        for (const entry of index) {
          const creatureType = foundry.utils.getProperty(entry, "system.details.type.value")
            ?? foundry.utils.getProperty(entry, "system.details.type") ?? "";
          if (String(creatureType).toLowerCase() !== "beast") continue;
          const cr = this.#crNumber(foundry.utils.getProperty(entry, "system.details.cr"));
          if (cr === null) continue;
          const fly = Number(foundry.utils.getProperty(entry, "system.attributes.movement.fly") ?? 0) > 0;
          options.push({
            uuid: `Compendium.${pack.collection}.Actor.${entry._id}`,
            name: entry.name,
            img: entry.img || "icons/svg/mystery-man.svg",
            cr,
            crLabel: this.#crLabel(cr),
            fly,
            sourceId: source.id,
            sourceLabel: source.label,
            sourceRank: rank
          });
        }
      }
    }
    const claimed = new Set();
    return options.sort((a, b) => a.sourceRank - b.sourceRank || a.cr - b.cr || a.name.localeCompare(b.name, game.i18n.lang))
      .filter(option => {
        const key = `${option.name.toLowerCase()}:${option.cr}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      });
  }

  static #groupBySource(options) {
    const groups = new Map();
    for (const option of options) {
      const group = groups.get(option.sourceId) ?? { id: option.sourceId, label: option.sourceLabel, rank: option.sourceRank, items: [] };
      group.items.push(option);
      groups.set(option.sourceId, group);
    }
    return [...groups.values()].sort((a, b) => a.rank - b.rank);
  }

  static #groupSpellsByLevel(options, registry) {
    const levels = new Map();
    for (const option of options) {
      const level = Number(option.system?.level ?? 0);
      const rows = levels.get(level) ?? [];
      rows.push(option);
      levels.set(level, rows);
    }
    return [...levels.entries()].sort(([a], [b]) => a - b).map(([level, rows]) => ({
      level,
      label: level === 0 ? "Cantrips — Spell Level 0" : `Spell Level ${level}`,
      groups: registry.groupOptions(rows),
      count: rows.length
    }));
  }

  static #feature(draft, identifier) {
    return draft.items.find(item => item.type === "feat" && (
      item.system?.identifier === identifier || this.#slug(item.name) === identifier
    ));
  }

  static #mysticArcanumLevel(newLevel, oldLevel) {
    const levels = { 11: 6, 13: 7, 15: 8, 17: 9 };
    return oldLevel < newLevel ? levels[newLevel] ?? 0 : 0;
  }

  static #scaleValue(cls, level, title) {
    return Number(this.#scaleRawValue(cls, level, title) ?? 0);
  }

  static #scaleRawValue(cls, level, title) {
    const advancements = cls.toObject().system?.advancement ?? {};
    const advancement = Object.values(advancements).find(entry => entry.type === "ScaleValue"
      && String(entry.title ?? "").toLowerCase().includes(title));
    const rows = Object.entries(advancement?.configuration?.scale ?? {})
      .map(([minimum, row]) => [Number(minimum), row?.value])
      .filter(([minimum]) => minimum <= level)
      .sort((a, b) => a[0] - b[0]);
    return rows.at(-1)?.[1] ?? 0;
  }

  static #crNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.includes("/")) {
      const parts = text.split("/");
      if (parts.length !== 2) return null;
      const numerator = Number(parts[0]);
      const denominator = Number(parts[1]);
      const result = numerator / denominator;
      return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 && result >= 0
        ? result
        : null;
    }
    const result = Number(text);
    return Number.isFinite(result) && result >= 0 ? result : null;
  }

  static #crLabel(value) {
    const fractions = [[0.125, "1/8"], [0.25, "1/4"], [0.5, "1/2"]];
    return fractions.find(([number]) => Math.abs(number - value) < 0.001)?.[1] ?? String(value);
  }

  static #validateExact(selected, expected, options, label, key = "identifier") {
    if (selected.length !== expected) throw new Error(`${label} requires exactly ${expected} selection${expected === 1 ? "" : "s"}.`);
    const allowed = new Set(options.map(option => String(option[key])));
    const invalid = selected.find(value => !allowed.has(String(value)));
    if (invalid) throw new Error(`${label} contains an unavailable selection.`);
  }

  static #spellAbility(classIdentifier, section) {
    if (section.ability) return section.ability;
    return { bard: "cha", cleric: "wis", druid: "wis", paladin: "cha", ranger: "wis", sorcerer: "cha", warlock: "cha", wizard: "int", fighter: "int", rogue: "int" }[classIdentifier] ?? "";
  }

  static #levelLabel(level) {
    const value = Number(level ?? 0);
    return value === 0 ? "Cantrip" : `Level ${value}`;
  }

  static #humanize(value) {
    return String(value ?? "").split(/[-_]/g).filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  }

  static #slug(value) {
    return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  static #emptyWildShape() {
    return {
      featureItemId: null, count: 0, growthCount: 0, repairCount: 0,
      invalidForms: [], invalidUuids: [], selectedCount: 0,
      options: [], groups: [], note: "", maxCrLabel: "", flyAllowed: false
    };
  }

  static #emptyLand() {
    return { featureItemId: null, required: false, current: "", currentLabel: "", selected: "", selectedLabel: "", options: [], previews: [], newSpells: [], hasAutomatic: false, note: "" };
  }
}
