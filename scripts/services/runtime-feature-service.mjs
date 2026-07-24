import { CURRENCY_CP, MODULE_ID } from "../constants.mjs";
import { FeatureSpellOwnershipService } from "./feature-spell-ownership-service.mjs";
import { PactOfTheTomeService } from "./pact-of-the-tome-service.mjs";
import { RuntimeBadgeReconciliationService } from "./runtime-badge-reconciliation-service.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";

const LAND_LABELS = Object.freeze({ arid: "Arid", polar: "Polar", temperate: "Temperate", tropical: "Tropical" });
const LAND_RESISTANCES = Object.freeze({ arid: "fire", polar: "cold", temperate: "lightning", tropical: "poison" });
const LAND_SPELLS = Object.freeze({
  arid: {
    3: ["blur", "burning-hands", "fire-bolt"], 5: ["fireball"], 7: ["blight"], 9: ["wall-of-stone"]
  },
  polar: {
    3: ["fog-cloud", "hold-person", "ray-of-frost"], 5: ["sleet-storm"], 7: ["ice-storm"], 9: ["cone-of-cold"]
  },
  temperate: {
    3: ["misty-step", "shocking-grasp", "sleep"], 5: ["lightning-bolt"], 7: ["freedom-of-movement"], 9: ["tree-stride"]
  },
  tropical: {
    3: ["acid-splash", "ray-of-sickness", "web"], 5: ["stinking-cloud"], 7: ["polymorph"], 9: ["insect-plague"]
  }
});

/**
 * Pure action discovery/context plus focused post-rest mutations. Every method
 * reads the live Actor as source of truth and never changes class levels, XP,
 * Hit Dice, or Level Up history.
 */
export class RuntimeFeatureService {
  static async actions(actor, restType, registry, session = null) {
    const type = restType === "short" ? "short" : "long";
    const rows = [];
    const add = (id, label, feature, kind, description, options = {}) => {
      if (rows.some(row => row.id === id)) return;
      rows.push({
        id, label, kind, description,
        img: options.img ?? feature?.img ?? "icons/svg/upgrade.svg",
        featureItemId: feature?.id ?? null,
        complete: Boolean(session?.completedActionIds?.includes(id)),
        native: Boolean(options.native),
        nativeActivityName: options.nativeActivityName ?? null,
        order: Number(options.order ?? 100)
      });
    };

    const weaponMastery = this.#feature(actor, "weapon-mastery");
    if (type === "long" && weaponMastery && this.#masteryClasses(actor).length) {
      add("weapon-mastery", "Weapon Mastery", weaponMastery, "weapon-mastery",
        "Practice weapon drills and replace one mastery choice for each eligible class.", { order: 10 });
    }

    const aspect = this.#feature(actor, "aspect-of-the-wilds");
    if (type === "long" && aspect) add("aspect-of-the-wilds", "Aspect of the Wilds", aspect, "effect-choice",
      "Choose Owl, Panther, or Salmon for the next adventuring day.", { order: 20 });

    const land = this.#feature(actor, "circle-of-the-land-spells");
    if (type === "long" && land) add("change-land", "Change Land", land, "land",
      "Change the Circle's Land, Circle Spells, and Nature's Ward together.", { order: 30 });

    const wildShape = this.#feature(actor, "wild-shape");
    if (type === "long" && wildShape && (wildShape.getFlag(MODULE_ID, "knownWildShapeForms") ?? []).length) {
      add("replace-wild-shape-form", "Known Wild Shape Forms", wildShape, "wild-shape-form",
        "Replace one known Beast form with another eligible form.", { order: 40 });
    }

    const tome = PactOfTheTomeService.findInvocation(actor);
    if (tome && ["short", "long"].includes(type)) add("pact-of-the-tome", "Pact of the Tome", tome, "pact-of-the-tome",
      "Reform the same Book of Shadows and reselect its three cantrips and two rituals.", { order: 50 });

    const starMap = this.#feature(actor, "star-map");
    if (starMap && ["short", "long"].includes(type)) add("star-map", "Star Map", starMap, "native-feature",
      "If the previous Star Map was lost, open the source-native Create Star Chart activity.", {
        native: true, nativeActivityName: "Create Star Chart", order: 55
      });

    const resilience = this.#feature(actor, "fiendish-resilience");
    if (resilience && ["short", "long"].includes(type)) add("fiendish-resilience", "Fiendish Resilience", resilience, "effect-choice",
      "Choose the damage type resisted until you choose again.", { order: 60 });

    const huntersPrey = this.#feature(actor, "hunters-prey");
    if (huntersPrey && ["short", "long"].includes(type)) add("hunters-prey", "Hunter's Prey", huntersPrey, "activity-choice",
      "Choose Colossus Slayer or Horde Breaker.", { order: 70 });

    const defensive = this.#feature(actor, "defensive-tactics");
    if (defensive && ["short", "long"].includes(type)) add("defensive-tactics", "Defensive Tactics", defensive, "activity-choice",
      "Choose Escape the Horde or Multiattack Defense.", { order: 80 });

    const warBond = this.#feature(actor, "war-bond");
    if (warBond && ["short", "long"].includes(type)) add("war-bond", "War Bond", warBond, "war-bond-guide",
      "Use the source-native War Bond feature and chat enchantment card to bind up to two inventory weapons.", {
        order: 90
      });

    const primalCompanion = this.#feature(actor, "primal-companion");
    if (type === "long" && primalCompanion) add("primal-companion", "Primal Companion", primalCompanion, "native-feature",
      "Open the source-native Summon Companion activity to choose a different primal beast.", {
        native: true, nativeActivityName: "Summon Companion", order: 97
      });

    const wizard = this.#class(actor, "wizard");
    if (type === "long" && wizard) {
      if (this.#normalClassSpells(actor, "wizard", { level: 0 }).length) {
        add("replace-wizard-cantrip", "Replace Cantrip", this.#classFeature(actor, "spellcasting", "wizard"), "replace-cantrip",
          "Replace one Wizard cantrip learned through Spellcasting.", { order: 100 });
      }
      const mastery = this.#feature(actor, "spell-mastery");
      if (mastery && this.#spellMasterySpells(actor).length === 2) {
        add("spell-mastery", "Spell Mastery", mastery, "spell-mastery",
          "Replace one mastered spell with another eligible spell of the same level.", { order: 110 });
      }
      if (this.#settings().allowSpellScrollScribing !== false && (await this.#scribeSources(actor, registry)).length) {
        add("scribe-spell", "Scribe Spell to Spellbook", this.#classFeature(actor, "spellcasting", "wizard"), "scribe-spell",
          "Copy an eligible written Wizard spell into the spellbook.", { img: this.#comprehendLanguagesIcon(registry), order: 140 });
      }
    }

    const cosmic = this.#feature(actor, "cosmic-omen");
    if (type === "long" && cosmic) add("cosmic-omen", "Cosmic Omen", cosmic, "roll-cosmic-omen",
      "Roll a public omen and record Weal or Woe.", { order: 120 });

    const portent = this.#feature(actor, "portent");
    if (type === "long" && portent) add("portent", "Portent", portent, "roll-portent",
      "Roll and publicly record the new Portent results.", { order: 130 });

    return rows.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, game.i18n.lang));
  }

