// Foundry owns modification statistics. Compendium provenance is document data.
function collectChanges(before, after, update, prefix = "") {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path === "_id") continue;
    if (key === "_stats") {
      const source = after[key]?.compendiumSource;
      if (source !== undefined && before[key]?.compendiumSource !== source) update[`${path}.compendiumSource`] = source;
      continue;
    }
    if (path === "system.advancement" && isRecord(after[key])) {
      if (!sameValue(before[key], after[key])) update[path] = foundry.data.operators.ForcedReplacement.create(after[key]);
      continue;
    }
    if (!Object.hasOwn(after, key)) {
      update[path] = new foundry.data.operators.ForcedDeletion();
    } else if (!Object.hasOwn(before, key)) {
      update[path] = after[key];
    } else if (Array.isArray(before[key]) && Array.isArray(after[key])) {
      if (!sameValue(before[key], after[key])) update[path] = after[key];
    } else if (isRecord(before[key]) && isRecord(after[key])) {
      collectChanges(before[key], after[key], update, path);
    } else if (before[key] !== after[key]) {
      update[path] = after[key];
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

function difference(document, target) {
  const update = {};
  collectChanges(document.toObject(), target, update);
  return update;
}

export async function reconcileEmbeddedDocuments(actor, type, desired, options, originalIds = null) {
  const collection = actor.getEmbeddedCollection(type);
  const targets = new Map(desired.map(row => [row._id, row]));
  if (targets.size !== desired.length || desired.some(row => !row._id)) throw new Error(`Invalid ${type} transaction IDs.`);
  const remove = collection.filter(doc => !targets.has(doc.id) && (!originalIds || originalIds.has(doc.id))).map(doc => doc.id);
  const create = [];
  const update = [];
  for (const row of desired) {
    const current = collection.get(row._id);
    if (!current) create.push(row);
    else {
      const changes = difference(current, row);
      if (Object.keys(changes).length) update.push({ _id: row._id, ...changes });
    }
  }
  if (create.length) {
    await actor.createEmbeddedDocuments(type, create, { ...options, keepId: true });
    if (create.some(row => !collection.has(row._id))) throw new Error(`Could not create required ${type} documents.`);
  }
  if (update.length) {
    const changed = await actor.updateEmbeddedDocuments(type, update, options);
    const updated = new Set(changed.map(doc => doc.id));
    for (const patch of update) {
      const current = collection.get(patch._id);
      if (!updated.has(patch._id) || !current) throw new Error(`Could not update required ${type} documents.`);
      const remaining = Object.keys(difference(current, targets.get(patch._id)));
      const incomplete = remaining.some(key => Object.hasOwn(patch, key)
        || Object.keys(patch).some(path => key.startsWith(path + ".")));
      if (incomplete) throw new Error(`A requested ${type} change was not applied to ${current.name ?? current.id}.`);
    }
  }
  if (remove.length) {
    await actor.deleteEmbeddedDocuments(type, remove, { ...options, deleteContents: false });
    if (remove.some(id => collection.has(id))) throw new Error(`Could not remove required ${type} documents.`);
  }
}
