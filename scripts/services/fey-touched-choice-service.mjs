import { MODULE_ID } from "../constants.mjs";
import { readAdvancementRecords, writeAdvancementValue } from "../utils/advancement-utils.mjs";
import { NativeSpellGrantProjectionService } from "./native-spell-grant-projection-service.mjs";

const ACQUISITION_LEVEL = "0";
const SPELL_LEVEL = 1;
const SCHOOLS = new Set(["div", "enc"]);
const REPAIR_OPTIONS = { characterBuilderValidationRepair: true };

export class FeyTouchedChoiceService {
  static isChoice(owner, advancement) {
    return owner?.type === "feat"
      && owner.system?.identifier === "fey-touched"
      && advancement?.type === "ItemChoice"
      && advancement.configuration?.type === "spell"
      && Number(advancement.configuration?.restriction?.level) === SPELL_LEVEL
      && Number(advancement.configuration?.choices?.[ACQUISITION_LEVEL]?.count) === 1;
  }

  static isEligible(spell) {
    return spell?.type === "spell"
      && Number(spell.system?.level) === SPELL_LEVEL
      && SCHOOLS.has(spell.system?.school);
  }

  static rejectionMessage(spell) {
    const school = globalThis.CONFIG?.DND5E?.spellSchools?.[spell.system?.school]?.label;
    const schoolName = school ? game.i18n.localize(school) : null;
    const description = schoolName ? `${spell.name} belongs to the ${schoolName} school.` : `${spell.name} is not eligible.`;
    return `${description} Fey-Touched requires a level 1 Divination or Enchantment spell. Choose another spell.`;
  }

  static invalidChoices(actor) {
    const issues = [];
    for (const owner of actor.items.filter(item => item.type === "feat" && item.system?.identifier === "fey-touched")) {
      for (const [advancementId, advancement] of Object.entries(readAdvancementRecords(owner))) {
        if (!this.isChoice(owner, advancement)) continue;
        const entries = Object.entries(advancement.value?.added?.[ACQUISITION_LEVEL] ?? {});
        for (const [id, uuid] of entries) {
          const spell = actor.items.get(id);
          const origin = `${owner.id}.${advancementId}`;
          if (spell?.type !== "spell" || typeof uuid !== "string"
            || spell.getFlag("dnd5e", "advancementOrigin") !== origin || this.isEligible(spell)) continue;
          issues.push({ owner, advancementId, advancement, spell });
        }
      }
    }
    return issues;
  }

  static replacementOptions(registry) {
    return registry.optionsByType("spell").flatMap(group => group.items)
      .filter(spell => this.isEligible(spell) && registry.isUuidAllowed(spell.uuid))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  }

  static canReplace(actor, { owner, advancementId, spell }) {
    const flags = spell.flags?.[MODULE_ID] ?? {};
    const grant = flags.itemGrantInstance;
    const ownsSpell = row => row.ownerItemId === owner.id && row.advancementId === advancementId;
    if (flags.classSpellAccess || flags.levelUpSpell || flags.mergedItemGrants?.length
      || (grant && !ownsSpell(grant)) || !(flags.featureSpellOwners ?? []).every(ownsSpell)) return false;
    // A separate acquisition may reference this same embedded Item even when
    // only one native origin is recorded on the spell itself.
    return !actor.items.some(item => Object.entries(readAdvancementRecords(item)).some(([id, record]) => {
      if (item.id === owner.id && id === advancementId) return false;
      const added = record.value?.added ?? {};
      if (record.type === "ItemGrant") return Object.hasOwn(added, spell.id);
      return record.type === "ItemChoice" && Object.values(added).some(level =>
        level && typeof level === "object" && Object.hasOwn(level, spell.id));
    }));
  }

