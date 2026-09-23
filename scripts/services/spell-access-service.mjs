import { MODULE_ID, SPELL_ACCESS_MODELS } from "../constants.mjs";
import { DraftManager } from "./draft-manager.mjs";
import { PactOfTheTomeService } from "./pact-of-the-tome-service.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";
import { AdditionalCantripEntitlementService } from "./additional-cantrip-entitlement-service.mjs";
import { advancementName } from "../utils/advancement-utils.mjs";

/**
 * Populates native Spell Items during creation. Spell Items, slots, and casting
 * remain native D&D5e data; Character Builder only governs class-authorized
 * preparation choices and their timing.
 */
export class SpellAccessService {
  static async buildContext(draft, registry) {
    const cls = draft.items.find(item => item.type === "class") ?? null;
    if (!cls) return this.#emptyContext("Select a Class before configuring spell access.");

    const identifier = cls.system.identifier;
    const progression = cls.system.spellcasting?.progression ?? "none";
    const model = this.#modelFor(cls);
    const state = DraftManager.getBuildState(draft);
    const saved = state.spellAccess ?? {};

    if (progression === "none" || model === "none") {
      return {
        ...this.#emptyContext(`${cls.name} has no level 1 class spell access to configure.`),
        className: cls.name,
        classIdentifier: identifier,
        model,
        saved: Boolean(state.spellAccessSaved),
        noSpellcasting: true
      };
    }

    const pool = await this.#classSpellPool(identifier, registry);
    const classLevel = Number(cls.system.levels ?? 1);
    const maximumSpellLevel = this.#maximumSpellLevel(progression, classLevel);
    // ScaleValue is the base class entitlement. Selected features that add to
    // the derived cantrips-known scale are projected separately and never
    // subtracted from the raw class progression.
    const cantripCount = this.#scaleValue(cls, classLevel, { title: "cantrips known" });
    const additionalCantripGrants = AdditionalCantripEntitlementService.grants(draft, cls);
    const maxPrepared = this.#scaleValue(cls, classLevel, { identifier: "max-prepared" });
    const initialPreparedCount = model === "fullList" && identifier === "ranger" ? maxPrepared : 0;
    const spellCount = model === "spellbook" ? (classLevel === 1 ? 6 : 2)
      : model === "limited" ? maxPrepared : 0;

    const cantrips = pool.filter(option => Number(option.system?.level ?? -1) === 0);
    const leveled = pool.filter(option => {
      const level = Number(option.system?.level ?? -1);
      return level >= 1 && level <= maximumSpellLevel;
    });

    const selectedCantrips = new Set(saved.classIdentifier === identifier ? saved.cantrips ?? [] : []);
    const savedAdditionalCantrips = saved.classIdentifier === identifier ? (saved.additionalCantrips ?? {}) : {};
    const selectedSpells = new Set(saved.classIdentifier === identifier ? saved.spells ?? [] : []);
    const alwaysPreparedIdentifiers = identifier === "ranger" && model === "fullList"
      ? await this.#alwaysPreparedClassSpellIdentifiers(draft, cls)
      : new Set();
    const selectedPreparedSpells = new Set((saved.classIdentifier === identifier ? saved.preparedSpells ?? [] : [])
      .filter(spellIdentifier => !alwaysPreparedIdentifiers.has(String(spellIdentifier))));
    const decorate = (option, selected, { disabled = false, disabledReason = "" } = {}) => {
      const level = Number(option.system?.level ?? 0);
      return {
        ...option,
        selected: !disabled && selected.has(option.identifier),
        disabled: Boolean(disabled || option.disabled),
        disabledReason: disabledReason || option.disabledReason || "",
        level,
        levelLabel: level === 0 ? "Cantrip" : `Level ${level}`
      };
    };

    const cantripOptions = cantrips.map(option => decorate(option, selectedCantrips));
    const additionalCantripSections = additionalCantripGrants.map(grant => {
      const legacyMagician = grant.category === "primal-order-magician" ? (saved.magicianCantrip ?? []) : [];
      const selected = new Set(savedAdditionalCantrips[grant.key] ?? legacyMagician);
      const options = cantrips.map(option => decorate(option, selected));
      return {
        ...grant,
        title: grant.featureName,
        note: `Choose ${grant.count === 1 ? "one" : grant.count} additional ${cls.name} cantrip${grant.count === 1 ? "" : "s"} granted by ${grant.featureName}. This is stored as a separate feature-owned acquisition.`,
        selectedCount: selected.size,
        groups: registry.groupOptions(options),
        filterTarget: `#cb-additional-cantrip-options-${grant.key}`
      };
    });
    const spellSelectionState = initialPreparedCount > 0 ? selectedPreparedSpells : selectedSpells;
    const spellOptions = leveled.map(option => {
      const alwaysPrepared = initialPreparedCount > 0 && alwaysPreparedIdentifiers.has(String(option.identifier));
      return decorate(option, spellSelectionState, {
        disabled: alwaysPrepared,
        disabledReason: alwaysPrepared
          ? "Always Prepared by a Ranger class feature; this spell does not consume one of your ordinary prepared-spell choices."
          : ""
      });
    });
    const automaticSpells = model === "fullList" ? spellOptions : [];
    const pactOfTheTome = identifier === "warlock"
      ? await PactOfTheTomeService.buildContext(draft, registry, {
        mode: "acquisition",
        selectedCantrips: saved.pactOfTheTomeCantrips ?? [],
        selectedRituals: saved.pactOfTheTomeRituals ?? [],
        pendingPreparedIdentifiers: [
          ...(saved.cantrips ?? []),
          ...(saved.spells ?? [])
        ],
        transactionId: `creation:${draft.id}`,
        classItem: cls
      })
      : { active: false, complete: true, cantripGroups: [], ritualGroups: [] };

    return {
      classLevel,
      className: cls.name,
      classIdentifier: identifier,
      progression,
      model,
      modelLabel: {
        fullList: "Full Class List",
        limited: "Limited Class Selection",
        spellbook: "Spellbook"
      }[model] ?? model,
      maximumSpellLevel,
      cantripCount,
      additionalCantripCount: additionalCantripGrants.reduce((sum, grant) => sum + grant.count, 0),
      additionalCantripSections,
      spellCount,
      initialPreparedCount,
      selectedCantripCount: selectedCantrips.size,
      selectedSpellCount: selectedSpells.size,
      selectedPreparedCount: selectedPreparedSpells.size,
      needsCantripChoice: cantripCount > 0,
      needsAdditionalCantripChoice: additionalCantripSections.length > 0,
      needsSpellChoice: ["limited", "spellbook"].includes(model) && spellCount > 0,
      needsPreparedChoice: initialPreparedCount > 0,
      cantripGroups: registry.groupOptions(cantripOptions),
      spellGroups: registry.groupOptions(spellOptions),
      automaticSpellGroups: registry.groupOptions(automaticSpells),
      automaticSpellCount: automaticSpells.length,
      saved: Boolean(state.spellAccessSaved && saved.classIdentifier === identifier),
      noSpellcasting: false,
      pactOfTheTome,
      note: this.#modelNote(model, cls.name, spellCount)
    };
  }

