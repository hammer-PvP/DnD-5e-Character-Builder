import { MODULE_ID } from "../constants.mjs";
import { PreparedSpellLimitService } from "./prepared-spell-limit-service.mjs";
import { SpellPreparationCadenceService } from "./spell-preparation-cadence-service.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";

const ACTION_PREFIX = "prepare-spells-";

/**
 * Character Keeper assistance for class spell preparation at Long Rest.
 *
 * Full-refresh classes stage their complete ordinary prepared list. Ranger 2024
 * uses the same source-of-truth infrastructure but a different transaction:
 * exactly one optional 1:1 prepared-spell replacement per completed Long Rest.
 */
export class LongRestSpellPreparationService {
  static isActionId(actionId) {
    return String(actionId ?? "").startsWith(ACTION_PREFIX);
  }

  static enabled(candidate = null) {
    const settings = candidate ?? globalThis.game?.settings?.get?.(MODULE_ID, "settings") ?? {};
    return settings.manageSpellPreparationWithKeeper !== false;
  }

  static managesClass(cls, candidate = null) {
    return this.enabled(candidate) && SpellPreparationCadenceService.allowsLongRest(cls);
  }

  static managesSpell(actor, spell, candidate = null) {
    if (!this.enabled(candidate) || !actor || spell?.type !== "spell" || Number(spell.system?.level ?? 0) <= 0) return false;
    if (PreparedSpellLimitService.isExcludedGrant(spell)) return false;
    const cls = PreparedSpellLimitService.owningClassForSpell(actor, spell);
    return Boolean(cls && this.managesClass(cls, candidate));
  }

  static actions(actor, restType, session = null) {
    if (restType !== "long" || !this.enabled()) return [];
    const rows = [];
    for (const cls of PreparedSpellLimitService.preparedListClasses(actor)) {
      if (!SpellPreparationCadenceService.allowsLongRest(cls)) continue;
      const limit = PreparedSpellLimitService.maxPrepared(cls);
      const candidates = PreparedSpellLimitService.ordinaryClassSpells(actor, cls);
      if (!limit || !candidates.length) continue;
      const identifier = String(cls.system?.identifier ?? "").trim().toLowerCase();
      const replaceOne = SpellPreparationCadenceService.replacesOneAtLongRest(cls);
      if (replaceOne) {
        const prepared = candidates.filter(spell => Number(spell.system?.prepared ?? 0) === SpellPreparationPolicyService.PREPARED);
        const available = candidates.filter(spell => Number(spell.system?.prepared ?? 0) === SpellPreparationPolicyService.UNPREPARED);
        if (!prepared.length || !available.length) continue;
      }
      const label = replaceOne ? `Replace ${cls.name} Spell` : `Prepare ${cls.name} Spells`;
      const accessModel = PreparedSpellLimitService.accessModelForClass(cls);
      rows.push({
        id: this.actionId(cls.id),
        label,
        kind: replaceOne ? "replace-prepared-spell" : "prepare-spells",
        description: replaceOne
          ? `Optionally replace exactly one ordinary prepared ${cls.name} spell with one eligible unprepared spell after this Long Rest.`
          : accessModel === "spellbook"
            ? `Review the level 1+ ${cls.name} spells in this spellbook and set the prepared list for the next adventuring day.`
            : `Review the level 1+ ${cls.name} spells available to this class and set the prepared list for the next adventuring day.`,
        img: cls.img ?? "icons/sundries/books/book-open-purple.webp",
        classItemId: cls.id,
        classIdentifier: identifier,
        className: cls.name,
        complete: Boolean(session?.completedActionIds?.includes(this.actionId(cls.id))),
        native: false,
        order: 5
      });
    }
    return rows;
  }

  static actionId(classItemId) {
    return `${ACTION_PREFIX}${String(classItemId ?? "")}`;
  }

  static classItemIdFromActionId(actionId) {
    const value = String(actionId ?? "");
    return this.isActionId(value) ? value.slice(ACTION_PREFIX.length) : "";
  }

