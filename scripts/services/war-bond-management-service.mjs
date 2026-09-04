import { MODULE_ID } from "../constants.mjs";

/**
 * Eldritch Knight War Bond maintenance around D&D5e's source-native Enchant
 * Activity. The native Activity remains authoritative for eligibility and for
 * creating the enchantment; Character Builder supplies the missing lifecycle
 * for breaking/replacing bonds and reconciles the feature's native uses.spent.
 */
export class WarBondManagementService {
  static feature(actor, featureItemId = null) {
    const explicit = featureItemId ? actor?.items?.get?.(featureItemId) : null;
    if (explicit?.type === "feat" && this.#identifier(explicit) === "war-bond") return explicit;
    return [...(actor?.items ?? [])].find(item => item?.type === "feat" && (
      this.#identifier(item) === "war-bond" || this.#normalize(item.name) === "war bond"
    )) ?? null;
  }

  static activity(feature, activityId = null) {
    if (!feature) return null;
    const activities = this.#activities(feature);
    const explicit = activityId ? activities.find(activity => String(activity.id ?? activity._id) === String(activityId)) : null;
    if (explicit && this.matchesActivity(explicit)) return explicit;
    return activities.find(activity => this.matchesActivity(activity)) ?? null;
  }

  static matchesActivity(activity) {
    const item = activity?.item ?? activity?.parent ?? null;
    if (!item || (this.#identifier(item) !== "war-bond" && this.#normalize(item.name) !== "war bond")) return false;
    if (String(activity?.type ?? "").trim().toLowerCase() !== "enchant") return false;
    return this.#normalize(activity?.name) === "bond with weapon";
  }

  static canManage(actor) {
    if (!actor || actor.type !== "character" || !actor.isOwner) return false;
    const feature = this.feature(actor);
    return Boolean(feature && this.activity(feature));
  }

  static async context(actor, { featureItemId = null, activityId = null } = {}) {
    const feature = this.feature(actor, featureItemId);
    const activity = this.activity(feature, activityId);
    if (!feature || !activity) throw new Error("The source-native War Bond / Bond with Weapon Activity could not be found.");

    const max = this.#usesMax(feature);
    if (!Number.isFinite(max) || max <= 0) throw new Error("War Bond does not currently expose a valid native bond capacity.");
    const spent = Math.max(0, Math.min(max, Number(feature.system?.uses?.spent ?? 0)));
    const bonds = this.#appliedBonds(actor, activity);
    const validCount = bonds.length;
    const brokenCount = Math.max(0, Math.min(max - validCount, spent - validCount));
    const occupied = Math.min(max, validCount + brokenCount);
    const freeCount = Math.max(0, max - occupied);
    const slots = [];

    for (const bond of bonds.slice(0, max)) {
      slots.push({
        index: slots.length,
        kind: "bound",
        bound: true,
        broken: false,
        free: false,
        effectId: bond.effect.id,
        effectUuid: bond.effect.uuid,
        weaponId: bond.weapon.id,
        weaponUuid: bond.weapon.uuid,
        name: bond.weapon.name,
        img: bond.weapon.img
      });
    }
    for (let index = 0; index < brokenCount && slots.length < max; index++) {
      slots.push({ index: slots.length, kind: "broken", bound: false, broken: true, free: false });
    }
    while (slots.length < max) slots.push({ index: slots.length, kind: "free", bound: false, broken: false, free: true });

    const bondedWeaponIds = new Set(bonds.map(row => row.weapon.id));
    const availableWeapons = [...(actor.items ?? [])]
      .filter(item => item?.type === "weapon" && !bondedWeaponIds.has(item.id))
      .map(weapon => ({ weapon, errors: this.#enchantmentErrors(activity, weapon) }))
      .filter(row => row.errors.length === 0)
      .map(({ weapon }) => ({
        id: weapon.id,
        uuid: weapon.uuid,
        name: weapon.name,
        img: weapon.img,
        typeLabel: String(weapon.system?.type?.value ?? "Weapon"),
        magical: weapon.system?.properties?.has?.("mgc") ?? false,
        search: String(weapon.name ?? "").toLowerCase()
      }))
      .sort((a, b) => a.name.localeCompare(b.name, globalThis.game?.i18n?.lang));

    return {
      actorId: actor.id,
      actorName: actor.name,
      featureItemId: feature.id,
      activityId: activity.id ?? activity._id,
      featureName: feature.name,
      featureImg: feature.img,
      max,
      spent,
      validCount,
      brokenCount,
      freeCount,
      slots,
      availableWeapons,
      outOfSync: validCount > spent,
      capacityLabel: `${Math.max(spent, validCount)} / ${max}`
    };
  }

  static async bind(actor, weaponId, { replaceBroken = false, featureItemId = null, activityId = null } = {}) {
    const context = await this.context(actor, { featureItemId, activityId });
    const feature = this.feature(actor, context.featureItemId);
    const activity = this.activity(feature, context.activityId);
    const weapon = actor?.items?.get?.(weaponId);
    if (!weapon || weapon.type !== "weapon") throw new Error("The selected weapon is no longer in this Actor's inventory.");
    if (context.slots.some(slot => slot.weaponId === weapon.id)) throw new Error(`${weapon.name} is already bound by this War Bond.`);

    const brokenAvailable = context.brokenCount > 0;
    const freeAvailable = context.freeCount > 0;
    if (replaceBroken && !brokenAvailable) throw new Error("That broken War Bond slot is no longer available.");
    if (!replaceBroken && !freeAvailable) {
      if (brokenAvailable) throw new Error("No free War Bond slot remains. Drop the weapon onto the Broken Bond slot to replace it, or release a bond first.");
      throw new Error("War Bond is at its native maximum. Break a bond before binding another weapon.");
    }

    const errors = this.#enchantmentErrors(activity, weapon);
    if (errors.length) throw new Error(errors.map(error => error?.message ?? String(error)).filter(Boolean).join(" ") || "That weapon is not eligible for War Bond.");
    const profile = activity.availableEnchantments?.[0]?._id ?? activity.availableEnchantments?.[0]?.id ?? null;
    if (!profile) throw new Error("The source-native War Bond enchantment profile could not be resolved.");

    const enchantment = await activity.applyEnchantment(profile, weapon, { strict: true });
    if (!enchantment) throw new Error(`D&D5e did not apply War Bond to ${weapon.name}.`);

    const afterValid = context.validCount + 1;
    const afterBroken = Math.max(0, context.brokenCount - (replaceBroken ? 1 : 0));
    await this.#setSpent(feature, Math.min(context.max, afterValid + afterBroken));
    return { changed: true, weaponId: weapon.id, weaponName: weapon.name, effectId: enchantment.id, replacedBroken: Boolean(replaceBroken) };
  }

  static async breakBond(actor, effectUuid, { featureItemId = null, activityId = null } = {}) {
    const context = await this.context(actor, { featureItemId, activityId });
    const feature = this.feature(actor, context.featureItemId);
    const activity = this.activity(feature, context.activityId);
    const bond = this.#appliedBonds(actor, activity).find(row => row.effect.uuid === effectUuid || row.effect.id === effectUuid);
    if (!bond) throw new Error("That War Bond is no longer present.");
    await bond.effect.delete({ characterBuilderRuntimeManagement: true, characterBuilderWarBond: true });
    const afterValid = Math.max(0, context.validCount - 1);
    await this.#setSpent(feature, Math.min(context.max, afterValid + context.brokenCount));
    return { changed: true, weaponId: bond.weapon.id, weaponName: bond.weapon.name };
  }

  static async releaseBroken(actor, { featureItemId = null, activityId = null } = {}) {
    const context = await this.context(actor, { featureItemId, activityId });
    if (!context.brokenCount) throw new Error("No broken War Bond slot remains to release.");
    const feature = this.feature(actor, context.featureItemId);
    await this.#setSpent(feature, Math.min(context.max, context.validCount + context.brokenCount - 1));
    return { changed: true, released: 1 };
  }

  static #appliedBonds(actor, activity) {
    let effects = [];
    try {
      effects = [...(globalThis.dnd5e?.registry?.enchantments?.applied?.(activity.uuid) ?? [])];
    } catch (_error) { effects = []; }
    if (!effects.length) {
      effects = [...(actor?.items ?? [])].flatMap(item => [...(item.effects ?? [])].filter(effect =>
        effect?.isAppliedEnchantment && String(effect.origin ?? "") === String(activity.uuid ?? "")
      ));
    }
    const seen = new Set();
    return effects.map(effect => ({ effect, weapon: effect?.parent }))
      .filter(row => row.weapon?.actor?.id === actor.id || row.weapon?.parent?.id === actor.id)
      .filter(row => row.weapon?.type === "weapon" && actor.items?.has?.(row.weapon.id))
      .filter(row => {
        const key = row.effect.uuid ?? `${row.weapon.id}:${row.effect.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  static #enchantmentErrors(activity, weapon) {
    try {
      const result = activity?.canEnchant?.(weapon);
      if (result === true || result == null) return [];
      return Array.isArray(result) ? result : [result];
    } catch (error) {
      return [error];
    }
  }

  static async #setSpent(feature, value) {
    const max = this.#usesMax(feature);
    const next = Math.max(0, Math.min(Number.isFinite(max) ? max : value, Math.trunc(Number(value) || 0)));
    if (Number(feature.system?.uses?.spent ?? 0) === next) return;
    await feature.update({ "system.uses.spent": next }, {
      characterBuilderRuntimeManagement: true,
      characterBuilderWarBond: true
    });
  }

  static #usesMax(feature) {
    const raw = feature?.system?.uses?.max;
    const direct = Number(raw);
    if (Number.isFinite(direct)) return Math.max(0, Math.trunc(direct));
    try {
      const formula = Roll.replaceFormulaData(String(raw ?? ""), feature?.getRollData?.({ deterministic: true }) ?? {}, { missing: "0" });
      const result = Number(Roll.safeEval(formula));
      return Number.isFinite(result) ? Math.max(0, Math.trunc(result)) : 0;
    } catch (_error) {
      return 0;
    }
  }

  static #activities(feature) {
    const collection = feature?.system?.activities;
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (typeof collection.values === "function") return [...collection.values()];
    return Object.values(collection);
  }

  static #identifier(item) {
    return String(item?.system?.identifier ?? "").trim().toLowerCase();
  }

  static #normalize(value) {
    return String(value ?? "").trim().toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
  }
}
