import { MODULE_ID } from "../constants.mjs";

/**
 * Stores compact read-only choice badges on the exact feature that owns each
 * Character Builder selection. Creation and Level Up acquisitions retain
 * independent contexts so later choices never overwrite earlier ones.
 */
export class AdvancementChoiceAnnotationService {
  static FLAG = "advancementChoiceBadges";
  static SCHEMA_FLAG = "advancementChoiceBadgeSchema";
  static SCHEMA_VERSION = 3;

  static getBadges(item) {
    return foundry.utils.deepClone(item?.getFlag(MODULE_ID, this.FLAG) ?? []);
  }

  /**
   * Build the badge that should represent one already-resolved Advancement on
   * a live Actor. Character Validation uses this to audit CB presentation
   * metadata without guessing or replaying the underlying choice.
   */
  static expectedAdvancementBadge(actor, {
    sourceItemId,
    advancementId,
    context = "validation",
    transactionId = null,
    characterLevel = null,
    classIdentifier = null,
    classLevel = null
  } = {}) {
    const sourceItem = actor?.items?.get?.(sourceItemId);
    if (!sourceItem || !advancementId) return null;
    const advancement = sourceItem.toObject().system?.advancement?.[advancementId];
    if (!advancement) return null;
    const base = this.#buildBadge(advancementId, advancement, actor);
    if (!base) return null;
    const target = this.#resolvePresentationItem(sourceItem, base, actor);
    if (!target) return null;

    const resolvedClassIdentifier = classIdentifier ?? this.#classIdentifierForItem(actor, sourceItem);
    const resolvedClassLevel = Number(classLevel ?? this.#classLevelForItem(actor, sourceItem) ?? advancement.level ?? 0);
    const resolvedCharacterLevel = Number(characterLevel ?? this.#actorLevel(actor));
    return {
      targetItemId: target.id,
      badge: {
        ...base,
        context,
        transactionId: transactionId ?? `validation:${sourceItem.id}:${advancementId}`,
        characterLevel: resolvedCharacterLevel,
        classIdentifier: resolvedClassIdentifier,
        classLevel: resolvedClassLevel,
        sourceItemId: sourceItem.id,
        targetItemId: target.id
      }
    };
  }

  /**
   * Reconcile only the Character Builder badge for an Advancement whose native
   * state is already complete. The mechanical choice remains untouched.
   */
  static async reconcileAdvancementBadge(actor, options = {}) {
    const expected = this.expectedAdvancementBadge(actor, options);
    if (!expected) return { changed: false, reason: "no-presentation-target" };
    const target = actor.items.get(expected.targetItemId);
    if (!target) return { changed: false, reason: "missing-target" };

    const incoming = expected.badge;
    const current = this.getBadges(target);
    // Runtime Weapon Mastery maintenance already owns a stable blue badge. A
    // Validator pass must not add a second cosmetic badge merely because the
    // native Trait Advancement uses a different advancementId. Treat an
    // equivalent same-source mastery badge as satisfying presentation state.
    if (this.#hasEquivalentMaintenanceBadge(current, incoming, target.id)) {
      return { changed: false, targetItemId: target.id, badge: incoming, reason: "equivalent-maintenance-badge" };
    }
    const retained = current.filter(badge => !(
      String(badge?.sourceItemId ?? "") === String(incoming.sourceItemId ?? "")
      && String(badge?.advancementId ?? "") === String(incoming.advancementId ?? "")
      && String(badge?.targetItemId ?? target.id) === String(target.id)
    ));
    const next = [...retained, incoming].sort((a, b) =>
      Number(a.characterLevel ?? 0) - Number(b.characterLevel ?? 0)
      || String(a.label ?? "").localeCompare(String(b.label ?? ""), game.i18n.lang)
    );
    if (this.#stableString(current) === this.#stableString(next)) {
      return { changed: false, targetItemId: target.id, badge: incoming };
    }
    await target.update({ [`flags.${MODULE_ID}.${this.FLAG}`]: next }, {
      characterBuilderAdvancementAnnotations: true,
      characterBuilderValidationRepair: true
    });
    return { changed: true, targetItemId: target.id, badge: incoming };
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
   * Rebuild legacy badges from the authoritative creation Advancements and
   * Level Up history, moving every choice to its exact presentation feature.
   */
  static async migrateActor(actor) {
    if (!actor || actor.type !== "character") return;
    if (Number(actor.getFlag(MODULE_ID, this.SCHEMA_FLAG) ?? 0) >= this.SCHEMA_VERSION) return;
    await this.refresh(actor, { rebuild: true });
    await actor.setFlag(MODULE_ID, this.SCHEMA_FLAG, this.SCHEMA_VERSION);
  }

  static async refreshCreation(actor) {
    const scope = this.#creationScope(actor);
    if (!scope) return [];
    return this.refresh(actor, { state: scope });
  }

  static async refresh(actor, { state = null, rebuild = false } = {}) {
    if (!actor?.items) return [];

    const byItem = new Map(actor.items.map(item => [item.id, []]));
    if (!rebuild) {
      const incomingContext = state?.context ?? "levelUp";
      for (const item of actor.items) {
        const retained = this.getBadges(item).filter(badge => {
          if (badge?.context !== incomingContext) return true;
          if (state?.transactionId) return badge.transactionId !== state.transactionId;
          return incomingContext !== "creation";
        });
        byItem.set(item.id, retained);
      }
    }

    const scopes = rebuild
      ? [this.#creationScope(actor), ...(actor.getFlag(MODULE_ID, "levelUpHistory") ?? [])].filter(Boolean)
      : (state ? [state] : []);

    for (const scope of scopes) {
      for (const row of this.#collectScope(actor, scope)) {
        const current = byItem.get(row.targetItemId) ?? [];
        const key = this.#badgeKey(row.badge);
        if (!current.some(badge => this.#badgeKey(badge) === key)) current.push(row.badge);
        byItem.set(row.targetItemId, current);
      }
    }

    // Known Wild Shape Forms are current Actor state, not historical Level Up
    // choices. Collapse every legacy per-transaction badge to one canonical
    // badge whenever annotations are otherwise refreshed. Character Keeper also
    // performs the same reconciliation when a known form is replaced, giving
    // older Actors a lazy repair path without a world-wide migration.
    this.#normalizeKnownFormsCurrentState(actor, byItem);

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
    const context = scope?.context ?? "levelUp";
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
            context,
            transactionId: scope.transactionId ?? (context === "creation" ? "character-creation" : null),
            characterLevel: Number(scope.targetCharacterLevel ?? 0),
            classIdentifier: selectedClassIdentifier,
            classLevel: targetClassLevel,
            sourceItemId: sourceItem.id,
            targetItemId: target.id
          }
        });
      }
    }
    for (const spell of actor.items.filter(item => item.type === "spell")) {
      for (const owner of spell.getFlag(MODULE_ID, "featureSpellOwners") ?? []) {
        if (scope?.transactionId && owner.transactionId !== scope.transactionId) continue;
        if (owner.classIdentifier && owner.classIdentifier !== selectedClassIdentifier) continue;
        const category = this.#featureSpellCategory(owner);
        rows.push({
          targetItemId: spell.id,
          badge: {
            advancementId: owner.featureItemId ?? owner.category,
            advancementType: "ManagedFeatureSpell",
            advancementTitle: owner.label ?? category,
            level: Number(owner.acquiredAtClassLevel ?? targetClassLevel),
            kind: "feature-spell",
            icon: this.#featureSpellIcon(owner.category),
            category,
            values: [spell.name],
            label: category,
            tooltip: this.#featureSpellTooltip(owner, spell),
            context,
            transactionId: scope.transactionId ?? owner.transactionId ?? (context === "creation" ? "character-creation" : null),
            characterLevel: Number(scope.targetCharacterLevel ?? owner.acquiredAtCharacterLevel ?? 0),
            classIdentifier: selectedClassIdentifier,
            classLevel: targetClassLevel,
            sourceItemId: owner.featureItemId ?? owner.ownerItemId ?? owner.classItemId,
            targetItemId: spell.id
          }
        });
      }
    }

    for (const feature of actor.items.filter(item => item.type === "feat")) {
      const choice = feature.getFlag(MODULE_ID, "managedFeatureChoice");
      if (choice && (!scope?.transactionId || choice.transactionId === scope.transactionId)
        && (!choice.classIdentifier || choice.classIdentifier === selectedClassIdentifier)) {
        rows.push({
          targetItemId: feature.id,
          badge: {
            advancementId: feature.id,
            advancementType: "ManagedFeatureChoice",
            advancementTitle: feature.name,
            level: Number(choice.acquiredAtClassLevel ?? targetClassLevel),
            kind: "managed-feature-choice",
            icon: "fa-solid fa-list-check",
            category: feature.name,
            values: [choice.label],
            label: this.#bracketLabel(feature.name, [choice.label]),
            tooltip: `${feature.name}: ${choice.label}`,
            context,
            transactionId: scope.transactionId ?? choice.transactionId ?? (context === "creation" ? "character-creation" : null),
            characterLevel: Number(scope.targetCharacterLevel ?? choice.acquiredAtCharacterLevel ?? 0),
            classIdentifier: selectedClassIdentifier,
            classLevel: targetClassLevel,
            sourceItemId: choice.classItemId ?? feature.id,
            targetItemId: feature.id
          }
        });
      }

      const invocation = feature.getFlag(MODULE_ID, "invocationInstance");
      if (invocation && (!scope?.transactionId || invocation.transactionId === scope.transactionId)
        && (!invocation.classIdentifier || invocation.classIdentifier === selectedClassIdentifier)) {
        const values = [];
        if (invocation.targetCantripName) {
          const targetExists = invocation.targetCantripItemId ? Boolean(actor.items.get(invocation.targetCantripItemId)) : true;
          values.push(targetExists ? invocation.targetCantripName : `Missing Target: ${invocation.targetCantripName}`);
        }
        const pactCantrips = invocation.selectedCantrips ?? invocation.cantrips ?? [];
        const pactRituals = invocation.selectedRituals ?? invocation.rituals ?? [];
        if (Array.isArray(pactCantrips)) values.push(...pactCantrips.map(row => row?.name ?? row).filter(Boolean));
        if (Array.isArray(pactRituals)) values.push(...pactRituals.map(row => row?.name ?? row).filter(Boolean));
        if (values.length) {
          rows.push({
            targetItemId: feature.id,
            badge: {
              advancementId: invocation.advancementId ?? feature.id,
              advancementType: "ManagedInvocationChoice",
              advancementTitle: feature.name,
              level: Number(invocation.acquiredAtWarlockLevel ?? targetClassLevel),
              kind: "invocation-choice",
              icon: "fa-solid fa-eye",
              category: feature.name,
              values: [...new Set(values)],
              label: this.#bracketLabel(feature.name, [...new Set(values)]),
              tooltip: `${feature.name}: ${[...new Set(values)].join(", ")}`,
              context,
              transactionId: scope.transactionId ?? invocation.transactionId ?? (context === "creation" ? "character-creation" : null),
              characterLevel: Number(scope.targetCharacterLevel ?? invocation.acquiredAtCharacterLevel ?? 0),
              classIdentifier: selectedClassIdentifier,
              classLevel: targetClassLevel,
              sourceItemId: invocation.classItemId ?? feature.id,
              targetItemId: feature.id
            }
          });
        }
      }

      const land = feature.getFlag(MODULE_ID, "circleLand");
      const landBelongsToScope = !scope?.transactionId || !land?.transactionId
        || land.transactionId === scope.transactionId;
      if (land && selectedClassIdentifier === "druid" && landBelongsToScope) {
        rows.push({
          targetItemId: feature.id,
          badge: {
            advancementId: "circle-land",
            advancementType: "ManagedFeatureChoice",
            advancementTitle: "Circle of the Land",
            level: Number(land.configuredAtDruidLevel ?? targetClassLevel),
            kind: "circle-land",
            icon: "fa-solid fa-leaf",
            category: "Land",
            values: [land.label],
            label: `Land: ${land.label}`,
            tooltip: `Circle of the Land: ${land.label}`,
            context,
            transactionId: scope.transactionId ?? land.transactionId ?? (context === "creation" ? "character-creation" : null),
            characterLevel: Number(scope.targetCharacterLevel ?? 0),
            classIdentifier: "druid",
            classLevel: targetClassLevel,
            sourceItemId: land.classItemId ?? feature.id,
            targetItemId: feature.id
          }
        });
      }
    }

    return rows;
  }

  static #featureSpellCategory(owner) {
    if (owner.category === "spell-mastery") return "Spell Mastery";
    if (owner.category === "signature-spell") return owner.signaturePosition ? `Signature Spell ${owner.signaturePosition}` : "Signature Spell";
    if (owner.category === "mystic-arcanum") return `Mystic Arcanum · Level ${owner.spellLevel}`;
    if (owner.category === "magical-discoveries") return "Magical Discoveries";
    if (owner.category === "circle-of-the-land-spells") return "Circle of the Land Spell";
    if (owner.category === "primal-order-magician") return "Primal Order: Magician";
    return owner.label ?? this.#humanize(owner.category ?? "Feature Spell");
  }