  static context(actor, action, operation = null) {
    const classItemId = action?.classItemId ?? this.classItemIdFromActionId(action?.id);
    const cls = actor?.items?.get?.(classItemId) ?? [...(actor?.items ?? [])].find(item => item?.id === classItemId);
    if (!cls || cls.type !== "class" || !this.managesClass(cls)) {
      throw new Error("The class that owns this Long Rest spell-preparation choice is no longer eligible.");
    }

    if (SpellPreparationCadenceService.replacesOneAtLongRest(cls)) {
      return this.#replacementContext(actor, action, cls, operation);
    }

    const limit = PreparedSpellLimitService.maxPrepared(cls);
    const candidates = this.#sorted(PreparedSpellLimitService.ordinaryClassSpells(actor, cls));
    const candidateIds = new Set(candidates.map(spell => spell.id));
    const hasOperation = Array.isArray(operation?.preparedSpellItemIds);
    const selectedIds = new Set((hasOperation
      ? operation.preparedSpellItemIds
      : candidates.filter(spell => Number(spell.system?.prepared ?? 0) === SpellPreparationPolicyService.PREPARED).map(spell => spell.id)
    ).filter(id => candidateIds.has(id)));

    const candidateRows = candidates.map(spell => this.#spellRow(spell, {
      selected: selectedIds.has(spell.id),
      current: Number(spell.system?.prepared ?? 0) === SpellPreparationPolicyService.PREPARED
    }));
    const locked = this.#lockedRows(actor, cls);
    const selectedCount = selectedIds.size;
    return {
      ...action,
      preparation: {
        classItemId: cls.id,
        classIdentifier: String(cls.system?.identifier ?? "").trim().toLowerCase(),
        className: cls.name,
        classLevel: Number(cls.system?.levels ?? 0),
        accessModel: PreparedSpellLimitService.accessModelForClass(cls),
        accessLabel: PreparedSpellLimitService.accessModelForClass(cls) === "spellbook" ? "Spellbook" : "Class Spell List",
        cadence: SpellPreparationCadenceService.forClass(cls),
        cadenceLabel: SpellPreparationCadenceService.label(cls),
        limit,
        selectedCount,
        remaining: Math.max(0, limit - selectedCount),
        overLimit: selectedCount > limit,
        candidates: candidateRows,
        groups: this.#groups(candidateRows),
        locked,
        lockedGroups: this.#groups(locked),
        cantripsExcluded: true
      }
    };
  }

  static validateOperation(actor, actionId, payload = {}) {
    if (!this.isActionId(actionId)) return true;
    const classItemId = this.classItemIdFromActionId(actionId);
    if (String(payload?.classItemId ?? classItemId) !== classItemId) {
      throw new Error("The prepared-spell choice no longer matches its owning class.");
    }
    const cls = actor?.items?.get?.(classItemId) ?? [...(actor?.items ?? [])].find(item => item?.id === classItemId);
    if (!cls || cls.type !== "class" || !this.managesClass(cls)) {
      throw new Error("This class can no longer change its prepared spells on a Long Rest.");
    }

    if (SpellPreparationCadenceService.replacesOneAtLongRest(cls)) {
      const removeItemId = String(payload?.removeItemId ?? "");
      const addItemId = String(payload?.addItemId ?? "");
      if (!removeItemId || !addItemId || removeItemId === addItemId) {
        throw new Error(`Choose one prepared ${cls.name} spell to replace and one different eligible spell to prepare.`);
      }
      const candidates = PreparedSpellLimitService.ordinaryClassSpells(actor, cls);
      const byId = new Map(candidates.map(spell => [String(spell.id), spell]));
      const remove = byId.get(removeItemId);
      const add = byId.get(addItemId);
      if (!remove || Number(remove.system?.prepared ?? 0) !== SpellPreparationPolicyService.PREPARED) {
        throw new Error("The spell selected for removal is no longer an ordinary prepared spell for this class.");
      }
      if (!add || Number(add.system?.prepared ?? 0) !== SpellPreparationPolicyService.UNPREPARED) {
        throw new Error("The replacement is no longer an eligible unprepared spell for this class.");
      }
      return true;
    }

    const limit = PreparedSpellLimitService.maxPrepared(cls);
    if (!limit) throw new Error(`${cls.name} no longer has a valid prepared-spell limit.`);
    const candidates = PreparedSpellLimitService.ordinaryClassSpells(actor, cls);
    const eligible = new Set(candidates.map(spell => spell.id));
    const selected = [...new Set((payload?.preparedSpellItemIds ?? []).map(String).filter(Boolean))];
    if (selected.length > limit) throw new Error(`${cls.name} can prepare at most ${limit} ordinary spell${limit === 1 ? "" : "s"}.`);
    const invalid = selected.find(id => !eligible.has(id));
    if (invalid) throw new Error("One selected spell is no longer an eligible ordinary spell for this class.");
    return true;
  }

  static async applyOperation(actor, actionId, payload = {}, transactionId = null) {
    this.validateOperation(actor, actionId, payload);
    const classItemId = this.classItemIdFromActionId(actionId);
    const cls = actor.items.get(classItemId);

    if (SpellPreparationCadenceService.replacesOneAtLongRest(cls)) {
      const removeItemId = String(payload.removeItemId);
      const addItemId = String(payload.addItemId);
      await actor.updateEmbeddedDocuments("Item", [
        { _id: removeItemId, "system.prepared": SpellPreparationPolicyService.UNPREPARED },
        { _id: addItemId, "system.prepared": SpellPreparationPolicyService.PREPARED }
      ], {
        characterBuilderRuntimeManagement: true,
        characterBuilderLongRestSpellPreparation: true,
        characterBuilderRangerSpellReplacement: true,
        characterBuilderTransactionId: transactionId
      });
      return {
        changed: true,
        changedSpells: 2,
        classItemId,
        classIdentifier: String(cls.system?.identifier ?? "").trim().toLowerCase(),
        removeItemId,
        addItemId,
        transactionId
      };
    }

    const selected = new Set((payload?.preparedSpellItemIds ?? []).map(String));
    const candidates = PreparedSpellLimitService.ordinaryClassSpells(actor, cls);
    const updates = [];
    for (const spell of candidates) {
      const next = selected.has(spell.id)
        ? SpellPreparationPolicyService.PREPARED
        : SpellPreparationPolicyService.UNPREPARED;
      if (Number(spell.system?.prepared ?? 0) === next) continue;
      updates.push({ _id: spell.id, "system.prepared": next });
    }
    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, {
        characterBuilderRuntimeManagement: true,
        characterBuilderLongRestSpellPreparation: true,
        characterBuilderTransactionId: transactionId
      });
    }
    return {
      changed: updates.length > 0,
      changedSpells: updates.length,
      classItemId,
      classIdentifier: String(cls.system?.identifier ?? "").trim().toLowerCase(),
      preparedSpellItemIds: [...selected],
      transactionId
    };
  }

  static #replacementContext(actor, action, cls, operation = null) {
    const candidates = this.#sorted(PreparedSpellLimitService.ordinaryClassSpells(actor, cls));
    const removeItemId = String(operation?.removeItemId ?? "");
    const addItemId = String(operation?.addItemId ?? "");
    const prepared = candidates
      .filter(spell => Number(spell.system?.prepared ?? 0) === SpellPreparationPolicyService.PREPARED)
      .map(spell => this.#spellRow(spell, { selected: spell.id === removeItemId, current: true }));
    const available = candidates
      .filter(spell => Number(spell.system?.prepared ?? 0) === SpellPreparationPolicyService.UNPREPARED)
      .map(spell => this.#spellRow(spell, { selected: spell.id === addItemId, current: false }));
    return {
      ...action,
      replacement: {
        classItemId: cls.id,
        classIdentifier: String(cls.system?.identifier ?? "").trim().toLowerCase(),
        className: cls.name,
        classLevel: Number(cls.system?.levels ?? 0),
        cadence: SpellPreparationCadenceService.forClass(cls),
        cadenceLabel: SpellPreparationCadenceService.label(cls),
        prepared,
        available,
        preparedCount: prepared.length,
        availableCount: available.length,
        removeItemId,
        addItemId,
        locked: this.#lockedRows(actor, cls)
      }
    };
  }

  static #lockedRows(actor, cls) {
    return this.#sorted([...(actor?.items ?? [])].filter(spell => spell?.type === "spell"
      && Number(spell.system?.level ?? 0) > 0
      && PreparedSpellLimitService.belongsToClass(actor, spell, cls)
      && PreparedSpellLimitService.isExcludedGrant(spell)))
      .map(spell => this.#spellRow(spell, {
        selected: true,
        locked: true,
        lockedLabel: Number(spell.system?.prepared ?? 0) === SpellPreparationPolicyService.ALWAYS_PREPARED
          ? "Always Prepared"
          : "Feature Prepared"
      }));
  }

  static #spellRow(spell, { selected = false, current = false, locked = false, lockedLabel = "" } = {}) {
    const level = Number(spell.system?.level ?? 0);
    const sourceUuid = spell.getFlag?.("dnd5e", "sourceId") ?? spell._stats?.compendiumSource ?? spell.uuid ?? null;
    return {
      id: spell.id,
      name: spell.name,
      img: spell.img,
      level,
      levelLabel: `Level ${level}`,
      school: String(spell.system?.school ?? "").trim(),
      selected: Boolean(selected),
      current: Boolean(current),
      locked: Boolean(locked),
      lockedLabel,
      uuid: spell.uuid,
      referenceUuid: sourceUuid,
      search: `${spell.name ?? ""} level ${level} ${spell.system?.school ?? ""}`.toLowerCase()
    };
  }

  static #groups(rows) {
    const map = new Map();
    for (const row of rows ?? []) {
      const group = map.get(row.level) ?? { level: row.level, label: `Level ${row.level}`, spells: [] };
      group.spells.push(row);
      map.set(row.level, group);
    }
    return [...map.values()].sort((a, b) => a.level - b.level);
  }

  static #sorted(spells) {
    return [...(spells ?? [])].sort((a, b) => Number(a.system?.level ?? 0) - Number(b.system?.level ?? 0)
      || String(a.name ?? "").localeCompare(String(b.name ?? ""), globalThis.game?.i18n?.lang));
  }
}
