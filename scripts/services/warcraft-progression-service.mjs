import { heroDialog, chooseStartingHero, chooseLevelThreeProgression } from "./warcraft-hero-dialog.mjs";
import { SourceResolver } from "./source-resolver.mjs";
import { readAdvancementRecords, writeAdvancementRecords } from "../utils/advancement-utils.mjs";
import { MODULE_ID } from "../constants.mjs";
import { FeatureSpellOwnershipService } from "./feature-spell-ownership-service.mjs";

const WOW = "dnd-world-warcraft";
export function activeWarcraft() {
  const module = globalThis.game?.modules?.get?.(WOW);
  return module?.active ? module : null;
}

export function sourceOf(item) {
  return item?._stats?.compendiumSource || item?.flags?.dnd5e?.sourceId || item?.uuid || "";
}

function optionsFor(identifier, registry) {
  const options = activeWarcraft()?.config?.heroClasses?.[identifier] ?? [];
  const enabled = !registry || registry.groups?.some(group => group.packageId === WOW
    || group.packCollections?.some(pack => pack.startsWith(WOW + ".")));
  if (!enabled) return [];
  return options.filter(hero => !hero.subclass || !registry || registry.isUuidAllowed(hero.subclass));
}

async function choose(title, buttons) {
  return heroDialog({
    window: { title }, buttons: buttons.map(([action, label]) => ({ action, label, callback: () => action })),
    rejectClose: false
  });
}

async function configure(data, variant, replaced = []) {
  const grants = Object.values(data.system.advancement ?? {});
  for (const step of grants) {
    if (step.type === "Subclass" && variant.subclass) {
      step.configuration.suggested = { fixed: true, uuid: variant.subclass };
    }
    const swaps = variant.replacedClassFeatures?.[step.level];
    if (step.type !== "ItemGrant" || !swaps) continue;
    for (const entry of Object.values(step.configuration.items ?? {})) {
      const original = await SourceResolver.linkedDocument(entry.uuid, data);
      const replacement = swaps[original?.system?.identifier];
      if (!replacement) continue;
      for (const [id, uuid] of Object.entries(step.value?.added ?? {})) {
        if (uuid !== entry.uuid && uuid !== original.uuid) continue;
        replaced.push({ id, origin: data._id + "." + step._id, uuid: original.uuid });
        delete step.value.added[id];
      }
      entry.uuid = replacement;
    }
  }
  data.name = game.i18n.localize(variant.name);
  data.img = variant.img;
  data.flags ??= {};
  data.flags[WOW] = { ...data.flags[WOW], heroClass: variant.identifier };
  return data;
}

export async function selectWarcraftClass(data, registry) {
  const identifier = data.system?.identifier;
  const variants = optionsFor(identifier, registry);
  if (!variants.length || data.flags?.[WOW]?.heroClass) return data;
  const selection = await chooseStartingHero(variants);
  if (!selection) return null;
  return selection.hero ? configure(data, selection.hero) : data;
}

function otherAcquisition(item) {
  const flags = item.flags?.[MODULE_ID] ?? {};
  return flags.classSpellAccess || (flags.levelUpSpell && !flags.levelUpSpell.featureItemId);
}

export async function retireGrantTree(actor, parentIds) {
  const retired = new Set(parentIds);
  for (const parentId of retired) {
    for (const item of [...actor.items]) {
      const flags = item.flags?.[MODULE_ID] ?? {};
      const native = item.flags?.dnd5e ?? {};
      const linked = [native.advancementOrigin, native.advancementRoot].some(link => link?.split(".")[0] === parentId)
        || flags.itemGrantInstance?.ownerItemId === parentId;
      const owns = row => (row.ownerItemId ?? row.featureItemId) === parentId;
      const owners = flags.featureSpellOwners ?? [];
      const receipts = flags.mergedItemGrants ?? [];
      if (!linked && !owners.some(owns) && !receipts.some(owns)) continue;
      const survivingReceipts = receipts.filter(row => !owns(row));
      const remaining = owners.some(owns) ? await FeatureSpellOwnershipService.removeOwner(item, owns) : owners;
      if (remaining.length || survivingReceipts.length || otherAcquisition(item)) {
        const update = {};
        if (survivingReceipts.length !== receipts.length) {
          update["flags." + MODULE_ID + ".mergedItemGrants"] = survivingReceipts;
          const history = flags.alwaysPreparedReconciliation;
          if (history) {
            const grants = (history.grants ?? []).filter(row => !owns(row));
            if (grants.length) update["flags." + MODULE_ID + ".alwaysPreparedReconciliation.grants"] = grants;
            else update["flags." + MODULE_ID + ".-=alwaysPreparedReconciliation"] = null;
          }
          const augmentation = receipts.find(row => owns(row) && row.augmentation)?.augmentation;
          if (augmentation && !survivingReceipts.some(row => row.augmentation)) {
            if (augmentation.previousUses) update["system.uses"] = foundry.data.operators.ForcedReplacement.create(augmentation.previousUses);
            for (const [id, targets] of Object.entries(augmentation.activityConsumptionPrevious ?? {})) {
              if (item.system.activities?.get?.(id)) update["system.activities." + id + ".consumption.targets"] = targets;
            }
          }
        }
        if (linked) {
          const survivor = remaining.find(row => row.ownerItemId && row.advancementId);
          for (const key of ["advancementOrigin", "advancementRoot"]) {
            if (native[key]?.split(".")[0] !== parentId) continue;
            if (survivor) update["flags.dnd5e." + key] = survivor.ownerItemId + "." + survivor.advancementId;
            else update["flags.dnd5e.-=" + key] = null;
          }
          if (flags.itemGrantInstance?.ownerItemId === parentId) update["flags." + MODULE_ID + ".-=itemGrantInstance"] = null;
        }
        if (Object.keys(update).length) await item.update(update);
      } else retired.add(item.id);
    }
  }
  const ids = [...retired].filter(id => actor.items.has(id));
  if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids, { deleteContents: false });
}

