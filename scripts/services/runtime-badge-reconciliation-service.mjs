import { MODULE_ID } from "../constants.mjs";

/**
 * Reconciles Character Builder presentation badges after a Character Keeper
 * mutation. The Actor's mechanics remain authoritative; this service changes
 * only the module-owned badge metadata attached to Items.
 */
export class RuntimeBadgeReconciliationService {
  static async reconcile(actor, {
    matches,
    additions = [],
    updateOptions = {}
  } = {}) {
    if (!actor?.items || typeof matches !== "function") return [];

    const byItem = new Map();
    for (const item of actor.items) {
      const current = foundry.utils.deepClone(item.getFlag(MODULE_ID, "advancementChoiceBadges") ?? []);
      byItem.set(item.id, current.filter(badge => !matches(item, badge)));
    }

    for (const addition of additions) {
      const itemId = addition?.itemId;
      const badge = foundry.utils.deepClone(addition?.badge ?? null);
      if (!itemId || !badge || !byItem.has(itemId)) continue;
      const current = byItem.get(itemId);
      const key = this.#badgeKey(badge);
      if (!current.some(existing => this.#badgeKey(existing) === key)) current.push(badge);
    }

    const updates = [];
    for (const item of actor.items) {
      const next = byItem.get(item.id) ?? [];
      const current = item.getFlag(MODULE_ID, "advancementChoiceBadges") ?? [];
      if (this.#stableString(current) === this.#stableString(next)) continue;
      updates.push({
        _id: item.id,
        [`flags.${MODULE_ID}.advancementChoiceBadges`]: next
      });
    }

    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, {
        characterBuilderRuntimeManagement: true,
        characterBuilderRuntimeBadgeReconciliation: true,
        ...updateOptions
      });
    }
    return updates;
  }

  static runtimeBadge({
    targetItem,
    category,
    values = [],
    kind,
    icon = "fa-solid fa-tag",
    transactionId = null,
    classIdentifier = null,
    classLevel = null,
    sourceItemId = null,
    advancementId = null,
    advancementType = "RuntimeManagement",
    advancementTitle = null,
    label = null,
    tooltip = null
  } = {}) {
    if (!targetItem) return null;
    const distinct = [...new Set((values ?? []).map(value => String(value ?? "").trim()).filter(Boolean))];
    const displayLabel = label ?? this.#bracketLabel(category, distinct);
    return {
      advancementId: advancementId ?? targetItem.id,
      advancementType,
      advancementTitle: advancementTitle ?? category,
      level: Number(classLevel ?? 0),
      kind,
      icon,
      category,
      values: distinct,
      label: displayLabel,
      tooltip: tooltip ?? `${category}: ${distinct.join(", ")}`,
      context: "restManagement",
      transactionId,
      characterLevel: this.#actorLevel(targetItem.actor),
      classIdentifier,
      classLevel: Number(classLevel ?? 0),
      sourceItemId: sourceItemId ?? targetItem.id,
      targetItemId: targetItem.id
    };
  }

  static #badgeKey(badge) {
    return [
      badge?.kind,
      badge?.category,
      badge?.classIdentifier,
      badge?.sourceItemId,
      badge?.targetItemId,
      badge?.label
    ].map(value => String(value ?? "")).join("|");
  }

  static #bracketLabel(category, values) {
    if (!values.length) return String(category ?? "");
    if (values.length <= 2) return `${category} [${values.join(", ")}]`;
    return `${category} [${values.slice(0, 2).join(", ")} +${values.length - 2}]`;
  }

  static #actorLevel(actor) {
    return actor?.items?.filter(item => item.type === "class")
      .reduce((total, item) => total + Number(item.system?.levels ?? 0), 0) ?? 0;
  }

  static #stableString(value) {
    return JSON.stringify(value ?? []);
  }
}
