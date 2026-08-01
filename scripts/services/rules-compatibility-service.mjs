import { MODULE_ID, defaultSettings } from "../constants.mjs";

/**
 * Applies the selected rules-generation policy to native D&D5e class
 * Advancements without replacing the native Advancement workflow.
 *
 * Existing Class Items contain live player decisions inside each Advancement's
 * `value` object. Rules-policy normalization must therefore patch only the
 * structural fields used to place a subclass choice at the correct level.
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

    const current = foundry.utils.deepClone(classItem.toObject().system?.advancement ?? {});
    const desired = this.#applyStructuralPolicy(current, original);
    const storedOriginal = classItem.getFlag(MODULE_ID, "rulesOriginalAdvancement");
    const mode = this.settings().rulesMode;
    const update = {};

    // Never replace the complete Advancement collection with source data.
    // That would erase live `value.chosen`, ItemGrant records, ASI/Feat state,
    // and other decisions already made on the Actor.
    if (this.#stableString(current) !== this.#stableString(desired)) update["system.advancement"] = desired;
    if (!storedOriginal) update[`flags.${MODULE_ID}.rulesOriginalAdvancement`] = foundry.utils.deepClone(original);
    if (classItem.getFlag(MODULE_ID, "rulesModeApplied") !== mode) update[`flags.${MODULE_ID}.rulesModeApplied`] = mode;
    if (!Object.keys(update).length) return false;
    await classItem.update(update, { characterBuilderRulesPolicy: true });
    return true;
  }

  static async applyWorldPolicy() {
    if (!game.user.isGM) return { updated: 0, repaired: 0, failed: 0 };
    let updated = 0;
    let repaired = 0;
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

      try {
        const result = await this.repairActorMasteryChoices(actor);
        repaired += Number(result?.updated ?? 0);
      } catch (error) {
        failed += 1;
        console.warn(`${MODULE_ID} | Could not reconcile Weapon Mastery Advancement state for ${actor.name}.`, error);
      }
    }
    return { updated, repaired, failed };
  }

  /**
   * Conservatively restores Weapon Mastery `value.chosen` records erased by
   * the former whole-Advancement rules-policy update. The Actor's live mastery
   * trait is authoritative. Builder badges are used to recover exact ownership
   * by Class and Advancement whenever available.
   */
  static async repairActorMasteryChoices(actor) {
    if (!actor || actor.type !== "character") return { updated: 0, skipped: 0 };

    const actorMasteries = [...new Set(this.#collectionValues(actor.system?.traits?.weaponProf?.mastery?.value)
      .map(value => String(value ?? "").trim())
      .filter(Boolean))];
    if (!actorMasteries.length) return { updated: 0, skipped: 0 };

    const classItems = this.#collectionValues(actor.items).filter(item => item?.type === "class");
    const classState = new Map();
    const represented = new Set();
    for (const cls of classItems) {
      const advancement = foundry.utils.deepClone(cls.toObject().system?.advancement ?? {});
      const rows = this.#advancementEntries(advancement)
        .filter(([, row]) => row?.type === "Trait"
          && row.configuration?.mode === "mastery"
          && this.#advancementIsActive(row, cls));
      for (const [, row] of rows) {
        for (const key of row.value?.chosen ?? []) represented.add(String(key).split(":").at(-1));
      }
      classState.set(cls.id, { cls, advancement, rows });
    }

    const missing = actorMasteries.filter(baseItem => !represented.has(baseItem));
    if (!missing.length) return { updated: 0, skipped: 0 };

    const missingByNormalized = new Map(missing.map(baseItem => [this.#normalizeToken(baseItem), baseItem]));
    const planned = new Map();
    const reserved = new Set(represented);
    let skipped = 0;

    // Preferred repair path: the badge identifies the owning Class and exact
    // Advancement ID, so no multiclass ownership has to be guessed.
    for (const badge of this.#masteryBadges(actor)) {
      const state = classState.get(String(badge.sourceItemId ?? ""));
      if (!state) continue;
      const rowEntry = state.rows.find(([id]) => String(id) === String(badge.advancementId ?? ""));
      if (!rowEntry) continue;
      const [advancementId, row] = rowEntry;
      if ((row.value?.chosen ?? []).length) continue;

      const badgeBases = [];
      for (const label of badge.values ?? []) {
        const baseItem = this.#matchBadgeValue(label, missingByNormalized);
        if (!baseItem || badgeBases.includes(baseItem)) continue;
        badgeBases.push(baseItem);
      }
      if (!badgeBases.length || badgeBases.some(baseItem => reserved.has(baseItem))) continue;
      if (badgeBases.length > this.#masteryChoiceCapacity(row)) {
        skipped += 1;
        continue;
      }

      const keys = await this.#masteryKeys(badgeBases);
      if (!keys) {
        skipped += 1;
        continue;
      }
      planned.set(`${state.cls.id}.${advancementId}`, { cls: state.cls, advancementId, keys });
      for (const baseItem of badgeBases) reserved.add(baseItem);
    }

    // Fallback for a straightforward legacy Actor without Builder badges:
    // exactly one active blank mastery Advancement, no represented choices,
    // and a live mastery count that exactly matches that Advancement's capacity.
    if (!planned.size && !represented.size) {
      const blankRows = [...classState.values()].flatMap(state => state.rows
        .filter(([, row]) => !(row.value?.chosen ?? []).length)
        .map(([advancementId, row]) => ({ ...state, advancementId, row })));
      if (blankRows.length === 1) {
        const candidate = blankRows[0];
        if (this.#masteryChoiceCapacity(candidate.row) === actorMasteries.length) {
          const keys = await this.#masteryKeys(actorMasteries);
          if (keys) planned.set(`${candidate.cls.id}.${candidate.advancementId}`, {
            cls: candidate.cls,
            advancementId: candidate.advancementId,
            keys
          });
          else skipped += 1;
        }
      }
    }

    if (!planned.size) return { updated: 0, skipped };

    const updatesByClass = new Map();
    for (const { cls, advancementId, keys } of planned.values()) {
      const update = updatesByClass.get(cls.id) ?? { _id: cls.id };
      update[`system.advancement.${advancementId}.value.chosen`] = keys;
      updatesByClass.set(cls.id, update);
    }

    const updates = [...updatesByClass.values()];
    await actor.updateEmbeddedDocuments("Item", updates, {
      characterBuilderRulesPolicy: true,
      characterBuilderAdvancementIntegrityRepair: true
    });
    console.info(`${MODULE_ID} | Restored ${planned.size} Weapon Mastery Advancement choice record(s) for ${actor.name}.`);
    return { updated: planned.size, skipped };
  }

  static #applyStructuralPolicy(current, original) {
    const desiredSource = this.isModern()
      ? this.#normalizeSubclassChoiceToLevelThree(original)
      : foundry.utils.deepClone(original);
    const patched = foundry.utils.deepClone(current ?? {});
    const currentById = new Map(this.#advancementEntries(patched).map(([id, row]) => [String(id), row]));

    for (const [id, sourceRow] of this.#advancementEntries(desiredSource)) {
      const targetRow = currentById.get(String(id));
      if (!targetRow) continue;
      if (!this.#isSubclassChoice(sourceRow) && !this.#isSubclassChoice(targetRow)) continue;
      this.#copySubclassStructure(targetRow, sourceRow);
    }
    return patched;
  }

  static #copySubclassStructure(target, source) {
    for (const key of ["level", "levels"]) {
      if (Object.hasOwn(source ?? {}, key)) target[key] = foundry.utils.deepClone(source[key]);
    }

    const sourceConfiguration = source?.configuration ?? {};
    if (!Object.hasOwn(sourceConfiguration, "choices") && !Object.hasOwn(sourceConfiguration, "levels")) return;
    target.configuration ??= {};
    for (const key of ["choices", "levels"]) {
      if (Object.hasOwn(sourceConfiguration, key)) {
        target.configuration[key] = foundry.utils.deepClone(sourceConfiguration[key]);
      }
    }
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

  static #advancementEntries(advancements) {
    if (Array.isArray(advancements)) {
      return advancements.map((row, index) => [String(row?._id ?? index), row]);
    }
    return Object.entries(advancements ?? {});
  }

  static #advancementIsActive(advancement, cls) {
    const level = Number(advancement?.level ?? 0);
    return !Number.isFinite(level) || level <= Number(cls?.system?.levels ?? 0);
  }

  static #masteryChoiceCapacity(row) {
    return (row?.configuration?.choices ?? []).reduce((total, choice) => total + Number(choice?.count ?? 0), 0);
  }

  static #masteryBadges(actor) {
    const badges = [];
    for (const item of this.#collectionValues(actor.items)) {
      const values = item?.getFlag?.(MODULE_ID, "advancementChoiceBadges")
        ?? item?.flags?.[MODULE_ID]?.advancementChoiceBadges
        ?? [];
      for (const badge of values) {
        const category = this.#normalizeToken(badge?.category ?? badge?.advancementTitle ?? badge?.label);
        if (!category.includes("weaponmastery")) continue;
        badges.push(foundry.utils.deepClone(badge));
      }
    }
    return badges;
  }

  static #matchBadgeValue(label, missingByNormalized) {
    const normalized = this.#normalizeToken(label);
    if (missingByNormalized.has(normalized)) return missingByNormalized.get(normalized);
    const matches = [...missingByNormalized.entries()].filter(([token]) => normalized.startsWith(token) || token.startsWith(normalized));
    return matches.length === 1 ? matches[0][1] : null;
  }

  static async #masteryKeys(baseItems) {
    const keys = [];
    for (const baseItem of baseItems) {
      const category = await this.#weaponCategory(baseItem);
      if (!category) return null;
      keys.push(`weapon:${category}:${baseItem}`);
    }
    return keys;
  }

  static async #weaponCategory(baseItem) {
    const weaponIds = globalThis.CONFIG?.DND5E?.weaponIds;
    const uuid = weaponIds?.get?.(baseItem) ?? weaponIds?.[baseItem] ?? null;
    if (!uuid || typeof globalThis.fromUuid !== "function") return null;
    const document = await globalThis.fromUuid(uuid);
    const type = String(document?.system?.type?.value ?? "");
    if (type.startsWith("simple")) return "sim";
    if (type.startsWith("martial")) return "mar";
    return null;
  }

  static #collectionValues(value) {
    if (!value) return [];
    if (Array.isArray(value)) return [...value];
    if (value instanceof Map || value instanceof Set) return [...value.values()];
    if (typeof value.values === "function") return [...value.values()];
    if (typeof value[Symbol.iterator] === "function") return [...value];
    return [];
  }

  static #normalizeToken(value) {
    return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  static #stableString(value) {
    return JSON.stringify(value ?? {});
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
