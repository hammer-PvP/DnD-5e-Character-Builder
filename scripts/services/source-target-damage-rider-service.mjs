import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "source-target-damage-riders";
const ADAPTERS = Object.freeze([
  Object.freeze({ sourceIdentifier: "hunters-mark", status: "marked", upgradeIdentifier: "foe-slayer", effectBridge: null }),
  Object.freeze({
    sourceIdentifier: "hex",
    status: "cursed",
    upgradeIdentifier: null,
    effectBridge: "native-no-consumption-activity"
  })
]);

/**
 * Adds a source-owned damage Activity to an Attack Activity's native damage
 * process when the selected target bears the matching source-owned effect.
 * The damage Activity remains authoritative for formula, type, and criticals.
 */
export class SourceTargetDamageRiderService {
  static #initialized = false;
  static #audit = new Map();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    Hooks.on("dnd5e.preRollDamage", (process, dialog, message) => this.#prepare(process, dialog, message));
    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => {
      void this.#bridgeNativeEffectApplication(activity, usageConfig, results).catch(error => {
        console.warn(`${MODULE_ID} | Source-target native effect bridge failed.`, error);
      });
    });
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static diagnostics(actor) {
    const key = String(actor?.id ?? actor ?? "");
    return (this.#audit.get(key) ?? []).map(row => ({ ...row }));
  }

  static #prepare(process) {
    if (!this.enabled()) return;
    const attack = process?.subject;
    if (!attack?.actor || attack.type !== "attack") return;
    if (process?.dnd5eCharacterBuilderSourceTargetRidersApplied) return;

    const targets = Array.from(game.user?.targets ?? []);
    if (targets.length !== 1) return;
    const targetActor = targets[0]?.actor;
    if (!targetActor) return;

    const matches = [];
    for (const effect of targetActor.effects ?? []) {
      if (effect.disabled || effect.isSuppressed) continue;
      const resolved = this.#resolveEffectSource(effect);
      if (!resolved?.sourceItem || resolved.controllerActor?.uuid !== attack.actor.uuid) continue;
      const adapter = ADAPTERS.find(row => row.sourceIdentifier === resolved.sourceItem.system?.identifier);
      if (!adapter || (adapter.status && !effect.statuses?.has?.(adapter.status))) continue;
      const rider = this.#selectRiderActivity(attack.actor, resolved.sourceItem, adapter);
      if (rider) matches.push({ effect, rider, adapter });
    }
    if (!matches.length) return;

    process.rolls ??= [];
    const seen = new Set();
    for (const { effect, rider, adapter } of matches) {
      const key = `${adapter.sourceIdentifier}:${rider.uuid ?? rider.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const riderConfig = rider.getDamageConfig?.({
        attackMode: process.attackMode,
        ammunition: process.ammunition,
        scaling: process.scaling
      });
      if (!riderConfig?.rolls?.length) continue;
      for (const roll of riderConfig.rolls) {
        roll.options ??= {};
        roll.options.dnd5eCharacterBuilderDamageRider = {
          sourceIdentifier: adapter.sourceIdentifier,
          sourceItemUuid: rider.item?.uuid ?? null,
          activityUuid: rider.uuid ?? null,
          effectUuid: effect.uuid ?? null
        };
        process.rolls.push(roll);
      }
      this.#record(attack.actor, {
        ruleId: RULE_ID,
        action: "Added source-target damage rider",
        sourceIdentifier: adapter.sourceIdentifier,
        riderActivity: rider.name ?? rider.id,
        targetActorUuid: targetActor.uuid ?? null
      });
    }
    if (seen.size) process.dnd5eCharacterBuilderSourceTargetRidersApplied = true;
  }

  static async #bridgeNativeEffectApplication(activity, usageConfig, results) {
    if (!this.enabled() || usageConfig?.dnd5eCharacterBuilderEffectBridge) return;
    const sourceIdentifier = activity?.item?.system?.identifier;
    const adapter = ADAPTERS.find(row => row.sourceIdentifier === sourceIdentifier);
    if (!adapter?.effectBridge) return;

    // If D&D5e already produced its native EffectApplicationElement, preserve
    // it exactly as-is. The bridge exists only for the source path where the
    // initial spell-use message omitted its declared effect tray.
    const message = results?.message;
    if (Array.isArray(message?.system?.effects) && message.system.effects.length) return;

    const liveItem = activity?.actor?.items?.get?.(activity.item?.id) ?? null;
    if (!liveItem) return;

    const declaredEffectIds = this.#declaredEffectIds(activity);
    if (!declaredEffectIds.length) return;

    // Re-enter D&D5e through an existing no-consumption Activity that declares
    // the same native effects. Hex 2024 provides "Curse New Creature" for this
    // purpose. We do not create an Active Effect ourselves; D&D5e creates a
    // normal Usage ChatMessage and its native EffectApplicationElement remains
    // responsible for the player's choice and GM application.
    const activities = liveItem.system?.activities?.contents
      ?? Array.from(liveItem.system?.activities?.values?.() ?? liveItem.system?.activities ?? []);
    const helper = activities.find(candidate => {
      if (!candidate || candidate.id === activity.id || candidate.type !== "utility") return false;
      if (candidate.consumption?.spellSlot === true) return false;
      const candidateIds = this.#declaredEffectIds(candidate);
      return declaredEffectIds.every(id => candidateIds.includes(id));
    });
    if (!helper?.use) return;

    const system = {};
    system.effects = declaredEffectIds.map(id => `.ActiveEffect.${id}`);
    if (message?.system?.concentration) system.concentration = message.system.concentration;
    if (message?.system?.spellLevel != null) system.spellLevel = message.system.spellLevel;
    if (message?.system?.scaling != null) system.scaling = foundry.utils.deepClone(message.system.scaling);

    const originalTargets = foundry.utils.getProperty(message, "flags.dnd5e.targets")
      ?? message?.getFlag?.("dnd5e", "targets")
      ?? null;
    const messageData = { system };
    if (originalTargets != null) {
      foundry.utils.setProperty(messageData, "flags.dnd5e.targets", foundry.utils.deepClone(originalTargets));
    }

    const bridgeResults = await helper.use({
      consume: false,
      concentration: { begin: false },
      scaling: message?.system?.scaling ?? 0,
      subsequentActions: false,
      dnd5eCharacterBuilderEffectBridge: true
    }, {
      configure: false
    }, {
      create: true,
      data: messageData
    });

    this.#record(activity.actor, {
      ruleId: RULE_ID,
      action: "Created native effect-application bridge",
      sourceIdentifier,
      sourceActivityId: activity.id ?? null,
      bridgeActivityId: helper.id ?? null,
      effectCount: declaredEffectIds.length,
      sourceMessageId: message?.id ?? null,
      bridgeMessageId: bridgeResults?.message?.id ?? null
    });
  }

  static #declaredEffectIds(activity) {
    const ids = [];
    const entries = activity?.effects?.contents
      ?? Array.from(activity?.effects?.values?.() ?? activity?.effects ?? []);
    for (const entry of entries) {
      const id = entry?.effect?.id ?? entry?._id ?? entry?.id ?? null;
      if (id && !ids.includes(String(id))) ids.push(String(id));
    }
    if (ids.length) return ids;
    for (const effect of Array.from(activity?.applicableEffects ?? [])) {
      if (effect?.id && !ids.includes(String(effect.id))) ids.push(String(effect.id));
    }
    return ids;
  }

  static #resolveEffectSource(effect) {
    let origin = null;
    try {
      origin = globalThis.fromUuidSync?.(effect.origin, { relative: effect, strict: false }) ?? null;
    } catch (_error) {}

    if (origin?.documentName === "ActiveEffect" && origin.parent?.documentName === "Actor") {
      const actor = origin.parent;
      const itemId = origin.getFlag?.("dnd5e", "item")?.id;
      const itemUuid = origin.getFlag?.("dnd5e", "item")?.uuid;
      const sourceItem = actor.items?.get?.(itemId)
        ?? (itemUuid ? globalThis.fromUuidSync?.(itemUuid, { relative: actor, strict: false }) : null);
      return { controllerActor: actor, sourceItem };
    }

    if (origin?.documentName === "Item" && origin.actor) {
      return { controllerActor: origin.actor, sourceItem: origin };
    }

    const dependent = effect.getFlag?.("dnd5e", "dependentOn");
    if (dependent) {
      try {
        const concentration = globalThis.fromUuidSync?.(dependent, { relative: effect, strict: false });
        if (concentration?.parent?.documentName === "Actor") {
          const actor = concentration.parent;
          const itemId = concentration.getFlag?.("dnd5e", "item")?.id;
          const itemUuid = concentration.getFlag?.("dnd5e", "item")?.uuid;
          const sourceItem = actor.items?.get?.(itemId)
            ?? (itemUuid ? globalThis.fromUuidSync?.(itemUuid, { relative: actor, strict: false }) : null);
          return { controllerActor: actor, sourceItem };
        }
      } catch (_error) {}
    }
    return null;
  }

  static #selectRiderActivity(actor, sourceItem, adapter) {
    if (adapter.upgradeIdentifier) {
      const upgrade = actor.items?.find?.(item => item.system?.identifier === adapter.upgradeIdentifier);
      const upgradedDamage = upgrade?.system?.activities?.find?.(activity => activity.type === "damage");
      if (upgradedDamage) return upgradedDamage;
    }
    return sourceItem.system?.activities?.find?.(activity => activity.type === "damage") ?? null;
  }

  static #record(actor, row) {
    const key = String(actor?.id ?? "");
    if (!key) return;
    const rows = this.#audit.get(key) ?? [];
    rows.push({ ...row, at: Date.now() });
    this.#audit.set(key, rows.slice(-50));
  }
}
