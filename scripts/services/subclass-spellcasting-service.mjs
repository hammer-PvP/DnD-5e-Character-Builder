import { AdditionalNativeSpellProgressionService } from "./additional-native-spell-progression-service.mjs";
/**
 * Resolves spellcasting introduced by a subclass of a non-spellcasting class.
 * Native D&D5e 6.x spellcasting, Spell List registry and ScaleValue records
 * are authoritative. Descriptive feature text is a conservative last resort
 * for the *source list only*, never for mechanical progression/entitlements.
 *
 * This resolver never edits source documents or grants spells itself.
 */
export class SubclassSpellcastingService {
  static #legacyCasterNames = new Map([
    // Compatibility with pre-existing Eldritch Knight / Arcane Trickster
    // content that predates native subclass spellcasting metadata.
    ["fighter:eldritch-knight", { spellList: "wizard", ability: "int", cantrips: [2, 3], fixedGrant: 0 }],
    ["rogue:arcane-trickster", { spellList: "wizard", ability: "int", cantrips: [3, 4], fixedGrant: 1 }],
    ["rogue:trickster", { spellList: "wizard", ability: "int", cantrips: [3, 4], fixedGrant: 1 }]
  ]);

  static find(draft, classIdentifier) {
    const id = String(classIdentifier ?? "").trim().toLowerCase();
    if (!id) return null;
    const candidates = [...(draft?.items ?? [])].filter(item => {
      if (item?.type !== "subclass") return false;
      const parent = item.system?.classIdentifier ?? item.system?.class?.identifier ?? item.system?.class;
      if (parent) return String(parent).trim().toLowerCase() === id;
      // Keep the previously supported parentless official legacy exports only.
      return this.#legacyCasterNames.has(`${id}:${String(item.system?.identifier ?? "").trim().toLowerCase()}`);
    });
    for (const subclass of candidates) {
      const identifier = String(subclass.system?.identifier ?? "").trim().toLowerCase();
      const progression = String(subclass.system?.spellcasting?.progression ?? "none").trim().toLowerCase();
      const legacy = this.#legacyCasterNames.get(`${id}:${identifier}`) ?? null;
      if (!(["full", "half", "third", "pact"].includes(progression)
        || AdditionalNativeSpellProgressionService.isAdditionalRegistered(progression) || legacy)) continue;
      return {
        subclass, identifier,
        legacy,
        progression: progression !== "none" ? progression : "third",
        ability: String(subclass.system?.spellcasting?.ability ?? legacy?.ability ?? ""),
        sourceItem: `subclass:${identifier}`,
        legacySpellList: legacy?.spellList ?? null,
        classIdentifier: id
      };
    }
    return null;
  }

  /** The subclass's own native advancement scales take precedence over prose. */
  static scaleValue(caster, level, kind) {
    if (!caster) return null;
    const entries = Object.values(caster.subclass?.toObject?.().system?.advancement
      ?? caster.subclass?.system?.advancement ?? {});
    const formula = String(caster.subclass?.system?.spellcasting?.preparation?.formula ?? "");
    const formulaKey = /^@scale\.[^.]+\.([\w-]+)$/i.exec(formula)?.[1]?.toLowerCase();
    const scales = entries.filter(row => row?.type === "ScaleValue");
    const byIdentifier = row => String(row.configuration?.identifier ?? "").toLowerCase();
    const entry = (kind === "prepared" && formulaKey
      ? scales.find(row => byIdentifier(row) === formulaKey)
      : null) ?? scales.find(row => {
        const key = byIdentifier(row);
        const title = String(row.name ?? "").trim().toLowerCase();
        return kind === "prepared"
          ? key === "max-prepared" || /max(?:imum)?\s+prepared/.test(title)
          : /^(?:cantrips?(?:[\s-]*known)?)$/.test(key) || /cantrips?\s+known/.test(title);
      });
    if (!entry) return null;
    const values = Object.entries(entry.configuration?.scale ?? {})
      .map(([minimum, value]) => [Number(minimum), Number(value?.value ?? value)])
      .filter(([minimum, value]) => Number.isFinite(minimum) && Number.isFinite(value) && minimum <= level)
      .sort((a, b) => a[0] - b[0]);
    return Math.max(0, Math.trunc(values.at(-1)?.[1] ?? 0));
  }

  static cantripCount(caster, oldLevel, newLevel) {
    if (!caster) return 0;
    const current = this.scaleValue(caster, newLevel, "cantrips");
    const previous = this.scaleValue(caster, oldLevel, "cantrips");
    const legacy = caster.legacy ?? this.#legacyCasterNames.get(`${caster.classIdentifier}:${caster.identifier}`);
    const fixedGrant = legacy?.fixedGrant && oldLevel < 3 && newLevel >= 3 ? legacy.fixedGrant : 0;
    if (current !== null) return Math.max(0, current - (previous ?? 0) - fixedGrant);
    // Older officially supported sources without structured scales retain the
    // same counts as the previous implementation. Other subclasses are never
    // assigned made-up cantrip entitlements.
    if (!legacy?.cantrips) return 0;
    const known = level => level < 3 ? 0 : level >= 10 ? legacy.cantrips[1] : legacy.cantrips[0];
    return Math.max(0, known(newLevel) - known(oldLevel) - fixedGrant);
  }

  static preparedCount(caster, oldLevel, newLevel) {
    if (!caster) return 0;
    const current = this.scaleValue(caster, newLevel, "prepared");
    const previous = this.scaleValue(caster, oldLevel, "prepared");
    return current === null ? 0 : Math.max(0, current - (previous ?? 0));
  }

  static maximumSpellLevel(progression, level) {
    if (level <= 0) return 0;
    switch (progression) {
      case "full": return Math.min(9, Math.ceil(level / 2));
      case "half": return Math.min(5, Math.max(1, Math.floor((level + 3) / 4)));
      case "third": return level < 3 ? 0 : level < 7 ? 1 : level < 13 ? 2 : level < 19 ? 3 : 4;
      case "pact": return Math.min(5, Math.ceil(level / 2));
      default: return AdditionalNativeSpellProgressionService.maximumSpellLevel(progression, level);
    }
  }

  /** Resolve native subclass list, explicit source feature, class list, then legacy compatibility. */
  static async spellList(caster, draft, newLevel) {
    if (!caster) return null;
    const registry = globalThis.dnd5e?.registry?.spellLists;
    if (!registry) throw new Error("The D&D5e spell-list registry is unavailable.");
    for (let attempt = 0; attempt < 20 && !registry.ready; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const valid = (type, identifier) => {
      if (!identifier) return false;
      try { const indexes = registry.forType?.(type, identifier)?.indexes;
        return Boolean((indexes?.length ?? indexes?.size ?? 0) > 0); }
      catch { return false; }
    };
    if (valid("subclass", caster.identifier)) return { type: "subclass", identifier: caster.identifier, source: "native-subclass-list" };

    const configured = caster.subclass?.system?.spellcasting?.spellList
      ?? caster.subclass?.system?.spellcasting?.list ?? null;
    if (valid("class", configured)) return { type: "class", identifier: configured, source: "native-subclass-field" };

    const granted = await this.#spellcastingFeatures(caster, draft, newLevel);
    const declared = new Set();
    for (const feature of granted) {
      const description = String(feature.system?.description?.value ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");
      for (const match of description.matchAll(/\b([a-z][a-z'-]*)\s+spell\s+list\b/gi)) {
        const identifier = match[1].toLowerCase();
        if (valid("class", identifier)) declared.add(identifier);
      }
    }
    if (declared.size === 1) return { type: "class", identifier: [...declared][0], source: "granted-spellcasting-feature" };
    if (declared.size > 1) return null; // Never guess between conflicting spell lists.

    if (valid("class", caster.classIdentifier)) {
      return { type: "class", identifier: caster.classIdentifier, source: "native-class-list" };
    }
    if (valid("class", caster.legacySpellList)) {
      return { type: "class", identifier: caster.legacySpellList, source: "legacy-compatibility" };
    }
    return null;
  }

  static async #spellcastingFeatures(caster, draft, level) {
    const advancements = Object.values(caster.subclass?.toObject?.().system?.advancement
      ?? caster.subclass?.system?.advancement ?? {});
    const grantedUuids = new Set(advancements.filter(entry => entry.type === "ItemGrant"
      && Number(entry.level ?? 0) <= level)
      .flatMap(entry => (entry.configuration?.items ?? []).map(row => String(row.uuid ?? "")))
      .filter(Boolean));
    const features = [];
    for (const feat of draft?.items ?? []) {
      if (feat?.type !== "feat") continue;
      const origin = String(feat.getFlag?.("dnd5e", "sourceId") ?? feat._stats?.compendiumSource ?? "");
      const requirement = String(feat.system?.requirements ?? "").toLowerCase();
      const belonging = grantedUuids.has(origin) || requirement.includes(caster.subclass.name.toLowerCase());
      if (belonging && this.#isSpellcastingFeature(feat)) features.push(feat);
    }
    // Some native grants do not retain their original UUID on a materialized
    // feature. Consult only the subclass's own ItemGrant source references.
    if (features.length) return features;
    if (typeof globalThis.fromUuid !== "function") return [];
    for (const uuid of grantedUuids) {
      let feature = null;
      try { feature = await fromUuid(uuid); } catch { /* unavailable pack */ }
      if (feature?.type === "feat" && this.#isSpellcastingFeature(feature)) features.push(feature);
    }
    return features;
  }

  static #isSpellcastingFeature(feat) {
    const name = String(feat?.name ?? "").toLowerCase();
    const identifier = String(feat?.system?.identifier ?? "").toLowerCase();
    return /spellcasting/.test(name) || /spellcasting/.test(identifier);
  }
}
