import { MODULE_ID } from "./constants.mjs";
import {
  buildCatalog,
  canonicalKey,
  entriesForProfile,
  entryMatchesSubtype,
  familyEntries,
  findEntry,
  loadItemDocument,
  normalizeRarity,
  normalizeText,
  resolvePrice
} from "./catalog.mjs";
import { getConfiguration } from "./settings.mjs";

const ENCHANTMENT_RARITY = {
  0: "none",
  1: "uncommon",
  2: "rare",
  3: "veryRare"
};

function clampInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Math.min(max, Math.max(min, Math.floor(Number(value ?? 0))));
}

function randomBetween(min, max) {
  const low = clampInteger(Math.min(Number(min ?? 0), Number(max ?? 0)));
  const high = clampInteger(Math.max(Number(min ?? 0), Number(max ?? 0)));
  return low + Math.floor(Math.random() * (high - low + 1));
}

export function calculateQuantity(rule, players, remaining = 0) {
  const value = Math.max(0, Number(rule.quantity ?? 0));
  switch (rule.quantityMode) {
    case "players": return clampInteger(players * Math.max(1, value || 1));
    case "halfDown": return clampInteger(Math.max(1, Math.floor(players / 2)) * Math.max(1, value || 1));
    case "halfUp": return clampInteger(Math.max(1, Math.ceil(players / 2)) * Math.max(1, value || 1));
    case "range": return randomBetween(rule.quantityMin ?? 1, rule.quantityMax ?? 1);
    case "remainder": return clampInteger(remaining);
    case "fixed":
    default: return clampInteger(value);
  }
}

export function calculateRandomTarget(profile, players) {
  const value = Math.max(0, Number(profile.stockTotal ?? 0));
  switch (profile.stockTotalMode) {
    case "perPlayer":
    case "playersMultiplier": return clampInteger(players * value);
    case "players": return clampInteger(players);
    case "halfDown": return clampInteger(Math.floor(players / 2));
    case "halfUp": return clampInteger(Math.ceil(players / 2));
    case "fixed":
    default: return clampInteger(value);
  }
}

function bandForLevel(configuration, level) {
  return (configuration.levelBands ?? []).find(entry => level >= Number(entry.min) && level <= Number(entry.max));
}

function raritiesForLevel(configuration, level) {
  const band = bandForLevel(configuration, level);
  return band?.rarities?.length ? band.rarities : ["none", "common"];
}

function maxSpellLevelForLevel(configuration, level) {
  const band = bandForLevel(configuration, level);
  if (Number.isFinite(Number(band?.maxSpellLevel))) return clampInteger(band.maxSpellLevel, 0, 9);
  return Math.min(9, Math.max(0, Math.ceil(level / 2)));
}

function allowedRarities(rule, configuration, level) {
  return rule.rarityMode === "level" ? raritiesForLevel(configuration, level) : (rule.rarities ?? []);
}

function canReceiveSyntheticEnhancement(entry) {
  return entry.type === "weapon" || (entry.type === "equipment" && Boolean(entry.armorCategory));
}

function categoryEntries(profileEntries, rule, catalog) {
  switch (rule.category) {
    case "weapon": return profileEntries.filter(entry => entry.type === "weapon");
    case "armor": // Legacy v0.0.1d rules are migrated to Equipment.
    case "equipment": return profileEntries.filter(entry => entry.type === "equipment");
    case "consumable": return profileEntries.filter(entry => entry.type === "consumable");
    case "tool": return profileEntries.filter(entry => entry.type === "tool");
    case "loot": return profileEntries.filter(entry => entry.type === "loot");
    case "container": return profileEntries.filter(entry => entry.type === "container");
    case "spellScroll": return profileEntries.filter(entry => entry.type === "spell");
    case "healingPotions": return familyEntries(catalog, "healingPotions", profileEntries);
    case "exact": return profileEntries;
    default: return [];
  }
}

function isExcluded(entry, excludedReferences) {
  const values = new Set((excludedReferences ?? []).map(normalizeText));
  return values.has(normalizeText(entry.identifier)) || values.has(normalizeText(entry.name));
}