  static async actionContext(actor, action, registry, session = null) {
    const operation = session?.operations?.[action.id]?.payload ?? null;
    switch (action.kind) {
      case "weapon-mastery": return { ...action, masteryGroups: await this.#masteryContext(actor, registry, operation) };
      case "effect-choice": return { ...action, effectChoice: this.#effectChoiceContext(actor.items.get(action.featureItemId), operation) };
      case "activity-choice": return { ...action, activityChoice: this.#activityChoiceContext(actor.items.get(action.featureItemId), operation) };
      case "land": return { ...action, landContext: await this.#landContext(actor, registry, operation) };
      case "wild-shape-form": return { ...action, wildShapeContext: await this.#wildShapeContext(actor, operation) };
      case "pact-of-the-tome": {
        const cls = this.#class(actor, "warlock");
        const payload = operation ?? {};
        const tome = await PactOfTheTomeService.buildContext(actor, registry, {
          mode: "maintenance",
          selectedCantrips: payload.selectedCantrips ?? [],
          selectedRituals: payload.selectedRituals ?? [],
          transactionId: session?.id ?? null,
          classItem: cls
        });
        return { ...action, pactOfTheTome: tome };
      }
      case "replace-cantrip": return { ...action, replaceCantrip: await this.#replaceCantripContext(actor, registry, operation) };
      case "spell-mastery": return { ...action, spellMastery: this.#spellMasteryContext(actor, operation) };
      case "roll-cosmic-omen": return { ...action, rollContext: this.#cosmicOmenContext(actor, session) };
      case "roll-portent": return { ...action, rollContext: this.#portentContext(actor, session) };
      case "scribe-spell": return { ...action, scribeContext: await this.#scribeContext(actor, registry, operation) };
      case "war-bond-guide": return {
        ...action,
        feature: this.#itemSummary(actor.items.get(action.featureItemId)),
        secondaryImg: this.#mordenkainensSwordIcon(registry)
      };
      case "native-feature": return { ...action, feature: this.#itemSummary(actor.items.get(action.featureItemId)) };
      default: return action;
    }
  }

  static async performPublicRoll(actor, actionId, session) {
    if (session?.rollLocks?.[actionId]) return session.rollLocks[actionId];
    if (actionId === "cosmic-omen") {
      const roll = await (new Roll("1d6")).evaluate();
      const total = Number(roll.total);
      const omen = total % 2 === 0 ? "Weal" : "Woe";
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `<strong>Cosmic Omen</strong> — ${omen} (${total % 2 === 0 ? "Even" : "Odd"})`
      });
      return { formula: "1d6", results: [total], omen, rolledAt: Date.now(), rolledBy: game.user.id };
    }
    if (actionId === "portent") {
      const count = this.#feature(actor, "greater-portent") ? 3 : 2;
      const rolls = [];
      for (let index = 0; index < count; index++) {
        const roll = await (new Roll("1d20")).evaluate();
        rolls.push(roll);
      }
      const results = rolls.map(roll => Number(roll.total));
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="dnd5e chat-card"><header class="card-header flexrow"><img src="${this.#feature(actor, "portent")?.img ?? "icons/magic/perception/eye-ringed-glow-angry-large-red.webp"}" alt=""><h3>Portent</h3></header><div class="card-content"><p>New Portent results: <strong>${results.join(", ")}</strong></p></div></div>`,
        rolls
      });
      return { formula: `${count} × 1d20`, results, rolledAt: Date.now(), rolledBy: game.user.id };
    }
    throw new Error("This Character Keeper action has no public roll.");
  }

  static async invokeNativeFeature(actor, actionId) {
    const feature = this.#feature(actor, actionId);
    if (!feature) throw new Error("The source-native feature could not be found on this Actor.");
    const activityNames = {
      "war-bond": "Bond with Weapon",
      "primal-companion": "Summon Companion",
      "star-map": "Create Star Chart"
    };
    const targetName = activityNames[actionId] ?? null;
    if (targetName) {
      const activities = feature.system?.activities;
      const target = activities?.getName?.(targetName)
        ?? [...(activities?.values?.() ?? [])].find(activity => String(activity.name ?? "") === targetName)
        ?? Object.values(activities ?? {}).find(activity => String(activity.name ?? "") === targetName);
      if (!target?.use) throw new Error(`The source-native ${targetName} activity could not be found on ${feature.name}.`);
      return target.use({});
    }
    return feature.use({ chooseActivity: true });
  }

  static restLifecycleRequired(actor, restType) {
    if (restType !== "long") return false;
    const cosmic = this.#feature(actor, "cosmic-omen");
    const portent = this.#feature(actor, "portent");
    return Boolean(cosmic?.getFlag(MODULE_ID, "activeCosmicOmen")
      || portent?.getFlag(MODULE_ID, "portentResults"));
  }

  static async applyRestLifecycle(actor, restType, operations = [], transactionId = null) {
    if (restType !== "long") return [];
    const staged = new Set((operations ?? []).map(operation => operation.actionId));
    const results = [];
    const rows = [
      { actionId: "cosmic-omen", identifier: "cosmic-omen", flag: "activeCosmicOmen", badgeKind: "runtime-cosmic-omen" },
      { actionId: "portent", identifier: "portent", flag: "portentResults", badgeKind: "runtime-portent" }
    ];
    for (const row of rows) {
      const feature = this.#feature(actor, row.identifier);
      if (!feature || staged.has(row.actionId)) continue;
      const hadState = Boolean(feature.getFlag(MODULE_ID, row.flag));
      if (!hadState) continue;
      await feature.unsetFlag(MODULE_ID, row.flag);
      await this.#removeRuntimeBadge(feature, row.badgeKind);
      results.push({
        changed: true,
        lifecycle: "expired-at-long-rest",
        actionId: row.actionId,
        featureItemId: feature.id,
        transactionId
      });
    }
    return results;
  }

  static async validateOperation(actor, registry, actionId, payload = {}) {
    switch (actionId) {
      case "pact-of-the-tome": {
        const cls = this.#class(actor, "warlock");
        const context = await PactOfTheTomeService.buildContext(actor, registry, {
          mode: "maintenance",
          selectedCantrips: payload.selectedCantrips ?? [],
          selectedRituals: payload.selectedRituals ?? [],
          classItem: cls
        });
        PactOfTheTomeService.validateSelection(
          context,
          payload.selectedCantrips ?? [],
          payload.selectedRituals ?? []
        );
        return true;
      }
      case "scribe-spell": {
        const settings = this.#settings();
        if (settings.allowSpellScrollScribing === false) throw new Error("Spell Scroll scribing is disabled by the GM.");
        const sourceItem = actor.items.get(payload?.sourceItemId);
        if (!sourceItem || Number(sourceItem.system?.quantity ?? 1) < 1) throw new Error("The selected Spell Scroll is no longer present in the inventory.");
        const candidate = (await this.#scribeSources(actor, registry)).find(row =>
          row.sourceItemId === sourceItem.id && row.spellUuid === payload?.spellUuid
        );
        if (!candidate) throw new Error("That Spell Scroll is no longer eligible for this Wizard.");
        const effectiveCostGp = settings.chargeWizardScribingCosts === false ? 0 : Number(candidate.costGp ?? 0);
        if (this.#currencyCp(actor) < effectiveCostGp * 100) throw new Error(`Not enough currency to pay ${effectiveCostGp} GP.`);
        return true;
      }
      default:
        return true;
    }
  }

  static async applyOperation(actor, registry, actionId, payload, transactionId) {
    switch (actionId) {
      case "weapon-mastery": return this.#applyMastery(actor, registry, payload, transactionId);
      case "aspect-of-the-wilds":
      case "fiendish-resilience": return this.#applyEffectChoice(actor, actionId, payload, transactionId);
      case "hunters-prey":
      case "defensive-tactics": return this.#applyActivityChoice(actor, actionId, payload, transactionId);
      case "change-land": return this.#applyLand(actor, registry, payload, transactionId);
      case "replace-wild-shape-form": return this.#applyWildShapeForm(actor, payload, transactionId);
      case "pact-of-the-tome": {
        const result = await PactOfTheTomeService.apply(actor, registry, {
          mode: "maintenance",
          selectedCantrips: payload.selectedCantrips ?? [],
          selectedRituals: payload.selectedRituals ?? [],
          transactionId,
          characterLevel: this.#actorLevel(actor),
          classLevel: Number(this.#class(actor, "warlock")?.system?.levels ?? 0),
          classItem: this.#class(actor, "warlock")
        });
        await this.#reconcilePactOfTheTomeBadge(actor, transactionId);
        return result;
      }
      case "replace-wizard-cantrip": return this.#applyCantripReplacement(actor, registry, payload, transactionId);
      case "spell-mastery": return this.#applySpellMastery(actor, payload, transactionId);
      case "cosmic-omen": return this.#applyRollState(actor, "cosmic-omen", payload, transactionId);
      case "portent": return this.#applyRollState(actor, "portent", payload, transactionId);
      case "scribe-spell": return this.#applyScribeSpell(actor, registry, payload, transactionId);
      default: throw new Error(`Unsupported Character Keeper action: ${actionId}`);
    }
  }

  static async externalScribeContext(actor, registry) {
    return this.#scribeContext(actor, registry, null);
  }

  static async applyExternalScribe(actor, registry, payload, transactionId) {
    return this.#applyScribeSpell(actor, registry, payload, transactionId);
  }

  static #feature(actor, identifier) {
    return actor?.items?.find(item => item.type === "feat" && String(item.system?.identifier ?? "") === identifier) ?? null;
  }

  static #classFeature(actor, featureIdentifier, classIdentifier) {
    const cls = this.#class(actor, classIdentifier);
    const candidates = actor?.items?.filter(item => item.type === "feat"
      && String(item.system?.identifier ?? "") === featureIdentifier) ?? [];
    if (!candidates.length) return null;
    if (!cls) return candidates.length === 1 ? candidates[0] : null;
    return candidates.find(item => {
      const root = String(item.getFlag("dnd5e", "advancementRoot")
        ?? item.getFlag("dnd5e", "advancementOrigin") ?? "");
      return root.split(".")[0] === cls.id;
    }) ?? candidates.find(item => String(item.system?.requirements ?? "").toLowerCase().includes(classIdentifier))
      ?? (candidates.length === 1 ? candidates[0] : null);
  }

  static #class(actor, identifier) {
    return actor?.items?.find(item => item.type === "class" && String(item.system?.identifier ?? "") === identifier) ?? null;
  }

  static #actorLevel(actor) {
    return actor.items.filter(item => item.type === "class").reduce((sum, item) => sum + Number(item.system?.levels ?? 0), 0);
  }

  static #advancements(item) {
    const source = item?.toObject?.().system?.advancement ?? item?.system?.advancement ?? {};
    return Object.entries(source).map(([id, data]) => ({ id, ...foundry.utils.deepClone(data) }));
  }

  static #masteryClasses(actor) {
    return actor.items.filter(item => item.type === "class").map(cls => {
      const rows = this.#advancements(cls).filter(advancement => advancement.type === "Trait"
        && advancement.configuration?.mode === "mastery"
        && (advancement.value?.chosen ?? []).length);
      if (!rows.length) return null;
      const currentCount = rows.reduce((sum, row) => sum + (row.value?.chosen ?? []).length, 0);
      const rule = this.#weaponMasteryRule(cls, currentCount);
      return rule ? { cls, rows, rule } : null;
    }).filter(Boolean);
  }

  static #weaponMasteryRule(cls, currentCount) {
    const identifier = String(cls?.system?.identifier ?? "");
    const rules = {
      barbarian: { maxChanges: 1, meleeOnly: true, requiresProficiency: false },
      fighter: { maxChanges: 1, meleeOnly: false, requiresProficiency: false },
      paladin: { maxChanges: currentCount, meleeOnly: false, requiresProficiency: true },
      ranger: { maxChanges: currentCount, meleeOnly: false, requiresProficiency: true },
      rogue: { maxChanges: currentCount, meleeOnly: false, requiresProficiency: true }
    };
    const rule = rules[identifier];
    if (!rule || currentCount < 1) return null;
    return { ...rule, identifier, maxChanges: Math.max(1, Math.min(currentCount, Number(rule.maxChanges ?? 1))) };
  }

  static #actorHasWeaponProficiency(actor, option) {
    const type = String(option.system?.type?.value ?? "");
    const category = type.startsWith("simple") ? "sim" : type.startsWith("martial") ? "mar" : null;
    const baseItem = String(option.system?.type?.baseItem || option.identifier || "");
    const values = actor.system?.traits?.weaponProf?.value ?? [];
    const has = value => values?.has ? values.has(value) : Array.from(values ?? []).includes(value);
    return Boolean((category && has(category)) || (baseItem && has(baseItem)));
  }

  static #weaponAllowedForMastery(actor, rule, option) {
    const type = String(option.system?.type?.value ?? "");
    if (!["simpleM", "simpleR", "martialM", "martialR"].includes(type)) return false;
    if (rule.meleeOnly && !["simpleM", "martialM"].includes(type)) return false;
    if (rule.requiresProficiency && !this.#actorHasWeaponProficiency(actor, option)) return false;
    return Boolean(option.system?.type?.baseItem || option.identifier);
  }

  static #weaponCandidates(registry) {
    const candidates = registry.optionsByType("weapon").flatMap(group => group.items)
      .filter(option => ["simpleM", "simpleR", "martialM", "martialR"].includes(option.system?.type?.value))
      .filter(option => option.system?.type?.baseItem || option.identifier)
      .map(option => {
        const baseItem = option.system?.type?.baseItem || option.identifier;
        const masteryId = String(option.system?.mastery ?? "");
        const masteryLabel = this.#weaponMasteryLabel(masteryId);
        return {
          ...option,
          baseItem,
          category: String(option.system?.type?.value ?? "").startsWith("simple") ? "sim" : "mar",
          masteryId,
          masteryLabel,
          displayLabel: masteryLabel ? `${option.name} — ${masteryLabel}` : option.name
        };
      });
    const unique = new Map();
    for (const option of candidates) if (!unique.has(option.baseItem)) unique.set(option.baseItem, option);
    return [...unique.values()].sort((a, b) =>
      Number(a.sourceRank ?? 999) - Number(b.sourceRank ?? 999)
      || a.name.localeCompare(b.name, game.i18n.lang)
    );
  }

  static async #masteryContext(actor, registry, operation) {
    const classRows = this.#masteryClasses(actor);
    const currentAll = new Set(actor.system?.traits?.weaponProf?.mastery?.value ?? []);
    const candidates = this.#weaponCandidates(registry);
    const candidateByBase = new Map(candidates.map(option => [String(option.baseItem), option]));
    const savedChanges = operation?.changes ?? [];
    return classRows.map(({ cls, rows, rule }) => {
      const currentChoices = rows.flatMap(row => (row.value?.chosen ?? []).map(key => {
        const baseItem = String(key).split(":").at(-1);
        const option = candidateByBase.get(baseItem);
        return {
          key,
          advancementId: row.id,
          baseItem,
          name: option?.name ?? this.#weaponLabel(key),
          masteryLabel: option?.masteryLabel ?? "",
          label: option?.displayLabel ?? this.#weaponLabel(key),
          sourceId: option?.sourceId ?? "current",
          sourceLabel: option?.sourceLabel ?? "Current Choices",
          sourceRank: option?.sourceRank ?? 999
        };
      }));
      const saved = savedChanges.filter(change => change.classItemId === cls.id).slice(0, rule.maxChanges);
      const changeSlots = Array.from({ length: rule.maxChanges }, (_unused, index) => ({
        index,
        selectedOldKey: saved[index]?.oldKey ?? "",
        selectedNewKey: saved[index]?.newKey ?? ""
      }));
      const options = candidates.filter(option => this.#weaponAllowedForMastery(actor, rule, option)).map(option => ({
        ...option,
        masteryKey: `weapon:${option.category}:${option.baseItem}`,
        disabled: currentAll.has(option.baseItem)
      }));
      return {
        classItemId: cls.id,
        classIdentifier: rule.identifier,
        className: cls.name,
        classLevel: Number(cls.system?.levels ?? 0),
        currentChoices,
        currentChoiceGroups: this.#groupMasteryOptions(currentChoices),
        currentCount: currentChoices.length,
        maxChanges: rule.maxChanges,
        oneChange: rule.maxChanges === 1,
        changeSlots,
        options,
        optionGroups: this.#groupMasteryOptions(options)
      };
    });
  }

  static #groupMasteryOptions(options) {
    const groups = new Map();
    for (const option of options ?? []) {
      const id = String(option.sourceId ?? "current");
      const group = groups.get(id) ?? {
        id,
        label: option.sourceLabel ?? "Current Choices",
        rank: Number(option.sourceRank ?? 999),
        items: []
      };
      group.items.push(option);
      groups.set(id, group);
    }
    return [...groups.values()]
      .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, game.i18n.lang))
      .map(group => ({
        ...group,
        items: group.items.sort((a, b) => String(a.name ?? a.label).localeCompare(String(b.name ?? b.label), game.i18n.lang))
      }));
  }

  static #effectChoiceContext(feature, operation) {
    if (!feature) return { options: [], selected: "" };
    const featureSummary = this.#itemSummary(feature);
    const options = feature.effects.map(effect => {
      const change = effect.system?.changes?.find(row => ["system.traits.dr.value", "attributes.senses.darkvision", "system.attributes.movement.speed"].includes(row.key));
      const label = String(effect.name ?? "").replace(/^.*?:\s*/, "").replace(/^Aspect of the\s+/i, "");
      return {
        id: effect.id,
        label,
        img: effect.img ?? feature.img,
        active: !effect.disabled,
        value: change?.value ?? label.toLowerCase(),
        referenceUuid: featureSummary?.referenceUuid ?? featureSummary?.uuid ?? null
      };
    });
    return {
      feature: featureSummary,
      current: options.find(option => option.active)?.label ?? "None",
      selected: operation?.effectId ?? options.find(option => option.active)?.id ?? "",
      options
    };
  }

  static #activityChoiceContext(feature, operation) {
    if (!feature) return { options: [], selected: "", current: "" };
    const featureSummary = this.#itemSummary(feature);
    const definitions = feature.system?.identifier === "hunters-prey"
      ? [
          { value: "colossus-slayer", label: "Colossus Slayer" },
          { value: "horde-breaker", label: "Horde Breaker" }
        ]
      : feature.system?.identifier === "defensive-tactics"
        ? [
            { value: "escape-the-horde", label: "Escape the Horde" },
            { value: "multiattack-defense", label: "Multiattack Defense" }
          ]
        : [];
    const activities = feature.system?.activities?.values ? [...feature.system.activities.values()] : Object.values(feature.system?.activities ?? {});
    const byLabel = new Map(activities.map(activity => [String(activity.name ?? "").toLowerCase(), activity]));
    const options = definitions.map(definition => {
      const activity = byLabel.get(definition.label.toLowerCase());
      return {
        ...definition,
        id: activity?.id ?? activity?._id ?? null,
        img: activity?.img || feature.img,
        referenceUuid: featureSummary?.referenceUuid ?? featureSummary?.uuid ?? null
      };
    });
    const current = feature.getFlag(MODULE_ID, "managedFeatureChoice") ?? {};
    return {
      feature: featureSummary,
      current: current.value ?? "",
      currentLabel: current.label ?? options.find(option => option.value === current.value)?.label ?? "Not recorded",
      selected: operation?.value ?? operation?.label ?? current.value ?? "",
      options
    };
  }

  static async #landContext(actor, registry, operation) {
    const feature = this.#feature(actor, "circle-of-the-land-spells");
    const current = feature?.getFlag(MODULE_ID, "circleLand")?.id ?? feature?.getFlag(MODULE_ID, "circleLand")?.land ?? "";
    const selected = operation?.land ?? current;
    const druidLevel = Number(this.#class(actor, "druid")?.system?.levels ?? 0);
    const lands = [];
    for (const [id, label] of Object.entries(LAND_LABELS)) {
      const spellGroups = [];
      for (const [level, identifiers] of Object.entries(LAND_SPELLS[id])) {
        const spells = identifiers.map(identifier => registry.preferredOption("spell", identifier)).filter(Boolean)
          .map(option => ({ ...option, level: Number(option.system?.level ?? 0), levelLabel: Number(option.system?.level ?? 0) ? `Level ${option.system.level}` : "Cantrip" }));
        spellGroups.push({ druidLevel: Number(level), unlocked: druidLevel >= Number(level), spells });
      }
      lands.push({ id, label, resistance: this.#humanize(LAND_RESISTANCES[id]), selected: id === selected, current: id === current, spellGroups });
    }
    return {
      feature: this.#itemSummary(feature),
      current,
      currentLabel: LAND_LABELS[current] ?? "Not recorded",
      selected,
      lands: lands.map(land => ({
        ...land,
        img: feature?.img ?? "icons/svg/leaf.svg",
        referenceUuid: this.#itemReferenceUuid(feature)
      })),
      druidLevel
    };
  }

  static async #wildShapeContext(actor, operation) {
    const feature = this.#feature(actor, "wild-shape");
    const current = foundry.utils.deepClone(feature?.getFlag(MODULE_ID, "knownWildShapeForms") ?? []);
    const druidLevel = Number(this.#class(actor, "druid")?.system?.levels ?? 0);
    const { maxCr, flyAllowed } = this.#wildShapeLimits(actor, druidLevel);
    const beasts = await this.#beastOptions({ maxCr, flyAllowed });
    const replacingId = operation?.oldUuid ?? "";
    const otherForms = current.filter(row => row.uuid !== replacingId);
    const existingUuids = new Set(otherForms.map(row => row.uuid).filter(Boolean));
    const existingKeys = new Set(otherForms.map(row => this.#wildShapeKey(row)).filter(Boolean));
    return {
      current,
      replacingId,
      selectedUuid: operation?.newUuid ?? "",
      maxCrLabel: this.#crLabel(maxCr),
      flyAllowed,
      options: beasts.map(option => ({
        ...option,
        disabled: existingUuids.has(option.uuid) || existingKeys.has(this.#wildShapeKey(option))
      }))
    };
  }

  static async #replaceCantripContext(actor, registry, operation) {
    const current = this.#normalClassSpells(actor, "wizard", { level: 0 }).map(item => {
      const dependent = this.#cantripDependencyReason(actor, item);
      return {
        id: item.id, name: item.name, img: item.img, identifier: item.system?.identifier,
        uuid: item.uuid,
        sourceUuid: this.#itemReferenceUuid(item),
        disabled: Boolean(dependent), disabledReason: dependent
      };
    });
    const pool = (await this.#classSpellPool("wizard", registry)).filter(option => Number(option.system?.level ?? 0) === 0);
    const owned = new Set(actor.items.filter(item => item.type === "spell").map(item => item.system?.identifier));
    const oldId = operation?.oldItemId ?? "";
    const oldIdentifier = current.find(row => row.id === oldId)?.identifier;
    return {
      current,
      oldItemId: oldId,
      newUuid: operation?.newUuid ?? "",
      options: pool.map(option => ({ ...option, disabled: owned.has(option.identifier) && option.identifier !== oldIdentifier }))
    };
  }

  static #spellMasteryContext(actor, operation) {
    const feature = this.#feature(actor, "spell-mastery");
    const current = this.#spellMasterySpells(actor).map(item => ({
      id: item.id,
      name: item.name,
      img: item.img,
      level: Number(item.system?.level ?? 0),
      uuid: item.uuid,
      referenceUuid: this.#itemReferenceUuid(item)
    }));
    const oldId = operation?.oldItemId ?? "";
    const old = current.find(row => row.id === oldId);
    const candidates = this.#normalClassSpells(actor, "wizard")
      .filter(item => [1, 2].includes(Number(item.system?.level ?? 0)))
      .filter(item => this.#isActionSpell(item))
      .filter(item => !current.some(row => row.id === item.id) || item.id === oldId)
      .filter(item => !old || Number(item.system?.level ?? 0) === old.level)
      .map(item => ({
        id: item.id,
        name: item.name,
        img: item.img,
        level: Number(item.system?.level ?? 0),
        levelLabel: `Level ${item.system.level}`,
        uuid: item.uuid,
        referenceUuid: this.#itemReferenceUuid(item)
      }));
    return { feature: this.#itemSummary(feature), current, oldItemId: oldId, newItemId: operation?.newItemId ?? "", candidates };
  }

  static #cosmicOmenContext(actor, session) {
    const locked = session?.rollLocks?.["cosmic-omen"] ?? null;
    const feature = this.#feature(actor, "cosmic-omen");
    const active = feature?.getFlag(MODULE_ID, "activeCosmicOmen") ?? null;
    return { feature: this.#itemSummary(feature), locked, active, count: 1, formula: "1d6" };
  }

  static #portentContext(actor, session) {
    const locked = session?.rollLocks?.portent ?? null;
    const feature = this.#feature(actor, "portent");
    const active = feature?.getFlag(MODULE_ID, "portentResults") ?? null;
    const count = this.#feature(actor, "greater-portent") ? 3 : 2;
    return { feature: this.#itemSummary(feature), locked, active, count, formula: `${count} × 1d20` };
  }

  static async #scribeContext(actor, registry, operation) {
    const settings = this.#settings();
    const enabled = settings.allowSpellScrollScribing !== false;
    const rawSources = enabled ? await this.#scribeSources(actor, registry) : [];
    const chargeCosts = settings.chargeWizardScribingCosts !== false;
    const requireArcanaCheck = settings.requireArcanaCheckForSpellScrollScribing !== false;
    const chargeOnFailedCheck = settings.chargeScribingCostOnFailedCheck !== false;
    const availableCp = this.#currencyCp(actor);
    const arcanaBonus = this.#arcanaBonus(actor);
    const sources = rawSources.map(row => {
      const rulesCostGp = Number(row.costGp ?? 0);
      const effectiveCostGp = chargeCosts ? rulesCostGp : 0;
      const remainingCp = availableCp - (effectiveCostGp * 100);
      return {
        ...row,
        rulesCostGp,
        effectiveCostGp,
        displayCostGp: effectiveCostGp,
        costLabel: chargeCosts ? `${effectiveCostGp} GP` : `0 GP (rules cost ${rulesCostGp} GP waived)`,
        affordable: remainingCp >= 0,
        availableGpLabel: this.#formatGpFromCp(availableCp),
        remainingGpLabel: remainingCp >= 0 ? this.#formatGpFromCp(remainingCp) : "Insufficient currency",
        requireArcanaCheck,
        arcanaBonus,
        arcanaBonusLabel: arcanaBonus >= 0 ? `+${arcanaBonus}` : String(arcanaBonus),
        chargeOnFailedCheck,
        failureCostLabel: !requireArcanaCheck
          ? "No failure is possible"
          : !chargeCosts
            ? "No GP is charged because scribing costs are disabled"
            : chargeOnFailedCheck
              ? `${effectiveCostGp} GP is charged on failure`
              : "Currency is preserved on failure"
      };
    });
    const selected = sources.find(row => row.sourceItemId === operation?.sourceItemId
      && (!operation?.spellUuid || row.spellUuid === operation.spellUuid)) ?? null;
    return {
      enabled,
      sources,
      selectedSourceItemId: operation?.sourceItemId ?? "",
      selected,
      chargeCosts,
      requireArcanaCheck,
      chargeOnFailedCheck,
      rulesCostGp: Number(selected?.rulesCostGp ?? 0),
      effectiveCostGp: Number(selected?.effectiveCostGp ?? 0),
      timeHours: Number(selected?.timeHours ?? 0),
      availableGpLabel: this.#formatGpFromCp(availableCp),
      remainingGpLabel: selected?.remainingGpLabel ?? this.#formatGpFromCp(availableCp),
      arcanaBonus,
      arcanaBonusLabel: arcanaBonus >= 0 ? `+${arcanaBonus}` : String(arcanaBonus),
      affordable: selected?.affordable ?? true,
      icon: this.#comprehendLanguagesIcon(registry),
      emptyMessage: enabled
        ? (sources.length ? "" : await this.#scribeEmptyMessage(actor, registry))
        : "Spell Scroll scribing is disabled by the GM."
    };
  }

  static async #applyMastery(actor, registry, payload, transactionId) {
    const requested = (payload?.changes ?? []).filter(change => change.oldKey && change.newKey && change.oldKey !== change.newKey);
    if (!requested.length) return { changed: false };

    const classRows = new Map(this.#masteryClasses(actor).map(row => [row.cls.id, row]));
    const candidates = this.#weaponCandidates(registry);
    const candidateByBase = new Map(candidates.map(option => [String(option.baseItem), option]));
    const grouped = new Map();
    for (const change of requested) {
      const rows = grouped.get(change.classItemId) ?? [];
      rows.push(change);
      grouped.set(change.classItemId, rows);
    }

    for (const [classItemId, changes] of grouped) {
      const classRow = classRows.get(classItemId);
      if (!classRow) throw new Error("The class that owns this Weapon Mastery choice no longer exists.");
      if (changes.length > classRow.rule.maxChanges) {
        throw new Error(`${classRow.cls.name} can change at most ${classRow.rule.maxChanges} Weapon Mastery ${classRow.rule.maxChanges === 1 ? "choice" : "choices"} after this Long Rest.`);
      }
      if (new Set(changes.map(change => change.oldKey)).size !== changes.length) {
        throw new Error(`${classRow.cls.name} cannot replace the same Weapon Mastery choice more than once.`);
      }
      if (new Set(changes.map(change => change.newKey)).size !== changes.length) {
        throw new Error(`${classRow.cls.name} cannot choose the same replacement weapon more than once.`);
      }
      for (const change of changes) {
        const baseItem = String(change.newKey).split(":").at(-1);
        const option = candidateByBase.get(baseItem);
        if (!option || !this.#weaponAllowedForMastery(actor, classRow.rule, option)) {
          throw new Error(`${option?.displayLabel ?? this.#weaponLabel(change.newKey)} is not an eligible Weapon Mastery choice for ${classRow.cls.name}.`);
        }
        const expected = `weapon:${option.category}:${option.baseItem}`;
        if (change.newKey !== expected) throw new Error("The selected Weapon Mastery key does not match its official weapon document.");
      }
    }

    const updateByClass = new Map();
    for (const [classItemId, changes] of grouped) {
      const { cls } = classRows.get(classItemId);
      const advancements = cls.toObject().system?.advancement ?? {};
      const replacementByOld = new Map(changes.map(change => [change.oldKey, change.newKey]));
      const foundOld = new Set();
      const update = { _id: cls.id };
      for (const [advancementId, advancement] of Object.entries(advancements)) {
        if (advancement.type !== "Trait" || advancement.configuration?.mode !== "mastery") continue;
        const chosen = (advancement.value?.chosen ?? []).map(value => {
          const replacement = replacementByOld.get(value);
          if (replacement) foundOld.add(value);
          return replacement ?? value;
        });
        if (new Set(chosen).size !== chosen.length) throw new Error(`${cls.name} cannot select the same Weapon Mastery more than once.`);
        if (chosen.some((value, index) => value !== (advancement.value?.chosen ?? [])[index])) {
          update[`system.advancement.${advancementId}.value.chosen`] = chosen;
        }
      }
      for (const change of changes) {
        if (!foundOld.has(change.oldKey)) throw new Error(`${cls.name} no longer owns ${this.#weaponLabel(change.oldKey)} mastery.`);
      }
      updateByClass.set(cls.id, update);
    }

    const projected = [];
    for (const { cls, rows } of this.#masteryClasses(actor)) {
      const replacements = new Map((grouped.get(cls.id) ?? []).map(change => [change.oldKey, change.newKey]));
      for (const row of rows) {
        projected.push(...(row.value?.chosen ?? []).map(value => String(replacements.get(value) ?? value).split(":").at(-1)));
      }
    }
    if (new Set(projected).size !== projected.length) {
      throw new Error("The same weapon cannot be selected more than once across the current Weapon Mastery choices.");
    }

    const updates = [...updateByClass.values()].filter(update => Object.keys(update).length > 1);
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { characterBuilderRuntimeManagement: true });
    const currentRepresented = new Set(
      this.#masteryClasses(actor).flatMap(({ rows }) =>
        rows.flatMap(row => (row.value?.chosen ?? []).map(key => String(key).split(":").at(-1)))
      )
    );
    const existing = new Set(actor.system?.traits?.weaponProf?.mastery?.value ?? []);
    for (const change of requested) existing.delete(String(change.oldKey).split(":").at(-1));
    for (const value of currentRepresented) existing.add(value);
    await actor.update({ "system.traits.weaponProf.mastery.value": [...existing] }, { characterBuilderRuntimeManagement: true });
    for (const { cls, rows } of this.#masteryClasses(actor)) {
      const feature = this.#classFeature(actor, "weapon-mastery", cls.system?.identifier);
      if (!feature) continue;
      const values = rows.flatMap(row => (row.value?.chosen ?? []).map(value => {
        const baseItem = String(value).split(":").at(-1);
        return candidateByBase.get(baseItem)?.displayLabel ?? this.#weaponLabel(value);
      }));
      await this.#reconcileWeaponMasteryBadge(actor, cls, feature, values, transactionId);
    }
    return { changed: true, changes: requested };
  }

  static async #applyEffectChoice(actor, identifier, payload, transactionId) {
    const feature = this.#feature(actor, identifier);
    if (!feature) throw new Error("The feature is no longer present on the Actor.");
    const effectId = payload?.effectId;
    if (!feature.effects.get(effectId)) throw new Error("Choose a valid feature option.");
    const updates = feature.effects.map(effect => ({ _id: effect.id, disabled: effect.id !== effectId }));
    await feature.updateEmbeddedDocuments("ActiveEffect", updates, { characterBuilderRuntimeManagement: true });
    const selected = feature.effects.get(effectId)?.name?.replace(/^.*?:\s*/, "").replace(/^Aspect of the\s+/i, "") ?? "Selected";
    await feature.setFlag(MODULE_ID, "managedFeatureChoice", {
      label: selected, transactionId, classIdentifier: identifier === "aspect-of-the-wilds" ? "barbarian" : "warlock",
      changedAt: Date.now(), changedBy: game.user.id, context: "restManagement"
    });
    await this.#setRuntimeBadge(feature, `runtime-${identifier}`, feature.name, [selected], "fa-solid fa-list-check", transactionId);
    return { changed: true, selected };
  }

  static async #applyActivityChoice(actor, identifier, payload, transactionId) {
    const feature = this.#feature(actor, identifier);
    if (!feature) throw new Error("The feature is no longer present on the Actor.");
    const context = this.#activityChoiceContext(feature, payload);
    const selected = context.options.find(row => row.value === payload?.value || row.label === payload?.label);
    if (!selected) throw new Error("Choose a valid feature option.");
    const classItem = this.#class(actor, "ranger");
    await feature.setFlag(MODULE_ID, "managedFeatureChoice", {
      value: selected.value, label: selected.label, transactionId, classIdentifier: "ranger", classItemId: classItem?.id ?? null,
      acquiredAtCharacterLevel: this.#actorLevel(actor), acquiredAtClassLevel: Number(classItem?.system?.levels ?? 0),
      changedAt: Date.now(), changedBy: game.user.id, context: "restManagement"
    });
    await this.#setRuntimeBadge(feature, `runtime-${identifier}`, feature.name, [selected.label], "fa-solid fa-list-check", transactionId);
    return { changed: true, selected: selected.value, label: selected.label };
  }

  static async #applyLand(actor, registry, payload, transactionId) {
    const land = String(payload?.land ?? "");
    if (!LAND_LABELS[land]) throw new Error("Choose a valid Circle of the Land environment.");
    const cls = this.#class(actor, "druid");
    const subclass = actor.items.find(item => item.type === "subclass" && (item.system?.identifier === "land" || item.system?.classIdentifier === "druid" && /land/i.test(item.name)));
    const feature = this.#feature(actor, "circle-of-the-land-spells");
    if (!cls || !feature) throw new Error("Circle of the Land ownership could not be resolved.");
    const currentLand = feature.getFlag(MODULE_ID, "circleLand")?.id ?? feature.getFlag(MODULE_ID, "circleLand")?.land ?? "";
    if (currentLand === land) return { changed: false, land, reason: "unchanged" };
    const level = Number(cls.system?.levels ?? 0);
    const identifiers = Object.entries(LAND_SPELLS[land]).filter(([minimum]) => level >= Number(minimum)).flatMap(([, rows]) => rows);
    const sources = identifiers.map(identifier => registry.preferredOption("spell", identifier));
    if (sources.some(source => !source)) throw new Error("One or more Circle Spells could not be resolved from the enabled sources.");
    const old = actor.items.filter(item => item.type === "spell" && (item.getFlag(MODULE_ID, "featureSpellOwners") ?? []).some(owner => owner.category === "circle-of-the-land-spells" && owner.featureItemId === feature.id));
    const deleteIds = [];
    for (const spell of old) {
      const remaining = await FeatureSpellOwnershipService.removeOwner(
        spell,
        owner => owner.category === "circle-of-the-land-spells" && owner.featureItemId === feature.id
      );
      const runtime = spell.getFlag(MODULE_ID, "runtimeManagementSpell");
      const dedicatedLandSpell = runtime?.category === "circle-of-the-land-spells"
        || String(spell.system?.sourceItem ?? "") === "subclass:land";
      if (!remaining.length && dedicatedLandSpell) deleteIds.push(spell.id);
    }
    if (deleteIds.length) await actor.deleteEmbeddedDocuments("Item", deleteIds, { characterBuilderRuntimeManagement: true, deleteContents: false });
    const createData = [];
    for (const option of sources) {
      const source = await fromUuid(option.uuid);
      const data = source.toObject(); delete data._id;
      data.system ??= {}; data.system.ability = "wis"; data.system.method = "spell"; data.system.prepared = 2; data.system.sourceItem = "subclass:land";
      data.flags ??= {}; data.flags.dnd5e ??= {}; data.flags.dnd5e.sourceId = source.uuid;
      const owner = {
        category: "circle-of-the-land-spells", label: `${LAND_LABELS[land]} Land Spells`, classIdentifier: "druid",
        classItemId: cls.id, subclassItemId: subclass?.id ?? null, featureItemId: feature.id, ownerItemId: feature.id,
        transactionId, acquiredAtCharacterLevel: this.#actorLevel(actor), acquiredAtClassLevel: level,
        sourceUuid: source.uuid, spellLevel: Number(data.system.level ?? 0), alwaysPrepared: true
      };
      data.flags[MODULE_ID] = {
        ...(data.flags[MODULE_ID] ?? {}), featureGrantedSpell: true, featureSpellOwners: [owner],
        runtimeManagementSpell: { transactionId, category: "circle-of-the-land-spells", land, classItemId: cls.id, featureItemId: feature.id, sourceUuid: source.uuid }
      };
      createData.push(data);
    }
    const created = await actor.createEmbeddedDocuments("Item", createData, { characterBuilderRuntimeManagement: true });
    await feature.setFlag(MODULE_ID, "circleLand", {
      id: land, land, label: LAND_LABELS[land], resistance: LAND_RESISTANCES[land], transactionId,
      classItemId: cls.id, subclassItemId: subclass?.id ?? null, configuredAtDruidLevel: level,
      changedAt: Date.now(), changedBy: game.user.id, context: "restManagement"
    });
    const ward = this.#feature(actor, "natures-ward");
    if (ward) {
      const resistance = LAND_RESISTANCES[land];
      const effects = ward.effects?.contents ?? [...(ward.effects ?? [])];
      const landEffects = effects.filter(effect => /^Nature's Ward:/i.test(effect.name ?? ""));
      const matching = landEffects.find(effect => {
        const namedLand = String(effect.name ?? "").split(":").at(-1)?.trim().toLowerCase();
        const changes = effect.system?.changes?.values
          ? [...effect.system.changes.values()]
          : (effect.system?.changes ?? []);
        return namedLand === land || changes.some(change =>
          change.key === "system.traits.dr.value"
          && String(change.value).toLowerCase() === resistance
        );
      });
      if (!matching) {
        throw new Error(`Nature's Ward does not contain the official ${this.#humanize(land)} (${this.#humanize(resistance)}) resistance effect.`);
      }
      const updates = landEffects.map(effect => ({
        _id: effect.id,
        disabled: effect.id !== matching.id
      }));
      if (updates.length) {
        await ward.updateEmbeddedDocuments("ActiveEffect", updates, { characterBuilderRuntimeManagement: true });
      }
      const active = (ward.effects?.contents ?? [...(ward.effects ?? [])]).filter(effect =>
        /^Nature's Ward:/i.test(effect.name ?? "") && !effect.disabled
      );
      if (active.length !== 1 || active[0].id !== matching.id) {
        throw new Error("Nature's Ward could not activate exactly one official land-resistance effect.");
      }
    }
    await this.#setRuntimeBadge(feature, "circle-land", "Land", [LAND_LABELS[land]], "fa-solid fa-leaf", transactionId);
    return { changed: true, land, createdItemIds: created.map(item => item.id), deletedItemIds: deleteIds };
  }

  static async #applyWildShapeForm(actor, payload, transactionId) {
    const feature = this.#feature(actor, "wild-shape");
    if (!feature) throw new Error("Wild Shape is no longer present.");
    const current = foundry.utils.deepClone(feature.getFlag(MODULE_ID, "knownWildShapeForms") ?? []);
    const index = current.findIndex(row => row.uuid === payload?.oldUuid);
    if (index < 0) throw new Error("Choose a known form to replace.");
    const druidLevel = Number(this.#class(actor, "druid")?.system?.levels ?? 0);
    const { maxCr, flyAllowed } = this.#wildShapeLimits(actor, druidLevel);
    const eligible = await this.#beastOptions({ maxCr, flyAllowed });
    const option = eligible.find(row => row.uuid === payload?.newUuid);
    if (!option) throw new Error("The selected Beast is not an eligible enabled-source form for this Druid level.");
    const source = await fromUuid(option.uuid);
    if (!source || source.type !== "npc") throw new Error("Choose a valid Beast form.");
    const type = source.system?.details?.type?.value ?? source.system?.details?.type;
    const cr = this.#crNumber(source.system?.details?.cr);
    const fly = Number(source.system?.attributes?.movement?.fly ?? 0) > 0;
    if (String(type).toLowerCase() !== "beast" || cr === null || cr > maxCr || (fly && !flyAllowed)) {
      throw new Error("The selected Beast is not eligible for this Druid level.");
    }
    const selectedKey = this.#wildShapeKey({ name: source.name, cr, uuid: source.uuid });
    if (current.some((row, rowIndex) => rowIndex !== index
      && (row.uuid === source.uuid || this.#wildShapeKey(row) === selectedKey))) {
      throw new Error("That Beast is already a known form.");
    }
    current[index] = {
      uuid: source.uuid, name: source.name, img: source.img, cr, fly,
      sourceId: option.sourceId, sourceLabel: option.sourceLabel
    };
    await feature.setFlag(MODULE_ID, "knownWildShapeForms", current);
    await feature.setFlag(MODULE_ID, "knownWildShapeFormsLastChange", { transactionId, changedAt: Date.now(), changedBy: game.user.id });
    await this.#setRuntimeBadge(feature, "known-forms", "Known Forms", current.map(row => row.name), "fa-solid fa-paw", transactionId);
    return { changed: true, forms: current };
  }

  static async #applyCantripReplacement(actor, registry, payload, transactionId) {
    const oldSpell = actor.items.get(payload?.oldItemId);
    if (!oldSpell || oldSpell.type !== "spell" || Number(oldSpell.system?.level ?? -1) !== 0 || !this.#isNormalClassSpell(oldSpell, "wizard")) throw new Error("Choose a valid Wizard cantrip to replace.");
    const dependencyReason = this.#cantripDependencyReason(actor, oldSpell);
    if (dependencyReason) throw new Error(dependencyReason);
    const option = registry.findOption(payload?.newUuid) ?? registry.sourceForUuid(payload?.newUuid);
    const source = option ? await fromUuid(option.uuid) : await fromUuid(payload?.newUuid);
    if (!source || source.type !== "spell" || Number(source.system?.level ?? -1) !== 0) throw new Error("Choose a valid Wizard cantrip.");
    const pool = await this.#classSpellPool("wizard", registry);
    if (!pool.some(row => row.uuid === source.uuid)) throw new Error("The replacement must be a Wizard cantrip from an enabled source.");
    if (actor.items.some(item => item.type === "spell" && item.id !== oldSpell.id && item.system?.identifier === source.system?.identifier)) throw new Error("This Actor already knows that cantrip.");
    const cls = this.#class(actor, "wizard");
    const data = source.toObject(); delete data._id;
    data.system ??= {}; data.system.ability = "int"; data.system.method = "spell";
    SpellPreparationPolicyService.applyToData(data, {
      category: "cantrip-replacement",
      accessModel: "spellbook"
    });
    data.system.sourceItem = "class:wizard";
    data.flags ??= {}; data.flags.dnd5e ??= {}; data.flags.dnd5e.sourceId = source.uuid;
    data.flags[MODULE_ID] = {
      ...(data.flags[MODULE_ID] ?? {}), classSpellAccess: true, classIdentifier: "wizard", classItemId: cls?.id ?? null,
      accessModel: "spellbook", category: "cantrip", runtimeManagementSpell: {
        transactionId, category: "cantrip-replacement", replacedItemId: oldSpell.id,
        replacedIdentifier: oldSpell.system?.identifier, sourceUuid: source.uuid
      }
    };
    await actor.deleteEmbeddedDocuments("Item", [oldSpell.id], { characterBuilderRuntimeManagement: true, deleteContents: false });
    const [created] = await actor.createEmbeddedDocuments("Item", [data], { characterBuilderRuntimeManagement: true });
    return { changed: true, deletedItemId: oldSpell.id, createdItemId: created.id };
  }

  static async #applySpellMastery(actor, payload, transactionId) {
    const oldSpell = actor.items.get(payload?.oldItemId);
    const newSpell = actor.items.get(payload?.newItemId);
    const feature = this.#feature(actor, "spell-mastery");
    const cls = this.#class(actor, "wizard");
    const current = this.#spellMasterySpells(actor);
    if (!feature || !current.includes(oldSpell)) throw new Error("Choose one of the current Spell Mastery spells.");
    if (!newSpell || !this.#isNormalClassSpell(newSpell, "wizard") || Number(newSpell.system?.level ?? 0) !== Number(oldSpell.system?.level ?? -1) || !this.#isActionSpell(newSpell)) throw new Error("Choose an eligible Wizard spell of the same level with an Action casting time.");
    if (current.some(spell => spell.id === newSpell.id)) throw new Error("That spell is already mastered.");
    await FeatureSpellOwnershipService.removeOwner(oldSpell, owner => owner.category === "spell-mastery" && owner.featureItemId === feature.id);
    const oldEffects = oldSpell.effects.filter(effect => effect.getFlag(MODULE_ID, "managedEnchantment") === "spell-mastery").map(effect => effect.id);
    if (oldEffects.length) await oldSpell.deleteEmbeddedDocuments("ActiveEffect", oldEffects, { characterBuilderRuntimeManagement: true });
    const owner = {
      category: "spell-mastery", label: "Spell Mastery", classIdentifier: "wizard", classItemId: cls?.id ?? null,
      subclassItemId: null, featureItemId: feature.id, ownerItemId: feature.id, transactionId,
      acquiredAtCharacterLevel: this.#actorLevel(actor), acquiredAtClassLevel: Number(cls?.system?.levels ?? 0),
      sourceUuid: newSpell.getFlag("dnd5e", "sourceId") ?? newSpell._stats?.compendiumSource ?? null,
      spellLevel: Number(newSpell.system?.level ?? 0), alwaysPrepared: true, freeCastAtBaseLevel: true,
      unlimitedFreeCast: true, requireSlot: false
    };
    await FeatureSpellOwnershipService.addOwner(newSpell, owner, { prepared: 2 });
    await this.#applyNativeEnchantment(newSpell, feature, "spell-mastery");
    await this.#reconcileSpellMasteryBadges(actor, feature, cls, transactionId);
    return { changed: true, oldItemId: oldSpell.id, newItemId: newSpell.id };
  }

  static async #applyRollState(actor, identifier, payload, transactionId) {
    const feature = this.#feature(actor, identifier);
    if (!feature) throw new Error("The rolled feature is no longer present.");
    if (!Array.isArray(payload?.results) || !payload.results.length) throw new Error("Roll this feature before confirming it.");
    const flag = identifier === "portent" ? "portentResults" : "activeCosmicOmen";
    const data = { ...foundry.utils.deepClone(payload), transactionId, activeAt: Date.now(), activeBy: game.user.id };
    await feature.setFlag(MODULE_ID, flag, data);
    const values = identifier === "portent" ? payload.results.map(String) : [payload.omen];
    await this.#setRuntimeBadge(feature, `runtime-${identifier}`, feature.name, values, identifier === "portent" ? "fa-solid fa-dice-d20" : "fa-solid fa-star", transactionId);
    return { changed: true, data };
  }

  static async #applyScribeSpell(actor, registry, payload, transactionId) {
    const settings = this.#settings();
    if (settings.allowSpellScrollScribing === false) {
      throw new Error("Spell Scroll scribing is disabled by the GM.");
    }

    const sourceItem = actor.items.get(payload?.sourceItemId);
    if (!sourceItem) throw new Error("The selected Spell Scroll is no longer present in the inventory.");
    if (Number(sourceItem.system?.quantity ?? 1) < 1) throw new Error("The selected Spell Scroll has no remaining quantity.");

    const sources = await this.#scribeSources(actor, registry);
    const candidate = sources.find(row => row.sourceItemId === sourceItem.id && row.spellUuid === payload?.spellUuid);
    if (!candidate) throw new Error("That Spell Scroll is no longer eligible for this Wizard.");

    const cls = this.#class(actor, "wizard");
    if (!cls) throw new Error("Scribe Spell requires at least one Wizard class level.");
    const level = Number(candidate.level ?? 0);
    const maxLevel = Math.min(9, Math.ceil(Number(cls.system?.levels ?? 0) / 2));
    if (level < 1 || level > maxLevel) {
      throw new Error(`This Wizard can prepare spells only up to level ${maxLevel}; the selected scroll is level ${level}.`);
    }

    const rulesCostGp = level * 50;
    const chargeCosts = settings.chargeWizardScribingCosts !== false;
    const effectiveCostGp = chargeCosts ? rulesCostGp : 0;
    const requireArcanaCheck = settings.requireArcanaCheckForSpellScrollScribing !== false;
    const chargeOnFailedCheck = settings.chargeScribingCostOnFailedCheck !== false;
    const costCp = effectiveCostGp * 100;
    if (this.#currencyCp(actor) < costCp) throw new Error(`Not enough currency to pay ${effectiveCostGp} GP.`);

    const preferred = registry?.preferredOption?.("spell", candidate.identifier) ?? null;
    if (!preferred || preferred.uuid !== candidate.spellUuid) {
      throw new Error("The preferred official spell source is no longer enabled.");
    }
    const source = await registry.document(preferred.uuid);
    if (!source || source.type !== "spell") throw new Error("The official spell document could not be loaded.");
    if (String(source.system?.identifier ?? "") !== String(candidate.identifier ?? "")) {
      throw new Error("The written spell no longer matches the selected official spell source.");
    }
    if (Number(source.system?.level ?? -1) !== level) {
      throw new Error("The written spell level no longer matches the selected official spell source.");
    }
    if (!(await this.#spellOnClassList(candidate.identifier, "wizard"))) {
      throw new Error("The selected written spell is not on the Wizard spell list.");
    }
    if (this.#normalClassSpells(actor, "wizard").some(item => item.system?.identifier === source.system?.identifier)) {
      throw new Error("That spell is already present in this Wizard's spellbook.");
    }

    const arcanaDc = 10 + level;
    let arcanaTotal = null;
    let success = true;
    if (requireArcanaCheck) {
      const rolls = await actor.rollSkill({ skill: "arc", ability: "int" }, { configure: false });
      const roll = rolls?.[0] ?? null;
      if (!roll) throw new Error("The Intelligence (Arcana) check was cancelled; no scribing attempt was applied.");
      arcanaTotal = Number(roll.total ?? 0);
      success = arcanaTotal >= arcanaDc;
    }

    const chargedGp = success
      ? effectiveCostGp
      : (requireArcanaCheck && chargeOnFailedCheck ? effectiveCostGp : 0);
    if (chargedGp) {
      const updates = this.#currencyDeductionUpdates(actor, chargedGp, "gp");
      await actor.update(updates, { characterBuilderRuntimeManagement: true });
    }

    const quantity = Number(sourceItem.system?.quantity ?? 1);
    if (quantity > 1) await sourceItem.update({ "system.quantity": quantity - 1 }, { characterBuilderRuntimeManagement: true });
    else await actor.deleteEmbeddedDocuments("Item", [sourceItem.id], { characterBuilderRuntimeManagement: true, deleteContents: true });

    let created = null;
    if (success) {
      const data = source.toObject();
      delete data._id;
      data.system ??= {};
      data.system.ability = "int";
      data.system.method = "spell";
      data.system.prepared = 0;
      data.system.sourceItem = "class:wizard";
      data.flags ??= {};
      data.flags.dnd5e ??= {};
      data.flags.dnd5e.sourceId = source.uuid;
      data.flags[MODULE_ID] = {
        ...(data.flags[MODULE_ID] ?? {}),
        classSpellAccess: true,
        classIdentifier: "wizard",
        classItemId: cls.id,
        accessModel: "spellbook",
        category: "spellbook",
        runtimeManagementSpell: {
          transactionId,
          category: "scribe-spell",
          sourceItemId: sourceItem.id,
          sourceUuid: source.uuid,
          writtenSourceUuid: candidate.writtenSpellUuid,
          scribedAt: Date.now(),
          rulesCostGp,
          chargedGp,
          timeHours: level * 2,
          checkRequired: requireArcanaCheck,
          arcanaDc: requireArcanaCheck ? arcanaDc : null,
          arcanaTotal
        }
      };
      [created] = await actor.createEmbeddedDocuments("Item", [data], { characterBuilderRuntimeManagement: true });
    }

    const icon = this.#escapeHtml(this.#comprehendLanguagesIcon(registry));
    const spellName = this.#escapeHtml(source.name);
    const resultLabel = success ? (requireArcanaCheck ? "Success" : "Automatic Success") : "Failure";
    const checkMarkup = requireArcanaCheck
      ? `<div class="cb-scribe-chat-check"><span>Intelligence (Arcana)</span><strong>${arcanaTotal} vs. DC ${arcanaDc} — ${resultLabel}</strong></div>`
      : `<div class="cb-scribe-chat-check"><span>Resolution</span><strong>Automatic Success — Arcana check disabled by the GM</strong></div>`;
    const currencyText = chargedGp
      ? `${chargedGp} GP spent`
      : (!chargeCosts ? "GP cost waived by the GM" : (!success ? "Currency preserved on failure" : "No GP spent"));
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<article class="cb-scribe-chat-card"><header><img src="${icon}" alt=""><div><span>Scribe Spell to Spellbook</span><h3>${spellName}</h3><small>Level ${level} spell · ${level * 2} hours</small></div></header>${checkMarkup}<ul><li><i class="fa-solid fa-scroll"></i><span>Spell Scroll destroyed</span></li><li><i class="fa-solid fa-coins"></i><span>${this.#escapeHtml(currencyText)}</span></li><li><i class="fa-solid fa-book"></i><span>${success ? `${spellName} added to the spellbook` : `${spellName} was not copied`}</span></li></ul></article>`
    });

    return {
      changed: true,
      success,
      automaticSuccess: !requireArcanaCheck,
      createdItemId: created?.id ?? null,
      consumedSourceItemId: sourceItem.id,
      sourceUuid: source.uuid,
      writtenSourceUuid: candidate.writtenSpellUuid,
      rulesCostGp,
      chargedGp,
      timeHours: level * 2,
      checkRequired: requireArcanaCheck,
      arcanaDc: requireArcanaCheck ? arcanaDc : null,
      arcanaTotal
    };
  }

  static async #scribeEmptyMessage(actor, registry) {
    if (this.#settings().allowSpellScrollScribing === false) return "Spell Scroll scribing is disabled by the GM.";
    const cls = this.#class(actor, "wizard");
    if (!cls) return "Scribe Spell requires at least one Wizard class level.";
    const scrolls = actor.items.filter(item => item.type === "consumable"
      && (String(item.system?.type?.value ?? "").toLowerCase() === "scroll"
        || /spell scroll|scroll of/i.test(item.name)));
    if (!scrolls.length) return "No compatible Spell Scroll is currently present in this Wizard's inventory.";

    const maxLevel = Math.min(9, Math.ceil(Number(cls.system?.levels ?? 0) / 2));
    const known = new Set(this.#normalClassSpells(actor, "wizard").map(item => item.system?.identifier));
    let resolvedCount = 0;
    let wizardCount = 0;
    let knownCount = 0;
    let aboveLevelCount = 0;

    for (const scroll of scrolls) {
      const candidates = await this.#resolveWrittenScrollSpells(scroll, registry);
      resolvedCount += candidates.length;
      for (const candidate of candidates) {
        if (!(await this.#spellOnClassList(candidate.identifier, "wizard"))) continue;
        wizardCount += 1;
        if (known.has(candidate.identifier)) knownCount += 1;
        else if (Number(candidate.level ?? 0) > maxLevel) aboveLevelCount += 1;
      }
    }

    if (!resolvedCount) return "Spell Scrolls were found, but their written spells could not be matched unambiguously to an enabled official source.";
    if (!wizardCount) return "Written spells were found, but none are on the Wizard spell list.";
    if (knownCount === wizardCount) return "Every compatible written Wizard spell in the inventory is already present in this spellbook.";
    if (aboveLevelCount) return `A written Wizard spell was found, but it is above the maximum spell level this Wizard can prepare (level ${maxLevel}).`;
    return "No eligible written Wizard spell is currently available to scribe.";
  }

  static async #scribeSources(actor, registry) {
    if (this.#settings().allowSpellScrollScribing === false) return [];
    const cls = this.#class(actor, "wizard");
    if (!cls || !registry) return [];
    const maxLevel = Math.min(9, Math.ceil(Number(cls.system?.levels ?? 0) / 2));
    const known = new Set(this.#normalClassSpells(actor, "wizard").map(item => item.system?.identifier));
    const rows = [];
    const claimed = new Set();

    for (const sourceItem of actor.items.filter(item => item.type === "consumable")) {
      const type = String(sourceItem.system?.type?.value ?? "").toLowerCase();
      if (!(type === "scroll" || /spell scroll|scroll of/i.test(sourceItem.name))) continue;

      const writtenCandidates = await this.#resolveWrittenScrollSpells(sourceItem, registry);
      for (const written of writtenCandidates) {
        const level = Number(written.level ?? 0);
        const identifier = String(written.identifier ?? "");
        if (!identifier || level < 1 || level > maxLevel || known.has(identifier)) continue;
        if (!(await this.#spellOnClassList(identifier, "wizard"))) continue;

        // The written Item identifies the spell, while the spell added to the
        // Actor comes from the highest-priority enabled Builder source.
        const preferred = registry.preferredOption("spell", identifier);
        if (!preferred) continue;
        const preferredLevel = Number(preferred.system?.level ?? level);
        if (!Number.isFinite(preferredLevel) || preferredLevel !== level) continue;
        const key = `${sourceItem.id}:${identifier}`;
        if (claimed.has(key)) continue;
        claimed.add(key);
        rows.push({
          sourceItemId: sourceItem.id,
          sourceItemName: sourceItem.name,
          sourceItemImg: sourceItem.img,
          spellUuid: preferred.uuid,
          spellName: preferred.name,
          spellImg: preferred.img,
          identifier,
          level,
          levelLabel: `Level ${level}`,
          costGp: level * 50,
          timeHours: level * 2,
          arcanaDc: 10 + level,
          sourceUuid: preferred.uuid,
          writtenSpellUuid: written.writtenSpellUuid ?? preferred.uuid,
          detectionMethod: written.detectionMethod
        });
      }
    }
    return rows.sort((a, b) => a.level - b.level || a.spellName.localeCompare(b.spellName, game.i18n.lang));
  }

  static async #resolveWrittenScrollSpells(sourceItem, registry) {
    const resolved = new Map();
    const explicitUuids = new Set();
    const activities = sourceItem.system?.activities?.values
      ? [...sourceItem.system.activities.values()]
      : Object.values(sourceItem.system?.activities ?? {});
    for (const activity of activities) {
      const uuid = activity?.spell?.uuid ?? activity?.system?.spell?.uuid ?? null;
      if (uuid) explicitUuids.add(String(uuid));
    }
    const effects = sourceItem.effects?.contents ?? [...(sourceItem.effects ?? [])];
    for (const effect of effects) {
      const origin = String(effect?.origin ?? effect?._source?.origin ?? "");
      if (origin) explicitUuids.add(origin);
    }

    for (const uuid of explicitUuids) {
      let writtenSpell = null;
      try {
        const document = await fromUuid(uuid);
        writtenSpell = document?.type === "spell" ? document : (document?.parent?.type === "spell" ? document.parent : null);
      } catch (_error) { writtenSpell = null; }
      if (!writtenSpell) continue;
      const identifier = String(writtenSpell.system?.identifier ?? "");
      const level = Number(writtenSpell.system?.level ?? 0);
      if (!identifier || !Number.isFinite(level) || level < 1) continue;
      resolved.set(identifier, {
        identifier,
        level,
        writtenSpellUuid: writtenSpell.uuid ?? uuid,
        detectionMethod: "official-document-link"
      });
    }

    // D&D5e 5.3.3 materializes many native Spell Scrolls as ordinary
    // activities (attack/save/utility) without activity.spell.uuid. In that
    // native format, resolve the exact spell name and level against enabled
    // official source indexes, accepting only one unambiguous identifier.
    const scrollLevel = this.#nativeScrollLevel(sourceItem);
    const scrollSpellName = this.#nativeScrollSpellName(sourceItem.name);
    if (scrollLevel >= 1 && scrollSpellName) {
      const matches = this.#registrySpellOptions(registry).filter(option =>
        Number(option.system?.level ?? -1) === scrollLevel
        && this.#normalizeName(option.name) === this.#normalizeName(scrollSpellName)
      );
      const identifiers = [...new Set(matches.map(option => String(option.identifier ?? "")).filter(Boolean))];
      if (identifiers.length === 1 && !resolved.has(identifiers[0])) {
        const preferred = registry.preferredOption("spell", identifiers[0]);
        if (preferred && Number(preferred.system?.level ?? -1) === scrollLevel) {
          resolved.set(identifiers[0], {
            identifier: identifiers[0],
            level: scrollLevel,
            writtenSpellUuid: preferred.uuid,
            detectionMethod: "native-scroll-name-level"
          });
        }
      }
    }

    return [...resolved.values()];
  }

  static #nativeScrollLevel(sourceItem) {
    const value = sourceItem.getFlag?.("dnd5e", "spellLevel")?.value
      ?? sourceItem.getFlag?.("dnd5e", "spellLevel")?.base
      ?? sourceItem.flags?.dnd5e?.spellLevel?.value
      ?? sourceItem.flags?.dnd5e?.spellLevel?.base;
    const level = Number(value);
    return Number.isFinite(level) ? level : 0;
  }

  static #nativeScrollSpellName(name) {
    const text = String(name ?? "").trim();
    const match = text.match(/^(?:spell\s+scroll\s*:\s*|scroll\s+of\s+)(.+)$/i);
    return String(match?.[1] ?? "").trim();
  }

  static #registrySpellOptions(registry) {
    return registry.optionsByType("spell").flatMap(group => group.items ?? []);
  }

  static #normalizeName(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/gi, " ")
      .trim()
      .toLowerCase();
  }

  static #normalClassSpells(actor, classIdentifier, { level = null } = {}) {
    return actor.items.filter(item => item.type === "spell"
      && (level == null || Number(item.system?.level ?? -1) === Number(level))
      && this.#isNormalClassSpell(item, classIdentifier));
  }

  static #isNormalClassSpell(item, classIdentifier) {
    const owners = item.getFlag(MODULE_ID, "featureSpellOwners") ?? [];
    if (owners.length) return false;
    const identifier = item.getFlag(MODULE_ID, "classIdentifier")
      ?? item.getFlag(MODULE_ID, "classSpellAccess")?.classIdentifier
      ?? item.getFlag(MODULE_ID, "levelUpSpell")?.classIdentifier
      ?? (String(item.system?.sourceItem ?? "").startsWith("class:") ? String(item.system.sourceItem).slice(6) : null);
    return identifier === classIdentifier;
  }

  static #cantripDependencyReason(actor, spell) {
    const augments = spell?.getFlag?.(MODULE_ID, "eldritchInvocationAugments") ?? [];
    if (augments.length) return `${spell.name} cannot be replaced while it is targeted by ${augments.map(row => row.name).filter(Boolean).join(", ") || "an Eldritch Invocation"}.`;
    const dependent = actor.items.find(item => item.type === "feat"
      && item.getFlag(MODULE_ID, "invocationInstance")?.targetCantripItemId === spell?.id);
    return dependent ? `${spell.name} cannot be replaced while it is targeted by ${dependent.name}.` : "";
  }

  static #spellMasterySpells(actor) {
    const feature = this.#feature(actor, "spell-mastery");
    if (!feature) return [];
    return actor.items.filter(item => item.type === "spell" && (item.getFlag(MODULE_ID, "featureSpellOwners") ?? []).some(owner => owner.category === "spell-mastery" && owner.featureItemId === feature.id));
  }

  static #isActionSpell(item) {
    if (String(item.system?.activation?.type ?? "") === "action") return true;
    const activities = item.system?.activities?.values ? [...item.system.activities.values()] : Object.values(item.system?.activities ?? {});
    return activities.some(activity => String(activity.activation?.type ?? "") === "action");
  }

  static #mordenkainensSwordIcon(registry) {
    const options = this.#registrySpellOptions(registry);
    const match = options.find(option => option.sourceId === "phb2024"
      && (this.#normalizeName(option.name) === "mordenkainens sword"
        || this.#normalizeName(option.identifier) === "mordenkainens sword"));
    return match?.img ?? "icons/weapons/swords/sword-runed-glowing.webp";
  }

  static #comprehendLanguagesIcon(registry) {
    const direct = registry?.optionsForKey?.("spell", "comprehend-languages") ?? [];
    const named = this.#registrySpellOptions(registry).filter(option =>
      this.#normalizeName(option.name) === "comprehend languages"
      || this.#normalizeName(option.identifier) === "comprehend languages"
    );
    const options = direct.length ? direct : named;
    return options.find(option => option.sourceId === "phb2024")?.img
      ?? options.find(option => option.sourceId === "srd52")?.img
      ?? options[0]?.img
      ?? "systems/dnd5e/icons/svg/ink-pot.svg";
  }

