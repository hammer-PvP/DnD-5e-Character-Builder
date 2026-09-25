import { MODULE_ID } from "../constants.mjs";

const LINEAGE_IDENTIFIER = "elven-lineage-high-elf";
const ACTION_ID = "replace-high-elf-cantrip";

/**
 * PHB 2024 High Elf maintenance.
 *
 * The High Elf cantrip is a mutable species grant: after each Long Rest the
 * one cantrip owned by Elven Lineage (High Elf) may be replaced by one other
 * cantrip from the Wizard spell list. Identity is always provenance-based;
 * spell name/identifier is never used to decide which owned cantrip belongs to
 * the lineage.
 */
export class HighElfCantripService {
  static get actionId() { return ACTION_ID; }
  static get kind() { return "replace-high-elf-cantrip"; }

  static lineage(actor) {
    return actor?.items?.find(item => item.type === "feat"
      && String(item.system?.identifier ?? "") === LINEAGE_IDENTIFIER) ?? null;
  }

  static action(actor, restType, session = null) {
    if (restType !== "long") return null;
    const lineage = this.lineage(actor);
    if (!lineage) return null;
    const current = this.currentCantrip(actor, lineage);
    if (!current) return null;
    return {
      id: ACTION_ID,
      label: "High Elf — Replace Cantrip",
      kind: this.kind,
      description: "Replace the cantrip granted by High Elf lineage with one different cantrip from the Wizard spell list.",
      img: lineage.img ?? current.img ?? "icons/svg/upgrade.svg",
      featureItemId: lineage.id,
      complete: Boolean(session?.completedActionIds?.includes(ACTION_ID)),
      native: false,
      order: 15
    };
  }

  static currentCantrip(actor, lineage = this.lineage(actor)) {
    if (!actor || !lineage) return null;
    const candidates = actor.items.filter(item => item.type === "spell" && Number(item.system?.level ?? -1) === 0);

    // Once Character Builder has performed the first replacement, this marker
    // is the strongest and unambiguous provenance signal.
    const explicit = candidates.filter(item => {
      const marker = item.getFlag?.(MODULE_ID, "highElfLineageCantrip");
      return Boolean(marker && (!marker.lineageItemId || marker.lineageItemId === lineage.id));
    });
    if (explicit.length === 1) return explicit[0];
    if (explicit.length > 1) return null;

    const lineageRoots = this.#lineageRootIds(lineage);

    // Native/CB ItemGrant and feature ownership are the next strongest
    // structural signals. PHB species grants commonly use the Species Item as
    // the owner while the visible Elven Lineage feature is a sibling grant.
    const owned = candidates.filter(item => {
      const grant = item.getFlag?.(MODULE_ID, "itemGrantInstance");
      if (grant?.ownerItemId && lineageRoots.has(String(grant.ownerItemId))) return true;
      const owners = item.getFlag?.(MODULE_ID, "featureSpellOwners") ?? [];
      return owners.some(owner => [owner.ownerItemId, owner.featureItemId]
        .filter(Boolean).some(id => lineageRoots.has(String(id))));
    });
    if (owned.length === 1) return owned[0];
    if (owned.length > 1) return null;

    // PHB ItemGrant documents preserve advancementRoot/advancementOrigin. The
    // High Elf lineage feat and its cantrip can both ultimately point to the
    // same Species root, so level 0 + same root is sufficient for this lineage.
    const rooted = candidates.filter(item => {
      for (const reference of [
        item.getFlag?.("dnd5e", "advancementRoot"),
        item.getFlag?.("dnd5e", "advancementOrigin")
      ]) {
        const rootId = String(reference ?? "").split(".")[0];
        if (rootId && lineageRoots.has(rootId)) return true;
      }
      return false;
    });
    return rooted.length === 1 ? rooted[0] : null;
  }