  static async replaceInvalidChoice(actor, registry, { ownerId, advancementId, spellId, sourceUuid }) {
    const choice = this.invalidChoices(actor).find(row => row.owner.id === ownerId
      && row.advancementId === advancementId && row.spell.id === spellId);
    if (!choice || !this.canReplace(actor, choice)) throw new Error("The invalid Fey-Touched choice could no longer be safely replaced.");

    const option = registry.sourceForUuid(sourceUuid);
    const sourceSpell = this.isEligible(option) && registry.isUuidAllowed(sourceUuid) ? await fromUuid(sourceUuid) : null;
    if (!this.isEligible(sourceSpell)) throw new Error("Choose a level 1 Divination or Enchantment spell from an enabled source.");

    const { owner, advancement, spell } = choice;
    const native = owner.system?.advancement?.get?.(advancementId);
    if (!native?.configuration?.spell?.applySpellChanges) {
      throw new Error("The native Fey-Touched spell configuration is unavailable.");
    }

    const originalValue = advancement.value;
    const ability = originalValue.ability || spell.system?.ability;
    const data = await NativeSpellGrantProjectionService.materialize({
      sourceAdvancement: native,
      sourceUuid: sourceSpell.uuid,
      sourceItem: sourceSpell,
      owner,
      localAdvancement: { value: { ability } }
    });
    if (!data) throw new Error(`D&D5e could not prepare ${sourceSpell.name} for Fey-Touched.`);
    const origin = `${owner.id}.${advancementId}`;
    const root = spell.getFlag("dnd5e", "advancementRoot")
      ?? owner.getFlag("dnd5e", "advancementRoot") ?? origin;
    delete data._id;
    data.flags ??= {};
    data.flags.dnd5e = { ...data.flags.dnd5e, sourceId: sourceSpell.uuid, advancementOrigin: origin, advancementRoot: root };
    data.system.sourceItem = `feat:${owner.system.identifier}`;
    if (data.system.uses?.max) data.system.uses.spent = Number(spell.system?.uses?.spent ?? 0);
    data.flags[MODULE_ID] = {
      ...data.flags[MODULE_ID],
      featureGrantedSpell: true,
      featureSpellOwners: [{
        ...(spell.getFlag(MODULE_ID, "featureSpellOwners")?.[0] ?? {}),
        category: "fey-magic",
        label: "Fey Magic",
        featureItemId: owner.id,
        ownerItemId: owner.id,
        advancementId,
        sourceUuid: sourceSpell.uuid,
        spellLevel: SPELL_LEVEL,
        alwaysPrepared: Number(data.system.prepared) === 2,
        nativeGrant: true,
        validationReconciled: true
      }]
    };

    // Creating the replacement first lets failures leave the original spell intact.
    const [replacement] = await actor.createEmbeddedDocuments("Item", [data], REPAIR_OPTIONS);
    if (!replacement) throw new Error(`D&D5e did not create ${sourceSpell.name}.`);
    const added = { ...originalValue.added, [ACQUISITION_LEVEL]: { ...originalValue.added[ACQUISITION_LEVEL] } };
    delete added[ACQUISITION_LEVEL][spellId];
    added[ACQUISITION_LEVEL][replacement.id] = sourceSpell.uuid;
    let linked = false;
    try {
      await writeAdvancementValue(owner, advancementId, { ...originalValue, added }, REPAIR_OPTIONS);
      linked = true;
      await actor.deleteEmbeddedDocuments("Item", [spellId], { ...REPAIR_OPTIONS, deleteContents: false });
      if (actor.items.get(spellId)) throw new Error(`D&D5e did not remove the invalid ${spell.name} grant.`);
    } catch (error) {
      if (!actor.items.get(spellId)) {
        if (linked) return replacement;
        throw error;
      }
      await writeAdvancementValue(owner, advancementId, originalValue, REPAIR_OPTIONS);
      await actor.deleteEmbeddedDocuments("Item", [replacement.id], { ...REPAIR_OPTIONS, deleteContents: false });
      throw error;
    }
    return replacement;
  }
}
