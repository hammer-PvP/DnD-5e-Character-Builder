import { MODULE_ID } from "./constants.mjs";
import { getConfiguration } from "./settings.mjs";

const INDEX_FIELDS = [
  "name",
  "type",
  "img",
  "system.identifier",
  "system.rarity",
  "system.type.value",
  "system.type.baseItem",
  "system.price.value",
  "system.price.denomination",
  "system.quantity",
  "system.properties",
  "system.magicalBonus",
  "system.level",
  "system.school",
  "system.range.value",
  "system.range.long",
  "system.range.units",
  "system.armor.type",
  "system.armor.value"
];

const SUBTYPE_LABEL_KEYS = {
  simpleM: "DND5E_SUPPLIER.Subtype.simpleM",
  simpleR: "DND5E_SUPPLIER.Subtype.simpleR",
  martialM: "DND5E_SUPPLIER.Subtype.martialM",
  martialR: "DND5E_SUPPLIER.Subtype.martialR",
  lightArmor: "DND5E_SUPPLIER.Subtype.lightArmor",
  mediumArmor: "DND5E_SUPPLIER.Subtype.mediumArmor",
  heavyArmor: "DND5E_SUPPLIER.Subtype.heavyArmor",
  shield: "DND5E_SUPPLIER.Subtype.shield",
  clothing: "DND5E_SUPPLIER.Subtype.clothing",
  ring: "DND5E_SUPPLIER.Subtype.ring",
  rod: "DND5E_SUPPLIER.Subtype.rod",
  trinket: "DND5E_SUPPLIER.Subtype.trinket",
  wand: "DND5E_SUPPLIER.Subtype.wand",
  wondrous: "DND5E_SUPPLIER.Subtype.wondrous",
  potion: "DND5E_SUPPLIER.Subtype.potion",
  poison: "DND5E_SUPPLIER.Subtype.poison",
  scroll: "DND5E_SUPPLIER.Subtype.scroll",
  food: "DND5E_SUPPLIER.Subtype.food",
  ammunition: "DND5E_SUPPLIER.Subtype.ammunition"
};

let catalogCache = null;
let cacheSignature = "";

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeRarity(value) {
  const normalized = normalizeText(value).replaceAll("-", "");
  if (!normalized) return "none";
  if (normalized === "veryrare") return "veryRare";
  return normalized;
}

function titleCase(value) {
  return String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  if (typeof value === "object") {
    if (Array.isArray(value.value)) return value.value;
    return Object.entries(value).filter(([, enabled]) => Boolean(enabled)).map(([key]) => key);
  }
  return [value];
}

function parseEnhancement(name, explicitBonus) {
  const numeric = Number(explicitBonus ?? 0);
  if (Number.isFinite(numeric) && numeric > 0) return Math.min(3, Math.floor(numeric));
  const match = String(name ?? "").match(/(?:^|\s)\+([123])(?:\s|$|\))/);
  return match ? Number(match[1]) : 0;
}

function classifyWeapon(subtype) {
  const raw = String(subtype ?? "");
  const normalized = normalizeText(raw);
  let category = "";
  let mode = "";

  if (/^simple/i.test(raw) || normalized.includes("simple")) category = "simple";
  if (/^martial/i.test(raw) || normalized.includes("martial")) category = "martial";

  if (/[rR]$/.test(raw) || normalized.includes("ranged")) mode = "ranged";
  if (/[mM]$/.test(raw) || normalized.includes("melee")) mode = "melee";

  return { category, mode };
}

function classifyArmor(type, subtype, armorType) {
  if (type !== "equipment") return "";
  const values = [subtype, armorType].map(normalizeText);
  for (const candidate of ["light", "medium", "heavy", "shield"]) {
    if (values.includes(candidate) || values.some(value => value.includes(candidate))) return candidate;
  }
  return "";
}

export function nativeSubtypeKey({ type, subtype, armorCategory = "", weaponCategory = "", weaponMode = "" }) {
  if (type === "weapon") {
    if (weaponCategory === "simple" && weaponMode === "melee") return "simpleM";
    if (weaponCategory === "simple" && weaponMode === "ranged") return "simpleR";
    if (weaponCategory === "martial" && weaponMode === "melee") return "martialM";
    if (weaponCategory === "martial" && weaponMode === "ranged") return "martialR";
  }
  if (type === "equipment") {
    if (armorCategory === "light") return "lightArmor";
    if (armorCategory === "medium") return "mediumArmor";
    if (armorCategory === "heavy") return "heavyArmor";
    if (armorCategory === "shield") return "shield";
  }

  const normalized = normalizeText(subtype).replaceAll("-", "");
  const aliases = {
    simplem: "simpleM",
    simpler: "simpleR",
    martialm: "martialM",
    martialr: "martialR",
    lightarmor: "lightArmor",
    mediumarmor: "mediumArmor",
    heavyarmor: "heavyArmor",
    wondrousitem: "wondrous",
    wondrous: "wondrous",
    ammo: "ammunition"
  };
  return aliases[normalized] ?? normalizeText(subtype);
}

