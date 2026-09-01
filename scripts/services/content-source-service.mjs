import { MODULE_ID, SOURCE_DEFINITIONS, defaultSettings } from "../constants.mjs";

const RELEVANT_ITEM_TYPES = new Set([
  "background", "class", "subclass", "race", "feat", "spell",
  "weapon", "equipment", "consumable", "tool", "container", "loot"
]);

const DISCOVERY_FIELDS = [
  "name", "type", "system.identifier", "system.classIdentifier", "system.level",
  "system.source.rules", "system.source.book"
];

/**
 * Discovers Item compendiums from active systems/modules/world packs and turns
 * them into package-level Character Builder sources. Built-in PHB/SRD sources
 * remain logically separated so SRD 5.1 and SRD 5.2 can be controlled independently.
 */
export class ContentSourceService {
  static #cache = null;
  static #signature = "";

  static async availableSources({ force = false } = {}) {
    const signature = this.#packSignature();
    if (!force && this.#cache && signature === this.#signature) {
      return foundry.utils.deepClone(this.#cache);
    }

    const builtIns = Object.values(SOURCE_DEFINITIONS).map(source => ({
      ...foundry.utils.deepClone(source),
      builtIn: true,
      installed: source.packageId === "dnd5e" || Boolean(game.modules.get(source.packageId)?.active),
      packCollections: [],
      typeCounts: {},
      itemCount: 0
    }));
    const builtInById = new Map(builtIns.map(source => [source.id, source]));
    const dynamic = new Map();

    for (const pack of game.packs) {
      if (pack.documentName !== "Item") continue;

      let index;
      try {
        index = await pack.getIndex({ fields: DISCOVERY_FIELDS });
      } catch (error) {
        console.warn(`${MODULE_ID} | Unable to inspect content source ${pack.collection}.`, error);
        continue;
      }

      const typeCounts = {};
      for (const entry of index) {
        if (!RELEVANT_ITEM_TYPES.has(entry.type)) continue;
        typeCounts[entry.type] = Number(typeCounts[entry.type] ?? 0) + 1;
      }
      const itemCount = Object.values(typeCounts).reduce((sum, count) => sum + Number(count), 0);
      if (!itemCount) continue;

      const builtIn = this.#matchingBuiltIn(pack, builtIns);
      if (builtIn) {
        builtIn.packCollections.push(pack.collection);
        builtIn.itemCount += itemCount;
        this.#mergeCounts(builtIn.typeCounts, typeCounts);
        continue;
      }

      const descriptor = this.#packageDescriptor(pack);
      const id = descriptor.id;
      const row = dynamic.get(id) ?? {
        id,
        label: descriptor.label,
        packageId: descriptor.packageId,
        packageType: descriptor.packageType,
        sourceBook: null,
        builtIn: false,
        defaultEnabled: false,
        defaultPriority: 999,
        installed: true,
        packCollections: [],
        typeCounts: {},
        itemCount: 0
      };
      row.packCollections.push(pack.collection);
      row.itemCount += itemCount;
      this.#mergeCounts(row.typeCounts, typeCounts);
      dynamic.set(id, row);
    }

    for (const source of builtInById.values()) {
      source.packCollections = [...new Set(source.packCollections)].sort();
      if (source.packageId === "dnd5e") source.installed = source.packCollections.length > 0;
    }

    const results = [
      ...builtIns,
      ...[...dynamic.values()].sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang))
    ].map(source => ({
      ...source,
      packCollections: [...new Set(source.packCollections)].sort(),
      contentSummary: this.#contentSummary(source.typeCounts),
      sourceKey: source.id
    }));