function isFamilyExcluded(entry, excludedFamilies) {
  const excluded = new Set(excludedFamilies ?? []);
  return (entry.familyIds ?? []).some(familyId => excluded.has(familyId));
}

function subtypeMatch(entry, rule) {
  const subtypes = rule.subtypes ?? [];
  if (subtypes.length && !subtypes.some(subtype => entryMatchesSubtype(entry, subtype))) return false;
  return true;
}

function magicMatch(entry, rule, configuration, level) {
  if (rule.category === "spellScroll") return true;
  if (rule.magicalState === "mundane" && entry.isMagical) return false;
  if (rule.magicalState === "magical" && !entry.isMagical) return false;

  // A ready-made +2/+3 document may exist in an enabled source, but it must
  // never bypass the party progression table merely because the source Item
  // itself passed the broad category filter.
  if (canReceiveSyntheticEnhancement(entry)
    && Number(entry.enhancement ?? 0) > maxEnhancementForLevel(configuration, level)) return false;

  // Party/fixed quality is applied to a mundane base item after selection.
  if (canReceiveSyntheticEnhancement(entry)
    && ["party", "mundane", "fixed"].includes(rule.qualityMode)
    && entry.isMagical) return false;
  return true;
}

function rarityMatch(entry, rule, configuration, level) {
  if (entry.type === "spell") return true;
  const rarities = new Set(allowedRarities(rule, configuration, level).map(normalizeRarity));
  if (!rarities.size) return true;

  const entryRarity = normalizeRarity(entry.rarity);
  const syntheticBase = canReceiveSyntheticEnhancement(entry)
    && ["party", "mundane", "fixed"].includes(rule.qualityMode)
    && entryRarity === "none";
  return syntheticBase || rarities.has(entryRarity);
}

function spellLevelMatch(entry, rule, configuration, level) {
  if (entry.type !== "spell") return true;
  if (rule.spellLevelMode === "level") return entry.spellLevel <= maxSpellLevelForLevel(configuration, level);
  const levels = new Set((rule.spellLevels ?? []).map(Number));
  return !levels.size || levels.has(entry.spellLevel);
}

export function inspectRulePool({ rule, catalog, profileEntries, configuration, level = 1 }) {
  if (!rule?.category) {
    return { count: 0, reason: "category", names: [], stages: { source: profileEntries.length, category: 0 } };
  }

  if (rule.category === "exact") {
    const references = (rule.itemRefs?.length ? rule.itemRefs : [rule.itemRef])
      .map(reference => reference?.uuid ?? reference?.itemRef ?? reference)
      .filter(Boolean);
    const found = references.map(reference => findEntry(catalog, reference, profileEntries)).filter(Boolean);
    return {
      count: found.length,
      reason: found.length ? "" : "exact",
      names: found.slice(0, 8).map(entry => entry.name),
      entries: found,
      stages: { source: profileEntries.length, category: found.length }
    };
  }

  const stageCategory = categoryEntries(profileEntries, rule, catalog);
  const stageSubtype = stageCategory.filter(entry => subtypeMatch(entry, rule));
  const stageMagic = stageSubtype.filter(entry => magicMatch(entry, rule, configuration, level));
  const stageRarity = stageMagic.filter(entry => rarityMatch(entry, rule, configuration, level));
  const stageSpell = stageRarity.filter(entry => spellLevelMatch(entry, rule, configuration, level));
  const stageFinal = stageSpell.filter(entry => !isExcluded(entry, rule.excludeRefs) && !isFamilyExcluded(entry, rule.excludeFamilies));

  let reason = "";
  if (!stageCategory.length) reason = "category";
  else if (!stageSubtype.length) reason = "subtype";
  else if (!stageMagic.length) reason = "magic";
  else if (!stageRarity.length) reason = "rarity";
  else if (!stageSpell.length) reason = "spellLevel";
  else if (!stageFinal.length) reason = "exclusion";

  const buckets = buildRuleBuckets(stageFinal, rule).map(group => ({ key: group.key, count: group.entries.length }));
  return {
    count: stageFinal.length,
    reason,
    names: stageFinal.slice(0, 8).map(entry => entry.name),
    entries: stageFinal,
    buckets,
    stages: {
      source: profileEntries.length,
      category: stageCategory.length,
      subtype: stageSubtype.length,
      magic: stageMagic.length,
      rarity: stageRarity.length,
      spellLevel: stageSpell.length,
      final: stageFinal.length
    }
  };
}

