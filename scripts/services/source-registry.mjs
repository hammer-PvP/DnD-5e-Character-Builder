import { MODULE_ID, SOURCE_DEFINITIONS } from "../constants.mjs";

const TextEditorImplementation = foundry.applications.ux.TextEditor.implementation;

const INDEX_FIELDS = [
  "name", "img", "type",
  "system.identifier",
  "system.source.rules",
  "system.type.value",
  "system.type.subtype",
  "system.type.baseItem",
  "system.mastery",
  "system.classIdentifier",
  "system.level",
  "system.school",
  "system.prerequisites.level",
  "system.prerequisites.repeatable",
  "system.rarity",
  "system.magicalBonus",
  "system.armor.magicalBonus",
  "system.properties",
  "system.price.value",
  "system.price.denomination",
  "system.attunement",
  "system.uses.max",
  "system.uses.autoDestroy"
];

export class SourceRegistry {
  constructor() {
    this.groups = [];
    this.byUuid = new Map();
    this.byKey = new Map();
    this.sourceRanks = new Map();
    this.loaded = false;
    this.settingsSignature = "";
  }

  static get settings() {
    return game.settings.get(MODULE_ID, "settings") ?? {};
  }

  static orderedSources() {
    const rows = this.settings.sources ?? [];
    return rows
      .filter(row => row.enabled && SOURCE_DEFINITIONS[row.id])
      .sort((a, b) => Number(a.priority) - Number(b.priority))
      .map(row => SOURCE_DEFINITIONS[row.id]);
  }