    this.#cache = foundry.utils.deepClone(results);
    this.#signature = signature;
    return results;
  }

  static async synchronizedRows(storedRows = null, { force = false } = {}) {
    const discovered = await this.availableSources({ force });
    const current = Array.from(storedRows ?? []);
    const currentById = new Map(current.map(row => [row.id, row]));
    const discoveredById = new Map(discovered.map(source => [source.id, source]));
    const rows = [];

    for (const row of [...current].sort((a, b) => Number(a.priority) - Number(b.priority))) {
      const source = discoveredById.get(row.id);
      const fallback = SOURCE_DEFINITIONS[row.id] ?? row;
      const resolved = source ?? {
        ...fallback,
        installed: false,
        packCollections: Array.from(row.packCollections ?? [])
      };
      rows.push(this.#configuredRow(resolved, row, rows.length));
      discoveredById.delete(row.id);
    }

    for (const source of discovered) {
      if (currentById.has(source.id)) continue;
      rows.push(this.#configuredRow(source, {
        enabled: Boolean(source.defaultEnabled),
        priority: rows.length
      }, rows.length));
    }

    return rows.map((row, priority) => ({ ...row, priority }));
  }

  static async synchronizeWorldSettings({ force = false, persist = true } = {}) {
    const stored = game.settings.get(MODULE_ID, "settings") ?? {};
    const merged = foundry.utils.mergeObject(defaultSettings(), stored, { inplace: false });
    const sources = await this.synchronizedRows(merged.sources, { force });
    const oldSignature = JSON.stringify(Array.from(merged.sources ?? []).map(this.#stableRow));
    const newSignature = JSON.stringify(sources.map(this.#stableRow));
    if (persist && game.user.isGM && oldSignature !== newSignature) {
      await game.settings.set(MODULE_ID, "settings", { ...merged, sources });
    }
    return sources;
  }

  static sourceFromConfiguredRow(row) {
    const fallback = SOURCE_DEFINITIONS[row?.id] ?? {};
    const source = { ...fallback, ...row };
    return {
      id: source.id,
      label: source.label ?? source.id,
      packageId: source.packageId ?? null,
      packageType: source.packageType ?? (source.packageId === "dnd5e" ? "system" : "module"),
      sourceBook: source.sourceBook ?? null,
      packCollections: Array.from(source.packCollections ?? []),
      builtIn: Boolean(source.builtIn ?? SOURCE_DEFINITIONS[source.id]),
      installed: source.installed !== false
    };
  }

  static #configuredRow(source, stored, fallbackPriority) {
    return {
      id: source.id,
      label: source.label ?? source.id,
      packageId: source.packageId ?? null,
      packageType: source.packageType ?? (source.packageId === "dnd5e" ? "system" : "module"),
      sourceBook: source.sourceBook ?? null,
      packCollections: Array.from(source.packCollections ?? stored.packCollections ?? []),
      builtIn: Boolean(source.builtIn ?? SOURCE_DEFINITIONS[source.id]),
      installed: source.installed !== false,
      contentSummary: source.contentSummary ?? stored.contentSummary ?? "Compatible Item content",
      typeCounts: foundry.utils.deepClone(source.typeCounts ?? stored.typeCounts ?? {}),
      itemCount: Number(source.itemCount ?? stored.itemCount ?? 0),
      enabled: Boolean(stored.enabled),
      priority: Number.isFinite(Number(stored.priority)) ? Number(stored.priority) : fallbackPriority
    };
  }

  static #matchingBuiltIn(pack, builtIns) {
    const packageId = pack.metadata.packageName ?? pack.metadata.package ?? pack.collection.split(".")[0];
    const sourceBook = foundry.utils.getProperty(pack.metadata, "flags.dnd5e.sourceBook") ?? null;
    return builtIns.find(source => {
      if (source.packageId !== packageId) return false;
      if (!source.sourceBook) return true;
      return source.sourceBook === sourceBook;
    }) ?? null;
  }

  static #packageDescriptor(pack) {
    const packageType = pack.metadata.packageType ?? "module";
    const packageId = pack.metadata.packageName ?? pack.metadata.package ?? pack.collection.split(".")[0];
    if (packageType === "world") {
      return {
        id: `world:${game.world?.id ?? packageId}`,
        label: game.world?.title ? `${game.world.title} — World Compendiums` : "World Compendiums",
        packageId,
        packageType
      };
    }
    if (packageType === "system") {
      return {
        id: `system:${packageId}`,
        label: game.system?.title ?? pack.metadata.packageTitle ?? packageId,
        packageId,
        packageType
      };
    }
    const module = game.modules.get(packageId);
    return {
      id: `module:${packageId}`,
      label: module?.title ?? pack.metadata.packageTitle ?? packageId,
      packageId,
      packageType: "module"
    };
  }

  static #packSignature() {
    return [...game.packs]
      .filter(pack => pack.documentName === "Item")
      .map(pack => `${pack.collection}:${pack.metadata.packageName ?? pack.metadata.package ?? ""}:${pack.metadata.packageType ?? ""}`)
      .sort()
      .join("|");
  }

  static #mergeCounts(target, additions) {
    for (const [type, count] of Object.entries(additions ?? {})) {
      target[type] = Number(target[type] ?? 0) + Number(count ?? 0);
    }
  }

  static #contentSummary(counts = {}) {
    const labels = {
      class: "Classes", subclass: "Subclasses", feat: "Features/Feats", spell: "Spells",
      background: "Backgrounds", race: "Species", weapon: "Weapons", equipment: "Equipment",
      consumable: "Consumables", tool: "Tools", container: "Containers", loot: "Loot"
    };
    const preferredOrder = [
      "class", "subclass", "feat", "spell", "background", "race",
      "weapon", "equipment", "consumable", "tool", "container", "loot"
    ];
    const parts = preferredOrder
      .filter(type => Number(counts[type] ?? 0) > 0)
      .map(type => `${labels[type]} ${Number(counts[type])}`);
    return parts.length ? parts.join(" · ") : "Compatible Item content";
  }

  static #stableRow(row) {
    return {
      id: row.id,
      label: row.label,
      packageId: row.packageId,
      packageType: row.packageType,
      sourceBook: row.sourceBook,
      packCollections: Array.from(row.packCollections ?? []).sort(),
      enabled: Boolean(row.enabled),
      priority: Number(row.priority ?? 0)
    };
  }
}
