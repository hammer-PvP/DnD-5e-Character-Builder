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
