import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

/**
 * Prevents a native Summon Activity from consuming resources when none of its
 * source-authored summon profiles is legal at the Activity's effective level.
 *
 * D&D5e already calculates `availableProfiles` from each profile's level.min /
 * level.max after spell scaling has been applied. Character Builder only closes
 * the transactional gap: if that native result is empty, activation is stopped
 * at preActivityConsumption before a slot or Item use can be spent.
 */
export class SummonProfileLevelGuardService {
  static #initialized = false;

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    Hooks.on("dnd5e.preActivityConsumption", (activity, usageConfig, messageConfig) =>
      this.#guard(activity, usageConfig, messageConfig)
    );
  }

  static #guard(activity, _usageConfig, _messageConfig) {
    if (!RulesAssistanceSettingsService.ruleEnabled("summon-profile-level-guard")) return;
    if (String(activity?.type ?? "") !== "summon") return;

    const profiles = this.#values(activity?.profiles);
    if (!profiles.length) return;
    const constrained = profiles.some(profile =>
      this.#finiteLevel(profile?.level?.min) !== null || this.#finiteLevel(profile?.level?.max) !== null
    );
    if (!constrained) return;

    const available = this.#values(activity?.availableProfiles);
    if (available.length) return;

    const level = Number(activity?.relevantLevel ?? activity?.item?.system?.level ?? 0);
    const minimums = profiles.map(profile => this.#finiteLevel(profile?.level?.min)).filter(value => value !== null);
    const maximums = profiles.map(profile => this.#finiteLevel(profile?.level?.max)).filter(value => value !== null);
    const minimum = minimums.length ? Math.min(...minimums) : null;
    const maximum = maximums.length ? Math.max(...maximums) : null;
    const range = minimum !== null && maximum !== null
      ? `${minimum}–${maximum}`
      : minimum !== null
        ? `${minimum}+`
        : maximum !== null
          ? `up to ${maximum}`
          : "the configured range";
    const label = activity?.name || activity?.item?.name || "Summon";

    ui.notifications.warn(
      `${label} has no summon profile available at effective level ${level}. Required profile level: ${range}. No resource was consumed.`
    );
    console.info(`${MODULE_ID} | Blocked invalid Summon Activity before consumption.`, {
      actorId: activity?.actor?.id ?? null,
      itemId: activity?.item?.id ?? null,
      activityId: activity?.id ?? null,
      effectiveLevel: level,
      requiredRange: range
    });
    return false;
  }

  static #finiteLevel(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  static #values(value) {
    if (!value) return [];
    if (Array.isArray(value)) return [...value];
    if (value instanceof Set) return [...value];
    if (value?.contents) return [...value.contents];
    if (typeof value?.values === "function") return [...value.values()];
    try { return [...value]; } catch (_error) { return []; }
  }
}