  static async save(draft, registry, formData) {
    const cls = draft.items.find(item => item.type === "class");
    if (!cls) throw new Error("Select a Class before saving spell access.");

    const identifier = cls.system.identifier;
    const progression = cls.system.spellcasting?.progression ?? "none";
    const model = this.#modelFor(cls);

    if (progression === "none" || model === "none") {
      const oldIds = draft.items
        .filter(item => item.getFlag(MODULE_ID, "classSpellAccess"))
        .map(item => item.id);
      if (oldIds.length) await draft.deleteEmbeddedDocuments("Item", oldIds);
      await DraftManager.setBuildState(draft, {
        spellAccess: { classIdentifier: identifier, cantrips: [], spells: [] },
        spellAccessSaved: true
      });
      return { created: 0 };
    }

    const context = await this.buildContext(draft, registry);
    const selectedCantrips = [...new Set(formData.getAll("spellAccess.cantrips").map(String))];
    const selectedAdditionalCantrips = this.#additionalCantripSelections(formData, context.additionalCantripSections ?? []);
    const selectedSpells = [...new Set(formData.getAll("spellAccess.spells").map(String))];
    const selectedPreparedSpells = [...new Set(formData.getAll("spellAccess.preparedSpells").map(String))];
    const selectedTomeCantrips = [...new Set(formData.getAll("spellAccess.pactOfTheTome.cantrips").map(String))];
    const selectedTomeRituals = [...new Set(formData.getAll("spellAccess.pactOfTheTome.rituals").map(String))];

    const validCantrips = new Map(context.cantripGroups.flatMap(group => group.items).map(option => [option.identifier, option]));
    const validSpells = new Map(context.spellGroups.flatMap(group => group.items).map(option => [option.identifier, option]));

    this.#validateSelections(selectedCantrips, context.cantripCount, validCantrips, "cantrip");
    for (const section of context.additionalCantripSections ?? []) {
      const valid = new Map((section.groups ?? []).flatMap(group => group.items).map(option => [option.identifier, option]));
      this.#validateSelections(selectedAdditionalCantrips[section.key] ?? [], section.count, valid, `${section.featureName} cantrip`);
    }
    if (context.needsSpellChoice) {
      this.#validateSelections(selectedSpells, context.spellCount, validSpells, "spell");
    }
    if (context.needsPreparedChoice) {
      this.#validateSelections(selectedPreparedSpells, context.initialPreparedCount, validSpells, "prepared spell");
    }

    const documents = [];
    for (const selected of selectedCantrips) documents.push({
      option: validCantrips.get(selected),
      prepared: SpellPreparationPolicyService.ALWAYS_PREPARED,
      category: "cantrip"
    });
    for (const section of context.additionalCantripSections ?? []) {
      const valid = new Map((section.groups ?? []).flatMap(group => group.items).map(option => [option.identifier, option]));
      for (const selected of selectedAdditionalCantrips[section.key] ?? []) documents.push({
        option: valid.get(selected),
        prepared: SpellPreparationPolicyService.ALWAYS_PREPARED,
        category: section.category,
        featureItemId: section.featureItemId,
        featureLabel: section.featureName
      });
    }

    if (model === "fullList") {
      const preparedIdentifiers = new Set(selectedPreparedSpells);
      for (const option of validSpells.values()) documents.push({
        option,
        prepared: preparedIdentifiers.has(option.identifier)
          ? SpellPreparationPolicyService.PREPARED
          : SpellPreparationPolicyService.UNPREPARED,
        category: "full-list"
      });
    } else {
      for (const selected of selectedSpells) documents.push({
        option: validSpells.get(selected),
        prepared: model === "limited" ? 1 : 0,
        category: model
      });
    }

    const createData = [];
    for (const entry of documents) {
      const document = await fromUuid(entry.option.uuid);
      if (!document) throw new Error(`Unable to load spell: ${entry.option.name}`);
      const data = document.toObject();
      delete data._id;
      data.system ??= {};
      data.system.ability = cls.system.spellcasting?.ability ?? "";
      data.system.method = progression === "pact" ? "pact" : "spell";
      SpellPreparationPolicyService.applyToData(data, {
        explicitPrepared: entry.prepared,
        category: entry.category,
        accessModel: model
      });
      data.system.sourceItem = `class:${identifier}`;
      data.flags ??= {};
      data.flags.dnd5e ??= {};
      data.flags.dnd5e.sourceId = document.uuid;
      const featureOwner = entry.featureItemId ? {
        category: entry.category,
        label: entry.featureLabel ?? entry.category,
        classIdentifier: identifier,
        classItemId: cls.id,
        subclassItemId: null,
        featureItemId: entry.featureItemId,
        ownerItemId: entry.featureItemId,
        transactionId: `creation:${draft.id}`,
        acquiredAtCharacterLevel: 1,
        acquiredAtClassLevel: context.classLevel,
        sourceUuid: document.uuid,
        spellLevel: Number(data.system.level ?? 0),
        alwaysPrepared: Number(data.system.prepared ?? 0) === SpellPreparationPolicyService.ALWAYS_PREPARED
      } : null;
      data.flags[MODULE_ID] = {
        classSpellAccess: true,
        classIdentifier: identifier,
        classItemId: cls.id,
        accessModel: model,
        category: entry.category,
        sourceLabel: entry.option.sourceLabel,
        ...(featureOwner ? {
          featureGrantedSpell: true,
          featureSpellOwners: [featureOwner]
        } : {})
      };
      createData.push(data);
    }

    // Preserve the previous valid spell state until every replacement document
    // has been resolved and prepared for creation.
    const oldIds = draft.items
      .filter(item => item.getFlag(MODULE_ID, "classSpellAccess"))
      .map(item => item.id);
    if (oldIds.length) await draft.deleteEmbeddedDocuments("Item", oldIds);
    if (createData.length) await draft.createEmbeddedDocuments("Item", createData);

    let tomeResult = { active: false, createdItemIds: [], deletedItemIds: [] };
    if (context.pactOfTheTome?.active) {
      const tomeContext = await PactOfTheTomeService.buildContext(draft, registry, {
        mode: "acquisition",
        selectedCantrips: selectedTomeCantrips,
        selectedRituals: selectedTomeRituals,
        pendingPreparedIdentifiers: [...selectedCantrips, ...selectedSpells, ...selectedPreparedSpells],
        transactionId: `creation:${draft.id}`,
        classItem: cls
      });
      if (!tomeContext.complete) {
        throw new Error("Complete the Pact of the Tome Book of Shadows selections before confirming Spell Selection.");
      }
      tomeResult = await PactOfTheTomeService.apply(draft, registry, {
        mode: "acquisition",
        selectedCantrips: selectedTomeCantrips,
        selectedRituals: selectedTomeRituals,
        transactionId: `creation:${draft.id}`,
        characterLevel: 1,
        classLevel: context.classLevel,
        classItem: cls
      });
    }

    // Validate acquisition records rather than globally unique spell identifiers.
    // A spell identifier may intentionally exist more than once when the same
    // spell is acquired through independent channels (for example, a normal
    // Druid cantrip and Primal Order: Magician).
    const acquisitionKey = data => {
      const flags = data?.flags?.[MODULE_ID] ?? {};
      const owner = Array.isArray(flags.featureSpellOwners) ? flags.featureSpellOwners[0] ?? {} : {};
      return [
        String(data?.system?.identifier ?? ""),
        String(flags.classItemId ?? ""),
        String(flags.category ?? ""),
        String(flags.accessModel ?? ""),
        String(owner.category ?? ""),
        String(owner.featureItemId ?? owner.ownerItemId ?? "")
      ].join("::");
    };
    const countByKey = rows => rows.reduce((counts, row) => {
      const key = acquisitionKey(row);
      if (!key.startsWith("::")) counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts;
    }, new Map());
    const expectedAcquisitions = countByKey(createData);
    const actualAcquisitions = countByKey(draft.items
      .filter(item => item.type === "spell"
        && item.getFlag(MODULE_ID, "classSpellAccess")
        && item.getFlag(MODULE_ID, "classItemId") === cls.id)
      .map(item => item.toObject()));
    const missingAcquisitions = [];
    for (const [key, expected] of expectedAcquisitions) {
      const actual = actualAcquisitions.get(key) ?? 0;
      if (actual < expected) missingAcquisitions.push({ key, missing: expected - actual });
    }
    if (missingAcquisitions.length) {
      const details = missingAcquisitions.map(({ key, missing }) => {
        const [spell, , category, , ownerCategory] = key.split("::");
        return `${spell} (${ownerCategory || category || "class"}) ×${missing}`;
      }).join(", ");
      throw new Error(`Character Creation did not create the exact Class-owned spell acquisition(s): ${details}.`);
    }
    await DraftManager.setBuildState(draft, {
      spellAccess: {
        classIdentifier: identifier,
        cantrips: selectedCantrips,
        additionalCantrips: selectedAdditionalCantrips,
        spells: model === "fullList" ? [...validSpells.keys()] : selectedSpells,
        preparedSpells: model === "fullList" ? selectedPreparedSpells : [],
        pactOfTheTomeCantrips: selectedTomeCantrips,
        pactOfTheTomeRituals: selectedTomeRituals
      },
      spellAccessSaved: true
    });

    return { created: createData.length + (tomeResult.createdItemIds?.length ?? 0) };
  }