  async load({ force = false } = {}) {
    const signature = SourceRegistry.orderedSources().map(source => source.id).join("|");
    if (this.loaded && !force && signature === this.settingsSignature) return this;

    this.groups = [];
    this.byUuid.clear();
    this.byKey.clear();
    this.sourceRanks.clear();
    const claimed = new Set();

    const sources = SourceRegistry.orderedSources();
    sources.forEach((source, rank) => this.sourceRanks.set(source.id, rank));

    for (const source of sources) {
      if (source.packageId !== "dnd5e" && !game.modules.get(source.packageId)?.active) continue;

      const packs = [...game.packs].filter(pack => this.#belongsToSource(pack, source));
      const items = [];

      for (const pack of packs) {
        let index;
        try {
          index = await pack.getIndex({ fields: INDEX_FIELDS });
        } catch (error) {
          console.warn(`${MODULE_ID} | Unable to index ${pack.collection}`, error);
          continue;
        }

        for (const entry of index) {
          const identifier = foundry.utils.getProperty(entry, "system.identifier") || this.#slug(entry.name);
          const dedupeKey = `${entry.type}:${identifier}`;
          const uuid = `Compendium.${pack.collection}.Item.${entry._id}`;
          const option = {
            id: entry._id,
            uuid,
            name: entry.name,
            img: entry.img || "icons/svg/item-bag.svg",
            type: entry.type,
            identifier,
            sourceId: source.id,
            sourceLabel: source.label,
            sourceRank: this.sourceRanks.get(source.id) ?? 999,
            search: String(entry.name ?? "").toLowerCase(),
            packCollection: pack.collection,
            system: entry.system ?? {}
          };

          this.byUuid.set(uuid, option);
          const candidates = this.byKey.get(dedupeKey) ?? [];
          candidates.push(option);
          candidates.sort((a, b) => a.sourceRank - b.sourceRank || a.name.localeCompare(b.name, game.i18n.lang));
          this.byKey.set(dedupeKey, candidates);

          if (claimed.has(dedupeKey)) continue;
          claimed.add(dedupeKey);
          items.push(option);
        }
      }

      items.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
      this.groups.push({ ...source, items });
    }

    this.loaded = true;
    this.settingsSignature = signature;
    return this;
  }


  isUuidAllowed(uuid) {
    if (!uuid) return true;
    if (String(uuid).startsWith("CharacterBuilder.")) return true;
    if (!String(uuid).startsWith("Compendium.")) return true;
    return this.byUuid.has(uuid);
  }

  enabledSourceIds() {
    return new Set(SourceRegistry.orderedSources().map(source => source.id));
  }

  originFeatOptions() {
    return this.optionsByType("feat")
      .flatMap(group => group.items)
      .filter(option => option.system?.type?.subtype === "origin");
  }

  optionsByType(type) {
    return this.groups
      .map(group => ({
        id: group.id,
        label: group.label,
        items: group.items.filter(item => item.type === type)
      }))
      .filter(group => group.items.length);
  }

  optionsForKey(type, identifier) {
    return [...(this.byKey.get(`${type}:${identifier}`) ?? [])];
  }

  preferredOption(type, identifier, allowedUuids = null) {
    let candidates = this.optionsForKey(type, identifier);
    if (allowedUuids?.size) candidates = candidates.filter(candidate => allowedUuids.has(candidate.uuid));
    return candidates[0] ?? null;
  }

  sourceForUuid(uuid) {
    return this.byUuid.get(uuid) ?? null;
  }

  sourceRankForUuid(uuid) {
    return this.byUuid.get(uuid)?.sourceRank ?? 999;
  }

  groupOptions(options) {
    const grouped = new Map();
    for (const option of options) {
      const row = grouped.get(option.sourceId) ?? {
        id: option.sourceId,
        label: option.sourceLabel,
        rank: option.sourceRank,
        items: []
      };
      row.items.push(option);
      grouped.set(option.sourceId, row);
    }
    return [...grouped.values()]
      .sort((a, b) => a.rank - b.rank)
      .map(group => ({
        ...group,
        items: group.items.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
      }));
  }

  equipmentGroups() {
    const physicalTypes = new Set(["weapon", "equipment", "consumable", "tool", "container", "loot"]);
    return this.groups
      .map(group => ({
        id: group.id,
        label: group.label,
        items: group.items.filter(item => physicalTypes.has(item.type))
      }))
      .filter(group => group.items.length);
  }

  async document(uuid) {
    return fromUuid(uuid);
  }

  findOption(uuid) {
    return this.byUuid.get(uuid) ?? null;
  }

  async enrichDocument(uuid) {
    const document = await this.document(uuid);
    if (!document) return null;
    const description = await TextEditorImplementation.enrichHTML(document.system?.description?.value ?? "", {
      async: true,
      relativeTo: document,
      secrets: document.isOwner
    });
    const advancementCollection = document.advancement;
    let advancements = [];
    if (advancementCollection?.contents) advancements = advancementCollection.contents;
    else if (advancementCollection?.values) advancements = [...advancementCollection.values()];
    else advancements = Object.values(document.system?.advancement ?? {});

    return {
      document,
      uuid,
      name: document.name,
      img: document.img,
      type: document.type,
      description,
      sourceLabel: this.findOption(uuid)?.sourceLabel ?? document.pack ?? "World",
      advancements: advancements.map(advancement => ({
        id: advancement.id ?? advancement._id,
        type: advancement.constructor?.typeName ?? advancement.type,
        title: advancement.title || advancement._defaultTitle || advancement.constructor?.metadata?.title || advancement.type,
        hint: advancement.hint || "",
        level: advancement.level ?? advancement.levels?.[0] ?? 0
      }))
    };
  }

  equipmentCandidates(entry, actor) {
    return this.equipmentGroups().map(group => ({
      ...group,
      items: group.items.filter(item => this.#matchesEquipmentEntry(item, entry, actor))
    })).filter(group => group.items.length);
  }

  #belongsToSource(pack, source) {
    if (pack.documentName !== "Item") return false;
    const packageId = pack.metadata.packageName ?? pack.metadata.package ?? pack.collection.split(".")[0];
    if (packageId !== source.packageId) return false;
    if (!source.sourceBook) return true;
    return foundry.utils.getProperty(pack.metadata, "flags.dnd5e.sourceBook") === source.sourceBook;
  }

  #matchesEquipmentEntry(item, entry, actor) {
    const typeValue = foundry.utils.getProperty(item, "system.type.value") ?? "";
    const subtype = foundry.utils.getProperty(item, "system.type.subtype") ?? "";
    const rarity = foundry.utils.getProperty(item, "system.rarity") ?? "";
    const bonus = Number(foundry.utils.getProperty(item, "system.magicalBonus") ??
      foundry.utils.getProperty(item, "system.armor.magicalBonus") ?? 0);

    if (bonus || !["", "none", "common"].includes(String(rarity).toLowerCase())) return false;

    if (entry.requiresProficiency && actor) {
      if (entry.type === "weapon") {
        const category = String(typeValue).startsWith("simple") ? "sim" :
          String(typeValue).startsWith("martial") ? "mar" : null;
        if (category && !this.#contains(actor.system.traits.weaponProf.value, category)) return false;
      }
      if (entry.type === "armor") {
        const map = { light: "lgt", medium: "med", heavy: "hvy", shield: "shl" };
        const proficiency = map[typeValue];
        if (proficiency && !this.#contains(actor.system.traits.armorProf.value, proficiency)) return false;
      }
    }

    switch (entry.type) {
      case "weapon": {
        if (item.type !== "weapon") return false;
        if (!entry.key) return true;
        if (entry.key === "sim") return String(typeValue).startsWith("simple");
        if (entry.key === "mar") return String(typeValue).startsWith("martial");
        return typeValue === entry.key || item.identifier === entry.key ||
          foundry.utils.getProperty(item, "system.type.baseItem") === entry.key;
      }
      case "armor": {
        if (item.type !== "equipment") return false;
        const map = { lgt: "light", med: "medium", hvy: "heavy", shl: "shield" };
        const expected = map[entry.key] ?? entry.key;
        return !expected || typeValue === expected;
      }
      case "tool":
        return item.type === "tool" && (!entry.key || typeValue === entry.key || subtype === entry.key);
      case "focus": {
        const properties = foundry.utils.getProperty(item, "system.properties");
        const propertyList = properties?.has ? [...properties] : Array.from(properties ?? []);
        return ["equipment", "tool"].includes(item.type) &&
          (propertyList.includes("foc") || typeValue === "focus" || subtype === entry.key ||
            item.identifier?.includes(entry.key ?? "focus"));
      }
      default:
        return false;
    }
  }

  #contains(collection, value) {
    if (collection?.has) return collection.has(value);
    return Array.from(collection ?? []).includes(value);
  }

  #slug(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
