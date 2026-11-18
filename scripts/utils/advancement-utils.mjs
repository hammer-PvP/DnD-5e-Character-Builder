import { MODULE_ID } from "../constants.mjs";

/**
 * Return the display/name field for a D&D5e Advancement without touching the
 * deprecated Advancement#title getter introduced as a compatibility shim in 6.x.
 *
 * Persisted Character Builder snapshots created before the D&D5e 6 migration may
 * still contain a raw `title` field, so raw source data is accepted as a final
 * fallback. Live 6.x Advancement documents are read through `name`.
 */
export function advancementName(advancement, fallback = "") {
  const source = advancement?._source ?? advancement ?? {};
  const value = advancement?.name ?? source?.name ?? source?.title ?? fallback;
  return String(value ?? fallback);
}

export function normalizedAdvancementName(advancement, fallback = "") {
  return advancementName(advancement, fallback).trim().toLowerCase();
}

/** Use the D&D5e document identifier, including its fallback for older Items. */
export function itemPrerequisiteKeys(item) {
  const identifier = item.identifier || item.system?.identifier
    || (item.name && globalThis.dnd5e?.utils?.formatIdentifier?.(item.name));
  if (!identifier) return [];
  return item.type ? [identifier, `${item.type}:${identifier}`] : [identifier];
}

export function itemPrerequisites(item) {
  const values = item.system?.prerequisites?.items;
  return [...new Set(Array.from(values?.values?.() ?? [], value =>
    String(typeof value === "string" ? value : value?.identifier ?? value?.id ?? value?.value ?? "").trim()
  ).filter(Boolean))];
}

export function meetsItemPrerequisites(required, available) {
  return !required.length || required.some(key => available.has(key));
}

/** Resolve acquired Items first and then any pending choices they unlock. */
export function orderItemPrerequisites(choices, available) {
  const prerequisites = new Set(available);
  const pending = [...choices];
  const ordered = [];
  while (pending.length) {
    const index = pending.findIndex(choice => meetsItemPrerequisites(choice.requires, prerequisites));
    if (index === -1) break;
    const [choice] = pending.splice(index, 1);
    ordered.push(choice);
    for (const key of choice.provides) prerequisites.add(key);
  }
  return { ordered, pending, prerequisites };
}

