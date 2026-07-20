import { MODULE_ID } from "../constants.mjs";
import { DraftManager } from "./draft-manager.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";

/**
 * Shared mandatory ItemGrant integrity audit for both Character Creation and
 * Level Up. Each grant is identified by its owning Item and Advancement ID;
 * equal names or identifiers from another acquisition path never satisfy it.
 */
export class ItemGrantIntegrityService {
  static async reconcile(draft, registry, {
    context = "levelUp",
    state = null,
    recoveryActor = null
  } = {}) {
    const resolvedState = state ?? this.#state(draft, context);
    const sourceActor = game.actors.get(draft.getFlag(MODULE_ID, "sourceActorId"));
    const sourceItemIds = new Set(sourceActor?.items.map(item => item.id) ?? []);
    const queue = draft.items.filter(item => this.#belongsToContext(item, draft, resolvedState, context));
    const processed = new Set();
    const summary = [];
    const repairedItemIds = [];
    const recoveredFromNativeCloneIds = [];
    const removedDuplicateItemIds = [];

    while (queue.length) {
      const owner = queue.shift();
      if (!owner || processed.has(owner.id)) continue;
      processed.add(owner.id);

      const currentLevel = this.#currentLevel(owner, draft, resolvedState, context);
      const rawAdvancements = owner.toObject().system?.advancement ?? {};
      for (const [advancementId, raw] of Object.entries(rawAdvancements)) {
        if (raw?.type !== "ItemGrant") continue;
        const advancementLevel = Number(raw.level ?? 0);
        if (advancementLevel > currentLevel) continue;

        const expected = this.#mandatoryEntries(raw.configuration ?? {}, {
          owner, raw, advancementId
        });
        if (!expected.length) continue;
        const advancement = owner.advancement?.byId?.[advancementId] ?? null;
        const origin = `${owner.id}.${advancementId}`;
        const value = foundry.utils.deepClone(raw.value ?? {});
        value.added ??= {};
        let valueChanged = false;

        const expectedCounts = this.#countByUuid(expected);
        for (const [configuredUuid, expectedCount] of expectedCounts) {
          const tracked = Object.entries(value.added)
            .filter(([, uuid]) => uuid === configuredUuid)
            .map(([id]) => id);
          const valid = tracked.filter(id => {
            const item = draft.items.get(id);
            return this.#isGrantInstance(item, origin) && this.#sourceMatches(item, configuredUuid);
          });

          // Recover an existing correctly-originated Item whose value.added link was lost.
          const untracked = draft.items.filter(item =>
            this.#isGrantInstance(item, origin)
            && this.#sourceMatches(item, configuredUuid)
            && !valid.includes(item.id)
          );
          for (const item of untracked) {
            if (valid.length >= expectedCount) break;
            value.added[item.id] = configuredUuid;
            valid.push(item.id);
            valueChanged = true;
          }

          const missingCount = Math.max(0, expectedCount - valid.length);
          const reusableIds = tracked.filter(id => !draft.items.get(id));
          for (let occurrence = 0; occurrence < missingCount; occurrence++) {
            const itemId = reusableIds.shift() ?? foundry.utils.randomID();
            const resolvedUuid = await this.#resolveUuid(configuredUuid, registry);
            const recovered = this.#nativeCloneItemData({
              recoveryActor,
              itemId,
              origin,
              configuredUuid,
              resolvedUuid
            });
            const data = recovered ?? await this.#createItemData({
              owner,
              advancement,
              raw,
              advancementId,
              advancementLevel,
              configuredUuid,
              resolvedUuid,
              itemId,
              occurrence: valid.length + occurrence,
              transactionId: this.#transactionId(draft, resolvedState, context)
            });
            if (!data) {
              throw new Error(`Unable to restore mandatory ItemGrant ${configuredUuid} from ${owner.name}.`);
            }

