import { MODULE_ID } from "../constants.mjs";

/**
 * Repairs and validates native D&D5e ItemChoice replacement records without
 * replacing the native Advancement workflow. D&D5e 5.3.3 requires both
 * `original` and `replacement` to be embedded Item IDs.
 */
export class ItemChoiceReplacementIntegrityService {
  static ID_PATTERN = /^[A-Za-z0-9]{16}$/;

  static async reconcile(actor, { throwOnFailure = true } = {}) {
    if (!actor?.items) return { changed: 0, inspected: 0 };
    const updates = [];
    let inspected = 0;

    for (const owner of actor.items.filter(item => ["class", "subclass", "feat"].includes(item.type))) {
      const source = owner.toObject();
      const advancements = source.system?.advancement ?? {};
      let changed = false;

      for (const advancement of Object.values(advancements)) {
        if (String(advancement?.type ?? "") !== "ItemChoice") continue;
        const replaced = advancement.value?.replaced ?? {};
        for (const [targetLevel, record] of Object.entries(replaced)) {
          if (!record || typeof record !== "object") continue;
          inspected++;
          const originalLevel = Number(record.level ?? targetLevel);
          const original = await this.#resolveId(actor, advancement, record.original, {
            role: "original",
            level: originalLevel
          });
          const replacement = await this.#resolveId(actor, advancement, record.replacement, {
            role: "replacement",
            level: Number(targetLevel)
          });

          if (!original || !replacement) {
            const title = advancement.title || owner.name || "Item Choice";
            const message = `${title} contains an invalid native replacement record at level ${targetLevel}.`;
            if (throwOnFailure) {
              const error = new Error(message);
              error.structuralLevelUp = true;
              error.reason = "The original or replacement Item could not be resolved to an embedded Item ID.";
              error.diagnostic = JSON.stringify({
                ownerId: owner.id,
                advancementId: advancement._id,
                targetLevel,
                original: record.original,
                replacement: record.replacement
              });
              throw error;
            }
            console.warn(`${MODULE_ID} | ${message}`, { owner, advancement, record });
            continue;
          }

          if (record.original !== original || record.replacement !== replacement || record.level !== originalLevel) {
            advancement.value.replaced[targetLevel] = { level: originalLevel, original, replacement };
            changed = true;
          }
        }
      }

      if (changed) updates.push({ _id: owner.id, "system.advancement": advancements });
    }

    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, {
        diff: false,
        recursive: false,
        characterBuilderItemChoiceReplacementRepair: true
      });
    }

    this.validate(actor);
    return { changed: updates.length, inspected };
  }

  static validate(actor) {
    for (const owner of actor?.items ?? []) {
      const advancements = owner.toObject().system?.advancement ?? {};
      for (const advancement of Object.values(advancements)) {
        if (String(advancement?.type ?? "") !== "ItemChoice") continue;
        for (const [targetLevel, record] of Object.entries(advancement.value?.replaced ?? {})) {
          if (!record || typeof record !== "object") continue;
          for (const field of ["original", "replacement"]) {
            const value = record[field];
            if (!this.ID_PATTERN.test(String(value ?? ""))) {
              const error = new Error(`${advancement.title || owner.name || "Item Choice"} has an invalid ${field} embedded Item ID at level ${targetLevel}.`);
              error.structuralLevelUp = true;
              error.reason = `Native ItemChoice replacement ${field} must be a 16-character embedded Item ID.`;
              error.diagnostic = JSON.stringify({ ownerId: owner.id, advancementId: advancement._id, targetLevel, field, value });
              throw error;
            }
          }
        }
      }
    }
  }

  static async #resolveId(actor, advancement, value, { role, level }) {
    const candidate = this.#candidateString(value);
    const added = advancement.value?.added ?? {};
    const levelMap = added[String(level)] ?? added[level] ?? {};
    const allEntries = Object.entries(added).flatMap(([addedLevel, rows]) =>
      Object.entries(rows ?? {}).map(([id, uuid]) => ({ id, uuid, level: Number(addedLevel) }))
    );

    if (this.ID_PATTERN.test(candidate)) {
      if (role === "replacement" && actor.items.get(candidate)) return candidate;
      if (allEntries.some(row => row.id === candidate)) return candidate;
      if (role === "original") return candidate;
    }

    const directItem = actor.items.get(candidate);
    if (directItem && this.ID_PATTERN.test(directItem.id)) return directItem.id;

    const sourceMatches = actor.items.filter(item => {
      const sourceId = item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource;
      return sourceId && String(sourceId) === candidate;
    });
    if (sourceMatches.length === 1) return sourceMatches[0].id;

    const addedSourceMatches = allEntries.filter(row => String(row.uuid ?? "") === candidate);
    if (addedSourceMatches.length === 1) return addedSourceMatches[0].id;

    const levelIds = Object.keys(levelMap ?? {}).filter(id => this.ID_PATTERN.test(id));
    if (role === "replacement" && levelIds.length === 1) {
      const item = actor.items.get(levelIds[0]);
      if (item) return item.id;
    }

    const identifier = this.#normalize(candidate);
    if (identifier) {
      const itemMatches = actor.items.filter(item =>
        this.#normalize(item.system?.identifier) === identifier || this.#normalize(item.name) === identifier
      );
      if (itemMatches.length === 1) return itemMatches[0].id;

      const sourceRows = [];
      for (const row of allEntries) {
        const document = row.uuid ? await fromUuid(row.uuid) : null;
        if (!document) continue;
        if (this.#normalize(document.system?.identifier) === identifier || this.#normalize(document.name) === identifier) {
          sourceRows.push(row);
        }
      }
      if (sourceRows.length === 1) return sourceRows[0].id;
    }

    return null;
  }

  static #candidateString(value) {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";
    return String(value.id ?? value._id ?? value.uuid ?? value.identifier ?? value.name ?? "").trim();
  }

  static #normalize(value) {
    return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
}
