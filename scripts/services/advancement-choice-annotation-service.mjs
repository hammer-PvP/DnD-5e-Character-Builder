import { MODULE_ID } from "../constants.mjs";

/**
 * Stores compact read-only badges only for choices made during Character Builder
 * Level Up transactions. Level 1 creation choices remain in their native sheet
 * locations and are deliberately not annotated.
 */
export class AdvancementChoiceAnnotationService {
  static FLAG = "advancementChoiceBadges";
  static SCHEMA_FLAG = "advancementChoiceBadgeSchema";
  static SCHEMA_VERSION = 2;

  static getBadges(item) {
    return foundry.utils.deepClone(item?.getFlag(MODULE_ID, this.FLAG) ?? []);
  }

  static async clear(actor) {
    if (!actor?.items) return [];
    const updates = actor.items
      .filter(item => this.getBadges(item).length)
      .map(item => ({ _id: item.id, [`flags.${MODULE_ID}.${this.FLAG}`]: [] }));
    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, {
        characterBuilderAdvancementAnnotations: true
      });
    }
    return updates;
  }

  /**
   * Rebuild legacy 0.9.2/0.9.3 badge data from Level Up history. This removes
   * creation badges and moves choices such as Scholar Expertise from the Class
   * document to the feature which presents that choice on the Actor sheet.
   */
  static async migrateActor(actor) {
    if (!actor || actor.type !== "character") return;
    if (Number(actor.getFlag(MODULE_ID, this.SCHEMA_FLAG) ?? 0) >= this.SCHEMA_VERSION) return;
    await this.refresh(actor, { rebuild: true });
    await actor.setFlag(MODULE_ID, this.SCHEMA_FLAG, this.SCHEMA_VERSION);
  }

  static async refresh(actor, { state = null, rebuild = false } = {}) {
    if (!actor?.items) return [];

    const byItem = new Map(actor.items.map(item => [item.id, []]));
    if (!rebuild) {
      for (const item of actor.items) {
        const retained = this.getBadges(item).filter(badge =>
          badge?.context === "levelUp"
          && (!state?.transactionId || badge.transactionId !== state.transactionId)
        );
        byItem.set(item.id, retained);
      }
    }

    const scopes = rebuild
      ? (actor.getFlag(MODULE_ID, "levelUpHistory") ?? [])
      : (state ? [state] : []);

    for (const scope of scopes) {
      for (const row of this.#collectScope(actor, scope)) {
        const current = byItem.get(row.targetItemId) ?? [];
        const key = this.#badgeKey(row.badge);
        if (!current.some(badge => this.#badgeKey(badge) === key)) current.push(row.badge);
        byItem.set(row.targetItemId, current);
      }
    }

    const updates = [];
    const changed = [];
    for (const item of actor.items) {
      const next = (byItem.get(item.id) ?? []).sort((a, b) =>
        Number(a.characterLevel ?? 0) - Number(b.characterLevel ?? 0)
        || a.label.localeCompare(b.label, game.i18n.lang)
      );
      const current = this.getBadges(item);
      if (this.#stableString(current) === this.#stableString(next)) continue;
      updates.push({ _id: item.id, [`flags.${MODULE_ID}.${this.FLAG}`]: next });
      changed.push({ itemId: item.id, badges: next });
    }

    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, {
        characterBuilderAdvancementAnnotations: true
      });
    }
    return changed;
  }

  static #collectScope(actor, scope) {
    const selectedClassIdentifier = String(
      scope?.selectedClassIdentifier ?? scope?.classIdentifier ?? ""
    );
    const targetClassLevel = Number(scope?.targetClassLevel ?? 0);
    if (!selectedClassIdentifier || !targetClassLevel) return [];

    const rows = [];
    for (const sourceItem of actor.items) {
      if (!this.#isScopeSource(sourceItem, selectedClassIdentifier)) continue;
      const advancements = sourceItem.toObject().system?.advancement ?? {};
      for (const [advancementId, advancement] of Object.entries(advancements)) {
        const level = Number(advancement?.level ?? 0);
        if (["class", "subclass"].includes(sourceItem.type) && level !== targetClassLevel) continue;
        const badge = this.#buildBadge(advancementId, advancement, actor);
        if (!badge) continue;
        const target = this.#resolvePresentationItem(sourceItem, badge, actor);
        if (!target) continue;
        rows.push({
          targetItemId: target.id,
          badge: {
            ...badge,
            context: "levelUp",
            transactionId: scope.transactionId ?? null,
            characterLevel: Number(scope.targetCharacterLevel ?? 0),
            classIdentifier: selectedClassIdentifier,
            classLevel: targetClassLevel,
            sourceItemId: sourceItem.id,
            targetItemId: target.id
          }
        });
      }
    }
    return rows;
  }

  static #isScopeSource(item, selectedClassIdentifier) {
    if (item.type === "class") return item.system?.identifier === selectedClassIdentifier;
    if (item.type === "subclass") {
      const classIdentifier = item.system?.classIdentifier
        ?? item.system?.class?.identifier
        ?? item.system?.class;
      if (typeof classIdentifier === "string" && classIdentifier) {
        return classIdentifier === selectedClassIdentifier;
      }
      return true;
    }
    return item.type === "feat" && this.getBadges(item).some(badge =>
      badge?.classIdentifier === selectedClassIdentifier
    );
  }

  static #resolvePresentationItem(sourceItem, badge, actor) {
    if (sourceItem.type === "feat") return sourceItem;

    const title = this.#normalize(badge.advancementTitle ?? badge.category);
    if (!title) return null;
    const exact = actor.items.filter(item => {
      if (item.type !== "feat") return false;
      return this.#normalize(item.name) === title
        || this.#normalize(item.system?.identifier) === title;
    });
    if (!exact.length) return null;

    const linked = exact.filter(item => {
      const origin = String(item.getFlag("dnd5e", "advancementOrigin") ?? "");
      const root = String(item.getFlag("dnd5e", "advancementRoot") ?? "");
      return origin.startsWith(`${sourceItem.id}.`) || root.startsWith(`${sourceItem.id}.`);
    });
    if (linked.length === 1) return linked[0];
    if (exact.length === 1) return exact[0];
    return null;
  }

  static #buildBadge(advancementId, advancement, actor) {
    const type = String(advancement?.type ?? "");
    if (type === "Trait") return this.#traitBadge(advancementId, advancement);
    if (type === "ItemChoice") return this.#itemChoiceBadge(advancementId, advancement, actor);
    if (type === "ItemGrant" && this.#isOptionalItemGrant(advancement)) {
      return this.#optionalItemGrantBadge(advancementId, advancement, actor);
    }
    return null;
  }

  static #traitBadge(advancementId, advancement) {
    const chosen = this.#collectionValues(advancement.value?.chosen).map(String).filter(Boolean);
    const choices = advancement.configuration?.choices ?? [];
    if (!chosen.length || !choices.length) return null;
    const fixed = new Set(this.#collectionValues(advancement.configuration?.grants).map(String));
    const selected = chosen.filter(key => !fixed.has(key));
    if (!selected.length) return null;
    const labels = selected.map(key => this.#traitKeyLabel(key));
    const mode = String(advancement.configuration?.mode ?? "default");
    return this.#badge({
      advancementId,
      advancement,
      kind: "trait",
      icon: mode === "expertise" ? "fa-solid fa-medal" : "fa-solid fa-list-check",
      category: this.#traitCategory(selected, mode, advancement.title),
      values: labels
    });
  }

  static #itemChoiceBadge(advancementId, advancement, actor) {
    const ids = this.#embeddedItemIds(advancement.value?.added, actor);
    const names = ids.map(id => actor.items.get(id)?.name).filter(Boolean);
    if (!names.length) return null;
    return this.#badge({
      advancementId,
      advancement,
      kind: "item-choice",
      icon: "fa-solid fa-puzzle-piece",
      category: advancement.title || "Choice",
      values: names
    });
  }

  static #optionalItemGrantBadge(advancementId, advancement, actor) {
    const ids = this.#embeddedItemIds(advancement.value?.added, actor);
    const names = ids.map(id => actor.items.get(id)?.name).filter(Boolean);
    if (!names.length) return null;
    return this.#badge({
      advancementId,
      advancement,
      kind: "optional-item-grant",
      icon: "fa-solid fa-gift",
      category: advancement.title || "Granted Choice",
      values: names
    });
  }

  static #badge({ advancementId, advancement, kind, icon, category, values }) {
    const allValues = [...new Set(values)].sort((a, b) => a.localeCompare(b, game.i18n.lang));
    const visibleValues = allValues.slice(0, 3);
    const remainder = allValues.length - visibleValues.length;
    const compact = `${category}: ${visibleValues.join(", ")}${remainder > 0 ? ` +${remainder}` : ""}`;
    return {
      advancementId,
      advancementType: advancement.type,
      advancementTitle: advancement.title || category,
      level: Number(advancement.level ?? 0),
      kind,
      icon,
      category,
      values: allValues,
      label: compact,
      tooltip: `${category}: ${allValues.join(", ")}`
    };
  }

  static #traitCategory(chosen, mode, title) {
    if (mode === "expertise") return "Expertise";
    if (mode === "mastery") return "Mastery";
    if (mode === "upgrade") return "Proficiency";
    const roots = new Set(chosen.map(key => String(key).split(":")[0]));
    if (roots.size === 1) {
      const root = roots.values().next().value;
      return {
        skills: "Skills", skill: "Skills", languages: "Languages", language: "Languages",
        tools: "Tools", tool: "Tools", weapon: "Weapons", weapons: "Weapons",
        armor: "Armor", saves: "Saving Throws", save: "Saving Throws"
      }[root] ?? title ?? "Choice";
    }
    return title ?? "Choices";
  }

  static #traitKeyLabel(key) {
    const parts = String(key).split(":").filter(Boolean);
    const root = parts[0] ?? "";
    const value = parts.at(-1) ?? key;
    const tables = {
      skills: CONFIG.DND5E.skills, skill: CONFIG.DND5E.skills,
      tools: CONFIG.DND5E.tools, tool: CONFIG.DND5E.tools,
      saves: CONFIG.DND5E.abilities, save: CONFIG.DND5E.abilities,
      abilities: CONFIG.DND5E.abilities, ability: CONFIG.DND5E.abilities,
      languages: CONFIG.DND5E.languages, language: CONFIG.DND5E.languages,
      weapon: CONFIG.DND5E.weaponTypes, weapons: CONFIG.DND5E.weaponTypes,
      armor: CONFIG.DND5E.armorTypes
    };
    const direct = this.#labelFromTable(tables[root], value);
    if (direct) return direct;
    for (const table of [CONFIG.DND5E.skills, CONFIG.DND5E.tools, CONFIG.DND5E.abilities, CONFIG.DND5E.languages]) {
      const label = this.#labelFromTable(table, value);
      if (label) return label;
    }
    return this.#humanize(value);
  }

  static #labelFromTable(table, key) {
    if (!table || typeof table !== "object") return null;
    const direct = this.#extractLabel(table[key]);
    if (direct) return direct;
    for (const entry of Object.values(table)) {
      if (!entry || typeof entry !== "object") continue;
      const nested = this.#extractLabel(entry[key]);
      if (nested) return nested;
      const values = entry.choices ?? entry.values ?? entry.children;
      const choice = this.#extractLabel(values?.[key]);
      if (choice) return choice;
    }
    return null;
  }

  static #extractLabel(value) {
    if (typeof value === "string") return game.i18n.localize(value);
    if (!value || typeof value !== "object") return null;
    const label = value.label ?? value.name ?? value.title;
    return typeof label === "string" ? game.i18n.localize(label) : null;
  }

  static #embeddedItemIds(value, actor) {
    const ids = [];
    const walk = node => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      for (const [key, nested] of Object.entries(node)) {
        if (actor.items.get(key)) ids.push(key);
        if (nested && typeof nested === "object") walk(nested);
      }
    };
    walk(value);
    return [...new Set(ids)];
  }

  static #isOptionalItemGrant(advancement) {
    return Boolean(advancement.configuration?.optional)
      || (advancement.configuration?.items ?? []).some(entry => Boolean(entry?.optional));
  }

  static #collectionValues(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return [...value];
    if (typeof value.values === "function") return [...value.values()];
    if (typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length && entries.every(([, selected]) => typeof selected === "boolean")) {
        return entries.filter(([, selected]) => selected).map(([key]) => key);
      }
      return Object.values(value);
    }
    return [];
  }

  static #normalize(value) {
    return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  static #humanize(value) {
    return String(value ?? "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[-_]/g).filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  }

  static #badgeKey(badge) {
    return [badge.transactionId ?? "history", badge.sourceItemId, badge.targetItemId,
      badge.advancementId, badge.label].join(":");
  }

  static #stableString(value) {
    return JSON.stringify(value ?? []);
  }
}