export async function resolveHeroProgression(actor, cls, level, registry) {
  if (cls.flags?.[WOW]?.heroClass) return { changed: false };
  const variants = optionsFor(cls.system.identifier, registry);
  if (!variants.length) return { changed: false };
  if (Number(level) === 3) {
    if (!Object.values(cls.toObject().system.advancement ?? {}).some(step => step.type === "Subclass" && Number(step.level) === 3)) return { changed: false };
    const selection = await chooseLevelThreeProgression(cls, variants, registry);
    if (!selection) return null;
    if (selection.hero) await applyHero(actor, cls, selection.hero);
    return { changed: Boolean(selection.hero), subclass: selection.uuid };
  }

  // Preserve opt-in review for an existing Ebon Blade character created before hero tracking.
  const legacy = variants.find(row => row.identifier === "death-knight");
  if (!legacy || Number(level) <= 3 || cls.getFlag(MODULE_ID, "reviewedLegacyKnight")
    || !actor.items.some(item => item.type === "subclass" && sourceOf(item) === legacy.subclass)) return { changed: false };
  const choice = await choose("Oath of the Ebon Blade progression", [["standard", "Keep current class features"], ["death-knight", "Apply Death Knight progression"]]);
  if (!choice) return null;
  if (choice === "standard") await cls.setFlag(MODULE_ID, "reviewedLegacyKnight", true);
  else await applyHero(actor, cls, legacy);
  return { changed: true };
}

async function applyHero(actor, cls, variant) {
  const removed = [];
  const data = await configure(cls.toObject(), variant, removed);
  for (const row of removed) {
    const item = actor.items.get(row.id);
    if (item && !(sourceOf(item) === row.uuid && [item.flags?.dnd5e?.advancementOrigin,
      item.flags?.dnd5e?.advancementRoot].includes(row.origin))) throw new Error("Cannot verify the class grant " + item.name);
  }
  const original = cls.getFlag(MODULE_ID, "rulesOriginalAdvancement");
  const updates = { name: data.name, img: data.img, ["flags." + WOW + ".heroClass"]: variant.identifier,
    ["flags." + MODULE_ID + ".-=deferredDeathKnight"]: null,
    "system.advancement": foundry.data.operators.ForcedReplacement.create(data.system.advancement) };
  if (original) {
    const base = { ...data, system: { advancement: foundry.utils.deepClone(original) } };
    await configure(base, variant);
    updates["flags." + MODULE_ID + ".rulesOriginalAdvancement"] = foundry.data.operators.ForcedReplacement.create(base.system.advancement);
  }
  await cls.update(updates);
  await retireGrantTree(actor, removed.map(row => row.id));
  return "changed";
}

export function eligibleWarcraftSpell(actor, spell) {
  if (!activeWarcraft() || !(spell?.packCollection === WOW + ".spells" || sourceOf(spell).startsWith("Compendium." + WOW + ".spells."))) return true;
  const text = String(spell.system?.description?.value ?? "").replace(/<[^>]*>/g, " ").trim();
  const match = /^Prerequisite:\s*([^\n]+?)(?:\s{2,}|$)/i.exec(text);
  if (!match) return true;
  const required = match[1].trim().toLowerCase().replace(/ subclass$/, "").replaceAll(" ", "-");
  const items = [...(actor?.items ?? [])];
  if (["void-elf", "nightborne-elf"].includes(required)) {
    const id = required === "void-elf" ? "wowsptVoidElf000" : "wowsptNightborne";
    return items.some(item => sourceOf(item) === "Compendium." + WOW + ".origins.Item." + id);
  }
  for (const [identifier, variants] of Object.entries(activeWarcraft().config?.heroClasses ?? {})) {
    const variant = variants.find(row => row.identifier === required);
    if (!variant) continue;
    const cls = items.find(item => item.type === "class" && item.system?.identifier === identifier);
    if (!cls) return false;
    if (required === "hunter") return !cls.flags?.[WOW]?.heroClass || cls.flags[WOW].heroClass === "hunter";
    if (!variant.subclass) return cls.flags?.[WOW]?.heroClass === required;
    if (required === "evoker" && cls.flags?.[WOW]?.heroClass !== required) return false;
    return items.some(item => item.type === "subclass" && item.system?.classIdentifier === identifier && sourceOf(item) === variant.subclass);
  }
  return false;
}