            data._id = itemId;
            this.#ensureGrantMetadata(data, {
              owner,
              advancementId,
              advancementLevel,
              configuredUuid,
              resolvedUuid,
              occurrence: valid.length + occurrence,
              transactionId: this.#transactionId(draft, resolvedState, context),
              recoveredFromNativeClone: Boolean(recovered)
            });

            const [created] = await draft.createEmbeddedDocuments("Item", [data], {
              keepId: true,
              characterBuilderItemGrantIntegrity: true
            });
            if (!created) throw new Error(`D&D5e did not create a required Item from ${owner.name}.`);
            value.added[created.id] = configuredUuid;
            valid.push(created.id);
            repairedItemIds.push(created.id);
            if (recovered) recoveredFromNativeCloneIds.push(created.id);
            valueChanged = true;
            if (Object.keys(created.toObject().system?.advancement ?? {}).length) queue.push(created);
          }

          // Collapse only unequivocal technical duplicates: same owning Item,
          // same Advancement, and same configured grant. Equal names or source
          // UUIDs from another acquisition origin are never considered here.
          const matching = draft.items.filter(item =>
            this.#isGrantInstance(item, origin) && this.#sourceMatches(item, configuredUuid)
          );
          const keepIds = [];
          for (const id of valid) {
            if (keepIds.length >= expectedCount) break;
            if (matching.some(item => item.id === id) && !keepIds.includes(id)) keepIds.push(id);
          }
          for (const item of matching) {
            if (keepIds.length >= expectedCount) break;
            if (!keepIds.includes(item.id)) keepIds.push(item.id);
          }
          const excessIds = matching.map(item => item.id).filter(id => !keepIds.includes(id));
          if (excessIds.length) {
            await draft.deleteEmbeddedDocuments("Item", excessIds, {
              deleteContents: true,
              characterBuilderItemGrantIntegrity: true
            });
            removedDuplicateItemIds.push(...excessIds);
            valueChanged = true;
          }
          for (const id of tracked) {
            if (keepIds.includes(id)) continue;
            if (Object.prototype.hasOwnProperty.call(value.added, id)) {
              delete value.added[id];
              valueChanged = true;
            }
          }
          for (const id of keepIds) {
            if (value.added[id] !== configuredUuid) valueChanged = true;
            value.added[id] = configuredUuid;
          }

          const rows = keepIds
            .map(id => draft.items.get(id))
            .filter(Boolean);
          const newlyUnlocked = context === "creation"
            || advancementLevel === Number(resolvedState.targetClassLevel)
            || rows.some(item => !sourceItemIds.has(item.id));
          if (newlyUnlocked) {
            for (const item of rows) {
              if (summary.some(row => row.itemId === item.id && row.advancementOrigin === origin)) continue;
              summary.push(this.#summaryRow(item, owner, raw, advancementId, {
                repaired: repairedItemIds.includes(item.id),
                recoveredFromNativeClone: recoveredFromNativeCloneIds.includes(item.id)
              }));
            }
          }
        }

        // Remove only dead technical references for UUIDs audited above.
        const auditedUuids = new Set(expected.map(entry => entry.uuid));
        for (const [id, uuid] of Object.entries(value.added)) {
          if (!auditedUuids.has(uuid)) continue;
          const item = draft.items.get(id);
          if (this.#isGrantInstance(item, origin) && this.#sourceMatches(item, uuid)) continue;
          delete value.added[id];
          valueChanged = true;
        }


        if (valueChanged) {
          await owner.update({ [`system.advancement.${advancementId}.value`]: value }, {
            characterBuilderItemGrantIntegrity: true
          });
        }
      }
    }

    const result = {
      context,
      checkedAt: Date.now(),
      transactionId: this.#transactionId(draft, resolvedState, context),
      repairedItemIds: [...new Set(repairedItemIds)],
      recoveredFromNativeCloneIds: [...new Set(recoveredFromNativeCloneIds)],
      removedDuplicateItemIds: [...new Set(removedDuplicateItemIds)],
      items: summary.sort((a, b) =>
        a.level - b.level || a.ownerName.localeCompare(b.ownerName, game.i18n.lang)
          || a.name.localeCompare(b.name, game.i18n.lang)
      )
    };
    await this.#storeResult(draft, resolvedState, context, result);
    return result;
  }

  static validate(draft, { context = "levelUp", state = null } = {}) {
    const resolvedState = state ?? this.#state(draft, context);
    const failures = [];
    for (const owner of draft.items.filter(item => this.#belongsToContext(item, draft, resolvedState, context))) {
      const currentLevel = this.#currentLevel(owner, draft, resolvedState, context);
      const rawAdvancements = owner.toObject().system?.advancement ?? {};
      for (const [advancementId, raw] of Object.entries(rawAdvancements)) {
        if (raw?.type !== "ItemGrant" || Number(raw.level ?? 0) > currentLevel) continue;
        const expectedCounts = this.#countByUuid(this.#mandatoryEntries(raw.configuration ?? {}, {
          owner, raw, advancementId
        }));
        if (!expectedCounts.size) continue;
        const origin = `${owner.id}.${advancementId}`;
        const added = raw.value?.added ?? {};
        for (const [uuid, expectedCount] of expectedCounts) {
          const actual = Object.entries(added).filter(([id, configuredUuid]) =>
            configuredUuid === uuid && this.#isGrantInstance(draft.items.get(id), origin)
          ).length;
          if (actual < expectedCount) {
            failures.push(`${owner.name}: ${raw.title || "Item Grant"} (${actual}/${expectedCount})`);
          }
        }
      }
    }
    if (failures.length) {
      const workflow = context === "creation" ? "Character Creation" : "Level Up";
      throw new Error(`Mandatory D&D5e ItemGrant integrity is incomplete during ${workflow}: ${failures.join("; ")}.`);
    }
    return true;
  }

  static #state(draft, context) {
    return context === "creation"
      ? DraftManager.getBuildState(draft)
      : LevelUpDraftManager.getState(draft);
  }

  static async #storeResult(draft, state, context, result) {
    if (context === "creation") {
      await DraftManager.setBuildState(draft, { itemGrantIntegrity: result });
    } else {
      // Keep the old key for draft compatibility while 0.9.1 transactions exist.
      await LevelUpDraftManager.setState(draft, {
        itemGrantIntegrity: result,
        itemGrantReconciliation: result
      });
    }
  }

  static #transactionId(draft, state, context) {
    if (state?.transactionId) return state.transactionId;
    return context === "creation" ? `creation:${draft.id}` : `level-up:${draft.id}`;
  }

  static #mandatoryEntries(configuration, { owner = null, raw = null, advancementId = null } = {}) {
    const optionalGroup = Boolean(configuration.optional);
    return (configuration.items ?? [])
      .map(entry => typeof entry === "string" ? { uuid: entry, optional: false } : entry)
      .filter(entry => entry?.uuid && (!optionalGroup || !entry.optional))
      .filter(entry => !this.#isRedundantMalformedLocalGrant(entry.uuid, {
        owner, raw, advancementId
      }));
  }

  /**
   * Some PHB 2024 documents contain a malformed local Item UUID and a second,
   * canonical Compendium UUID for the exact same mandatory grant at the exact
   * same level. Ignore only that provably redundant malformed entry. Global
   * mandatory ItemGrant validation remains strict for every other case.
   */
  static #isRedundantMalformedLocalGrant(uuid, { owner, raw, advancementId } = {}) {
    const match = /^Item\.([A-Za-z0-9]{16})$/.exec(String(uuid ?? ""));
    if (!match || !owner || !raw) return false;
    const itemId = match[1];
    const level = Number(raw.level ?? 0);
    const advancements = owner.toObject().system?.advancement ?? {};
    for (const [otherId, other] of Object.entries(advancements)) {
      if (otherId === advancementId || other?.type !== "ItemGrant" || Number(other.level ?? 0) !== level) continue;
      const optionalGroup = Boolean(other.configuration?.optional);
      for (const configured of other.configuration?.items ?? []) {
        const row = typeof configured === "string" ? { uuid: configured, optional: false } : configured;
        if (!row?.uuid || (optionalGroup && row.optional)) continue;
        const canonical = String(row.uuid);
        if (!canonical.startsWith("Compendium.") || !canonical.endsWith(`.Item.${itemId}`)) continue;
        if (this.#canonicalUuidResolvable(canonical)) return true;
      }
    }
    return false;
  }

  static #canonicalUuidResolvable(uuid) {
    try {
      if (typeof fromUuidSync === "function" && fromUuidSync(uuid)) return true;
    } catch (_error) {
      // Fall through to the already indexed Compendium lookup below.
    }
    const match = /^Compendium\.([^.]*(?:\.[^.]*)*)\.Item\.([A-Za-z0-9]{16})$/.exec(String(uuid ?? ""));
    if (!match) return false;
    const [, collection, itemId] = match;
    const pack = game.packs.get(collection);
    if (!pack) return false;
    return Boolean(pack.index?.get?.(itemId)
      ?? pack.index?.find?.(entry => entry?._id === itemId));
  }

  static #countByUuid(entries) {
    const counts = new Map();
    for (const entry of entries) counts.set(entry.uuid, (counts.get(entry.uuid) ?? 0) + 1);
    return counts;
  }

  static #belongsToContext(item, _draft, _state, _context) {
    // Integrity is Actor-wide. During a Class Level Up, total character level
    // can also unlock Species, Feat, or other linked Advancements, and older
    // mandatory grants from any acquisition path may already be phantom. The
    // per-owner current-level calculation below prevents future grants from
    // being applied early.
    return Boolean(item);
  }

  static #currentLevel(owner, draft, state, context) {
    if (owner.type === "class") return Number(owner.system?.levels ?? state.targetClassLevel ?? 0);
    if (owner.type === "subclass") {
      const identifier = owner.system?.classIdentifier ?? owner.class?.system?.identifier;
      const cls = draft.items.find(item => item.type === "class" && item.system?.identifier === identifier);
      return Number(cls?.system?.levels ?? state.targetClassLevel ?? 0);
    }
    const root = owner.getFlag("dnd5e", "advancementRoot") ?? owner.getFlag("dnd5e", "advancementOrigin");
    const [rootId] = String(root ?? "").split(".");
    const rootItem = rootId ? draft.items.get(rootId) : null;
    if (rootItem && rootItem.id !== owner.id) return this.#currentLevel(rootItem, draft, state, context);
    const total = Number(draft.system?.details?.level ?? state.targetCharacterLevel ?? 0);
    return Math.max(context === "creation" ? 1 : 0, total);
  }

  static #isGrantInstance(item, origin) {
    return Boolean(item && item.getFlag("dnd5e", "advancementOrigin") === origin);
  }

  static #sourceMatches(item, configuredUuid) {
    if (!item) return false;
    const grant = item.getFlag(MODULE_ID, "itemGrantInstance");
    if (grant?.configuredUuid === configuredUuid) return true;
    const sourceUuid = item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource;
    if (sourceUuid === configuredUuid) return true;
    const configured = fromUuidSync(configuredUuid);
    return Boolean(configured?.system?.identifier
      && item.type === configured.type
      && item.system?.identifier === configured.system.identifier);
  }

  static async #resolveUuid(configuredUuid, registry) {
    if (!registry || registry.isUuidAllowed(configuredUuid)) return configuredUuid;
    const source = await fromUuid(configuredUuid);
    const preferred = source?.system?.identifier
      ? registry.preferredOption(source.type, source.system.identifier)
      : null;
    if (!preferred) throw new Error(`The mandatory grant ${source?.name ?? configuredUuid} is unavailable from enabled sources.`);
    return preferred.uuid;
  }

  static #nativeCloneItemData({ recoveryActor, itemId, origin, configuredUuid, resolvedUuid }) {
    if (!recoveryActor?.items) return null;
    const exact = recoveryActor.items.get(itemId);
    const candidate = exact ?? recoveryActor.items.find(item =>
      this.#isGrantInstance(item, origin)
      && (this.#sourceMatches(item, configuredUuid) || this.#sourceMatches(item, resolvedUuid))
    );
    if (!candidate) return null;
    // A native clone from a filtered-out source must not be resurrected when
    // the registry resolved this grant to a different enabled document.
    if (resolvedUuid !== configuredUuid && !this.#sourceMatches(candidate, resolvedUuid)) return null;
    const data = foundry.utils.deepClone(candidate._source ?? candidate.toObject());
    data._id = itemId;
    return data;
  }

  static async #createItemData({
    owner, advancement, raw, advancementId, advancementLevel, configuredUuid,
    resolvedUuid, itemId, occurrence, transactionId
  }) {
    let data = advancement?.createItemData
      ? await advancement.createItemData(resolvedUuid, itemId)
      : null;
    if (!data) {
      const source = await fromUuid(resolvedUuid);
      if (!source) return null;
      data = source.toObject();
      data._id = itemId;
      data.flags ??= {};
      data.flags.dnd5e ??= {};
      data.flags.dnd5e.sourceId = resolvedUuid;
      data.flags.dnd5e.advancementOrigin = `${owner.id}.${advancementId}`;
      data.flags.dnd5e.advancementRoot = owner.getFlag("dnd5e", "advancementRoot")
        ?? `${owner.id}.${advancementId}`;
    }

    if (data.type === "spell") {
      const ability = advancement?.value?.ability ?? this.#first(raw.configuration?.spell?.ability);
      if (advancement?.configuration?.spell?.applySpellChanges) {
        advancement.configuration.spell.applySpellChanges(data, { ability });
      } else this.#applyRawSpellConfiguration(data, raw.configuration?.spell, owner, ability);
    }

    this.#ensureGrantMetadata(data, {
      owner,
      advancementId,
      advancementLevel,
      configuredUuid,
      resolvedUuid,
      occurrence,
      transactionId,
      recoveredFromNativeClone: false
    });
    return data;
  }

  static #ensureGrantMetadata(data, {
    owner, advancementId, advancementLevel, configuredUuid, resolvedUuid,
    occurrence, transactionId, recoveredFromNativeClone
  }) {
    data.flags ??= {};
    data.flags.dnd5e ??= {};
    data.flags.dnd5e.sourceId = resolvedUuid;
    data.flags.dnd5e.advancementOrigin = `${owner.id}.${advancementId}`;
    data.flags.dnd5e.advancementRoot ??= owner.getFlag("dnd5e", "advancementRoot")
      ?? `${owner.id}.${advancementId}`;
    data.flags[MODULE_ID] ??= {};
    data.flags[MODULE_ID].itemGrantInstance = {
      transactionId,
      ownerItemId: owner.id,
      ownerIdentifier: owner.system?.identifier ?? null,
      advancementId,
      advancementLevel,
      configuredUuid,
      sourceUuid: resolvedUuid,
      occurrence,
      reconciled: true,
      recoveredFromNativeClone
    };
  }

  static #applyRawSpellConfiguration(itemData, spell, owner, ability) {
    if (!spell) return;
    const abilities = Array.isArray(spell.ability) ? spell.ability : [...(spell.ability ?? [])];
    const selectedAbility = abilities.includes(ability) ? ability : abilities[0];
    if (selectedAbility) foundry.utils.setProperty(itemData, "system.ability", selectedAbility);
    if (spell.method) {
      foundry.utils.setProperty(itemData, "system.method", spell.method);
      foundry.utils.setProperty(itemData, "system.prepared", Number(spell.prepared ?? 0));
    }
    if (owner.system?.identifier) {
      foundry.utils.setProperty(itemData, "system.sourceItem", `${owner.type}:${owner.system.identifier}`);
    }
    if (!spell.uses?.max || !spell.uses?.per) return;

    foundry.utils.setProperty(itemData, "system.uses.max", spell.uses.max);
    itemData.system.uses.recovery ??= [];
    itemData.system.uses.recovery.push({ period: spell.uses.per, type: "recoverAll" });
    const spellcasting = CONFIG.DND5E.spellcasting[itemData.system.method];
    const createForwardActivity = !spell.uses.requireSlot && spellcasting?.slots;
    for (const activity of Object.values(itemData.system.activities ?? {})) {
      if (!activity.consumption?.spellSlot) continue;
      if (createForwardActivity) {
        const newId = foundry.utils.randomID();
        foundry.utils.setProperty(itemData, `system.activities.${newId}`, {
          _id: newId,
          type: "forward",
          name: `${activity.name ?? "Cast"} (free casting)`,
          sort: Number(activity.sort ?? 0) + 1,
          activity: { id: activity._id },
          consumption: { targets: [{ type: "itemUses", target: "", value: "1" }] }
        });
      } else {
        activity.consumption.targets ??= [];
        activity.consumption.targets.push({ type: "itemUses", target: "", value: "1" });
      }
    }
  }

  static #first(value) {
    if (!value) return null;
    if (typeof value.first === "function") return value.first();
    if (Array.isArray(value)) return value[0] ?? null;
    if (value instanceof Set) return value.values().next().value ?? null;
    return null;
  }

  static #summaryRow(item, owner, raw, advancementId, { repaired, recoveredFromNativeClone }) {
    const alwaysPrepared = item.type === "spell" && Number(item.system?.prepared ?? 0) === 2;
    const uses = item.system?.uses ?? {};
    return {
      itemId: item.id,
      uuid: item.uuid,
      name: item.name,
      img: item.img,
      type: item.type,
      identifier: item.system?.identifier ?? null,
      ownerItemId: owner.id,
      ownerName: owner.name,
      ownerType: owner.type,
      advancementId,
      advancementOrigin: `${owner.id}.${advancementId}`,
      advancementTitle: raw.title || "Automatic Grant",
      level: Number(raw.level ?? 0),
      alwaysPrepared,
      castingMethod: item.system?.method ?? null,
      freeUses: uses.max && uses.recovery?.length ? String(uses.max) : null,
      repaired,
      recoveredFromNativeClone
    };
  }
}