function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function weightedStateChoice(states) {
  const weighted = states.map(state => ({
    state,
    weight: Math.max(0.1, Number(state.rule.randomWeight ?? 1))
  }));
  const total = weighted.reduce((sum, option) => sum + option.weight, 0);
  let roll = Math.random() * total;
  for (const option of weighted) {
    roll -= option.weight;
    if (roll <= 0) return option.state;
  }
  return weighted.at(-1)?.state ?? null;
}

export function buildRuleBuckets(pool, rule) {
  if (!pool.length) return [];
  const selectedSubtypes = rule.subtypes ?? [];
  const groups = new Map();

  for (const entry of pool) {
    let key = "all";
    if (selectedSubtypes.length) {
      const primary = entry.primarySubtypeKey;
      if (primary && selectedSubtypes.includes(primary)) key = primary;
      else key = selectedSubtypes.find(subtype => entryMatchesSubtype(entry, subtype)) ?? "all";
    } else if (entry.primarySubtypeKey) key = entry.primarySubtypeKey;

    const entries = groups.get(key) ?? [];
    entries.push(entry);
    groups.set(key, entries);
  }

  return [...groups.entries()].map(([key, entries]) => ({ key, entries }));
}

function chooseFromBuckets(pool, rule, quantity, allowDuplicates) {
  const groups = buildRuleBuckets(pool, rule).map(group => ({ ...group, available: [...group.entries] }));
  if (!groups.length || quantity <= 0) return [];
  const chosen = [];

  while (chosen.length < quantity) {
    const active = groups.filter(group => allowDuplicates || group.available.length);
    if (!active.length) break;
    const group = randomChoice(active);
    const source = allowDuplicates ? group.entries : group.available;
    if (!source.length) continue;
    const index = Math.floor(Math.random() * source.length);
    chosen.push(allowDuplicates ? source[index] : source.splice(index, 1)[0]);
  }
  return chosen;
}

function selectRuleEntries({ rule, catalog, profileEntries, configuration, level, quantity, warnings }) {
  const inspection = inspectRulePool({ rule, catalog, profileEntries, configuration, level });
  const pool = inspection.entries ?? [];
  if (!pool.length) {
    warnings.push(game.i18n.format("DND5E_SUPPLIER.Errors.EmptyPoolReason", {
      rule: rule.name || game.i18n.localize("DND5E_SUPPLIER.Config.UnnamedRule"),
      reason: game.i18n.localize(`DND5E_SUPPLIER.PoolReason.${inspection.reason || "category"}`)
    }));
    return [];
  }

  // Every quantity point is an independent slot. This is important for families:
  // 10 Healing Potion slots produce 10 independent tier rolls, then stack.
  if (rule.coverageMode === "oneEach") {
    const groups = buildRuleBuckets(pool, rule);
    if (groups.length) {
      const selected = [];
      for (let repeat = 0; repeat < Math.max(1, quantity); repeat += 1) {
        for (const group of groups) selected.push(randomChoice(group.entries));
      }
      return selected;
    }
  }

  const selected = chooseFromBuckets(pool, rule, quantity, rule.allowDuplicates !== false);
  if (rule.allowDuplicates === false && selected.length < quantity) {
    warnings.push(game.i18n.format("DND5E_SUPPLIER.Errors.NotEnoughUnique", {
      requested: quantity,
      available: pool.length,
      rule: rule.name || game.i18n.localize("DND5E_SUPPLIER.Config.UnnamedRule")
    }));
  }
  return selected;
}

function enchantmentBand(configuration, level) {
  return (configuration.enchantmentBands ?? []).find(entry => level >= Number(entry.min) && level <= Number(entry.max));
}

function maxEnhancementForLevel(configuration, level) {
  const weights = enchantmentBand(configuration, level)?.weights ?? { 0: 100, 1: 0, 2: 0, 3: 0 };
  return [3, 2, 1].find(bonus => Number(weights?.[bonus] ?? weights?.[String(bonus)] ?? 0) > 0) ?? 0;
}

