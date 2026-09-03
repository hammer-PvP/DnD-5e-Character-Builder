import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceFormulaService } from "./rules-assistance-formula-service.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "healing-potion-maximum-action";
const MANAGED_FLAG = "healingPotionMaximumAction";

const OFFICIAL_NAMES = new Set([
  "potion of healing",
  "potion of healing (greater)",
  "potion of healing (superior)",
  "potion of healing (supreme)",
  "potion of greater healing",
  "potion of superior healing",
  "potion of supreme healing"
]);

/** Adds/removes the optional maximum-healing Action Activity on eligible potions. */
export class HealingPotionAssistanceService {
  static #initialized = false;
  static #reconciling = new Set();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    Hooks.on("createItem", item => this.#queueItem(item));
    Hooks.on("updateItem", (item, _changes, options) => {
      if (options?.characterBuilderHealingPotionAssistance) return;
      this.#queueItem(item);
    });
    Hooks.on("deleteItem", item => this.#reconciling.delete(String(item?.uuid ?? item?.id ?? "")));
  }

  static async ready() {
    if (this.#isActiveGM()) await this.reconcileWorld();
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static customPotions(candidate = null) {
    const settings = RulesAssistanceSettingsService.settings(candidate);
    return [...(settings.rulesAssistance?.healingPotionMaximumAction?.customPotions ?? [])];
  }

  static async reconcileWorld() {
    if (!this.#isActiveGM()) return { changed: 0 };
    let changed = 0;
    for (const actor of game.actors ?? []) {
      for (const item of actor.items ?? []) {
        if (await this.reconcileItem(item)) changed += 1;
      }
    }
    return { changed };
  }

  static async reconcileItem(item) {
    if (!this.#isActiveGM() || item?.documentName !== "Item" || !item?.actor) return false;
    const key = String(item.uuid ?? item.id ?? "");
    if (!key || this.#reconciling.has(key)) return false;
    this.#reconciling.add(key);
    try {
      const managed = this.#managedActivities(item);
      if (!this.enabled()) return this.#removeManaged(item, managed);

      const eligibility = this.eligibility(item);
      if (!eligibility.eligible) return this.#removeManaged(item, managed);
      const sourceActivity = eligibility.activity;
      const max = RulesAssistanceFormulaService.maximizeNumericDice(sourceActivity.healing?.formula ?? "");
      if (!max.compatible) return this.#removeManaged(item, managed);

      const desired = this.#desiredActivity(sourceActivity, max.formula);
      const current = managed.find(activity => String(activity.flags?.[MODULE_ID]?.[MANAGED_FLAG]?.sourceActivityId ?? "") === String(sourceActivity.id ?? sourceActivity._id));
      const extras = managed.filter(activity => activity !== current);
      let changed = false;
      if (extras.length) changed = await this.#removeManaged(item, extras) || changed;

      if (!current) {
        await item.update({ [`system.activities.${desired._id}`]: desired }, { characterBuilderHealingPotionAssistance: true });
        return true;
      }

      const currentSource = current.toObject?.() ?? foundry.utils.deepClone(current);
      const comparableCurrent = foundry.utils.deepClone(currentSource);
      const comparableDesired = foundry.utils.deepClone(desired);
      comparableDesired._id = comparableCurrent._id;
      if (JSON.stringify(comparableCurrent) === JSON.stringify(comparableDesired)) return changed;
      await item.update({ [`system.activities.${current.id}`]: comparableDesired }, { characterBuilderHealingPotionAssistance: true });
      return true;
    } finally {
      this.#reconciling.delete(key);
    }
  }

  static eligibility(item, candidate = null) {
    if (item?.type !== "consumable") return { eligible: false, reason: "Only consumable Items are supported." };
    const custom = this.#customMatch(item, candidate);
    const official = this.#official(item);
    if (!custom && !official) return { eligible: false, reason: "This Item is not a registered Healing Potion." };

    const requestedActivityId = String(custom?.activityId ?? "");
    const heals = this.#healingActivities(item).filter(activity => !activity.flags?.[MODULE_ID]?.[MANAGED_FLAG]);
    const activity = requestedActivityId
      ? heals.find(row => String(row.id ?? row._id) === requestedActivityId)
      : heals.length === 1 ? heals[0] : heals.find(row => String(row.activation?.type ?? "") === "bonus") ?? heals[0];
    if (!activity) return { eligible: false, reason: "No compatible native Healing Activity was found." };
    const max = RulesAssistanceFormulaService.maximizeNumericDice(activity.healing?.formula ?? "");
    if (!max.compatible) return { eligible: false, reason: max.reason ?? "The healing formula cannot be maximized safely." };
    return { eligible: true, activity, formula: activity.healing?.formula ?? "", maximumFormula: max.formula, official, custom };
  }

  static inspectSource(item) {
    if (item?.documentName !== "Item" || item?.type !== "consumable") {
      return { compatible: false, reason: "Drop a consumable Item." };
    }
    const activities = this.#healingActivities(item).filter(activity => !activity.flags?.[MODULE_ID]?.[MANAGED_FLAG]);
    const rows = activities.map(activity => {
      const result = RulesAssistanceFormulaService.maximizeNumericDice(activity.healing?.formula ?? "");
      return {
        id: String(activity.id ?? activity._id ?? ""),
        name: activity.name || "Healing",
        formula: String(activity.healing?.formula ?? ""),
        maximumFormula: result.formula,
        compatible: result.compatible,
        reason: result.reason ?? null
      };
    });
    const compatible = rows.filter(row => row.compatible);
    return {
      compatible: compatible.length > 0,
      reason: compatible.length ? null : rows[0]?.reason ?? "This Item has no compatible Healing Activity.",
      activities: rows,
      compatibleActivities: compatible
    };
  }

  static sourceIdentity(item) {
    return String(item?.getFlag?.("dnd5e", "sourceId")
      ?? item?._stats?.compendiumSource
      ?? item?.getFlag?.("core", "sourceId")
      ?? item?.uuid
      ?? "").trim();
  }

  static #queueItem(item) {
    if (!this.#isActiveGM() || item?.documentName !== "Item" || !item?.actor) return;
    setTimeout(() => void this.reconcileItem(item).catch(error => {
      console.warn(`${MODULE_ID} | Healing Potion assistance reconciliation failed.`, error);
    }), 0);
  }

  static #official(item) {
    const name = String(item?.name ?? "").trim().toLowerCase();
    if (!OFFICIAL_NAMES.has(name)) return false;
    const source = this.sourceIdentity(item).toLowerCase();
    return source.startsWith("compendium.dnd-players-handbook.")
      || source.startsWith("compendium.dnd5e.");
  }

  static #customMatch(item, candidate = null) {
    const identities = new Set([
      this.sourceIdentity(item),
      String(item?.uuid ?? ""),
      String(item?.getFlag?.("core", "sourceId") ?? "")
    ].filter(Boolean));
    return this.customPotions(candidate).find(row => identities.has(String(row?.sourceUuid ?? ""))) ?? null;
  }

  static #healingActivities(item) {
    const activities = item?.system?.activities;
    const values = activities?.values ? [...activities.values()] : Object.values(activities ?? {});
    return values.filter(activity => String(activity?.type ?? "") === "heal");
  }

  static #managedActivities(item) {
    return this.#healingActivities(item).filter(activity => Boolean(activity.flags?.[MODULE_ID]?.[MANAGED_FLAG]));
  }

  static #desiredActivity(sourceActivity, maximumFormula) {
    const data = sourceActivity.toObject?.() ?? foundry.utils.deepClone(sourceActivity);
    data._id = foundry.utils.randomID?.(16) ?? crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    data.name = "Drink as Action — Maximum Healing";
    data.activation ??= {};
    data.activation.type = "action";
    data.activation.value = 1;
    data.healing ??= {};
    data.healing.custom ??= {};
    data.healing.custom.enabled = true;
    data.healing.custom.formula = maximumFormula;
    data.flags ??= {};
    data.flags[MODULE_ID] ??= {};
    data.flags[MODULE_ID][MANAGED_FLAG] = {
      managed: true,
      sourceActivityId: String(sourceActivity.id ?? sourceActivity._id ?? ""),
      sourceFormula: String(sourceActivity.healing?.formula ?? ""),
      maximumFormula
    };
    return data;
  }

  static async #removeManaged(item, activities) {
    if (!activities?.length) return false;
    // D&D5e 5.3.3/Foundry 14 changed MappingField deletion semantics. Use
    // the system's own Activity deletion API rather than the legacy `-=`
    // update syntax so this remains correct on the supported V14 runtime.
    for (const activity of activities) {
      const id = String(activity?.id ?? activity?._id ?? "");
      if (!id || !item.system?.activities?.has?.(id)) continue;
      await item.deleteActivity(id);
    }
    return true;
  }

  static #isActiveGM() {
    if (!game.user?.isGM) return false;
    const preferred = game.users?.activeGM;
    if (preferred?.active && preferred.isGM) return preferred.id === game.user.id;
    const active = game.users?.contents?.filter(user => user.active && user.isGM)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    return !active || active.id === game.user.id;
  }
}
