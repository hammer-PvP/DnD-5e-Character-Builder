import { MODULE_ID, defaultSettings } from "../constants.mjs";

/**
 * Applies the selected rules-generation policy to native D&D5e class
 * Advancements without replacing the native Advancement workflow.
 */
export class RulesCompatibilityService {
  static settings() {
    return foundry.utils.mergeObject(defaultSettings(), game.settings.get(MODULE_ID, "settings") ?? {}, {
      inplace: false
    });
  }

  static isModern() {
    return this.settings().rulesMode !== "legacy2014";
  }

  static prepareClassData(data, { sourceUuid = null } = {}) {
    const prepared = foundry.utils.deepClone(data);
    if (prepared.type !== "class") return prepared;
    const original = foundry.utils.deepClone(prepared.system?.advancement ?? {});
    prepared.flags ??= {};
    prepared.flags[MODULE_ID] = foundry.utils.mergeObject(prepared.flags[MODULE_ID] ?? {}, {
      rulesOriginalAdvancement: original,
      rulesSourceUuid: sourceUuid,
      rulesModeApplied: this.settings().rulesMode
    }, { inplace: false, overwrite: true });
    prepared.system ??= {};
    prepared.system.advancement = this.isModern()
      ? this.#normalizeSubclassChoiceToLevelThree(original)
      : original;
    return prepared;
  }

  static async ensureClassItemPolicy(classItem) {
    if (!classItem || classItem.type !== "class") return false;
    const original = await this.#originalAdvancement(classItem);
    if (!original) return false;
    const desired = this.isModern()
      ? this.#normalizeSubclassChoiceToLevelThree(original)
      : foundry.utils.deepClone(original);
    const current = classItem.toObject().system?.advancement ?? {};
    const storedOriginal = classItem.getFlag(MODULE_ID, "rulesOriginalAdvancement");
    const mode = this.settings().rulesMode;
    const update = {};
    if (JSON.stringify(current) !== JSON.stringify(desired)) update["system.advancement"] = desired;
    if (!storedOriginal) update[`flags.${MODULE_ID}.rulesOriginalAdvancement`] = foundry.utils.deepClone(original);
    if (classItem.getFlag(MODULE_ID, "rulesModeApplied") !== mode) update[`flags.${MODULE_ID}.rulesModeApplied`] = mode;
    if (!Object.keys(update).length) return false;
    await classItem.update(update, { characterBuilderRulesPolicy: true });
    return true;
  }

  static async applyWorldPolicy() {
    if (!game.user.isGM) return { updated: 0, failed: 0 };
    let updated = 0;
    let failed = 0;
    for (const actor of game.actors) {
      if (actor.type !== "character") continue;
      for (const classItem of actor.items.filter(item => item.type === "class")) {
        try {
          if (await this.ensureClassItemPolicy(classItem)) updated += 1;
        } catch (error) {
          failed += 1;
          console.warn(`${MODULE_ID} | Could not apply the rules policy to ${actor.name} / ${classItem.name}.`, error);
        }
      }
    }
    return { updated, failed };
  }

  static #normalizeSubclassChoiceToLevelThree(advancements) {
    const normalized = foundry.utils.deepClone(advancements ?? {});
    const entries = Array.isArray(normalized) ? normalized : Object.values(normalized);
    for (const advancement of entries) {
      if (!this.#isSubclassChoice(advancement)) continue;
      this.#moveLevelFields(advancement, 3);
    }
    return normalized;
  }

  static #isSubclassChoice(advancement = {}) {
    const configuration = advancement.configuration ?? {};
    const restriction = configuration.restriction ?? {};
    const directTypes = [
      configuration.type,
      configuration.itemType,
      configuration.documentType,
      restriction.type,
      restriction.itemType,
      advancement.itemType
    ].map(value => String(value ?? "").toLowerCase());
    if (directTypes.includes("subclass")) return true;
    try {
      if (/"subclass"/i.test(JSON.stringify(configuration))) return true;
    } catch (_error) {
      // Non-serializable configuration values are ignored; the textual fallback remains available.
    }

    const type = String(advancement.type ?? "").toLowerCase();
    if (!type.includes("itemchoice")) return false;
    const text = `${advancement.title ?? ""} ${advancement.hint ?? ""} ${configuration.label ?? ""}`.toLowerCase();
    return /\b(subclass|archetype|primal path|bard college|divine domain|druid circle|martial archetype|monastic tradition|sacred oath|ranger archetype|roguish archetype|sorcerous origin|otherworldly patron|arcane tradition)\b/.test(text);
  }

  static #moveLevelFields(advancement, targetLevel) {
    const moveScalar = key => {
      const value = Number(advancement[key]);
      if (Number.isFinite(value) && value < targetLevel) advancement[key] = targetLevel;
    };
    moveScalar("level");

    if (Array.isArray(advancement.levels)) {
      advancement.levels = [...new Set(advancement.levels.map(level => {
        const value = Number(level);
        return Number.isFinite(value) && value < targetLevel ? targetLevel : level;
      }))];
    }

    const configuration = advancement.configuration ??= {};
    for (const key of ["choices", "levels"]) {
      const table = configuration[key];
      if (!table) continue;
      if (Array.isArray(table)) {
        for (const row of table) {
          if (!row || typeof row !== "object") continue;
          const level = Number(row.level);
          if (Number.isFinite(level) && level < targetLevel) row.level = targetLevel;
        }
        continue;
      }
      if (typeof table !== "object") continue;
      let moved = 0;
      for (const [level, value] of Object.entries(table)) {
        const numericLevel = Number(level);
        if (!Number.isFinite(numericLevel) || numericLevel >= targetLevel) continue;
        moved += Number(value ?? 0);
        delete table[level];
      }
      if (moved) table[String(targetLevel)] = Number(table[String(targetLevel)] ?? 0) + moved;
    }
  }

  static async #originalAdvancement(classItem) {
    const stored = classItem.getFlag(MODULE_ID, "rulesOriginalAdvancement");
    if (stored) return foundry.utils.deepClone(stored);

    const sourceUuid = classItem.getFlag("dnd5e", "sourceId")
      ?? classItem._stats?.compendiumSource
      ?? classItem.getFlag(MODULE_ID, "sourceSnapshot")?.uuid
      ?? classItem.getFlag(MODULE_ID, "rulesSourceUuid")
      ?? null;
    if (sourceUuid) {
      try {
        const source = await fromUuid(sourceUuid);
        if (source?.type === "class") return foundry.utils.deepClone(source.toObject().system?.advancement ?? {});
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not read original Class Advancements from ${sourceUuid}.`, error);
      }
    }
    return foundry.utils.deepClone(classItem.toObject().system?.advancement ?? {});
  }
}