export function nativeSubtypeLabel(key) {
  const localizationKey = SUBTYPE_LABEL_KEYS[key];
  if (localizationKey && game?.i18n?.has?.(localizationKey)) return game.i18n.localize(localizationKey);
  if (localizationKey) {
    const translated = game?.i18n?.localize?.(localizationKey);
    if (translated && translated !== localizationKey) return translated;
  }
  return titleCase(key);
}

export function entryMatchesSubtype(entry, subtypeKey) {
  const wanted = nativeSubtypeKey({ type: entry.type, subtype: subtypeKey });
  return new Set(entry.subtypeKeys ?? [entry.primarySubtypeKey]).has(wanted);
}

export function healingPotionTier(entry) {
  const value = normalizeText(`${entry.identifier ?? ""} ${entry.name ?? ""}`);
  if (!value.includes("potion") || !value.includes("healing")) return "";
  if (value.includes("supreme")) return "supreme";
  if (value.includes("superior")) return "superior";
  if (value.includes("greater")) return "greater";
  return "basic";
}

export function entryFamilyIds(entry) {
  const families = [];
  if (healingPotionTier(entry)) families.push("healingPotions");
  return families;
}

export function canonicalKey(entry) {
  const identifier = normalizeText(entry.identifier);
  if (identifier) return `identifier:${identifier}`;
  return `name:${normalizeText(entry.name)}|type:${normalizeText(entry.type)}`;
}

export function banKey(entry) {
  return `name:${normalizeText(entry.name)}|type:${normalizeText(entry.type)}`;
}

export function familyMemberKey(entry, familyId) {
  if (familyId === "healingPotions") return `${familyId}:${healingPotionTier(entry) || canonicalKey(entry)}`;
  return `${familyId}:${canonicalKey(entry)}`;
}

function sourceSignature(configuration) {
  return JSON.stringify((configuration.sources ?? []).map(source => [source.id, source.enabled, source.priority]));
}

export function clearCatalogCache() {
  catalogCache = null;
  cacheSignature = "";
}

function mergeEntryGroup(group) {
  if (!group?.length) return null;
  const primary = group[0];
  const subtypeKeys = [];
  const subtypeAliases = [];
  const familyIds = new Set();
  for (const variant of group) {
    for (const key of variant.subtypeKeys ?? [variant.primarySubtypeKey]) {
      if (key && !subtypeKeys.includes(key)) subtypeKeys.push(key);
    }
    if (variant.subtype && !subtypeAliases.includes(variant.subtype)) subtypeAliases.push(variant.subtype);
    for (const familyId of variant.familyIds ?? []) familyIds.add(familyId);
  }
  return {
    ...primary,
    subtypeKeys,
    subtypeAliases,
    familyIds: [...familyIds],
    sourceVariants: group.map(variant => ({
      uuid: variant.uuid,
      packId: variant.packId,
      packLabel: variant.packLabel,
      subtype: variant.subtype,
      subtypeKey: variant.primarySubtypeKey,
      rarity: variant.rarity,
      enhancement: variant.enhancement
    }))
  };
}

