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
  if (!registry || registry.groups?.some(group => group.packageId === WOW
    || group.packCollections?.some(pack => pack.startsWith(WOW + ".")))) return options;
  return [];
}

async function choose(title, buttons) {
  return foundry.applications.api.DialogV2.wait({
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
      const original = await fromUuid(entry.uuid);
      const replacement = swaps[original?.system?.identifier];
      if (!replacement) continue;
      for (const [id, uuid] of Object.entries(step.value?.added ?? {})) {
        if (uuid !== entry.uuid) continue;
        replaced.push({ id, origin: data._id + "." + step._id, uuid });
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
  const buttons = variants.map(row => [row.identifier, game.i18n.localize(row.name)]);
  buttons.push(["standard", data.name]);
  if (identifier === "paladin") buttons.push(["defer", "Decide at Paladin Level 3"]);
  const choice = await choose("Choose " + data.name + " progression", buttons);
  if (!choice) return null;
  if (identifier === "ranger" && choice === "standard") {
    data.flags ??= {};
    data.flags[MODULE_ID] = { ...data.flags[MODULE_ID], standardWarcraftRanger: true };
  }
  if (choice === "defer") {
    data.flags ??= {};
    data.flags[MODULE_ID] = { ...data.flags[MODULE_ID], deferredDeathKnight: true };
  }
  const variant = variants.find(row => row.identifier === choice);
  return variant ? configure(data, variant) : data;
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

export async function resolveDeferredKnight(actor, cls, level, registry) {
  if (!activeWarcraft() || cls.system?.identifier !== "paladin" || cls.flags?.[WOW]?.heroClass) return "unchanged";
  const deferred = cls.getFlag(MODULE_ID, "deferredDeathKnight") && Number(level) === 3;
  const legacy = Number(level) > 3 && !cls.getFlag(MODULE_ID, "reviewedLegacyKnight") && actor.items.some(item =>
    item.type === "subclass" && sourceOf(item) === "Compendium.dnd-world-warcraft.classes.Item.wowpdnOathEbonBl");
  if (!deferred && !legacy) return "unchanged";
  const variant = optionsFor(cls.system.identifier, registry).find(row => row.identifier === "death-knight");
  if (!variant) return "unchanged";
  const choice = await choose(legacy ? "Oath of the Ebon Blade progression" : "Paladin Level 3",
    [["standard", legacy ? "Keep current class features" : "Remain a Paladin"], ["death-knight", "Apply Death Knight progression"]]);
  if (!choice) return "cancelled";
  if (choice === "standard") {
    if (legacy) await cls.setFlag(MODULE_ID, "reviewedLegacyKnight", true);
    else await cls.unsetFlag(MODULE_ID, "deferredDeathKnight");
    return "changed";
  }
  const removed = [];
  const data = await configure(cls.toObject(), variant, removed);
  for (const row of removed) {
    const item = actor.items.get(row.id);
    if (item && !(sourceOf(item) === row.uuid && [item.flags?.dnd5e?.advancementOrigin,
      item.flags?.dnd5e?.advancementRoot].includes(row.origin))) throw new Error("Cannot verify the Paladin grant " + item.name);
  }
  const original = cls.getFlag(MODULE_ID, "rulesOriginalAdvancement");
  const updates = { name: data.name, img: data.img, ["flags." + WOW + ".heroClass"]: variant.identifier,
    ["flags." + MODULE_ID + ".-=deferredDeathKnight"]: null,
    "system.advancement": foundry.data.operators.ForcedReplacement.create(data.system.advancement) };
  if (original) {
    const base = { system: { advancement: foundry.utils.deepClone(original) } };
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
    if (!variant.subclass) return cls.flags?.[WOW]?.heroClass === required;
    if (required === "evoker" && cls.flags?.[WOW]?.heroClass !== required) return false;
    return items.some(item => item.type === "subclass" && item.system?.classIdentifier === identifier && sourceOf(item) === variant.subclass);
  }
  return false;
}

export function invalidListGrant(actor, item) {
  const flags = item.flags?.[MODULE_ID] ?? {};
  const native = item.flags?.dnd5e ?? {};
  const listOnly = flags.accessModel === "fullList" && (flags.classSpellAccess || flags.levelUpSpell);
  return Boolean(item.type === "spell" && listOnly && !flags.featureGrantedSpell && !flags.featureSpellOwners?.length
    && !flags.featureAcquisition && !flags.mergedItemGrants?.length && !flags.levelUpSpell?.featureItemId && !native.advancementOrigin && !native.advancementRoot
    && !flags.itemGrantInstance && !eligibleWarcraftSpell(actor, item));
}

const PET_SPECIALIZATION = "Compendium.dnd-world-warcraft.classes.Item.wowrngPetSpecial";

function alreadyOfferedPet(cls) {
  return Object.values(cls.toObject().system.advancement ?? {}).some(grant => Number(grant.level) === 6
    && grant.configuration?.items?.some(entry => entry.uuid === PET_SPECIALIZATION)
    && Object.keys(grant.value?.added ?? {}).length > 0);
}

export async function prepareHunterChoice(actor, cls, nextLevel, registry) {
  if (!activeWarcraft() || cls.system.identifier !== "ranger" || nextLevel < 6
    || !optionsFor("ranger", registry).some(row => row.identifier === "hunter")
    || !registry?.isUuidAllowed(PET_SPECIALIZATION)) return "unchanged";
  const beastMaster = actor.items.some(item => item.type === "subclass" && item.system.classIdentifier === "ranger"
    && ["beast", "beast-master"].includes(item.system.identifier));
  if (!beastMaster || cls.flags?.[MODULE_ID]?.standardWarcraftRanger || cls.flags?.[MODULE_ID]?.reviewedHunterPet) return "unchanged";
  if (nextLevel > 6 && alreadyOfferedPet(cls)) return "unchanged";
  let variant = cls.flags?.[WOW]?.heroClass;
  const update = {};
  if (!variant) {
    const choice = await choose("Beast Master progression", [["standard", "Keep standard Ranger"], ["hunter", "Use Warcraft Hunter"]]);
    if (!choice) return "cancelled";
    if (choice === "standard") {
      await cls.setFlag(MODULE_ID, "standardWarcraftRanger", true);
      return "changed";
    }
    const hunter = optionsFor("ranger", registry).find(row => row.identifier === "hunter");
    Object.assign(update, { name: game.i18n.localize(hunter.name), img: hunter.img, ["flags." + WOW + ".heroClass"]: "hunter" });
    variant = "hunter";
  }
  if (variant !== "hunter") return "unchanged";
  const advancement = cls.toObject().system.advancement;
  for (const grant of Object.values(advancement)) {
    if (grant.type !== "ItemGrant" || Number(grant.level) !== 6) continue;
    const entries = grant.configuration.items;
    const roving = (await Promise.all(entries.map(async entry =>
      (await fromUuid(entry.uuid))?.system?.identifier === "roving" ? entry : null))).find(Boolean);
    if (!roving) continue;
    grant.configuration.optional = true;
    roving.optional = true;
    if (!entries.some(entry => entry.uuid === PET_SPECIALIZATION)) {
      entries.push({ uuid: PET_SPECIALIZATION, optional: true, sort: (entries.at(-1)?.sort ?? 0) + CONST.SORT_INTEGER_DENSITY });
    }
    // Older Hunters may have already received Roving without being offered a choice.
    if (nextLevel > 6 && !Object.values(grant.value?.added ?? {}).includes(PET_SPECIALIZATION)) {
      const old = Object.entries(grant.value?.added ?? {}).find(([, uuid]) => uuid === roving.uuid);
      if (!old || !actor.items.has(old[0])) {
        ui.notifications.warn("Roving has no recoverable Level 6 grant on this character.");
        return "unchanged";
      }
      const choice = await choose("Beast Master Level 6", [["keep", "Keep Roving"], ["pet", "Replace Roving with Pet Specialization"]]);
      if (!choice) return "cancelled";
      if (choice === "pet") {
        const item = actor.items.get(old[0]);
        const origin = cls.id + "." + grant._id;
        if (item.flags?.dnd5e?.advancementOrigin !== origin) throw new Error("Cannot verify the origin of Roving.");
        const source = await fromUuid(PET_SPECIALIZATION);
        const replacement = source.toObject();
        delete replacement._id;
        replacement.flags ??= {};
        replacement.flags.dnd5e = { ...replacement.flags.dnd5e, sourceId: source.uuid, advancementOrigin: origin,
          advancementRoot: item.flags.dnd5e.advancementRoot ?? origin };
        const [created] = await actor.createEmbeddedDocuments("Item", [replacement]);
        delete grant.value.added[old[0]];
        grant.value.added[created.id] = source.uuid;
        await retireGrantTree(actor, [old[0]]);
      }
    }
    update["flags." + MODULE_ID + ".reviewedHunterPet"] = true;
    update["system.advancement"] = foundry.data.operators.ForcedReplacement.create(advancement);
    await cls.update(update);
    return "changed";
  }
  if (Object.keys(update).length) { await cls.update(update); return "changed"; }
  return "unchanged";
}

export function hunterReview(actor, cls, registry) {
  if (!activeWarcraft() || cls?.type !== "class" || cls.system.identifier !== "ranger" || Number(cls.system.levels) < 6
    || cls.flags?.[MODULE_ID]?.standardWarcraftRanger || cls.flags?.[MODULE_ID]?.reviewedHunterPet
    || !registry?.isUuidAllowed(PET_SPECIALIZATION) || !optionsFor("ranger", registry).some(row => row.identifier === "hunter")) return false;
  if (alreadyOfferedPet(cls)) return false;
  const hero = cls.flags?.[WOW]?.heroClass;
  return (!hero || hero === "hunter") && [...actor.items].some(item => item.type === "subclass"
    && item.system.classIdentifier === "ranger" && ["beast", "beast-master"].includes(item.system.identifier))
    && !actor.items.some(item => sourceOf(item) === PET_SPECIALIZATION);
}

export function validateHunterChoice(actor, cls, level) {
  if (!activeWarcraft() || Number(level) !== 6 || cls?.flags?.[WOW]?.heroClass !== "hunter") return;
  for (const grant of Object.values(cls.toObject().system.advancement ?? {})) {
    if (grant.type !== "ItemGrant" || Number(grant.level) !== 6
      || !grant.configuration?.items?.some(entry => entry.uuid === PET_SPECIALIZATION)) continue;
    const choices = Object.entries(grant.value?.added ?? {}).filter(([id, uuid]) =>
      actor.items.has(id) && (uuid === PET_SPECIALIZATION || actor.items.get(id).system.identifier === "roving"));
    if (choices.length !== 1) throw new Error("Choose either Roving or Pet Specialization in the Level 6 Hunter advancement.");
  }
}
