import { MODULE_ID } from "../constants.mjs";

/**
 * Projects additive cantrip entitlements contributed by selected class features.
 *
 * The class ScaleValue is the base entitlement. Features such as Druid's
 * Primal Order: Magician and Cleric's Divine Order: Thaumaturge add to the
 * derived D&D5e scale through transfer Active Effects. Character Builder treats
 * those additions as separate feature-owned acquisitions instead of subtracting
 * them from the raw class ScaleValue.
 */
export class AdditionalCantripEntitlementService {
  static grants(actor, classItemOrIdentifier) {
    if (!actor) return [];
    const classItem = typeof classItemOrIdentifier === "string"
      ? this.#items(actor).find(item => item?.type === "class"
        && String(item.system?.identifier ?? "") === String(classItemOrIdentifier))
      : classItemOrIdentifier;
    const classIdentifier = String(classItem?.system?.identifier ?? classItemOrIdentifier ?? "").trim();
    if (!classIdentifier) return [];

    const key = `system.scale.${classIdentifier}.cantrips-known`;
    const grants = [];
    for (const item of this.#items(actor)) {
      if (!item || item.type === "class" || item.type === "spell") continue;
      let count = 0;
      for (const effect of this.#effects(item)) {
        // The selected feature Item is the entitlement source. A manually
        // disabled transfer effect must not erase a rules-granted cantrip from
        // Character Creation, Level Up, or Validator projection.
        if (!effect || effect.transfer === false) continue;
        const changes = this.#changes(effect);
        for (const change of changes) {
          if (String(change?.key ?? "") !== key) continue;
          if (!this.#isAddChange(change)) continue;
          const value = Number(change?.value ?? 0);
          if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) continue;
          count += value;
        }
      }
      if (!count) continue;

      const featureIdentifier = String(item.system?.identifier ?? "").trim();
      const category = this.#slug(featureIdentifier || item.name || "additional-cantrip");
      grants.push({
        key: String(item.id ?? item._id ?? category),
        count,
        classIdentifier,
        classItemId: classItem?.id ?? classItem?._id ?? null,
        featureItemId: item.id ?? item._id ?? null,
        featureIdentifier: featureIdentifier || null,
        featureName: String(item.name ?? "Additional Cantrip"),
        category,
        sourceUuid: this.#sourceUuid(item),
        fieldName: `spellAccess.additionalCantrip.${String(item.id ?? item._id ?? category)}`
      });
    }
    return grants.sort((a, b) => a.featureName.localeCompare(b.featureName, globalThis.game?.i18n?.lang));
  }

  static hasOwner(spell, grant) {
    if (!spell || spell.type !== "spell" || !grant) return false;
    const owners = this.#flag(spell, "featureSpellOwners") ?? [];
    return owners.some(owner => String(owner?.featureItemId ?? owner?.ownerItemId ?? "") === String(grant.featureItemId ?? "")
      && String(owner?.classItemId ?? "") === String(grant.classItemId ?? "")
      && String(owner?.category ?? "") === String(grant.category ?? ""));
  }

  static ownerRecord(grant, spellSource, {
    transactionId = null,
    acquiredAtCharacterLevel = null,
    acquiredAtClassLevel = null,
    alwaysPrepared = true,
    validationReconciled = false
  } = {}) {
    return {
      category: grant.category,
      label: grant.featureName,
      classIdentifier: grant.classIdentifier,
      classItemId: grant.classItemId,
      subclassItemId: null,
      featureItemId: grant.featureItemId,
      ownerItemId: grant.featureItemId,
      advancementId: null,
      transactionId,
      acquiredAtCharacterLevel,
      acquiredAtClassLevel,
      sourceUuid: spellSource?.uuid ?? spellSource?.getFlag?.("dnd5e", "sourceId") ?? spellSource?._stats?.compendiumSource ?? null,
      spellLevel: Number(spellSource?.system?.level ?? 0),
      alwaysPrepared: Boolean(alwaysPrepared),
      nativeGrant: false,
      ...(validationReconciled ? { validationReconciled: true } : {})
    };
  }

  static #items(actor) {
    const items = actor?.items;
    if (Array.isArray(items)) return items;
    if (Array.isArray(items?.contents)) return items.contents;
    if (typeof items?.values === "function") return [...items.values()];
    if (items && typeof items[Symbol.iterator] === "function") return [...items];
    return [];
  }

  static #effects(item) {
    const effects = item?.effects;
    if (Array.isArray(effects)) return effects;
    if (Array.isArray(effects?.contents)) return effects.contents;
    if (typeof effects?.values === "function") return [...effects.values()];
    if (effects && typeof effects[Symbol.iterator] === "function") return [...effects];
    return item?.toObject?.().effects ?? item?._source?.effects ?? [];
  }

  static #changes(effect) {
    const direct = effect?.system?.changes;
    if (Array.isArray(direct)) return direct;
    if (Array.isArray(direct?.contents)) return direct.contents;
    const raw = effect?.toObject?.().system?.changes ?? effect?._source?.system?.changes;
    return Array.isArray(raw) ? raw : [];
  }

  static #isAddChange(change) {
    const type = String(change?.type ?? "").toLowerCase();
    if (!type) return true;
    return type === "add" || type === "2";
  }

  static #sourceUuid(item) {
    return item?.getFlag?.("dnd5e", "sourceId")
      ?? item?.flags?.dnd5e?.sourceId
      ?? item?._stats?.compendiumSource
      ?? null;
  }

  static #flag(item, key) {
    return item?.getFlag?.(MODULE_ID, key) ?? item?.flags?.[MODULE_ID]?.[key];
  }

  static #slug(value) {
    return String(value ?? "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "additional-cantrip";
  }
}
