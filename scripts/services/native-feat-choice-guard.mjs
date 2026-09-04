import { MODULE_ID, defaultSettings } from "../constants.mjs";

/**
 * Pure classification helpers for post-Advancement validation.
 *
 * This service never opens, wraps, patches, filters, or observes the native
 * D&D5e Compendium Browser or AdvancementManager. The native workflow runs
 * untouched; Character Builder uses these helpers only after it has completed
 * on the temporary Level Up Draft.
 */
export class NativeFeatChoiceGuard {
  static settings() {
    return foundry.utils.mergeObject(defaultSettings(), game.settings.get(MODULE_ID, "settings") ?? {}, {
      inplace: false
    });
  }

  /** The generic native two-point Ability Score Improvement option only. */
  static isAbilityScoreImprovement(item) {
    return item?.type === "feat"
      && item.system?.type?.value === "feat"
      && String(item.system?.identifier ?? "").trim() === "ability-score-improvement";
  }

  static isEpicBoon(item) {
    return item?.type === "feat"
      && item.system?.type?.value === "feat"
      && String(item.system?.type?.subtype ?? "") === "epicBoon";
  }

  static isRepeatable(item) {
    return item?.system?.prerequisites?.repeatable === true;
  }

  static findOwnedEquivalent(candidate, actor) {
    const sourceUuid = this.sourceUuid(candidate) ?? candidate?.uuid ?? null;
    const identifier = String(candidate?.system?.identifier ?? "").trim();
    const subtype = String(candidate?.system?.type?.subtype ?? "").trim();

    for (const owned of actor?.items ?? []) {
      if (owned.type !== "feat" || owned.system?.type?.value !== "feat") continue;
      const ownedSource = this.sourceUuid(owned);
      if (sourceUuid && ownedSource && sourceUuid === ownedSource) return owned;
      if (identifier && subtype
        && identifier === String(owned.system?.identifier ?? "").trim()
        && subtype === String(owned.system?.type?.subtype ?? "").trim()) return owned;
    }
    return null;
  }

  static sourceUuid(item) {
    const candidates = [
      item?.flags?.dnd5e?.sourceId,
      item?._stats?.compendiumSource,
      item?.getFlag?.("dnd5e", "sourceId")
    ];
    return candidates.map(value => String(value ?? "").trim())
      .find(value => value.startsWith("Compendium.")) ?? null;
  }
}