export function restrictedOrdinarySpell(actor, item) {
  if (item?.type !== "spell" || eligibleWarcraftSpell(actor, item)) return false;
  const flags = item.flags?.[MODULE_ID] ?? {};
  const native = item.flags?.dnd5e ?? {};
  return !flags.featureGrantedSpell && !flags.featureSpellOwners?.length && !flags.featureAcquisition
    && !flags.mergedItemGrants?.length && !flags.alwaysPreparedReconciliation?.grants?.length
    && !flags.levelUpSpell?.featureItemId && !flags.levelUpSpell?.subclassItemId
    && !native.advancementOrigin && !native.advancementRoot && !flags.itemGrantInstance;
}

export function invalidListGrant(actor, item) {
  const flags = item.flags?.[MODULE_ID] ?? {};
  const levelUp = flags.levelUpSpell;
  const listOnly = (flags.accessModel === "fullList" && flags.classSpellAccess)
    || (levelUp?.category === "full-list" && levelUp.accessModel === "fullList");
  return Boolean(listOnly && flags.warcraftRetainedSpell !== sourceOf(item) && restrictedOrdinarySpell(actor, item));
}

export async function reviewRestrictedSpell(actor, spell) {
  if (!restrictedOrdinarySpell(actor, spell)) return "unchanged";
  const choice = await choose(spell.name + " · Warcraft prerequisite",
    [["keep", "Keep as a GM grant"], ["remove", "Remove from revised copy"]]);
  if (!choice) return "cancelled";
  if (!restrictedOrdinarySpell(actor, spell)) return "unchanged";
  if (choice === "keep") await spell.setFlag(MODULE_ID, "warcraftRetainedSpell", sourceOf(spell));
  else await actor.deleteEmbeddedDocuments("Item", [spell.id], { characterBuilderValidationRepair: true });
  return "changed";
}

const PET_SPECIALIZATION = "Compendium.dnd-world-warcraft.classes.Item.wowrngPetSpecial";

function eligibleBeastMaster(actor, cls, registry) {
  if (!activeWarcraft() || cls?.type !== "class" || cls.system.identifier !== "ranger"
    || !registry?.isUuidAllowed(PET_SPECIALIZATION) || !optionsFor("ranger", registry).some(row => row.identifier === "hunter")) return false;
  const hero = cls.flags?.[WOW]?.heroClass;
  return (!hero || hero === "hunter") && actor.items.some(item => item.type === "subclass"
    && item.system.classIdentifier === "ranger" && ["beast", "beast-master"].includes(item.system.identifier));
}

function existingPetChoice(cls, actor) {
  return Object.values(readAdvancementRecords(cls)).some(grant => Number(grant.level) === 6
    && Object.values(grant.configuration?.items ?? {}).some(entry => entry.uuid === PET_SPECIALIZATION)
    && Object.keys(grant.value?.added ?? {}).some(id => ["pet-specialization", "roving"].includes(actor.items.get(id)?.system?.identifier)));
}

export function hunterReview(actor, cls, registry) {
  return eligibleBeastMaster(actor, cls, registry) && Number(cls.system.levels) >= 6
    && !existingPetChoice(cls, actor)
    && !actor.items.some(item => sourceOf(item) === PET_SPECIALIZATION);
}

async function levelSixGrant(cls, records) {
  for (const [id, grant] of Object.entries(records)) {
    if (grant.type !== "ItemGrant" || Number(grant.level) !== 6) continue;
    for (const entry of Object.values(grant.configuration?.items ?? {})) {
      const uuid = typeof entry === "string" ? entry : entry.uuid;
      const source = await SourceResolver.linkedDocument(uuid, cls);
      if (source?.system?.identifier === "roving") return { id, grant, rovingUuid: uuid, source };
    }
  }
  return null;
}