  static async invalidate(draft) {
    const tome = PactOfTheTomeService.findInvocation(draft);
    if (tome) await PactOfTheTomeService.cleanup(draft, tome.id);
    const ids = draft.items.filter(item => item.getFlag(MODULE_ID, "classSpellAccess")).map(item => item.id);
    if (ids.length) await draft.deleteEmbeddedDocuments("Item", ids);
    await DraftManager.setBuildState(draft, {
      spellAccess: {},
      spellAccessSaved: false,
      equipmentSaved: false
    });
  }

  static #additionalCantripSelections(formData, sections) {
    const selected = {};
    for (const section of sections ?? []) {
      selected[section.key] = [...new Set(formData.getAll(section.fieldName).map(String))];
    }
    return selected;
  }

  static async #alwaysPreparedClassSpellIdentifiers(draft, cls) {
    const classIdentifier = String(cls?.system?.identifier ?? "").trim().toLowerCase();
    if (!classIdentifier) return new Set();
    const identifiers = new Set();

    // Native D&D5e ItemGrant materialization normally creates these spells as
    // the class features are applied. Prefer the live draft state because it
    // already reflects source priority and any native preparation metadata.
    for (const spell of draft.items.filter(item => item?.type === "spell" && Number(item.system?.level ?? 0) > 0)) {
      if (Number(spell.system?.prepared ?? 0) !== SpellPreparationPolicyService.ALWAYS_PREPARED) continue;
      if (this.#classIdentifierForItem(spell, draft) !== classIdentifier) continue;
      const identifier = String(spell.system?.identifier ?? "").trim();
      if (identifier) identifiers.add(identifier);
    }

    // The feature Item can exist before its nested spell grant is materialized.
    // Read its native ItemGrant configuration as a second, source-driven guard
    // so an Always Prepared spell can never consume a Ranger ordinary slot.
    for (const owner of draft.items) {
      if (owner?.type === "spell" || this.#classIdentifierForItem(owner, draft) !== classIdentifier) continue;
      for (const advancement of this.#advancementData(owner)) {
        if (advancement?.type !== "ItemGrant") continue;
        if (Number(advancement.configuration?.spell?.prepared ?? 0) !== SpellPreparationPolicyService.ALWAYS_PREPARED) continue;
        for (const entry of advancement.configuration?.items ?? []) {
          const uuid = typeof entry === "string" ? entry : entry?.uuid;
          if (!uuid) continue;
          const document = await fromUuid(uuid);
          const identifier = String(document?.system?.identifier ?? "").trim();
          if (document?.type === "spell" && identifier) identifiers.add(identifier);
        }
      }
    }
    return identifiers;
  }

  static #classIdentifierForItem(item, draft, seen = new Set()) {
    if (!item || seen.has(item.id)) return null;
    if (item.id) seen.add(item.id);
    if (item.type === "class") return String(item.system?.identifier ?? "").trim().toLowerCase() || null;
    if (item.type === "subclass") {
      const parent = item.system?.classIdentifier ?? item.system?.class?.identifier ?? item.system?.class;
      return String(parent ?? "").trim().toLowerCase() || null;
    }

    const flags = item.flags?.[MODULE_ID] ?? {};
    const explicit = flags.classIdentifier ?? flags.levelUpSpell?.classIdentifier;
    if (explicit) return String(explicit).trim().toLowerCase();
    const ownerClass = (flags.featureSpellOwners ?? []).find(owner => owner?.classIdentifier)?.classIdentifier;
    if (ownerClass) return String(ownerClass).trim().toLowerCase();

    const sourceItem = String(item.system?.sourceItem ?? "").trim();
    const classMatch = /^class:([^:]+)$/i.exec(sourceItem);
    if (classMatch?.[1]) return classMatch[1].trim().toLowerCase();

    const references = [
      sourceItem,
      item.getFlag?.("dnd5e", "advancementRoot"),
      item.getFlag?.("dnd5e", "advancementOrigin")
    ].filter(Boolean);
    for (const reference of references) {
      const owner = this.#ownerItemFromReference(reference, draft);
      if (!owner || owner.id === item.id) continue;
      const inherited = this.#classIdentifierForItem(owner, draft, seen);
      if (inherited) return inherited;
    }
    return null;
  }

  static #ownerItemFromReference(reference, draft) {
    const raw = String(reference ?? "").trim();
    if (!raw || !draft?.items) return null;
    if (draft.items.get(raw)) return draft.items.get(raw);
    const tokens = raw.split(".").filter(Boolean);
    const itemMarker = tokens.lastIndexOf("Item");
    if (itemMarker >= 0 && tokens[itemMarker + 1] && draft.items.get(tokens[itemMarker + 1])) {
      return draft.items.get(tokens[itemMarker + 1]);
    }
    for (let index = tokens.length - 1; index >= 0; index--) {
      const candidate = draft.items.get(tokens[index]);
      if (candidate) return candidate;
    }
    return null;
  }

  static #modelFor(cls) {
    const identifier = cls.system.identifier;
    if (SPELL_ACCESS_MODELS.fullList.has(identifier)) return "fullList";
    if (SPELL_ACCESS_MODELS.limited.has(identifier)) return "limited";
    if (SPELL_ACCESS_MODELS.spellbook.has(identifier)) return "spellbook";
    return cls.system.spellcasting?.progression === "none" ? "none" : "limited";
  }

  static async #classSpellPool(identifier, registry) {
    const spellLists = globalThis.dnd5e?.registry?.spellLists;
    if (!spellLists) throw new Error("The D&D5e spell-list registry is unavailable.");

    // Registration normally finishes before the Builder opens, but allow a brief grace period.
    for (let attempt = 0; attempt < 20 && !spellLists.ready; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const list = spellLists.forType("class", identifier);
    if (!list) throw new Error(`No registered class spell list was found for ${identifier}.`);

    const options = new Map();
    for (const index of list.indexes) {
      const spellIdentifier = index.system?.identifier;
      if (!spellIdentifier) continue;
      const preferred = registry.preferredOption("spell", spellIdentifier);
      if (!preferred) continue;
      options.set(spellIdentifier, preferred);
    }
    return [...options.values()].sort((a, b) => {
      const levelDifference = Number(a.system?.level ?? 0) - Number(b.system?.level ?? 0);
      return levelDifference || a.name.localeCompare(b.name, game.i18n.lang);
    });
  }

  static #scaleValue(cls, level, { identifier = null, title = null } = {}) {
    const advancements = this.#advancementData(cls);
    const advancement = advancements.find(entry => {
      if (entry.type !== "ScaleValue") return false;
      if (identifier && entry.configuration?.identifier === identifier) return true;
      return title && advancementName(entry).toLowerCase().includes(title);
    });
    if (!advancement) return 0;

    const rows = Object.entries(advancement.configuration?.scale ?? {})
      .map(([minimumLevel, value]) => [Number(minimumLevel), Number(value?.value ?? 0)])
      .filter(([minimumLevel]) => minimumLevel <= level)
      .sort((a, b) => a[0] - b[0]);
    return rows.at(-1)?.[1] ?? 0;
  }

  static #advancementData(item) {
    const collection = item.advancement;
    if (collection?.contents) {
      return collection.contents.map(entry => entry.toObject ? entry.toObject() : foundry.utils.deepClone(entry));
    }
    if (collection?.values) {
      return [...collection.values()].map(entry => entry.toObject ? entry.toObject() : foundry.utils.deepClone(entry));
    }
    const source = item.toObject?.().system?.advancement ?? item._source?.system?.advancement ?? item.system?.advancement ?? {};
    return Object.values(source).map(entry => entry.toObject ? entry.toObject() : foundry.utils.deepClone(entry));
  }

  static #maximumSpellLevel(progression, level) {
    switch (progression) {
      case "full": return Math.min(9, Math.ceil(level / 2));
      case "half": return Math.min(5, Math.max(1, Math.floor((level + 3) / 4)));
      case "third": return Math.min(4, Math.max(1, Math.floor((level + 2) / 3)));
      case "pact": return Math.min(5, Math.ceil(level / 2));
      default: return 0;
    }
  }

  static #validateSelections(selected, expected, validOptions, label) {
    if (selected.length !== expected) {
      throw new Error(`Choose exactly ${expected} ${label}${expected === 1 ? "" : "s"}.`);
    }
    const invalid = selected.find(identifier => {
      const option = validOptions.get(identifier);
      return !option || option.disabled;
    });
    if (invalid) throw new Error(`The selected ${label} is not available from the prioritized class list.`);
  }

  static #modelNote(model, className, spellCount) {
    if (model === "fullList") {
      if (String(className ?? "").trim().toLowerCase() === "ranger") {
        return `${className} receives the full currently accessible class spell list. Choose the initial prepared list now; later preparation changes follow the Ranger's class timing.`;
      }
      return `${className} receives every currently accessible leveled spell on the Actor. Character Builder manages rule-authorized preparation windows.`;
    }
    if (model === "spellbook") {
      return `Choose ${spellCount} starting spellbook spells. Unselected spells remain unavailable until learned later.`;
    }
    return `Choose the spells ${className} gains at this level. The native D&D5e sheet manages slots and casting.`;
  }

  static #emptyContext(message) {
    return {
      className: "",
      classIdentifier: "",
      model: "none",
      modelLabel: "No Spellcasting",
      maximumSpellLevel: 0,
      cantripCount: 0,
      additionalCantripCount: 0,
      additionalCantripSections: [],
      spellCount: 0,
      initialPreparedCount: 0,
      selectedCantripCount: 0,
      selectedSpellCount: 0,
      selectedPreparedCount: 0,
      needsCantripChoice: false,
      needsAdditionalCantripChoice: false,
      needsSpellChoice: false,
      needsPreparedChoice: false,
      cantripGroups: [],
      spellGroups: [],
      automaticSpellGroups: [],
      automaticSpellCount: 0,
      saved: false,
      noSpellcasting: true,
      note: message
    };
  }
}
