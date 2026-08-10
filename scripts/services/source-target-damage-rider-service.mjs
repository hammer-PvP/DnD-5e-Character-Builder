import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "source-target-damage-riders";
const ADAPTERS = Object.freeze([
  Object.freeze({ sourceIdentifier: "hunters-mark", status: "marked", upgradeIdentifier: "foe-slayer" }),
  Object.freeze({ sourceIdentifier: "hex", status: "cursed", upgradeIdentifier: null })
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