  static #arcanaBonus(actor) {
    const derived = Number(actor.system?.skills?.arc?.total ?? actor.system?.skills?.arc?.mod);
    if (Number.isFinite(derived)) return derived;
    const intelligence = Number(actor.system?.abilities?.int?.value ?? 10);
    const abilityModifier = Math.floor((intelligence - 10) / 2);
    const proficiencyMultiplier = Number(actor.system?.skills?.arc?.value ?? 0);
    const proficiencyBonus = Number(actor.system?.attributes?.prof
      ?? Math.ceil(Math.max(1, this.#actorLevel(actor)) / 4) + 1);
    return abilityModifier + Math.floor(proficiencyMultiplier * proficiencyBonus);
  }

  static #formatGpFromCp(cp) {
    const value = Number(cp ?? 0) / 100;
    return Number.isInteger(value) ? `${value} GP` : `${value.toFixed(2).replace(/\.00$/, "")} GP equivalent`;
  }

  static #escapeHtml(value) {
    return foundry.utils.escapeHTML(String(value ?? ""));
  }

  static async #reconcileWeaponMasteryBadge(actor, cls, feature, values, transactionId) {
    const classIdentifier = String(cls.system?.identifier ?? "");
    const badge = RuntimeBadgeReconciliationService.runtimeBadge({
      targetItem: feature,
      category: "Weapon Mastery",
      values,
      kind: "runtime-weapon-mastery",
      icon: "fa-solid fa-list-check",
      transactionId,
      classIdentifier,
      classLevel: Number(cls.system?.levels ?? 0),
      sourceItemId: cls.id,
      advancementId: feature.id
    });
    await RuntimeBadgeReconciliationService.reconcile(actor, {
      matches: (item, existing) => {
        const category = this.#normalizeName(existing?.category ?? existing?.advancementTitle);
        if (category !== "weapon mastery") return false;
        return item.id === feature.id
          || existing?.targetItemId === feature.id
          || existing?.sourceItemId === cls.id
          || existing?.classIdentifier === classIdentifier;
      },
      additions: badge ? [{ itemId: feature.id, badge }] : []
    });
  }

  static async #reconcileSpellMasteryBadges(actor, feature, cls, transactionId) {
    const mastered = this.#spellMasterySpells(actor);
    const additions = mastered.map(spell => ({
      itemId: spell.id,
      badge: RuntimeBadgeReconciliationService.runtimeBadge({
        targetItem: spell,
        category: "Spell Mastery",
        values: [spell.name],
        kind: "feature-spell",
        icon: "fa-solid fa-infinity",
        transactionId,
        classIdentifier: "wizard",
        classLevel: Number(cls?.system?.levels ?? 0),
        sourceItemId: feature.id,
        advancementId: feature.id,
        advancementType: "ManagedFeatureSpell",
        advancementTitle: "Spell Mastery",
        label: "Spell Mastery",
        tooltip: `Spell Mastery · ${spell.name} · Free at base level; upcasting requires a spell slot`
      })
    }));
    await RuntimeBadgeReconciliationService.reconcile(actor, {
      matches: (_item, existing) => {
        const category = this.#normalizeName(existing?.category ?? existing?.advancementTitle);
        return category === "spell mastery"
          || existing?.kind === "runtime-spell-mastery"
          || (existing?.kind === "feature-spell" && category === "spell mastery");
      },
      additions
    });
  }

  static async #reconcilePactOfTheTomeBadge(actor, transactionId) {
    const invocation = PactOfTheTomeService.findInvocation(actor);
    if (!invocation) return;
    const instance = invocation.getFlag(MODULE_ID, "invocationInstance") ?? {};
    const cantrips = (instance.selectedCantrips ?? []).map(row => row?.name ?? row).filter(Boolean);
    const rituals = (instance.selectedRituals ?? []).map(row => row?.name ?? row).filter(Boolean);
    const values = [...new Set([...cantrips, ...rituals])];
    const cls = this.#class(actor, "warlock");
    const badge = RuntimeBadgeReconciliationService.runtimeBadge({
      targetItem: invocation,
      category: invocation.name,
      values,
      kind: "invocation-choice",
      icon: "fa-solid fa-eye",
      transactionId,
      classIdentifier: "warlock",
      classLevel: Number(cls?.system?.levels ?? 0),
      sourceItemId: cls?.id ?? invocation.id,
      advancementId: instance.advancementId ?? invocation.id,
      advancementType: "ManagedInvocationChoice",
      advancementTitle: invocation.name
    });
    await RuntimeBadgeReconciliationService.reconcile(actor, {
      matches: (item, existing) => {
        if (item.id !== invocation.id && existing?.targetItemId !== invocation.id) return false;
        const category = this.#normalizeName(existing?.category ?? existing?.advancementTitle);
        return existing?.kind === "invocation-choice"
          && (category === this.#normalizeName(invocation.name)
            || existing?.advancementId === (instance.advancementId ?? invocation.id));
      },
      additions: badge ? [{ itemId: invocation.id, badge }] : []
    });
  }

  static async #applyNativeEnchantment(spell, feature, special) {
    const existing = spell.effects.find(effect => effect.getFlag(MODULE_ID, "managedEnchantment") === special);
    if (existing) return;
    const profile = feature.effects.find(effect => effect.type === "enchantment");
    if (!profile) return;
    const data = profile.toObject(); const profileId = data._id; delete data._id;
    data.disabled = false; data.flags ??= {}; data.flags.dnd5e ??= {}; data.flags.dnd5e.enchantmentProfile = profileId;
    data.origin = feature.uuid; data.flags.core ??= {}; data.flags.core.originText = feature.uuid;
    data.flags[MODULE_ID] ??= {}; data.flags[MODULE_ID].managedEnchantment = special;
    await spell.createEmbeddedDocuments("ActiveEffect", [data], { characterBuilderRuntimeManagement: true });
  }

  static async #removeRuntimeBadge(item, kind) {
    const current = foundry.utils.deepClone(item.getFlag(MODULE_ID, "advancementChoiceBadges") ?? []);
    const filtered = current.filter(badge => badge.kind !== kind);
    if (filtered.length === current.length) return;
    await item.setFlag(MODULE_ID, "advancementChoiceBadges", filtered);
  }

  static async #setRuntimeBadge(item, kind, category, values, icon, transactionId) {
    const current = foundry.utils.deepClone(item.getFlag(MODULE_ID, "advancementChoiceBadges") ?? []);
    const filtered = current.filter(badge => badge.kind !== kind && !(kind === "circle-land" && badge.kind === "circle-land") && !(kind === "known-forms" && badge.kind === "known-forms"));
    const distinct = [...new Set(values.filter(Boolean))];
    const label = distinct.length <= 2 ? `${category} [${distinct.join(", ")}]` : `${category} [${distinct.slice(0, 2).join(", ")} +${distinct.length - 2}]`;
    filtered.push({
      advancementId: item.id, advancementType: "RuntimeManagement", advancementTitle: category,
      level: 0, kind, icon, category, values: distinct, label, tooltip: `${category}: ${distinct.join(", ")}`,
      context: "restManagement", transactionId, characterLevel: this.#actorLevel(item.actor),
      classIdentifier: null, classLevel: null, sourceItemId: item.id, targetItemId: item.id
    });
    await item.setFlag(MODULE_ID, "advancementChoiceBadges", filtered);
  }

  static async #classSpellPool(identifier, registry) {
    const spellLists = globalThis.dnd5e?.registry?.spellLists;
    if (!spellLists) return [];
    for (let attempt = 0; attempt < 20 && !spellLists.ready; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    const list = spellLists.forType("class", identifier);
    if (!list) return [];
    const options = new Map();
    for (const index of list.indexes) {
      const id = index.system?.identifier;
      const preferred = id ? registry.preferredOption("spell", id) : null;
      if (preferred) options.set(id, preferred);
    }
    return [...options.values()].sort((a, b) => Number(a.system?.level ?? 0) - Number(b.system?.level ?? 0) || a.name.localeCompare(b.name, game.i18n.lang));
  }

  static async #spellOnClassList(identifier, classIdentifier) {
    const spellLists = globalThis.dnd5e?.registry?.spellLists;
    if (!spellLists) return false;
    for (let attempt = 0; attempt < 20 && !spellLists.ready; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    const list = spellLists.forType("class", classIdentifier);
    return Boolean(list?.indexes?.some(index => index.system?.identifier === identifier));
  }

  static async #beastOptions({ maxCr, flyAllowed }) {
    const options = [];
    const sources = (await import("./source-registry.mjs")).SourceRegistry.orderedSources();
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
          if (cr === null || cr > maxCr) continue;
          const fly = Number(foundry.utils.getProperty(entry, "system.attributes.movement.fly") ?? 0) > 0;
          if (fly && !flyAllowed) continue;
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
    return options
      .sort((a, b) => a.sourceRank - b.sourceRank || a.cr - b.cr || a.name.localeCompare(b.name, game.i18n.lang))
      .filter(option => {
        const key = `${option.name.toLowerCase()}:${option.cr}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      });
  }

  static #wildShapeLimits(actor, druidLevel) {
    const cls = this.#class(actor, "druid");
    if (!cls) throw new Error("Wild Shape Known Forms requires a Druid class Item.");
    const raw = this.#scaleRawValue(cls, druidLevel, "wild shape cr");
    const maxCr = this.#crNumber(raw);
    if (maxCr === null) {
      throw new Error("Wild Shape Known Forms cannot be offered because the class Wild Shape CR scale is missing or non-numeric.");
    }
    return { maxCr, flyAllowed: Number(druidLevel) >= 8 };
  }

  static #scaleRawValue(cls, level, title) {
    const advancements = cls?.toObject?.().system?.advancement ?? cls?.system?.advancement ?? {};
    const advancement = Object.values(advancements).find(entry => entry.type === "ScaleValue"
      && String(entry.title ?? "").toLowerCase().includes(String(title).toLowerCase()));
    const rows = Object.entries(advancement?.configuration?.scale ?? {})
      .map(([minimum, row]) => [Number(minimum), row?.value])
      .filter(([minimum]) => Number.isFinite(minimum) && minimum <= Number(level))
      .sort((a, b) => a[0] - b[0]);
    return rows.at(-1)?.[1] ?? null;
  }

  static #maximumSpellLevel(progression, level) {
    const value = Number(level ?? 0);
    if (value <= 0) return 0;
    switch (String(progression ?? "")) {
      case "full": return Math.min(9, Math.ceil(value / 2));
      case "half": return Math.min(5, Math.max(1, Math.floor((value + 3) / 4)));
      case "third": return Math.min(4, Math.max(1, Math.floor((value + 2) / 3)));
      case "pact": return Math.min(5, Math.ceil(value / 2));
      default: return 0;
    }
  }

  static #itemReferenceUuid(item) {
    return item?.getFlag?.("dnd5e", "sourceId")
      ?? item?._stats?.compendiumSource
      ?? item?.uuid
      ?? null;
  }

  static #itemSummary(item) {
    return item ? {
      id: item.id,
      name: item.name,
      img: item.img,
      identifier: item.system?.identifier,
      uuid: item.uuid,
      referenceUuid: this.#itemReferenceUuid(item)
    } : null;
  }
  static #settings() {
    return foundry.utils.mergeObject({
      allowSpellScrollScribing: true,
      chargeWizardScribingCosts: true,
      requireArcanaCheckForSpellScrollScribing: true,
      chargeScribingCostOnFailedCheck: true
    }, game.settings.get(MODULE_ID, "settings") ?? {}, { inplace: false });
  }
  static #currencyCp(actor) { return Object.entries(actor.system?.currency ?? {}).reduce((sum, [key, value]) => sum + Number(value ?? 0) * Number(CURRENCY_CP[key] ?? 0), 0); }
  static #currencyDeductionUpdates(actor, amount, denomination = "gp") {
    const manager = globalThis.dnd5e?.applications?.CurrencyManager;
    if (manager?.getActorCurrencyUpdates) {
      const { item: _item, remainder, ...updates } = manager.getActorCurrencyUpdates(
        actor,
        Number(amount),
        denomination,
        { exact: true, makeChange: true, priority: "low" }
      );
      if (Math.abs(Number(remainder ?? 0)) > 1e-8) {
        throw new Error(`Not enough currency to pay ${amount} ${String(denomination).toUpperCase()}.`);
      }
      return updates;
    }

    // Compatibility fallback for unsupported systems. Foundry D&D5e 5.3.3
    // uses CurrencyManager above, which preserves denominations and makes
    // change. The fallback is intentionally isolated and never used there.
    const multiplier = Number(CURRENCY_CP[denomination] ?? 0);
    const remainingTotal = this.#currencyCp(actor) - (Number(amount) * multiplier);
    if (!multiplier || remainingTotal < 0) throw new Error(`Not enough currency to pay ${amount} ${String(denomination).toUpperCase()}.`);
    let remaining = Math.trunc(remainingTotal);
    const currency = {};
    for (const key of ["pp", "gp", "ep", "sp", "cp"]) {
      const value = Number(CURRENCY_CP[key] ?? 0);
      currency[key] = value ? Math.floor(remaining / value) : 0;
      remaining %= value || 1;
    }
    return { system: { currency } };
  }
  static #weaponMasteryLabel(value) {
    const key = String(value ?? "");
    const label = CONFIG.DND5E.weaponMasteries?.[key]?.label;
    return label ? game.i18n.localize(label) : (key ? this.#humanize(key) : "");
  }
  static #weaponLabel(value) { const key = String(value ?? "").split(":").at(-1); return CONFIG.DND5E.weaponIds?.[key]?.label ? game.i18n.localize(CONFIG.DND5E.weaponIds[key].label) : this.#humanize(key); }
  static #humanize(value) { return String(value ?? "").replace(/[-_]+/g, " ").replace(/\b\w/g, match => match.toUpperCase()); }
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
      return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 && result >= 0 ? result : null;
    }
    const number = Number(text);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }
  static #wildShapeKey(value) {
    const name = String(value?.name ?? "").trim().toLocaleLowerCase();
    const cr = this.#crNumber(value?.cr);
    if (name && cr !== null) return `${name}:${cr}`;
    const uuid = String(value?.uuid ?? "").trim();
    return uuid ? `uuid:${uuid}` : null;
  }
  static #crLabel(value) { if (value === 0.125) return "1/8"; if (value === 0.25) return "1/4"; if (value === 0.5) return "1/2"; return String(value); }
}
