import { MODULE_ID } from "../constants.mjs";
import { AgonizingBlastBindingService } from "./agonizing-blast-binding-service.mjs";
import { RulesAssistanceFormulaService } from "./rules-assistance-formula-service.mjs";
import { MageArmorAssistanceService } from "./mage-armor-assistance-service.mjs";
import { BardicInspirationAssistanceService } from "./bardic-inspiration-assistance-service.mjs";
import { LayOnHandsAssistanceService } from "./lay-on-hands-assistance-service.mjs";
import { ContextualRollModifierService } from "./contextual-roll-modifier-service.mjs";
import { EffectLifecycleService } from "./effect-lifecycle-service.mjs";
import { NativeContextualEffectService } from "./native-contextual-effect-service.mjs";
import { NativeSaveGatedEffectService } from "./native-save-gated-effect-service.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULES = Object.freeze({
  GREAT_WEAPON_FIGHTING: "great-weapon-fighting",
  THROWN_WEAPON_FIGHTING: "thrown-weapon-fighting",
  CLERIC_POTENT_SPELLCASTING: "cleric-potent-spellcasting",
  DRUID_POTENT_SPELLCASTING: "druid-potent-spellcasting",
  EMPOWERED_EVOCATION: "empowered-evocation"
});

/**
 * Silent runtime assistance for deterministic mechanics that the D&D5e system
 * does not complete natively. The service modifies only the current native roll
 * configuration and never persists duplicate Items, Activities, or formulas.
 */
