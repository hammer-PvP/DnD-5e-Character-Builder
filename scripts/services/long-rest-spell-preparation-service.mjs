import { MODULE_ID } from "../constants.mjs";
import { PreparedSpellLimitService } from "./prepared-spell-limit-service.mjs";
import { SpellPreparationCadenceService } from "./spell-preparation-cadence-service.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";

const ACTION_PREFIX = "prepare-spells-";

/**
 * Character Keeper assistance for classes whose ordinary prepared list may be
 * changed when a Long Rest finishes. The service stages Item IDs only; it does
 * not touch the Actor until the authoritative native Long Rest has completed.
 */
export class LongRestSpellPreparationService {
  static isActionId(actionId) {
    return String(actionId ?? "").startsWith(ACTION_PREFIX);
  }

  static actions(actor, restType, session = null) {
    if (restType !== "long") return [];
    const rows = [];
    for (const cls of PreparedSpellLimitService.preparedListClasses(actor)) {
      if (!SpellPreparationCadenceService.allowsLongRest(cls)) continue;
      const limit = PreparedSpellLimitService.maxPrepared(cls);
      const candidates = PreparedSpellLimitService.ordinaryClassSpells(actor, cls);
      if (!limit || !candidates.length) continue;
      const identifier = String(cls.system?.identifier ?? "").trim().toLowerCase();
      const label = `Prepare ${cls.name} Spells`;
      const accessModel = PreparedSpellLimitService.accessModelForClass(cls);
      rows.push({
        id: this.actionId(cls.id),
        label,
        kind: "prepare-spells",
        description: accessModel === "spellbook"
          ? `Review the level 1+ ${cls.name} spells in this spellbook and set the prepared list for the next adventuring day.`
          : `Review the level 1+ ${cls.name} spells available to this class and set the prepared list for the next adventuring day.`,
        img: cls.img ?? "icons/sundries/books/book-open-purple.webp",
        classItemId: cls.id,
        classIdentifier: identifier,
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
    if (!cls || cls.type !== "class" || !SpellPreparationCadenceService.allowsLongRest(cls)) {
      throw new Error("The class that owns this Long Rest spell-preparation choice is no longer eligible.");
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
    const locked = this.#sorted([...(actor?.items ?? [])].filter(spell => spell?.type === "spell"
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
    if (!cls || cls.type !== "class" || !SpellPreparationCadenceService.allowsLongRest(cls)) {
      throw new Error("This class can no longer change its prepared spells on a Long Rest.");
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
