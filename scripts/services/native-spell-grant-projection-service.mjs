import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";

/**
 * Thin adapter around D&D5e's native Advancement Spell Configuration.
 *
 * The D&D5e system is authoritative for how a granted spell is materialized.
 * In 5.3.3 `SpellConfiguration.applySpellChanges()` applies casting method,
 * preparation state, sourceItem, use pools/recovery, and free-cast Forward
 * Activities. Character Builder calls that native projection from a clean Item
 * source instead of re-implementing individual feature mechanics.
 */
export class NativeSpellGrantProjectionService {
  static async materialize({
    sourceAdvancement,
    sourceUuid,
    sourceItem = null,
    itemId = null,
    owner = null,
    localAdvancement = null
  } = {}) {
    if (!sourceAdvancement || !sourceUuid) return null;
    let data = sourceAdvancement.createItemData
      ? await sourceAdvancement.createItemData(sourceUuid, itemId ?? undefined)
      : null;
    if (!data && sourceItem) data = foundry.utils.deepClone(sourceItem.toObject?.() ?? sourceItem);
    if (!data) return null;
    if (itemId) data._id = itemId;
    this.apply(data, { sourceAdvancement, owner, localAdvancement });
    return data;
  }

  static apply(data, { sourceAdvancement, owner = null, localAdvancement = null } = {}) {
    if (data?.type !== "spell") return data;
    const spellConfiguration = sourceAdvancement?.configuration?.spell;
    const configuredAbilities = this.#values(spellConfiguration?.ability);
    const ability = localAdvancement?.value?.ability
      ?? sourceAdvancement?.value?.ability
      ?? configuredAbilities[0]
      ?? data.system?.ability
      ?? null;

    if (typeof spellConfiguration?.applySpellChanges === "function") {
      spellConfiguration.applySpellChanges(data, { ability });
      return data;
    }

    // Compatibility fallback. Supported D&D5e 5.3.3 sources should use the
    // native branch above; this only avoids turning unavailable malformed source
    // metadata into a hard crash.
    const raw = sourceAdvancement?.toObject?.()?.configuration?.spell
      ?? sourceAdvancement?.configuration?.spell
      ?? {};
    const abilities = Array.isArray(raw.ability) ? raw.ability : this.#values(raw.ability);
    if (ability ?? abilities[0]) data.system.ability = ability ?? abilities[0];
    if (raw.method) data.system.method = raw.method;
    if (owner?.system?.identifier) data.system.sourceItem = `${owner.type}:${owner.system.identifier}`;
    data.system.prepared = SpellPreparationPolicyService.resolve({
      level: data.system?.level,
      explicitPrepared: raw.prepared,
      alwaysPrepared: Number(raw.prepared) === SpellPreparationPolicyService.ALWAYS_PREPARED,
      category: "native-item-grant"
    });
    return data;
  }

  static #values(value) {
    if (!value) return [];
    if (Array.isArray(value)) return [...value];
    if (value instanceof Set) return [...value];
    if (value?.contents) return [...value.contents];
    if (typeof value?.values === "function") return [...value.values()];
    try { return [...value]; } catch (_error) { return []; }
  }
}