  static async context(actor, registry, operation = null) {
    const lineage = this.lineage(actor);
    const current = this.currentCantrip(actor, lineage);
    if (!lineage || !current) {
      return {
        available: false,
        lineage: lineage ? this.#summary(lineage) : null,
        current: null,
        oldItemId: "",
        newUuid: "",
        options: []
      };
    }

    const pool = (await this.#wizardCantripPool(registry))
      .filter(option => String(option.system?.identifier ?? "") !== String(current.system?.identifier ?? ""));

    return {
      available: true,
      lineage: this.#summary(lineage),
      current: {
        id: current.id,
        name: current.name,
        img: current.img,
        identifier: current.system?.identifier ?? "",
        uuid: current.uuid,
        sourceUuid: this.#referenceUuid(current),
        ability: current.system?.ability ?? "",
        abilityLabel: this.#abilityLabel(current.system?.ability)
      },
      oldItemId: current.id,
      newUuid: operation?.newUuid ?? "",
      options: pool.map(option => ({
        ...option,
        levelLabel: "Wizard Cantrip",
        disabled: false
      }))
    };
  }

  static async validate(actor, registry, payload = {}) {
    const lineage = this.lineage(actor);
    const current = this.currentCantrip(actor, lineage);
    if (!lineage || !current) throw new Error("The current High Elf lineage cantrip could not be identified by provenance.");
    if (String(payload?.oldItemId ?? "") !== String(current.id)) {
      throw new Error("The High Elf cantrip changed before this replacement could be confirmed. Reopen the option and try again.");
    }

    const source = await this.#sourceSpell(registry, payload?.newUuid);
    if (!source || source.type !== "spell" || Number(source.system?.level ?? -1) !== 0) {
      throw new Error("Choose a valid Wizard cantrip.");
    }
    if (String(source.system?.identifier ?? "") === String(current.system?.identifier ?? "")) {
      throw new Error("Choose a different Wizard cantrip for the High Elf lineage.");
    }
    const pool = await this.#wizardCantripPool(registry);
    if (!pool.some(option => option.uuid === source.uuid)) {
      throw new Error("The replacement must be a Wizard cantrip from an enabled source.");
    }
    return true;
  }

  static async apply(actor, registry, payload, transactionId) {
    await this.validate(actor, registry, payload);
    const lineage = this.lineage(actor);
    const oldSpell = this.currentCantrip(actor, lineage);
    const source = await this.#sourceSpell(registry, payload?.newUuid);
    if (!lineage || !oldSpell || !source) throw new Error("The High Elf cantrip replacement could not be resolved.");

    const data = source.toObject();
    delete data._id;
    data.system ??= {};

    // The source spell contributes its rules/content. The racial grant keeps
    // the casting/provenance contract of the cantrip it replaces.
    for (const key of ["ability", "method", "prepared", "sourceItem"]) {
      if (oldSpell.system?.[key] !== undefined) data.system[key] = foundry.utils.deepClone(oldSpell.system[key]);
    }

    data.flags ??= {};
    data.flags.dnd5e ??= {};
    const oldDndFlags = oldSpell.flags?.dnd5e ?? {};
    for (const key of ["advancementOrigin", "advancementRoot"]) {
      const value = oldDndFlags[key] ?? oldSpell.getFlag?.("dnd5e", key);
      if (value) data.flags.dnd5e[key] = foundry.utils.deepClone(value);
    }
    data.flags.dnd5e.sourceId = source.uuid;

    const oldModuleFlags = foundry.utils.deepClone(oldSpell.flags?.[MODULE_ID] ?? {});
    const nativeGrant = this.#grantDescriptor(actor, lineage, oldSpell);
    const oldGrant = nativeGrant
      ? {
        ...foundry.utils.deepClone(nativeGrant),
        // configuredUuid is intentionally preserved: it identifies the PHB
        // ItemGrant slot (Prestidigitation), while sourceUuid records which
        // Wizard cantrip currently occupies that mutable racial slot.
        sourceUuid: source.uuid,
        transactionId: nativeGrant.transactionId ?? transactionId,
        reconciled: true
      }
      : null;
    const oldOwners = Array.isArray(oldModuleFlags.featureSpellOwners)
      ? oldModuleFlags.featureSpellOwners.map(owner => ({
        ...foundry.utils.deepClone(owner),
        sourceUuid: source.uuid
      }))
      : [];
    if (!oldOwners.length && oldGrant) {
      oldOwners.push({
        category: "high-elf-lineage",
        label: lineage.name,
        ownerItemId: oldGrant.ownerItemId,
        featureItemId: lineage.id,
        advancementId: oldGrant.advancementId,
        transactionId,
        sourceUuid: source.uuid,
        spellLevel: 0,
        alwaysPrepared: true,
        nativeGrant: true
      });
    }
    data.flags[MODULE_ID] = {
      ...oldModuleFlags,
      ...(oldGrant ? { itemGrantInstance: oldGrant } : {}),
      ...(oldOwners.length ? { featureGrantedSpell: true, featureSpellOwners: oldOwners } : {}),
      highElfLineageCantrip: {
        lineageItemId: lineage.id,
        speciesItemId: this.#speciesRootId(lineage),
        transactionId,
        replacedItemId: oldSpell.id,
        replacedIdentifier: oldSpell.system?.identifier ?? null,
        sourceUuid: source.uuid,
        replacedAt: Date.now(),
        replacedBy: game.user?.id ?? null
      }
    };

    // Materialize first so a source/import failure can never destroy the
    // character's existing racial cantrip. Then move the native ItemGrant
    // ledger to the replacement before deleting the old embedded Item.
    let created = null;
    let grantRelinked = false;
    try {
      [created] = await actor.createEmbeddedDocuments("Item", [data], {
        characterBuilderRuntimeManagement: true,
        characterBuilderHighElfCantripReplacement: true
      });
      if (!created) throw new Error("D&D5e did not create the replacement High Elf cantrip.");

      if (oldGrant) {
        grantRelinked = await this.#relinkNativeGrant(actor, oldGrant, oldSpell.id, created.id);
        if (!grantRelinked) {
          throw new Error("The High Elf ItemGrant ledger could not be relinked to the replacement cantrip.");
        }
      }

      await actor.deleteEmbeddedDocuments("Item", [oldSpell.id], {
        characterBuilderRuntimeManagement: true,
        characterBuilderHighElfCantripReplacement: true,
        deleteContents: false
      });
    } catch (error) {
      // Roll back only while the original spell still exists. If D&D5e reports
      // an error after actually deleting it, preserving the newly-created
      // replacement is safer than leaving the lineage with no cantrip.
      const originalStillExists = Boolean(actor.items.get(oldSpell.id));
      if (created && originalStillExists) {
        if (grantRelinked) {
          try { await this.#relinkNativeGrant(actor, oldGrant, created.id, oldSpell.id); } catch (_rollbackError) {}
        }
        try {
          await actor.deleteEmbeddedDocuments("Item", [created.id], {
            characterBuilderRuntimeManagement: true,
            characterBuilderHighElfCantripReplacement: true,
            deleteContents: false
          });
        } catch (_rollbackError) {}
      }
      if (originalStillExists) throw error;
    }

    return {
      changed: true,
      lineageItemId: lineage.id,
      deletedItemId: oldSpell.id,
      createdItemId: created?.id ?? null,
      oldIdentifier: oldSpell.system?.identifier ?? null,
      newIdentifier: created?.system?.identifier ?? source.system?.identifier ?? null,
      sourceUuid: source.uuid
    };
  }

  static #grantDescriptor(actor, lineage, spell) {
    const existing = spell.getFlag?.(MODULE_ID, "itemGrantInstance");
    if (existing?.ownerItemId && existing?.advancementId && existing?.configuredUuid) {
      return foundry.utils.deepClone(existing);
    }

    // Older/native-only High Elves may predate Character Builder's ItemGrant
    // receipt flags. Recover the same immutable slot identity from D&D5e's own
    // Advancement ledger before replacing the embedded spell.
    const references = [
      spell.getFlag?.("dnd5e", "advancementOrigin"),
      spell.getFlag?.("dnd5e", "advancementRoot"),
      lineage?.getFlag?.("dnd5e", "advancementOrigin"),
      lineage?.getFlag?.("dnd5e", "advancementRoot")
    ].filter(Boolean);
    for (const reference of references) {
      const [ownerItemId, advancementId] = String(reference).split(".");
      if (!ownerItemId || !advancementId) continue;
      const owner = actor.items.get(ownerItemId);
      const raw = owner?.toObject?.().system?.advancement?.[advancementId];
      if (raw?.type !== "ItemGrant") continue;
      const configuredUuid = raw.value?.added?.[spell.id];
      if (!configuredUuid) continue;
      return {
        ownerItemId,
        advancementId,
        configuredUuid: String(configuredUuid),
        sourceUuid: this.#referenceUuid(spell),
        transactionId: null,
        reconciled: true
      };
    }
    return null;
  }

  static async #relinkNativeGrant(actor, grant, oldItemId, newItemId) {
    if (!grant?.ownerItemId || !grant?.advancementId || !grant?.configuredUuid) return false;
    const owner = actor.items.get(grant.ownerItemId);
    if (!owner) return false;
    const raw = owner.toObject().system?.advancement?.[grant.advancementId];
    if (!raw) return false;
    const value = foundry.utils.deepClone(raw.value ?? {});
    value.added ??= {};
    delete value.added[oldItemId];
    value.added[newItemId] = grant.configuredUuid;
    await owner.update({ [`system.advancement.${grant.advancementId}.value`]: value }, {
      characterBuilderRuntimeManagement: true,
      characterBuilderHighElfCantripReplacement: true
    });
    return true;
  }

