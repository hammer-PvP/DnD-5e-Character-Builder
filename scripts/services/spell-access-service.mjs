import { MODULE_ID, SPELL_ACCESS_MODELS } from "../constants.mjs";
import { DraftManager } from "./draft-manager.mjs";

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
    const cantripCount = this.#scaleValue(cls, classLevel, { title: "cantrips known" });
    const maxPrepared = this.#scaleValue(cls, classLevel, { identifier: "max-prepared" });
    const spellCount = model === "spellbook" ? (classLevel === 1 ? 6 : 2)
      : model === "limited" ? maxPrepared : 0;

    const cantrips = pool.filter(option => Number(option.system?.level ?? -1) === 0);
    const leveled = pool.filter(option => {
      const level = Number(option.system?.level ?? -1);
      return level >= 1 && level <= maximumSpellLevel;
    });

    const selectedCantrips = new Set(saved.classIdentifier === identifier ? saved.cantrips ?? [] : []);
    const selectedSpells = new Set(saved.classIdentifier === identifier ? saved.spells ?? [] : []);
    const decorate = (option, selected) => ({
      ...option,
      selected: selected.has(option.identifier),
      level: Number(option.system?.level ?? 0)
    });

    const cantripOptions = cantrips.map(option => decorate(option, selectedCantrips));
    const spellOptions = leveled.map(option => decorate(option, selectedSpells));
    const automaticSpells = model === "fullList" ? spellOptions : [];

    return {
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
      spellCount,
      selectedCantripCount: selectedCantrips.size,
      selectedSpellCount: selectedSpells.size,
      needsCantripChoice: cantripCount > 0,
      needsSpellChoice: ["limited", "spellbook"].includes(model) && spellCount > 0,
      cantripGroups: registry.groupOptions(cantripOptions),
      spellGroups: registry.groupOptions(spellOptions),
      automaticSpellGroups: registry.groupOptions(automaticSpells),
      automaticSpellCount: automaticSpells.length,
      saved: Boolean(state.spellAccessSaved && saved.classIdentifier === identifier),
      noSpellcasting: false,
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
    const selectedSpells = [...new Set(formData.getAll("spellAccess.spells").map(String))];

    const validCantrips = new Map(context.cantripGroups.flatMap(group => group.items).map(option => [option.identifier, option]));
    const validSpells = new Map(context.spellGroups.flatMap(group => group.items).map(option => [option.identifier, option]));

    this.#validateSelections(selectedCantrips, context.cantripCount, validCantrips, "cantrip");
    if (context.needsSpellChoice) {
      this.#validateSelections(selectedSpells, context.spellCount, validSpells, "spell");
    }

    const documents = [];
    for (const selected of selectedCantrips) documents.push({
      option: validCantrips.get(selected),
      prepared: 1,
      category: "cantrip"
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

    // Native Advancements can grant a Class spell before the Builder populates
    // the class-list access Items (for example Hunter's Mark from Favored Enemy).
    // Preserve the native grant and do not create a second Builder-managed copy.
    const nativeGrantedIdentifiers = new Set(draft.items
      .filter(item => item.type === "spell" && !item.getFlag(MODULE_ID, "classSpellAccess"))
      .map(item => item.system?.identifier)
      .filter(Boolean));

    const createData = [];
    for (const entry of documents) {
      if (nativeGrantedIdentifiers.has(entry.option.identifier)) continue;
      const document = await fromUuid(entry.option.uuid);
      if (!document) throw new Error(`Unable to load spell: ${entry.option.name}`);
      const data = document.toObject();
      delete data._id;
      data.system ??= {};
      data.system.ability = cls.system.spellcasting?.ability ?? "";
      data.system.method = progression === "pact" ? "pact" : "spell";
      data.system.prepared = entry.prepared;
      data.system.sourceItem = `class:${identifier}`;
      data.flags ??= {};
      data.flags.dnd5e ??= {};
      data.flags.dnd5e.sourceId = document.uuid;
      data.flags[MODULE_ID] = {
        classSpellAccess: true,
        classIdentifier: identifier,
        classItemId: cls.id,
        accessModel: model,
        category: entry.category,
        sourceLabel: entry.option.sourceLabel
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
    await DraftManager.setBuildState(draft, {
      spellAccess: {
        classIdentifier: identifier,
        cantrips: selectedCantrips,
        spells: model === "fullList" ? [...validSpells.keys()] : selectedSpells
      },
      spellAccessSaved: true
    });

    return { created: createData.length };
  }

  static async invalidate(draft) {
    const ids = draft.items.filter(item => item.getFlag(MODULE_ID, "classSpellAccess")).map(item => item.id);
    if (ids.length) await draft.deleteEmbeddedDocuments("Item", ids);
    await DraftManager.setBuildState(draft, {
      spellAccess: {},
      spellAccessSaved: false,
      equipmentSaved: false
    });
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
    const invalid = selected.find(identifier => !validOptions.has(identifier));
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