export class RulesAssistanceService {
  static #initialized = false;
  static #casts = new Map();
  static #audit = new Map();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    AgonizingBlastBindingService.initialize();
    MageArmorAssistanceService.initialize();
    BardicInspirationAssistanceService.initialize();
    LayOnHandsAssistanceService.initialize();
    ContextualRollModifierService.initialize();
    EffectLifecycleService.initialize();
    NativeContextualEffectService.initialize();
    NativeSaveGatedEffectService.initialize();

    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig, dialogConfig, messageConfig) =>
      this.#prepareCast(activity, usageConfig, dialogConfig, messageConfig)
    );
    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) =>
      this.#confirmCast(activity, usageConfig, results)
    );
    Hooks.on("dnd5e.preRollDamage", (process, dialog, message) =>
      this.#prepareDamageProcess(process, dialog, message)
    );
    Hooks.on("dnd5e.postBuildDamageRollConfig", (process, rollConfig, index, options) =>
      this.#applyDamageRules(process, rollConfig, index, options)
    );
    Hooks.on("dnd5e.rollDamage", (rolls, data) => this.#finalizeDamageRoll(rolls, data));
  }

  static async ready() {
    await AgonizingBlastBindingService.ready();
    await MageArmorAssistanceService.ready();
    await BardicInspirationAssistanceService.ready();
    await LayOnHandsAssistanceService.ready();
    await NativeContextualEffectService.ready();
    await NativeSaveGatedEffectService.ready();
  }

  static enabled() {
    return RulesAssistanceSettingsService.masterEnabled();
  }

  static ruleEnabled(ruleId) {
    return RulesAssistanceSettingsService.ruleEnabled(ruleId);
  }

  static async refresh() {
    this.#casts.clear();
    if (this.ruleEnabled("agonizing-blast-native-binding")) {
      await AgonizingBlastBindingService.ready();
    }
  }

  static async reconcileActor(actor) {
    await NativeContextualEffectService.reconcileActor(actor, { reason: "api" });
    await NativeSaveGatedEffectService.reconcileActor(actor, { reason: "api" });
    return AgonizingBlastBindingService.reconcileActor(actor, { reason: "api" });
  }

  static contextualRollModifierApi() {
    return ContextualRollModifierService.api();
  }

  static bindManagedEffectData(effectData, lifecycle = {}) {
    return EffectLifecycleService.bindEffectData(effectData, lifecycle);
  }

  static createManagedEffect(actor, effectData, lifecycle = {}) {
    return EffectLifecycleService.createManagedEffect(actor, effectData, lifecycle);
  }

  static diagnostics(actor) {
    const actorId = actor?.id ?? actor;
    const rows = this.#audit.get(String(actorId ?? "")) ?? [];
    return [
      ...rows.map(row => ({ ...row })),
      ...MageArmorAssistanceService.diagnostics(actor),
      ...BardicInspirationAssistanceService.diagnostics(actor),
      ...LayOnHandsAssistanceService.diagnostics(actor),
      ...ContextualRollModifierService.diagnostics(actor),
      ...EffectLifecycleService.diagnostics(actor),
      ...NativeContextualEffectService.diagnostics(actor),
      ...NativeSaveGatedEffectService.diagnostics(actor)
    ].sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0));
  }

  static #prepareCast(activity, usageConfig, _dialogConfig, messageConfig) {
    if (!this.ruleEnabled(RULES.EMPOWERED_EVOCATION) || !this.#qualifiesEmpoweredEvocation(activity)) return;
    if (!this.#isRealSpellCast(activity)) return;

    const castId = foundry.utils.randomID?.(24) ?? crypto.randomUUID();
    usageConfig.dnd5eCharacterBuilderRulesAssistance ??= {};
    usageConfig.dnd5eCharacterBuilderRulesAssistance.empoweredEvocationCastId = castId;
    foundry.utils.setProperty(
      messageConfig,
      `data.flags.${MODULE_ID}.rulesAssistance.empoweredEvocationCastId`,
      castId
    );
  }

  static #confirmCast(activity, usageConfig, results) {
    if (!this.ruleEnabled(RULES.EMPOWERED_EVOCATION) || !this.#qualifiesEmpoweredEvocation(activity)) return;
    const castId = usageConfig?.dnd5eCharacterBuilderRulesAssistance?.empoweredEvocationCastId;
    if (!castId) return;

    const actor = activity.actor;
    const item = activity.item;
    const messageId = results?.message?.id ?? results?.message?._id ?? null;
    const key = this.#castKey(actor, item);
    const rows = this.#casts.get(key) ?? [];
    rows.push({
      castId,
      actorId: actor?.id ?? null,
      itemId: item?.id ?? null,
      activityId: activity?.id ?? null,
      messageId,
      createdAt: Date.now(),
      used: false
    });
    this.#casts.set(key, this.#pruneCasts(rows).slice(-12));
  }

  static #prepareDamageProcess(process, _dialog, message) {
    if (!this.enabled()) return;
    const activity = process?.subject;
    if (!activity) return;

    process.dnd5eCharacterBuilderRulesAssistance ??= {};
    const context = process.dnd5eCharacterBuilderRulesAssistance;
    context.activityId = activity.id ?? null;
    context.itemId = activity.item?.id ?? null;
    context.actorId = activity.actor?.id ?? null;

    if (this.ruleEnabled(RULES.GREAT_WEAPON_FIGHTING)
      && this.#qualifiesGreatWeaponFighting(activity, process)) context.greatWeaponFighting = true;
    if (this.ruleEnabled(RULES.THROWN_WEAPON_FIGHTING)
      && this.#qualifiesThrownWeaponFighting(activity, process)) context.thrownWeaponFighting = true;

    const potent = this.#potentSpellcastingRule(activity);
    if (potent && this.ruleEnabled(potent.ruleId)) context.potentSpellcasting = potent;

    if (this.ruleEnabled(RULES.EMPOWERED_EVOCATION) && this.#qualifiesEmpoweredEvocation(activity)) {
      const cast = this.#selectCast(activity, message);
      if (cast) context.empoweredEvocation = { castId: cast.castId };
    }
  }

  static #applyDamageRules(process, rollConfig, index) {
    if (!this.enabled() || !rollConfig) return;
    const context = process?.dnd5eCharacterBuilderRulesAssistance ?? {};

    if (context.greatWeaponFighting && this.ruleEnabled(RULES.GREAT_WEAPON_FIGHTING)) {
      this.#applyGreatWeaponFighting(process, rollConfig, index);
    }
    if (index !== 0) return;

    if (context.thrownWeaponFighting && this.ruleEnabled(RULES.THROWN_WEAPON_FIGHTING)) {
      this.#applyFlatDamageBonus(rollConfig, 2, RULES.THROWN_WEAPON_FIGHTING, {
        label: "Thrown Weapon Fighting"
      });
    }
    if (context.potentSpellcasting && this.ruleEnabled(context.potentSpellcasting.ruleId)) {
      this.#applyAbilityModifier(
        rollConfig,
        context.potentSpellcasting.ability,
        context.potentSpellcasting.ruleId,
        { label: context.potentSpellcasting.label }
      );
    }
    if (context.empoweredEvocation?.castId && this.ruleEnabled(RULES.EMPOWERED_EVOCATION)) {
      this.#applyAbilityModifier(rollConfig, "int", RULES.EMPOWERED_EVOCATION, {
        label: "Empowered Evocation",
        castId: context.empoweredEvocation.castId
      });
    }
  }

  static #applyGreatWeaponFighting(process, rollConfig, index) {
    if (RulesAssistanceFormulaService.includesMarker(rollConfig, RULES.GREAT_WEAPON_FIGHTING)) return;
    const parts = rollConfig.parts ?? [];
    let changed = false;
    let alreadyApplied = false;
    rollConfig.parts = parts.map(part => {
      const result = RulesAssistanceFormulaService.applyDieMinimum(part, 3);
      changed ||= result.changed;
      alreadyApplied ||= result.alreadyApplied;
      return result.formula;
    });

    if (changed) {
      RulesAssistanceFormulaService.mark(rollConfig, RULES.GREAT_WEAPON_FIGHTING, {
        label: "Great Weapon Fighting",
        minimum: 3,
        rollIndex: index
      });
      this.#recordAudit(process?.subject?.actor, {
        ruleId: RULES.GREAT_WEAPON_FIGHTING,
        action: "Applied minimum 3 to eligible damage dice",
        itemId: process?.subject?.item?.id ?? null
      });
    } else if (alreadyApplied) {
      this.#recordAudit(process?.subject?.actor, {
        ruleId: RULES.GREAT_WEAPON_FIGHTING,
        action: "Possible duplicate automation: an equal or stronger die minimum was already present",
        itemId: process?.subject?.item?.id ?? null,
        warning: true
      });
    }
  }

  static #applyFlatDamageBonus(rollConfig, amount, ruleId, metadata = {}) {
    if (RulesAssistanceFormulaService.includesMarker(rollConfig, ruleId)) return;
    rollConfig.parts ??= [];
    rollConfig.parts.push(String(amount));
    RulesAssistanceFormulaService.mark(rollConfig, ruleId, { amount, ...metadata });
  }

  static #applyAbilityModifier(rollConfig, ability, ruleId, metadata = {}) {
    if (RulesAssistanceFormulaService.includesMarker(rollConfig, ruleId)) return;
    if (RulesAssistanceFormulaService.includesAbilityModifier(rollConfig.parts, ability)) {
      RulesAssistanceFormulaService.mark(rollConfig, ruleId, {
        skippedDuplicate: true,
        ability,
        ...metadata
      });
      return;
    }
    rollConfig.parts ??= [];
    rollConfig.parts.push(`@abilities.${ability}.mod`);
    RulesAssistanceFormulaService.mark(rollConfig, ruleId, { ability, ...metadata });
  }

  static #finalizeDamageRoll(rolls) {
    for (const roll of rolls ?? []) {
      const rules = roll?.options?.dnd5eCharacterBuilderRulesAssistance ?? {};
      const empowered = rules[RULES.EMPOWERED_EVOCATION];
      if (!empowered?.castId) continue;
      for (const [key, rows] of this.#casts) {
        const cast = rows.find(row => row.castId === empowered.castId);
        if (!cast) continue;
        cast.used = true;
        cast.usedAt = Date.now();
        this.#casts.set(key, this.#pruneCasts(rows));
        break;
      }
    }
  }

  static #qualifiesGreatWeaponFighting(activity, process) {
    const actor = activity?.actor;
    const item = activity?.item;
    if (!actor || item?.type !== "weapon" || activity.type !== "attack") return false;
    if (!this.#actorHasFeature(actor, "great-weapon-fighting")) return false;

    const properties = item.system?.properties;
    const has = key => properties?.has?.(key) ?? properties?.includes?.(key);
    const twoHanded = has("two");
    const versatile = has("ver") || item.system?.isVersatile;
    if (!twoHanded && !versatile) return false;

    const attackMode = String(process?.attackMode ?? "");
    if (versatile && attackMode !== "twoHanded") return false;
    if (twoHanded && attackMode && attackMode !== "twoHanded") return false;

    const actionType = activity.getActionType?.(attackMode) ?? activity.actionType;
    return actionType === "mwak" || activity.attack?.type?.value === "melee";
  }

  static #qualifiesThrownWeaponFighting(activity, process) {
    const actor = activity?.actor;
    const item = activity?.item;
    if (!actor || item?.type !== "weapon" || activity.type !== "attack") return false;
    if (!this.#actorHasFeature(actor, "thrown-weapon-fighting")) return false;
    const properties = item.system?.properties;
    const thrownProperty = properties?.has?.("thr") ?? properties?.includes?.("thr");
    if (!thrownProperty) return false;
    return String(process?.attackMode ?? "").startsWith("thrown");
  }

  static #potentSpellcastingRule(activity) {
    const actor = activity?.actor;
    const spell = activity?.item;
    if (!actor || spell?.type !== "spell" || Number(spell.system?.level ?? -1) !== 0) return null;

    if (this.#actorHasFeature(actor, "blessed-strikes-potent-spellcasting")
      && this.#spellCountsAsClassSpell(spell, "cleric")) {
      return {
        ruleId: RULES.CLERIC_POTENT_SPELLCASTING,
        label: "Blessed Strikes: Potent Spellcasting",
        ability: "wis"
      };
    }
    if (this.#actorHasFeature(actor, "elemental-fury-potent-spellcasting")
      && this.#spellCountsAsClassSpell(spell, "druid")) {
      return {
        ruleId: RULES.DRUID_POTENT_SPELLCASTING,
        label: "Elemental Fury: Potent Spellcasting",
        ability: "wis"
      };
    }
    return null;
  }

  static #qualifiesEmpoweredEvocation(activity) {
    const actor = activity?.actor;
    const spell = activity?.item;
    return Boolean(actor
      && spell?.type === "spell"
      && String(spell.system?.school ?? "") === "evo"
      && this.#actorHasFeature(actor, "empowered-evocation")
      && this.#spellCountsAsClassSpell(spell, "wizard"));
  }

  static #isRealSpellCast(activity) {
    if (activity?.item?.type !== "spell") return false;
    if (Number(activity.item.system?.level ?? 0) === 0) return activity.consumption?.spellSlot !== false;
    return activity.consumption?.spellSlot !== false;
  }

  static #actorHasFeature(actor, identifier) {
    return this.#items(actor).some(item => {
      const ownIdentifier = String(item.system?.identifier ?? "").toLowerCase();
      if (ownIdentifier === identifier) return true;
      const sourceId = String(item.getFlag?.("dnd5e", "sourceId")
        ?? item.flags?.dnd5e?.sourceId
        ?? item._stats?.compendiumSource
        ?? "").toLowerCase();
      return sourceId.includes(identifier.replaceAll("-", ""));
    });
  }

  static #spellCountsAsClassSpell(spell, classIdentifier) {
    const expected = String(classIdentifier).toLowerCase();
    const flagged = String(spell.getFlag?.(MODULE_ID, "classIdentifier")
      ?? spell.flags?.[MODULE_ID]?.classIdentifier
      ?? "").toLowerCase();
    if (flagged === expected) return true;

    const sourceItemRaw = String(spell.system?.sourceItem ?? "");
    const sourceItem = sourceItemRaw.toLowerCase();
    if (sourceItem === `class:${expected}`) return true;
    const actorClass = spell.actor?.items?.get?.(sourceItemRaw);
    if (String(actorClass?.system?.identifier ?? "").toLowerCase() === expected) return true;
    return false;
  }

  static #selectCast(activity, message) {
    const key = this.#castKey(activity.actor, activity.item);
    const rows = this.#pruneCasts(this.#casts.get(key) ?? []);
    this.#casts.set(key, rows);
    if (!rows.length) return null;

    const originMessageId = foundry.utils.getProperty(message, "data.flags.dnd5e.originatingMessage")
      ?? foundry.utils.getProperty(message, "flags.dnd5e.originatingMessage")
      ?? null;
    if (originMessageId) {
      const exact = [...rows].reverse().find(row => !row.used && row.messageId === originMessageId);
      if (exact) return exact;
    }
    return [...rows].reverse().find(row => !row.used) ?? null;
  }

  static #castKey(actor, item) {
    return `${actor?.id ?? actor?.uuid ?? ""}|${item?.id ?? item?.uuid ?? ""}`;
  }

  static #pruneCasts(rows) {
    const cutoff = Date.now() - (60 * 60 * 1000);
    return (rows ?? []).filter(row => Number(row.createdAt ?? 0) >= cutoff && !row.used);
  }

  static #items(actor) {
    if (!actor?.items) return [];
    if (Array.isArray(actor.items)) return actor.items;
    if (Array.isArray(actor.items.contents)) return actor.items.contents;
    return [...actor.items];
  }

  static #recordAudit(actor, entry) {
    if (!actor?.id) return;
    const key = String(actor.id);
    const rows = this.#audit.get(key) ?? [];
    rows.push({ at: Date.now(), ...entry });
    this.#audit.set(key, rows.slice(-50));
  }
}

export { RULES as RULES_ASSISTANCE_IDS };