function weightedBonus(configuration, level, { positiveOnly = false } = {}) {
  const weights = enchantmentBand(configuration, level)?.weights ?? { 0: 100, 1: 0, 2: 0, 3: 0 };
  const options = [0, 1, 2, 3]
    .filter(bonus => !positiveOnly || bonus > 0)
    .map(bonus => ({ bonus, weight: Math.max(0, Number(weights[bonus] ?? weights[String(bonus)] ?? 0)) }))
    .filter(option => option.weight > 0);
  if (!options.length) return 0;
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = Math.random() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll <= 0) return option.bonus;
  }
  return options.at(-1).bonus;
}

function minimumEnchanted(rule, players, eligibleCount) {
  const value = Math.max(0, Number(rule.enchantedMinimum ?? 0));
  let result = 0;
  switch (rule.enchantedMinimumMode) {
    case "fixed": result = value; break;
    case "players": result = players * Math.max(1, value || 1); break;
    case "halfDown": result = Math.floor(players / 2) * Math.max(1, value || 1); break;
    case "halfUp": result = Math.ceil(players / 2) * Math.max(1, value || 1); break;
    case "none":
    default: result = 0;
  }
  return Math.min(eligibleCount, clampInteger(result));
}

function applyQuality(rule, entries, configuration, level, players, warnings) {
  const picks = entries.map(entry => ({ entry, enhancement: entry.enhancement || 0, units: 1 }));

  for (const pick of picks) {
    if (!canReceiveSyntheticEnhancement(pick.entry)) continue;
    if (rule.qualityMode === "mundane") pick.enhancement = 0;
    else if (rule.qualityMode === "fixed") pick.enhancement = clampInteger(rule.fixedBonus, 0, 3);
    else if (rule.qualityMode === "party" && !pick.entry.isMagical) pick.enhancement = weightedBonus(configuration, level);
  }

  const eligible = picks.filter(pick => canReceiveSyntheticEnhancement(pick.entry));
  const required = minimumEnchanted(rule, players, eligible.length);
  let enchanted = eligible.filter(pick => pick.entry.isMagical || pick.enhancement > 0).length;
  if (required > enchanted) {
    const promotable = eligible.filter(pick => !pick.entry.isMagical && pick.enhancement === 0);
    while (enchanted < required && promotable.length) {
      const index = Math.floor(Math.random() * promotable.length);
      const [pick] = promotable.splice(index, 1);
      pick.enhancement = weightedBonus(configuration, level, { positiveOnly: true });
      if (pick.enhancement <= 0) {
        warnings.push(game.i18n.localize("DND5E_SUPPLIER.Errors.NoUnlockedEnchantment"));
        break;
      }
      enchanted += 1;
    }
  }
  return picks;
}

function applyEnhancementToDocument(data, bonus, configuration) {
  const result = foundry.utils.deepClone(data);
  if (!bonus || bonus <= 0) return result;

  const cleanName = String(result.name ?? "").replace(/\s+\+[123]\s*$/, "");
  result.name = `${cleanName} +${bonus}`;
  foundry.utils.setProperty(result, "system.magicalBonus", bonus);
  foundry.utils.setProperty(result, "system.rarity", ENCHANTMENT_RARITY[bonus] ?? "uncommon");

  const properties = foundry.utils.getProperty(result, "system.properties");
  if (Array.isArray(properties) && !properties.includes("mgc")) properties.push("mgc");
  else if (properties && typeof properties === "object" && !(properties instanceof Set)) properties.mgc = true;

  const currentPrice = Math.max(0, Number(foundry.utils.getProperty(result, "system.price.value") ?? 0));
  const addition = Math.max(0, Number(configuration.qualityPriceAdditions?.[bonus] ?? 0));
  foundry.utils.setProperty(result, "system.price", {
    value: Math.max(1, currentPrice + addition),
    denomination: foundry.utils.getProperty(result, "system.price.denomination") ?? "gp"
  });
  return result;
}