  static #lineageRootIds(lineage) {
    const ids = new Set([String(lineage.id)]);
    const speciesRoot = this.#speciesRootId(lineage);
    if (speciesRoot) ids.add(speciesRoot);
    const highElfSpecies = lineage?.actor?.items?.find?.(item => item.type === "race"
      && ["elf-high", "high-elf"].includes(String(item.system?.identifier ?? "")));
    if (highElfSpecies?.id) ids.add(String(highElfSpecies.id));
    return ids;
  }

  static #speciesRootId(lineage) {
    for (const reference of [
      lineage?.getFlag?.("dnd5e", "advancementRoot"),
      lineage?.getFlag?.("dnd5e", "advancementOrigin")
    ]) {
      const id = String(reference ?? "").split(".")[0];
      if (id) return id;
    }
    return null;
  }

  static async #wizardCantripPool(registry) {
    const spellLists = globalThis.dnd5e?.registry?.spellLists;
    if (!spellLists || !registry) return [];
    for (let attempt = 0; attempt < 20 && !spellLists.ready; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const list = spellLists.forType?.("class", "wizard");
    if (!list) return [];
    const options = new Map();
    for (const index of list.indexes ?? []) {
      if (Number(index.system?.level ?? -1) !== 0) continue;
      const identifier = String(index.system?.identifier ?? "");
      const preferred = identifier ? registry.preferredOption?.("spell", identifier) : null;
      if (preferred) options.set(identifier, preferred);
    }
    return [...options.values()].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang));
  }

  static async #sourceSpell(registry, uuid) {
    const target = String(uuid ?? "");
    if (!target) return null;
    const option = registry?.findOption?.(target) ?? registry?.sourceForUuid?.(target);
    return fromUuid(option?.uuid ?? target);
  }


  static #abilityLabel(ability) {
    return ({ int: "Intelligence", wis: "Wisdom", cha: "Charisma" })[String(ability ?? "").toLowerCase()]
      ?? String(ability ?? "").toUpperCase();
  }

  static #referenceUuid(item) {
    return item?.getFlag?.("dnd5e", "sourceId") ?? item?._stats?.compendiumSource ?? item?.uuid ?? null;
  }

  static #summary(item) {
    return item ? { id: item.id, uuid: item.uuid, name: item.name, img: item.img } : null;
  }
}
