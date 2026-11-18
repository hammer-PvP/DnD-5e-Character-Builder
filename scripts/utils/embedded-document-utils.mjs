function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
}

// toObject() includes database timestamps on both Items and their ActiveEffects.
// Only a document boundary has administrative stats. Keep arbitrary flag data intact.
function documentFields(data, type) {
  const fields = { ...data };
  delete fields._stats;
  if (data._stats?.compendiumSource != null) fields._stats = { compendiumSource: data._stats.compendiumSource };
  // Scene Packer recomputes its content hash when a draft Item is embedded on
  // the original Actor. Other module flags, including other Scene Packer keys,
  // still participate in comparison and verification.
  if (type === "Item" && record(data.flags?.["scene-packer"])) {
    const { hash, ...metadata } = data.flags["scene-packer"];
    if (hash !== undefined) {
      fields.flags = { ...data.flags };
      if (Object.keys(metadata).length) fields.flags["scene-packer"] = metadata;
      else delete fields.flags["scene-packer"];
    }
  }
  if (type === "Item" || type === "Actor") delete fields.effects;
  if (type === "Actor") delete fields.items;
  return fields;
}

function documentData(data, type) {
  const fields = documentFields(data, type);
  if (type === "Item" || type === "Actor") fields.effects = documentList(data.effects, "ActiveEffect");
  if (type === "Actor") fields.items = documentList(data.items, "Item");
  return fields;
}

function documentList(rows = [], type) {
  return rows.map(row => documentData(row, type)).sort((a, b) => String(a._id).localeCompare(String(b._id)));
}

export function documentFingerprint(data, type) {
  return JSON.stringify(ordered(documentData(data, type)));
}

function sameValue(a, b) {
  return a === b || JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}

function collectChanges(before, after, update, prefix = "") {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const path = prefix ? prefix + "." + key : key;
    if (path === "_id") continue;
    if (path === "_stats") {
      if (before[key]?.compendiumSource !== after[key]?.compendiumSource) {
        update["_stats.compendiumSource"] = after[key]?.compendiumSource ?? null;
      }
    } else if (!Object.hasOwn(after, key)) {
      update[path] = new foundry.data.operators.ForcedDeletion();
    } else if (path === "system.advancement" && record(after[key])) {
      if (!sameValue(before[key], after[key])) update[path] = foundry.data.operators.ForcedReplacement.create(after[key]);
    } else if (record(before[key]) && record(after[key])) {
      collectChanges(before[key], after[key], update, path);
    } else if (!sameValue(before[key], after[key])) {
      update[path] = after[key];
    }
  }
}

// Creation hooks can add their own fields. Every field explicitly requested in
// the create operation must survive, including the original compendium link.
function missingField(current, target, prefix = "") {
  if (!record(target)) return sameValue(current, target) ? null : prefix;
  if (!record(current)) return prefix;
  for (const [key, value] of Object.entries(target)) {
    const path = prefix ? prefix + "." + key : key;
    if (!Object.hasOwn(current, key)) return path;
    const missing = missingField(current[key], value, path);
    if (missing) return missing;
  }
  return null;
}

function difference(current, target, type) {
  return fieldChanges(documentFields(current.toObject(), type), documentFields(target, type));
}

export function fieldChanges(before, after) {
  const patch = {};
  collectChanges(before, after, patch);
  return patch;
}

export async function reconcileEmbeddedDocuments(parent, type, desired, options, originalIds = null) {
  const collection = parent.getEmbeddedCollection(type);
  const targets = new Map(desired.map(row => [row._id, row]));
  if (targets.size !== desired.length || desired.some(row => !row._id)) throw new Error(`Invalid ${type} transaction IDs.`);
  const remove = collection.filter(doc => !targets.has(doc.id) && (!originalIds || originalIds.has(doc.id))).map(doc => doc.id);
  const create = [];
  const update = [];
  for (const row of desired) {
    const current = collection.get(row._id);
    if (!current) create.push(row);
    else {
      const patch = difference(current, row, type);
      if (Object.keys(patch).length) update.push({ _id: row._id, ...patch });
    }
  }
  if (create.length) {
    await parent.createEmbeddedDocuments(type, create, { ...options, keepId: true, keepEmbeddedIds: true });
    for (const row of create) {
      const current = collection.get(row._id);
      if (!current) throw new Error(`Could not create required ${type} ${row.name ?? row._id}.`);
      const missing = missingField(documentFields(current.toObject(), type), documentFields(row, type));
      if (missing) throw new Error(`Created ${type} ${row.name ?? row._id} does not match the draft at ${missing}.`);
    }
  }
  if (update.length) {
    await parent.updateEmbeddedDocuments(type, update, options);
    for (const { _id, ...patch } of update) {
      const current = collection.get(_id);
      if (!current) throw new Error(`Missing updated ${type} ${_id}.`);
      const remaining = Object.keys(difference(current, targets.get(_id), type));
      const incomplete = remaining.find(key => Object.keys(patch).some(path =>
        key === path || key.startsWith(path + ".") || path.startsWith(key + ".")));
      if (incomplete) throw new Error(`A requested ${type} change was not applied to ${current.name ?? _id} (${incomplete}).`);
    }
  }
  if (type === "Item") {
    for (const row of desired) {
      const item = collection.get(row._id);
      const effects = row.effects ?? [];
      if (!sameValue(documentList(item.toObject().effects, "ActiveEffect"), documentList(effects, "ActiveEffect"))) {
        await reconcileEmbeddedDocuments(item, "ActiveEffect", effects, options);
      }
    }
  }
  if (remove.length) {
    await parent.deleteEmbeddedDocuments(type, remove, { ...options, deleteContents: false });
    if (remove.some(id => collection.has(id))) throw new Error(`Could not remove required ${type} documents.`);
  }
}