function normalizeScrollActivityLevels(data) {
  const activities = foundry.utils.getProperty(data, "system.activities");
  if (!activities || typeof activities !== "object") return;
  for (const activity of Object.values(activities)) {
    if (activity?.spell?.level !== undefined) activity.spell.level = Number(activity.spell.level);
  }
}

async function createSpellScrollPreview(entry, configuration) {
  const spell = await loadItemDocument(entry);
  const level = Number(spell.system.level ?? entry.spellLevel ?? 0);
  const ItemClass = CONFIG.Item.documentClass;
  if (typeof ItemClass.createScrollFromSpell !== "function") {
    throw new Error(game.i18n.localize("DND5E_SUPPLIER.Errors.ScrollApiUnavailable"));
  }
  const scroll = await ItemClass.createScrollFromSpell(spell, {}, {
    dialog: false,
    level,
    explanation: "reference"
  });
  if (!scroll) throw new Error(game.i18n.format("DND5E_SUPPLIER.Errors.ScrollCreationFailed", { spell: spell.name }));
  const data = scroll.toObject ? scroll.toObject() : foundry.utils.deepClone(scroll);
  normalizeScrollActivityLevels(data);
  const rarity = normalizeRarity(foundry.utils.getProperty(data, "system.rarity"));
  const priceValue = Number(foundry.utils.getProperty(data, "system.price.value") ?? 0);
  const price = priceValue > 0
    ? { value: priceValue, denomination: foundry.utils.getProperty(data, "system.price.denomination") ?? "gp", origin: "official" }
    : { value: Math.max(1, Number(configuration.priceFallbacks?.[rarity] ?? configuration.priceFallbacks?.none ?? 1)), denomination: "gp", origin: "fallback" };
  return { data, price, rarity, spellLevel: level };
}

async function buildPreviewLine(pick, catalog, configuration) {
  if (pick.rule.category === "spellScroll") {
    const scroll = await createSpellScrollPreview(pick.entry, configuration);
    return {
      key: `scroll:${canonicalKey(pick.entry)}`,
      name: scroll.data.name,
      img: scroll.data.img || pick.entry.img,
      type: scroll.data.type || "consumable",
      subtype: foundry.utils.getProperty(scroll.data, "system.type.value") ?? "scroll",
      rarity: scroll.rarity,
      quantity: Math.max(1, Number(pick.units ?? 1)),
      packLabel: pick.entry.packLabel,
      sourceUuid: pick.entry.uuid,
      price: scroll.price,
      documentData: scroll.data,
      generationKind: "spellScroll",
      enhancement: 0,
      spellLevel: scroll.spellLevel,
      ruleIds: [pick.rule.id]
    };
  }

  const document = await loadItemDocument(pick.entry);
  const basePrice = resolvePrice(pick.entry, catalog, configuration);
  let documentData = document.toObject();
  let price = basePrice;
  let rarity = normalizeRarity(foundry.utils.getProperty(document, "system.rarity") ?? pick.entry.rarity);
  if (pick.enhancement > 0 && !pick.entry.isMagical) {
    documentData = applyEnhancementToDocument(documentData, pick.enhancement, configuration);
    rarity = ENCHANTMENT_RARITY[pick.enhancement] ?? rarity;
    price = {
      value: Math.max(1, Number(foundry.utils.getProperty(documentData, "system.price.value") ?? 1)),
      denomination: foundry.utils.getProperty(documentData, "system.price.denomination") ?? "gp",
      origin: "generatedQuality"
    };
  }

  return {
    key: `${canonicalKey(pick.entry)}|bonus:${pick.enhancement || 0}`,
    name: documentData.name,
    img: documentData.img,
    type: documentData.type,
    subtype: foundry.utils.getProperty(documentData, "system.type.value") ?? pick.entry.subtype,
    rarity,
    quantity: Math.max(1, Number(pick.units ?? 1)),
    packLabel: pick.entry.packLabel,
    sourceUuid: pick.entry.uuid,
    price,
    documentData,
    generationKind: pick.enhancement > 0 && !pick.entry.isMagical ? "enhanced" : "copy",
    enhancement: pick.enhancement || 0,
    ruleIds: [pick.rule.id]
  };
}