export async function prepareHunterChoice(actor, cls, nextLevel, registry) {
  if (nextLevel < 6 || !eligibleBeastMaster(actor, cls, registry) 
    || (nextLevel > 6 && existingPetChoice(cls, actor))) return "unchanged";
  const records = readAdvancementRecords(cls);
  const slot = await levelSixGrant(cls, records);
  if (!slot) throw new Error("Cannot locate the level 6 Roving advancement in this Ranger class. Check its source or skip this finding.");
  const { id, grant, rovingUuid, source } = slot;
  const origin = cls.id + "." + id;
  const cfg = grant.configuration;
  cfg.items = Object.values(cfg.items).map(row => typeof row === "string" ? { uuid: row } : row);
  cfg.items.find(entry => entry.uuid === rovingUuid).optional = true;
  cfg.optional = true;
  if (!cfg.items.some(entry => entry.uuid === PET_SPECIALIZATION)) cfg.items.push({
    uuid: PET_SPECIALIZATION, optional: true, sort: (cfg.items.at(-1)?.sort ?? 0) + CONST.SORT_INTEGER_DENSITY
  });

  if (nextLevel === 6) {
    await writeAdvancementRecords(cls, records);
    return "changed";
  }

  grant.value ??= {};
  const added = grant.value.added ??= {};
  const candidates = actor.items.filter(item => item.type === "feat" && item.system?.identifier === "roving");
  const owned = candidates.filter(item => item.flags?.dnd5e?.advancementOrigin === origin
    || item.flags?.[MODULE_ID]?.itemGrantInstance?.advancementOrigin === origin
    || ([rovingUuid, source.uuid].includes(added[item.id]) && !item.flags?.dnd5e?.advancementOrigin));
  if (owned.length > 1) throw new Error("Several Roving items belong to this advancement. Review those items or skip this finding.");
  const old = owned[0];
  if (!old && candidates.length) {
    // A receipt can be absent on an imported Actor. Only adopt an unclaimed canonical copy.
    const adoptable = candidates.filter(item => sourceOf(item) === source.uuid && !item.flags?.dnd5e?.advancementOrigin
      && !item.flags?.[MODULE_ID]?.itemGrantInstance && !item.flags?.dnd5e?.advancementRoot);
    if (adoptable.length !== 1 || candidates.length !== 1) throw new Error("Cannot identify the class-owned Roving among the existing items. Review their origins or skip this finding.");
    owned.push(adoptable[0]);
  }
  const current = owned[0];
  const choice = await choose("Beast Master · Ranger Level 6", [["keep", current ? "Keep Roving" : "Gain Roving"],
    ["pet", current ? "Replace Roving with Pet Specialization" : "Gain Pet Specialization"]]);
  if (!choice) return "cancelled";
  const previous = readAdvancementRecords(cls);
  const selected = choice === "pet" ? await fromUuid(PET_SPECIALIZATION) : source;
  if (!selected) throw new Error("The selected feature is unavailable in the enabled source.");
  let created;
  try {
    if (choice === "pet" || !current) {
      const data = selected.toObject();
      delete data._id;
      data.flags ??= {};
      data.flags.dnd5e = { ...data.flags.dnd5e, sourceId: selected.uuid, advancementOrigin: origin, advancementRoot: origin };
      [created] = await actor.createEmbeddedDocuments("Item", [data]);
      if (!created) throw new Error("The selected Ranger feature could not be created.");
    }
    for (const [key, uuid] of Object.entries(added)) {
      if ([rovingUuid, source.uuid, PET_SPECIALIZATION].includes(uuid) && (!actor.items.has(key) || key === current?.id)) delete added[key];
    }
    added[(created ?? current).id] = choice === "pet" ? PET_SPECIALIZATION : rovingUuid;
    await writeAdvancementRecords(cls, records);
    if (choice === "pet" && current) {
      await actor.deleteEmbeddedDocuments("Item", [current.id], { deleteContents: false });
      if (actor.items.has(current.id)) throw new Error("The previous Roving item could not be replaced.");
    }
    return "changed";
  } catch (error) {
    await writeAdvancementRecords(cls, previous);
    if (created && actor.items.has(created.id)) await actor.deleteEmbeddedDocuments("Item", [created.id]);
    throw error;
  }
}

export function validateHunterChoice(actor, cls, level) {
  if (!activeWarcraft() || Number(level) !== 6 || cls?.system.identifier !== "ranger") return;
  for (const grant of Object.values(readAdvancementRecords(cls))) {
    if (grant.type !== "ItemGrant" || Number(grant.level) !== 6
      || !grant.configuration?.items?.some(entry => entry.uuid === PET_SPECIALIZATION)) continue;
    const choices = Object.entries(grant.value?.added ?? {}).filter(([id, uuid]) =>
      actor.items.has(id) && (uuid === PET_SPECIALIZATION || actor.items.get(id).system.identifier === "roving"));
    if (choices.length !== 1) throw new Error("Choose either Roving or Pet Specialization in the Level 6 Hunter advancement.");
  }
}
