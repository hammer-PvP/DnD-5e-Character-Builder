import { MODULE_ID } from "../constants.mjs";
import { PreparedSpellLimitService } from "./prepared-spell-limit-service.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";

/**
 * Wizard level-5 Memorize Spell maintenance.
 * The feature never changes the prepared-spell count: it swaps exactly one
 * ordinary prepared Wizard spell for one ordinary unprepared Wizard spell in
 * the same spellbook after a Short Rest.
 */
export class MemorizeSpellService {
  static feature(actor) {
    return [...(actor?.items ?? [])].find(item => item?.type === "feat" && (
      String(item.system?.identifier ?? "").trim().toLowerCase() === "memorize-spell"
      || String(item.name ?? "").trim().toLowerCase() === "memorize spell"
    )) ?? null;
  }

  static wizardClass(actor) {
    return PreparedSpellLimitService.classByIdentifier(actor, "wizard");
  }

  static available(actor) {
    const feature = this.feature(actor);
    const cls = this.wizardClass(actor);
    if (!feature || !cls) return false;
    const rows = PreparedSpellLimitService.ordinaryClassSpells(actor, cls);
    return rows.some(spell => Number(spell.system?.prepared ?? 0) === SpellPreparationPolicyService.PREPARED)
      && rows.some(spell => Number(spell.system?.prepared ?? 0) === SpellPreparationPolicyService.UNPREPARED);
  }

  static context(actor, operation = null) {
    const feature = this.feature(actor);
    const cls = this.wizardClass(actor);
    if (!feature || !cls) throw new Error("Memorize Spell is no longer available on this Wizard.");

    const ordinary = this.#sorted(PreparedSpellLimitService.ordinaryClassSpells(actor, cls));
    const prepared = ordinary.filter(spell => Number(spell.system?.prepared ?? 0) === SpellPreparationPolicyService.PREPARED);
    const available = ordinary.filter(spell => Number(spell.system?.prepared ?? 0) === SpellPreparationPolicyService.UNPREPARED);
    const removeItemId = prepared.some(spell => spell.id === operation?.removeItemId) ? operation.removeItemId : "";
    const addItemId = available.some(spell => spell.id === operation?.addItemId) ? operation.addItemId : "";

    return {
      featureItemId: feature.id,
      featureName: feature.name,
      featureImg: feature.img,
      classItemId: cls.id,
      classLevel: Number(cls.system?.levels ?? 0),
      removeItemId,
      addItemId,
      prepared: prepared.map(spell => this.#row(spell, removeItemId === spell.id)),
      available: available.map(spell => this.#row(spell, addItemId === spell.id)),
      preparedCount: prepared.length,
      availableCount: available.length
    };
  }

  static validate(actor, payload = {}) {
    const feature = this.feature(actor);
    const cls = this.wizardClass(actor);
    if (!feature || !cls) throw new Error("Memorize Spell is no longer available on this Wizard.");

    const removeItemId = String(payload?.removeItemId ?? "");
    const addItemId = String(payload?.addItemId ?? "");
    if (!removeItemId || !addItemId || removeItemId === addItemId) {
      throw new Error("Choose exactly one prepared Wizard spell to forget and one different spellbook spell to prepare.");
    }

    const ordinary = PreparedSpellLimitService.ordinaryClassSpells(actor, cls);
    const byId = new Map(ordinary.map(spell => [spell.id, spell]));
    const remove = byId.get(removeItemId);
    const add = byId.get(addItemId);
    if (!remove || Number(remove.system?.prepared ?? 0) !== SpellPreparationPolicyService.PREPARED) {
      throw new Error("The spell selected to remove is no longer an eligible prepared Wizard spell.");
    }
    if (!add || Number(add.system?.prepared ?? 0) !== SpellPreparationPolicyService.UNPREPARED) {
      throw new Error("The spell selected to prepare is no longer an eligible unprepared Wizard spell in this spellbook.");
    }
    return { feature, cls, remove, add };
  }

  static async apply(actor, payload = {}, transactionId = null) {
    const { cls, remove, add } = this.validate(actor, payload);
    await actor.updateEmbeddedDocuments("Item", [
      { _id: remove.id, "system.prepared": SpellPreparationPolicyService.UNPREPARED },
      { _id: add.id, "system.prepared": SpellPreparationPolicyService.PREPARED }
    ], {
      characterBuilderRuntimeManagement: true,
      characterBuilderMemorizeSpell: true,
      characterBuilderTransactionId: transactionId
    });
    return {
      changed: true,
      classItemId: cls.id,
      removedItemId: remove.id,
      removedSpell: remove.name,
      addedItemId: add.id,
      addedSpell: add.name,
      transactionId
    };
  }

  static #row(spell, selected) {
    const level = Number(spell.system?.level ?? 0);
    return {
      id: spell.id,
      name: spell.name,
      img: spell.img,
      level,
      levelLabel: `Level ${level}`,
      school: String(spell.system?.school ?? "").trim(),
      selected: Boolean(selected),
      uuid: spell.uuid,
      referenceUuid: spell.getFlag?.("dnd5e", "sourceId") ?? spell._stats?.compendiumSource ?? spell.uuid ?? null,
      search: `${spell.name ?? ""} level ${level} ${spell.system?.school ?? ""}`.toLowerCase()
    };
  }

  static #sorted(spells) {
    return [...(spells ?? [])].sort((a, b) => Number(a.system?.level ?? 0) - Number(b.system?.level ?? 0)
      || String(a.name ?? "").localeCompare(String(b.name ?? ""), globalThis.game?.i18n?.lang));
  }
}