  static #featureSpellIcon(category) {
    if (category === "mystic-arcanum") return "fa-solid fa-eye";
    if (category === "spell-mastery") return "fa-solid fa-infinity";
    if (category === "signature-spell") return "fa-solid fa-signature";
    if (category === "circle-of-the-land-spells") return "fa-solid fa-leaf";
    if (category === "primal-order-magician") return "fa-solid fa-wand-magic-sparkles";
    return "fa-solid fa-wand-magic-sparkles";
  }

  static #featureSpellTooltip(owner, spell) {
    const details = [this.#featureSpellCategory(owner), spell.name];
    if (owner.trackerActivityName) details.push(owner.trackerActivityName);
    if (owner.unlimitedFreeCast) details.push("Free cast at base level; no upcast");
    if (owner.category === "mystic-arcanum") details.push("1/Long Rest; no Pact Slot");
    return details.join(" · ");
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
    let allValues = [...new Set(values)].sort((a, b) => a.localeCompare(b, game.i18n.lang));
    if (String(advancement?.configuration?.mode ?? "") === "expertise" && category !== "Expertise") {
      allValues = allValues.map(value => `Expertise: ${value}`);
    }
    return {
      advancementId,
      advancementType: advancement.type,
      advancementTitle: advancement.title || category,
      level: Number(advancement.level ?? 0),
      kind,
      icon,
      category,
      values: allValues,
      label: this.#bracketLabel(category, allValues),
      tooltip: `${category}: ${allValues.join(", ")}`
    };
  }

  static #traitCategory(chosen, mode, title) {
    const normalizedTitle = String(title ?? "").trim();
    if (mode === "expertise") return normalizedTitle || "Expertise";
    if (mode === "mastery") return /weapon mastery/i.test(normalizedTitle) ? "Weapon Mastery" : (normalizedTitle || "Mastery");
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
    // Foundry Collection extends Map. Check the concrete collection type rather
    // than invoking an arbitrary external object method named values().
    if (value instanceof Map) return [...value.values()];
    if (typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length && entries.every(([, selected]) => typeof selected === "boolean")) {
        return entries.filter(([, selected]) => selected).map(([key]) => key);
      }
      return Object.values(value);
    }
    return [];
  }

  static #normalizeKnownFormsCurrentState(actor, byItem) {
    if (!actor?.items || !(byItem instanceof Map)) return;

    for (const [itemId, badges] of byItem) {
      byItem.set(itemId, (badges ?? []).filter(badge =>
        badge?.kind !== "known-forms"
        && badge?.advancementId !== "known-wild-shape-forms"
      ));
    }

    const feature = actor.items.find(item => {
      const forms = item.getFlag?.(MODULE_ID, "knownWildShapeForms");
      return Array.isArray(forms) && forms.length > 0;
    });
    if (!feature || !byItem.has(feature.id)) return;

    const forms = feature.getFlag(MODULE_ID, "knownWildShapeForms") ?? [];
    const values = [...new Set(forms.map(row => String(row?.name ?? "").trim()).filter(Boolean))];
    if (!values.length) return;

    const druid = actor.items.find(item => item.type === "class" && String(item.system?.identifier ?? "") === "druid");
    const druidLevel = Number(druid?.system?.levels ?? 0);
    const lastChange = feature.getFlag(MODULE_ID, "knownWildShapeFormsLastChange") ?? {};
    const current = byItem.get(feature.id) ?? [];
    current.push({
      advancementId: "known-wild-shape-forms",
      advancementType: "ManagedActorChoice",
      advancementTitle: "Known Forms",
      level: druidLevel,
      kind: "known-forms",
      icon: "fa-solid fa-paw",
      category: "Known Forms",
      values,
      label: `Known Forms: ${forms.length}`,
      tooltip: `Known Wild Shape Forms: ${values.join(", ")}`,
      context: "currentState",
      transactionId: lastChange.transactionId ?? "known-forms-current",
      characterLevel: this.#actorLevel(actor),
      classIdentifier: "druid",
      classLevel: druidLevel,
      sourceItemId: feature.id,
      targetItemId: feature.id
    });
    byItem.set(feature.id, current);
  }

  static #creationScope(actor) {
    const originalClassId = actor?.system?.details?.originalClass?.id
      ?? actor?.system?.details?.originalClass
      ?? null;
    const cls = originalClassId ? actor.items.get(originalClassId) : actor.items.find(item => item.type === "class");
    const identifier = cls?.system?.identifier;
    if (!identifier) return null;
    return {
      context: "creation",
      transactionId: "character-creation",
      selectedClassId: cls.id,
      selectedClassIdentifier: identifier,
      targetClassLevel: 1,
      targetCharacterLevel: 1
    };
  }

  static #hasEquivalentMaintenanceBadge(current, incoming, targetItemId) {
    if (String(incoming?.category ?? "").toLowerCase() !== "weapon mastery") return false;
    const expected = this.#normalizedMasteryBadgeValues(incoming?.values ?? []);
    if (!expected.length) return false;
    return (current ?? []).some(badge => {
      if (String(badge?.sourceItemId ?? "") !== String(incoming?.sourceItemId ?? "")) return false;
      if (String(badge?.targetItemId ?? targetItemId) !== String(targetItemId)) return false;
      if (String(badge?.category ?? "").toLowerCase() !== "weapon mastery") return false;
      const values = this.#normalizedMasteryBadgeValues(badge?.values ?? []);
      return this.#stableString(values) === this.#stableString(expected);
    });
  }

  static #normalizedMasteryBadgeValues(values) {
    return [...new Set((values ?? []).map(value => String(value ?? "").split(" — ")[0].trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, game.i18n.lang));
  }

  static #classIdentifierForItem(actor, item) {
    if (!item) return null;
    if (item.type === "class") return item.system?.identifier ?? null;
    if (item.type === "subclass") return item.system?.classIdentifier ?? item.system?.class?.identifier ?? item.system?.class ?? null;
    const origin = String(item.getFlag?.("dnd5e", "advancementRoot") ?? item.getFlag?.("dnd5e", "advancementOrigin") ?? "");
    const root = actor?.items?.get?.(origin.split(".")[0]);
    if (root && root.id !== item.id) return this.#classIdentifierForItem(actor, root);
    return null;
  }

  static #classLevelForItem(actor, item) {
    const identifier = this.#classIdentifierForItem(actor, item);
    if (!identifier) return null;
    return Number(actor?.items?.find?.(candidate => candidate.type === "class" && candidate.system?.identifier === identifier)?.system?.levels ?? 0);
  }

  static #actorLevel(actor) {
    return (actor?.items ?? []).filter(item => item.type === "class")
      .reduce((sum, item) => sum + Number(item.system?.levels ?? 0), 0);
  }

  static #bracketLabel(category, values) {
    const rows = [...new Set(values ?? [])].filter(Boolean);
    if (!rows.length) return category;
    const visible = rows.slice(0, 3);
    const remainder = rows.length - visible.length;
    return `${category} [${visible.join(", ")}${remainder > 0 ? ` +${remainder}` : ""}]`;
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
