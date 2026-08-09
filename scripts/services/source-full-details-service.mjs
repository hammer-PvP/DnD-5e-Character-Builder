import { MODULE_ID } from "../constants.mjs";

/**
 * Resolves editorial JournalEntryPage content that belongs to the same source
 * package as an Item. Character Builder never copies the book content; it
 * discovers and renders the active source at runtime.
 */
export class SourceFullDetailsService {
  static #pageCache = new Map();

  static sourceUuid(item) {
    return item?.getFlag?.("dnd5e", "sourceId")
      ?? item?._stats?.compendiumSource
      ?? item?.getFlag?.(MODULE_ID, "sourceSnapshot")?.uuid
      ?? null;
  }

  static async resolve(item) {
    if (!item) return { document: null, sourceDocument: null, page: null, reason: "No source document was provided." };

    const sourceUuid = this.sourceUuid(item);
    let sourceDocument = null;
    if (sourceUuid) {
      try { sourceDocument = await fromUuid(sourceUuid); }
      catch (_error) { sourceDocument = null; }
    }
    sourceDocument ??= item;

    const packageId = this.#packageId(sourceUuid ?? sourceDocument?.uuid ?? item?.uuid);
    const identifier = String(sourceDocument?.system?.identifier ?? item?.system?.identifier ?? "").trim();
    const name = String(sourceDocument?.name ?? item?.name ?? "").trim();
    const cacheKey = `${packageId ?? ""}|${sourceUuid ?? ""}|${identifier}|${name}`;
    if (this.#pageCache.has(cacheKey)) {
      return { document: item, sourceDocument, page: this.#pageCache.get(cacheKey), sourceUuid, packageId };
    }

    const page = packageId
      ? await this.#findJournalPage({ packageId, sourceUuid, sourceDocument, identifier, name })
      : null;
    this.#pageCache.set(cacheKey, page ?? null);
    return {
      document: item,
      sourceDocument,
      page: page ?? null,
      sourceUuid,
      packageId,
      reason: page ? null : "This source does not expose a dedicated Journal page for the subclass."
    };
  }

  static clearCache() {
    this.#pageCache.clear();
  }

  static async #findJournalPage({ packageId, sourceUuid, sourceDocument, identifier, name }) {
    const packs = [...game.packs].filter(pack => {
      if (pack.documentName !== "JournalEntry") return false;
      const owner = pack.metadata?.packageName ?? pack.metadata?.package ?? pack.collection?.split?.(".")?.[0];
      return owner === packageId;
    });
    if (!packs.length) return null;

    const sourceCandidates = new Set([
      sourceUuid,
      sourceDocument?.uuid,
      sourceDocument?._stats?.compendiumSource,
      sourceDocument?.getFlag?.("dnd5e", "sourceId")
    ].filter(Boolean).map(String));
    const wantedIdentifier = this.#slug(identifier || name);
    const wantedName = this.#slug(name);

    const exactLinks = [];
    const identifierMatches = [];
    const nameMatches = [];

    for (const pack of packs) {
      let journals = [];
      try { journals = await pack.getDocuments(); }
      catch (error) {
        console.warn(`${MODULE_ID} | Could not inspect source Journal pack ${pack.collection}.`, error);
        continue;
      }
      for (const journal of journals) {
        for (const page of journal.pages ?? []) {
          const linkedItem = String(page.system?.item ?? page.system?.document ?? "").trim();
          if (linkedItem && sourceCandidates.has(linkedItem)) {
            exactLinks.push(page);
            continue;
          }

          const pageIdentifier = this.#slug(page.system?.identifier ?? page.flags?.dnd5e?.identifier ?? "");
          if (wantedIdentifier && pageIdentifier && pageIdentifier === wantedIdentifier) {
            identifierMatches.push(page);
            continue;
          }

          const pageName = this.#slug(page.name);
          if (wantedName && pageName === wantedName) nameMatches.push(page);
        }
      }
    }

    const preferred = rows => rows.find(page => page.type === "subclass")
      ?? rows.find(page => page.type === sourceDocument?.type)
      ?? rows[0]
      ?? null;
    return preferred(exactLinks) ?? preferred(identifierMatches) ?? preferred(nameMatches);
  }

  static #packageId(uuid) {
    const value = String(uuid ?? "");
    const match = value.match(/^Compendium\.([^.]+)\.([^.]+)\./);
    if (match) return match[1];
    const collection = value.startsWith("Compendium.") ? value.slice("Compendium.".length).split(".").slice(0, 2).join(".") : "";
    return collection ? collection.split(".")[0] : null;
  }

  static #slug(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