function addPicks(target, entries, rule, ruleType, configuration, level, players, warnings) {
  const qualityPicks = applyQuality(rule, entries, configuration, level, players, warnings);
  for (const pick of qualityPicks) target.push({ ...pick, rule, ruleType });
  return qualityPicks.length;
}

export async function generateStock({ profile, level, players }) {
  const configuration = getConfiguration();
  const catalog = await buildCatalog();
  if (!catalog.entries.length) throw new Error(game.i18n.localize("DND5E_SUPPLIER.Errors.NoCatalog"));

  const profileEntries = entriesForProfile(catalog, profile, configuration);
  if (!profileEntries.length) throw new Error(game.i18n.localize("DND5E_SUPPLIER.Errors.NoProfileCatalog"));

  const picks = [];
  const warnings = [];
  const randomTarget = calculateRandomTarget(profile, players);
  let catalogUnits = 0;
  let guaranteedUnits = 0;
  let randomUnits = 0;

  // 1. Mundane Catalog is always additional to the random target.
  // Every eligible distinct Item is included with the configured quantity per Item.
  for (const rule of profile.mundaneCatalogRules ?? []) {
    if (!rule.enabled || !rule.category) continue;
    const perItem = calculateQuantity(rule, players, 0);
    if (!perItem) continue;
    const inspection = inspectRulePool({ rule, catalog, profileEntries, configuration, level });
    if (!inspection.count) {
      warnings.push(game.i18n.format("DND5E_SUPPLIER.Errors.EmptyPoolReason", {
        rule: rule.name || game.i18n.localize("DND5E_SUPPLIER.Config.MundaneCatalog"),
        reason: game.i18n.localize(`DND5E_SUPPLIER.PoolReason.${inspection.reason || "category"}`)
      }));
      continue;
    }
    for (const entry of inspection.entries) {
      picks.push({ entry, enhancement: 0, units: perItem, rule, ruleType: "catalog" });
      catalogUnits += perItem;
    }
  }

  // 2. Guaranteed Items are also additional to the random target.
  // Quantity N always means N independent selections and N independent quality rolls.
  for (const rule of profile.guaranteedRules ?? []) {
    if (!rule.enabled || !rule.category) continue;
    const quantity = calculateQuantity(rule, players, 0);
    if (!quantity) continue;
    const selected = selectRuleEntries({ rule, catalog, profileEntries, configuration, level, quantity, warnings });
    guaranteedUnits += addPicks(picks, selected, rule, "guaranteed", configuration, level, players, warnings);
  }

  // 3. Random Stock has one explicit target. All enabled random pools compete
  // for those slots according to their relative weights.
  if (randomTarget > 0) {
    const allStates = [];
    for (const rule of profile.randomRules ?? []) {
      if (!rule.enabled || !rule.category) continue;
      const inspection = inspectRulePool({ rule, catalog, profileEntries, configuration, level });
      if (!inspection.count) {
        warnings.push(game.i18n.format("DND5E_SUPPLIER.Errors.EmptyPoolReason", {
          rule: rule.name || game.i18n.localize("DND5E_SUPPLIER.Config.RandomStock"),
          reason: game.i18n.localize(`DND5E_SUPPLIER.PoolReason.${inspection.reason || "category"}`)
        }));
        continue;
      }
      const pool = inspection.entries ?? [];
      allStates.push({
        rule,
        pool,
        buckets: buildRuleBuckets(pool, rule).map(group => ({ ...group, available: [...group.entries] })),
        selected: []
      });
    }

    const activeStates = [...allStates];
    while (randomUnits < randomTarget && activeStates.length) {
      const state = weightedStateChoice(activeStates);
      if (!state) break;
      const allowDuplicates = state.rule.allowDuplicates !== false;
      const activeBuckets = state.buckets.filter(bucket => allowDuplicates || bucket.available.length);
      if (!activeBuckets.length) {
        activeStates.splice(activeStates.indexOf(state), 1);
        continue;
      }
      const bucket = randomChoice(activeBuckets);
      const source = allowDuplicates ? bucket.entries : bucket.available;
      const index = Math.floor(Math.random() * source.length);
      const entry = allowDuplicates ? source[index] : source.splice(index, 1)[0];
      state.selected.push(entry);
      randomUnits += 1;
    }

    // Apply quality once per pool so enchanted minimums are evaluated against
    // the full set won by that pool, not independently for every slot.
    for (const state of allStates) {
      if (!state.selected.length) continue;
      addPicks(picks, state.selected, state.rule, "random", configuration, level, players, warnings);
    }
  }

  if (randomTarget > randomUnits) {
    warnings.push(game.i18n.format("DND5E_SUPPLIER.Errors.RandomTargetNotFilled", {
      generated: randomUnits,
      target: randomTarget
    }));
  }

  const lines = [];
  for (const pick of picks) {
    try {
      lines.push(await buildPreviewLine(pick, catalog, configuration));
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to prepare ${pick.entry?.name}`, error);
      warnings.push(error.message);
    }
  }

  const stacked = new Map();
  for (const line of lines) {
    const current = stacked.get(line.key);
    if (current) {
      current.quantity += Number(line.quantity ?? 1);
      current.ruleIds = [...new Set([...current.ruleIds, ...line.ruleIds])];
    } else stacked.set(line.key, line);
  }

  const preview = [...stacked.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    preview,
    warnings,
    target: randomTarget,
    randomTarget,
    catalogUnits,
    guaranteedUnits,
    randomUnits,
    generatedUnits: catalogUnits + guaranteedUnits + randomUnits
  };
}

function formatFolderName(template, profile, level, players) {
  const now = new Date();
  const language = game.i18n.lang || "pt-BR";
  const date = new Intl.DateTimeFormat(language, { day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
  const time = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hour12: false }).format(now);

  return String(template || "{supplier} — {date} — {time}")
    .replaceAll("{supplier}", profile.name)
    .replaceAll("{date}", date)
    .replaceAll("{time}", time)
    .replaceAll("{datetime}", `${date} ${time}`)
    .replaceAll("{level}", String(level))
    .replaceAll("{players}", String(players));
}

export async function createWorldFolder({ profile, level, players, preview }) {
  if (!preview?.length) throw new Error(game.i18n.localize("DND5E_SUPPLIER.Errors.NoPreview"));

  const configuration = getConfiguration();
  const generationId = foundry.utils.randomID(24);
  const generatedAt = Date.now();
  const ItemClass = CONFIG.Item.documentClass;
  const FolderClass = CONFIG.Folder?.documentClass ?? Folder;
  const folderName = formatFolderName(configuration.folderNameTemplate, profile, level, players);

  const folder = await FolderClass.create({
    name: folderName,
    type: "Item",
    flags: {
      [MODULE_ID]: {
        generated: true,
        generationId,
        profileId: profile.id,
        profileName: profile.name,
        partyLevel: level,
        partySize: players,
        generatedAt,
        moduleVersion: game.modules.get(MODULE_ID)?.version
      }
    }
  });

  try {
    const documents = preview.map(line => {
      const data = foundry.utils.deepClone(line.documentData);
      delete data._id;
      data.folder = folder.id;
      if (data.system && Object.hasOwn(data.system, "container")) delete data.system.container;
      normalizeScrollActivityLevels(data);
      foundry.utils.setProperty(data, "system.quantity", Math.max(1, Number(line.quantity)));
      foundry.utils.setProperty(data, "system.price", {
        value: Math.max(1, Number(line.price.value)),
        denomination: line.price.denomination || "gp"
      });
      data.flags ??= {};
      data.flags[MODULE_ID] = {
        generated: true,
        generationId,
        profileId: profile.id,
        profileName: profile.name,
        sourceUuid: line.sourceUuid,
        priceOrigin: line.price.origin,
        generationKind: line.generationKind,
        enhancement: line.enhancement ?? 0,
        generatedAt
      };
      return data;
    });

    const items = await ItemClass.createDocuments(documents);
    return { folder, items };
  } catch (error) {
    const partialItems = game.items.filter(item => item.folder?.id === folder.id && item.getFlag(MODULE_ID, "generationId") === generationId);
    if (partialItems.length) await ItemClass.deleteDocuments(partialItems.map(item => item.id));
    await folder.delete();
    throw error;
  }
}