export async function buildCatalog({ force = false, configurationOverride = null } = {}) {
  const configuration = configurationOverride ?? getConfiguration();
  const signature = sourceSignature(configuration);
  if (!force && catalogCache && cacheSignature === signature) return catalogCache;

  const enabledSources = (configuration.sources ?? [])
    .filter(source => source.enabled)
    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0));

  const rawEntries = [];
  for (const source of enabledSources) {
    const pack = game.packs.get(source.id);
    if (!pack || pack.documentName !== "Item") continue;

    let index;
    try {
      index = await pack.getIndex({ fields: INDEX_FIELDS });
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to index ${source.id}`, error);
      continue;
    }

    for (const record of index) {
      const subtype = foundry.utils.getProperty(record, "system.type.value") ?? "";
      const armorType = foundry.utils.getProperty(record, "system.armor.type") ?? "";
      const properties = toArray(foundry.utils.getProperty(record, "system.properties")).map(String);
      const enhancement = parseEnhancement(record.name, foundry.utils.getProperty(record, "system.magicalBonus"));
      const weapon = record.type === "weapon" ? classifyWeapon(subtype) : { category: "", mode: "" };
      const armorCategory = classifyArmor(record.type, subtype, armorType);
      const rarity = normalizeRarity(foundry.utils.getProperty(record, "system.rarity"));
      const isMagical = enhancement > 0 || rarity !== "none" || properties.includes("mgc");
      const primarySubtypeKey = nativeSubtypeKey({
        type: record.type,
        subtype,
        armorCategory,
        weaponCategory: weapon.category,
        weaponMode: weapon.mode
      });

      const entry = {
        id: record._id,
        uuid: record.uuid ?? `Compendium.${pack.collection}.Item.${record._id}`,
        packId: pack.collection,
        packLabel: pack.metadata.label,
        packageName: pack.metadata.packageName,
        priority: Number(source.priority ?? 0),
        name: record.name,
        type: record.type,
        img: record.img,
        identifier: foundry.utils.getProperty(record, "system.identifier") ?? "",
        rarity,
        subtype,
        primarySubtypeKey,
        subtypeKeys: primarySubtypeKey ? [primarySubtypeKey] : [],
        subtypeAliases: subtype ? [subtype] : [],
        baseItem: foundry.utils.getProperty(record, "system.type.baseItem") ?? "",
        priceValue: Number(foundry.utils.getProperty(record, "system.price.value") ?? 0),
        priceDenomination: foundry.utils.getProperty(record, "system.price.denomination") ?? "gp",
        properties,
        enhancement,
        isMagical,
        weaponCategory: weapon.category,
        weaponMode: weapon.mode,
        armorCategory,
        spellLevel: Number(foundry.utils.getProperty(record, "system.level") ?? 0),
        school: foundry.utils.getProperty(record, "system.school") ?? ""
      };
      entry.key = canonicalKey(entry);
      entry.familyIds = entryFamilyIds(entry);
      rawEntries.push(entry);
    }
  }

  rawEntries.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  const grouped = new Map();
  for (const entry of rawEntries) {
    const group = grouped.get(entry.key) ?? [];
    group.push(entry);
    grouped.set(entry.key, group);
  }

  const entries = [...grouped.values()].map(mergeEntryGroup).filter(Boolean);
  const familyGroups = new Map();
  for (const entry of entries) {
    for (const familyId of entry.familyIds) {
      const key = familyMemberKey(entry, familyId);
      const group = familyGroups.get(key) ?? [];
      group.push(entry);
      familyGroups.set(key, group);
    }
  }

  catalogCache = { entries, rawEntries, grouped, familyGroups };
  cacheSignature = signature;
  return catalogCache;
}

export function isBannedEntry(entry, profile, configuration = getConfiguration()) {
  const bans = [
    ...(profile?.bannedItems ?? []),
    ...(configuration?.bannedItems ?? [])
  ];
  for (const banned of bans) {
    if (banned?.allSources === true && banned.key && banned.key === banKey(entry)) return true;
    if (banned?.uuid && banned.uuid === entry.uuid) return true;
  }
  return false;
}

export function entriesForProfile(catalog, profile, configuration = getConfiguration(), { includeBanned = false } = {}) {
  const sourceIds = new Set(profile?.sourceIds ?? []);
  const entries = [];
  for (const group of catalog.grouped.values()) {
    const variants = group.filter(entry => {
      if (sourceIds.size && !sourceIds.has(entry.packId)) return false;
      if (!includeBanned && isBannedEntry(entry, profile, configuration)) return false;
      return true;
    });
    const merged = mergeEntryGroup(variants);
    if (merged) entries.push(merged);
  }
  return entries;
}

export function subtypeOptionsForCategory(entries, category) {
  const counts = new Map();
  for (const entry of entries) {
    if (entry.type !== category) continue;
    for (const subtypeKey of entry.subtypeKeys ?? []) {
      if (!subtypeKey) continue;
      counts.set(subtypeKey, (counts.get(subtypeKey) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, label: nativeSubtypeLabel(value) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function findEntry(catalog, reference, entries = catalog.entries) {
  const rawReference = String(reference ?? "").trim();
  if (!rawReference) return null;
  if (rawReference.startsWith("Compendium.")) {
    const raw = catalog.rawEntries.find(entry => entry.uuid === rawReference) ?? null;
    if (!raw) return null;
    return entries.find(entry => entry.key === raw.key) ?? raw;
  }

  const normalized = normalizeText(rawReference);
  return entries.find(entry => normalizeText(entry.identifier) === normalized)
    ?? entries.find(entry => normalizeText(entry.name) === normalized)
    ?? null;
}

export function familyEntries(catalog, familyId, entries = catalog.entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!(entry.familyIds ?? []).includes(familyId)) continue;
    const key = familyMemberKey(entry, familyId);
    if (!groups.has(key)) groups.set(key, entry);
  }
  return [...groups.values()];
}

export function resolvePrice(entry, catalog, configuration) {
  if (Number(entry.priceValue) > 0) {
    return {
      value: Number(entry.priceValue),
      denomination: entry.priceDenomination || "gp",
      origin: "official"
    };
  }

  const sibling = (catalog.grouped.get(entry.key) ?? []).find(candidate => Number(candidate.priceValue) > 0);
  if (sibling) {
    return {
      value: Number(sibling.priceValue),
      denomination: sibling.priceDenomination || "gp",
      origin: "alternateSource",
      source: sibling.packLabel
    };
  }

  const rarity = normalizeRarity(entry.rarity);
  const fallback = Math.max(1, Number(configuration.priceFallbacks?.[rarity] ?? configuration.priceFallbacks?.none ?? 1));
  return {
    value: fallback,
    denomination: "gp",
    origin: "fallback"
  };
}

export async function loadItemDocument(entry) {
  const document = await fromUuid(entry.uuid);
  if (!document || document.documentName !== "Item") {
    throw new Error(`Unable to load Item: ${entry.uuid}`);
  }
  return document;
}
