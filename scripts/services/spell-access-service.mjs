import { MODULE_ID, SPELL_ACCESS_MODELS } from "../constants.mjs";
import { DraftManager } from "./draft-manager.mjs";
import { PactOfTheTomeService } from "./pact-of-the-tome-service.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";

/**
 * Populates native Spell Items during creation. Preparation, slots, casting,
 * and rest behavior remain entirely under the D&D5e Actor sheet.
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
    const totalCantripCount = this.#scaleValue(cls, classLevel, { title: "cantrips known" });
    const magicianFeature = identifier === "druid" ? this.#magicianFeature(draft) : null;
    const magicianCantripCount = magicianFeature ? 1 : 0;
    const cantripCount = Math.max(0, totalCantripCount - magicianCantripCount);
    const maxPrepared = this.#scaleValue(cls, classLevel, { identifier: "max-prepared" });
    const spellCount = model === "spellbook" ? (classLevel === 1 ? 6 : 2)
      : model === "limited" ? maxPrepared : 0;

    const cantrips = pool.filter(option => Number(option.system?.level ?? -1) === 0);
    const leveled = pool.filter(option => {
      const level = Number(option.system?.level ?? -1);
      return level >= 1 && level <= maximumSpellLevel;
    });

    const selectedCantrips = new Set(saved.classIdentifier === identifier ? saved.cantrips ?? [] : []);
    const selectedMagicianCantrips = new Set(saved.classIdentifier === identifier ? saved.magicianCantrip ?? [] : []);
    const selectedSpells = new Set(saved.classIdentifier === identifier ? saved.spells ?? [] : []);
    const decorate = (option, selected) => ({
      ...option,
      selected: selected.has(option.identifier),
      level: Number(option.system?.level ?? 0)
    });

    const cantripOptions = cantrips.map(option => decorate(option, selectedCantrips));
    const magicianCantripOptions = cantrips.map(option => decorate(option, selectedMagicianCantrips));
    const spellOptions = leveled.map(option => decorate(option, selectedSpells));
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
      magicianCantripCount,
      magicianFeatureItemId: magicianFeature?.id ?? null,
      spellCount,
      selectedCantripCount: selectedCantrips.size,
      selectedMagicianCantripCount: selectedMagicianCantrips.size,
      selectedSpellCount: selectedSpells.size,
      needsCantripChoice: cantripCount > 0,
      needsMagicianCantripChoice: magicianCantripCount > 0,
      needsSpellChoice: ["limited", "spellbook"].includes(model) && spellCount > 0,
      cantripGroups: registry.groupOptions(cantripOptions),
      magicianCantripGroups: registry.groupOptions(magicianCantripOptions),
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
    const selectedMagicianCantrips = [...new Set(formData.getAll("spellAccess.magicianCantrip").map(String))];
    const selectedSpells = [...new Set(formData.getAll("spellAccess.spells").map(String))];
    const selectedTomeCantrips = [...new Set(formData.getAll("spellAccess.pactOfTheTome.cantrips").map(String))];
    const selectedTomeRituals = [...new Set(formData.getAll("spellAccess.pactOfTheTome.rituals").map(String))];

    const validCantrips = new Map(context.cantripGroups.flatMap(group => group.items).map(option => [option.identifier, option]));
    const validMagicianCantrips = new Map((context.magicianCantripGroups ?? []).flatMap(group => group.items).map(option => [option.identifier, option]));
    const validSpells = new Map(context.spellGroups.flatMap(group => group.items).map(option => [option.identifier, option]));

    this.#validateSelections(selectedCantrips, context.cantripCount, validCantrips, "cantrip");
    this.#validateSelections(selectedMagicianCantrips, context.magicianCantripCount ?? 0, validMagicianCantrips, "Primal Order: Magician cantrip");
    if (context.needsSpellChoice) {
      this.#validateSelections(selectedSpells, context.spellCount, validSpells, "spell");
    }

    const documents = [];
    for (const selected of selectedCantrips) documents.push({
      option: validCantrips.get(selected),
      prepared: SpellPreparationPolicyService.ALWAYS_PREPARED,
      category: "cantrip"
    });
    for (const selected of selectedMagicianCantrips) documents.push({
      option: validMagicianCantrips.get(selected),
      prepared: SpellPreparationPolicyService.ALWAYS_PREPARED,
      category: "primal-order-magician",
      featureItemId: context.magicianFeatureItemId,
      featureLabel: "Primal Order: Magician"
    });

    if (model === "fullList") {
      for (const option of validSpells.values()) documents.push({ option, prepared: 0, category: "full-list" });
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
        pendingPreparedIdentifiers: [...selectedCantrips, ...selectedSpells],
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
        magicianCantrip: selectedMagicianCantrips,
        spells: model === "fullList" ? [...validSpells.keys()] : selectedSpells,
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

  static #magicianFeature(draft) {
    return draft.items.find(item => item.type === "feat" && (
      String(item.system?.identifier ?? "").toLowerCase() === "magician"
      || String(item.name ?? "").trim().toLowerCase() === "magician"
      || String(item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? "").endsWith(".Item.phbPrimalOrderMa")
    )) ?? null;
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
      return title && String(entry.title ?? "").toLowerCase().includes(title);
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
      return `${className} receives every currently accessible leveled spell on the Actor. The native D&D5e sheet manages preparation.`;
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
      spellCount: 0,
      selectedCantripCount: 0,
      selectedSpellCount: 0,
      needsCantripChoice: false,
      needsSpellChoice: false,
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