export function itemPrerequisiteLabel(key, names) {
  return names?.get(key) ?? globalThis.dnd5e?.registry?.items?.get(key)?.name
    ?? key.slice(key.indexOf(":") + 1).split(/[-_]/g).filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function itemPrerequisiteIndex(items) {
  const names = new Map();
  for (const item of items) {
    for (const key of itemPrerequisiteKeys(item)) {
      if (!names.has(key)) names.set(key, item.name);
    }
  }
  return names;
}

function missingItemPrerequisites(items, available) {
  return items.filter(item => !meetsItemPrerequisites(itemPrerequisites(item), available));
}

export function newMissingItemPrerequisites(items, previousItems = []) {
  const previousMissing = new Set(missingItemPrerequisites(previousItems, itemPrerequisiteIndex(previousItems))
    .map(item => item.id ?? item._id));
  return missingItemPrerequisites(items, itemPrerequisiteIndex(items))
    .filter(item => !previousMissing.has(item.id ?? item._id));
}

/** Read modern feature-owned Wild Shape scales, with legacy class scales as fallback. */
export function wildShapeScales(feature, cls, level) {
  const find = (item, ids, title) => Object.values(item?.toObject?.().system?.advancement
    ?? item?.system?.advancement ?? {}).find(row => row.type === "ScaleValue"
      && (ids.includes(row.configuration?.identifier) || normalizedAdvancementName(row) === title));
  const atLevel = row => Object.entries(row?.configuration?.scale ?? {})
    .filter(([minimum]) => Number(minimum) <= level)
    .sort(([left], [right]) => Number(left) - Number(right)).at(-1)?.[1]?.value;
  const forms = find(feature, ["forms"], "known forms") ?? find(cls, ["wild-shape-forms", "known-forms"], "known forms");
  const cr = find(feature, ["cr"], "wild shape cr") ?? find(cls, ["wild-shape-cr"], "wild shape cr");
  return { count: Number(atLevel(forms) ?? 0), cr: atLevel(cr), tracked: Boolean(forms && cr) };
}

export function readAdvancementRecords(owner) {
  const records = owner?.toObject?.().system?.advancement ?? {};
  // Native schema migrations can leave legacy packs in array form.
  return Array.isArray(records) ? Object.fromEntries(records.filter(row => row?._id)
    .map(row => [row._id, row])) : records;
}

// D&D5e consumes Foundry's replacement operator at the collection field.
// A nested operator can be persisted inside an Advancement value as plain data.
export async function writeAdvancementRecords(owner, records, options = {}) {
  const expected = advancementRecordKey(records);
  const replacement = foundry.data.operators.ForcedReplacement.create(records);
  await owner.update({ "system.advancement": replacement }, options);
  const persisted = owner.toObject().system?.advancement ?? {};
  if (advancementRecordKey(persisted) !== expected) {
    throw new Error(`The Advancement records on ${owner.name} could not be saved as intended.`);
  }
}

export async function writeAdvancementValue(owner, id, value, options) {
  const records = readAdvancementRecords(owner);
  if (!records[id]) throw new Error(`The Advancement ${id} no longer exists on ${owner.name}.`);
  records[id].value = value;
  return writeAdvancementRecords(owner, records, options);
}

function advancementRecordKey(data) {
  return JSON.stringify(data, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : value);
}

export function hasSerializedAdvancementReplacement(record) {
  return record?.value?.added?.["__$OPERATOR$__"] === "ForcedReplacement";
}

// Read the intended ledger only when each proposed link can be verified
// against the Actor or the historical ItemChoice replacement records.
export function planAdvancementRecordRepairs(actor, owner) {
  const records = readAdvancementRecords(owner);
  const issues = [];
  for (const [id, record] of Object.entries(records)) {
    if (!hasSerializedAdvancementReplacement(record)) continue;
    const added = recoverAdvancementLinks(actor, owner, id, record);
    issues.push({ id, record, repairable: Boolean(added) });
    if (added) record.value.added = added;
  }
  return { records, issues };
}

export async function repairAdvancementRecords(actor, { ownerId = null } = {}) {
  let repaired = 0;
  const owners = ownerId ? [actor.items.get(ownerId)].filter(Boolean) : actor.items;
  for (const owner of owners) {
    const { records, issues } = planAdvancementRecordRepairs(actor, owner);
    const count = issues.filter(issue => issue.repairable).length;
    if (!count) continue;
    await writeAdvancementRecords(owner, records, { characterBuilderAdvancementIntegrityRepair: true });
    repaired += count;
  }
  return repaired;
}

function recoverAdvancementLinks(actor, owner, id, record) {
  const { ["__$OPERATOR$__"]: _operator, value: intended, ...direct } = record.value.added;
  if (!intended || typeof intended !== "object" || Array.isArray(intended)) return null;
  const choice = record.type === "ItemChoice";
  if (!choice && record.type !== "ItemGrant") return null;
  const levels = choice ? Object.entries(intended) : [["", intended]];
  const origin = `${owner.id}.${id}`;
  const configured = new Set(Object.values(record.configuration?.items ?? {}).map(entry => entry?.uuid ?? entry));
  const knownHistory = new Set(Object.values(record.value.replaced ?? {}).flatMap(entry => [entry?.original, entry?.replacement]));
  const intendedIds = new Set();
  for (const [level, links] of levels) {
    if (choice && !/^\d+$/.test(level)) return null;
    if (!links || typeof links !== "object" || Array.isArray(links)) return null;
    for (const [itemId, uuid] of Object.entries(links)) {
      if (!/^[A-Za-z0-9]{16}$/.test(itemId) || typeof uuid !== "string" || !uuid) return null;
      if (intendedIds.has(itemId)) return null;
      intendedIds.add(itemId);
      const item = actor.items.get(itemId);
      if (!item) {
        if (!choice || !knownHistory.has(itemId)) return null;
        continue;
      }
      const source = item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource;
      const receipt = item.getFlag(MODULE_ID, "itemGrantInstance");
      const merged = item.getFlag(MODULE_ID, "mergedItemGrants") ?? [];
      const ownOrigin = item.getFlag("dnd5e", "advancementOrigin") === origin;
      const sameReceipt = grant => grant?.ownerItemId === owner.id
        && grant.advancementId === id && grant.configuredUuid === uuid && grant.sourceUuid === source;
      const valid = choice ? ownOrigin && source === uuid : configured.has(uuid) && (
        (ownOrigin && (source === uuid || sameReceipt(receipt))) || merged.some(sameReceipt)
      );
      if (!valid) return null;
    }
  }
  if (!intendedIds.size) return null;

  // Leave ambiguous overlap for review if a directly recorded live Item
  // would be dropped by the recovered snapshot.
  const directIds = choice ? Object.values(direct).flatMap(links => Object.keys(links ?? {})) : Object.keys(direct);
  if (directIds.some(itemId => actor.items.get(itemId) && !intendedIds.has(itemId))) return null;
  return intended;
}

/** Normalize a weapon Trait key or a document UUID to the native base Item key. */
export function weaponMasteryBaseItem(value) {
  const key = String(value ?? "").split(":").at(-1);
  if (!key.includes(".")) return key;
  const weaponIds = globalThis.CONFIG?.DND5E?.weaponIds ?? {};
  const configured = Object.entries(weaponIds).find(([, uuid]) => uuid === key)?.[0];
  if (configured) return configured;
  const weapon = weaponMasteryDocument(key);
  return weapon?.system?.type?.baseItem || null;
}

function weaponMasteryDocument(uuid) {
  if (typeof uuid !== "string" || !uuid) return null;
  try { return globalThis.fromUuidSync?.(uuid); }
  catch (_error) { return null; }
}

export function weaponMasteryLabel(value) {
  const key = String(value ?? "").split(":").at(-1);
  const base = weaponMasteryBaseItem(key);
  const configured = globalThis.CONFIG?.DND5E?.weaponIds?.[base];
  const document = weaponMasteryDocument(key.includes(".") ? key : configured);
  const label = document?.name ?? (typeof configured === "object" ? configured?.label : null);
  if (label) return globalThis.game.i18n.localize(label);
  return base ? base.replace(/(^|\s)\S/g, character => character.toUpperCase()) : "Unavailable Weapon";
}

/** The embedded Item owning each native Weapon Mastery Trait is also its write target. */
export function weaponMasteryChoices(actor) {
  const items = [...(actor?.items ?? [])];
  const owners = new Map(items.map(item => [item.id, item]));
  const classFor = item => {
    const seen = new Set();
    while (item && !seen.has(item.id)) {
      if (item.type === "class") return item;
      if (item.type === "subclass") {
        return items.find(cls => cls.type === "class" && cls.system?.identifier === item.system?.classIdentifier);
      }
      seen.add(item.id);
      const origin = item.getFlag?.("dnd5e", "advancementOrigin") ?? item.getFlag?.("dnd5e", "advancementRoot");
      item = owners.get(String(origin ?? "").split(".")[0]);
    }
    return null;
  };
  const groups = new Map();
  for (const owner of items) {
    const rows = Object.entries(readAdvancementRecords(owner))
      .filter(([, row]) => row?.type === "Trait" && row.configuration?.mode === "mastery")
      .map(([id, row]) => ({ ...row, id, owner }));
    if (!rows.length) continue;
    const cls = classFor(owner);
    if (!cls) continue;
    const group = groups.get(cls.id) ?? { cls, feature: null, rows: [] };
    if (owner.type === "feat" && (!group.feature || owner.system?.identifier === "weapon-mastery")) {
      group.feature = owner;
    }
    group.rows.push(...rows);
    groups.set(cls.id, group);
  }
  for (const { cls, feature } of groups.values()) {
    if (feature) continue;
    const candidates = items.filter(item => item.type === "feat" && item.system?.identifier === "weapon-mastery"
      && classFor(item)?.id === cls.id);
    if (candidates.length === 1) groups.get(cls.id).feature = candidates[0];
  }
  return [...groups.values()].map(({ cls, feature, rows }) => {
    // Some migrated sheets retain an identical record on the former owner.
    // Use the feature-owned choice and keep distinct choices from all sources.
    const ownedSelections = new Set(rows.filter(row => row.owner.type !== "class")
      .flatMap(row => [...(row.value?.chosen ?? [])].map(key => weaponMasteryBaseItem(key) ?? key)));
    const active = rows.map(row => row.owner.type === "class" ? {
      ...row, value: { ...row.value, chosen: [...(row.value?.chosen ?? [])]
        .filter(key => !ownedSelections.has(weaponMasteryBaseItem(key) ?? key)) }
    } : row).filter(row => row.value?.chosen?.length);
    return { cls, feature, owners: [...new Set(rows.map(row => row.owner))], rows: active };
  }).filter(group => group.rows.length);
}
