import { MODULE_ID } from "../constants.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";

/**
 * Reconciles mandatory ItemGrant Advancements after the native D&D5e Level Up
 * flow. D&D5e remains the source of truth: item data is created through the
 * prepared Advancement document whenever possible, including spell
 * preparation, casting method, free uses, activities, effects, and origin
 * flags.
 *
 * Identity is grant-specific. An Item with the same name or identifier from a
 * different Advancement, preparation model, or consumption model never
 * satisfies this audit and is never merged here.
 */
export class ItemGrantReconciliationService {
  static async reconcile(draft, registry, state = LevelUpDraftManager.getState(draft)) {
    const sourceActor = game.actors.get(draft.getFlag(MODULE_ID, "sourceActorId"));
    const sourceItemIds = new Set(sourceActor?.items.map(item => item.id) ?? []);
    const queue = draft.items.filter(item => this.#belongsToSelectedProgression(item, draft, state));
    const processed = new Set();
    const summary = [];
    const repairedItemIds = [];

    while (queue.length) {
      const owner = queue.shift();
      if (!owner || processed.has(owner.id)) continue;
      processed.add(owner.id);

      const currentLevel = this.#currentLevel(owner, draft, state);
      const rawAdvancements = owner.toObject().system?.advancement ?? {};
      for (const [advancementId, raw] of Object.entries(rawAdvancements)) {
        if (raw?.type !== "ItemGrant") continue;
        const advancementLevel = Number(raw.level ?? 0);
        if (advancementLevel > currentLevel) continue;

        const expected = this.#mandatoryEntries(raw.configuration ?? {});
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
          const valid = tracked.filter(id => this.#isGrantInstance(draft.items.get(id), origin));

          // Recover a correctly-originated Item whose value.added link was lost.
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
            const data = await this.#createItemData({
              owner,
              advancement,
              raw,
              advancementId,
              advancementLevel,
              configuredUuid,
              resolvedUuid,
              itemId,
              occurrence: valid.length + occurrence,
              transactionId: state.transactionId
            });
            if (!data) {
              throw new Error(`Unable to restore mandatory ItemGrant ${configuredUuid} from ${owner.name}.`);
            }

            const [created] = await draft.createEmbeddedDocuments("Item", [data], {
              keepId: true,
              characterBuilderItemGrantReconciliation: true
            });
            if (!created) throw new Error(`D&D5e did not create a required Item from ${owner.name}.`);
            value.added[created.id] = configuredUuid;
            valid.push(created.id);
            repairedItemIds.push(created.id);
            valueChanged = true;
            if (created.system?.advancement && Object.keys(created.toObject().system?.advancement ?? {}).length) {
              queue.push(created);
            }
          }

          const rows = valid.slice(0, expectedCount)
            .map(id => draft.items.get(id))
            .filter(Boolean);
          const newlyUnlocked = advancementLevel === Number(state.targetClassLevel)
            || rows.some(item => !sourceItemIds.has(item.id));
          if (newlyUnlocked) {
            for (const item of rows) {
              if (summary.some(row => row.itemId === item.id && row.advancementOrigin === origin)) continue;
              summary.push(this.#summaryRow(item, owner, raw, advancementId, repairedItemIds.includes(item.id)));
            }
          }
        }

        // Remove only dead technical references for the UUIDs audited above.
        // Valid separate grants from any other Advancement remain untouched.
        const auditedUuids = new Set(expected.map(entry => entry.uuid));
        for (const [id, uuid] of Object.entries(value.added)) {
          if (!auditedUuids.has(uuid)) continue;
          const item = draft.items.get(id);
          if (this.#isGrantInstance(item, origin)) continue;
          delete value.added[id];
          valueChanged = true;
        }

        // Re-add the real IDs after dead references have been removed.
        for (const configuredUuid of auditedUuids) {
          for (const item of draft.items.filter(candidate =>
            this.#isGrantInstance(candidate, origin) && this.#sourceMatches(candidate, configuredUuid)
          )) value.added[item.id] = configuredUuid;
        }

        if (valueChanged) {
          await owner.update({ [`system.advancement.${advancementId}.value`]: value }, {
            characterBuilderItemGrantReconciliation: true
          });
        }
      }
    }

    const result = {
      checkedAt: Date.now(),
      transactionId: state.transactionId,
      repairedItemIds: [...new Set(repairedItemIds)],
      items: summary.sort((a, b) =>
        a.level - b.level || a.ownerName.localeCompare(b.ownerName, game.i18n.lang)
          || a.name.localeCompare(b.name, game.i18n.lang)
      )
    };
    await LevelUpDraftManager.setState(draft, { itemGrantReconciliation: result });
    return result;
  }

  /**
   * Block Commit if a mandatory grant is still represented only by a phantom
   * advancement value or by an Item from a different acquisition origin.
   */
  static validate(draft, state = LevelUpDraftManager.getState(draft)) {
    const failures = [];
    for (const owner of draft.items.filter(item => this.#belongsToSelectedProgression(item, draft, state))) {
      const currentLevel = this.#currentLevel(owner, draft, state);
      const rawAdvancements = owner.toObject().system?.advancement ?? {};
      for (const [advancementId, raw] of Object.entries(rawAdvancements)) {
        if (raw?.type !== "ItemGrant" || Number(raw.level ?? 0) > currentLevel) continue;
        const expectedCounts = this.#countByUuid(this.#mandatoryEntries(raw.configuration ?? {}));
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
      throw new Error(`Mandatory D&D5e ItemGrant reconciliation is incomplete: ${failures.join("; ")}. Reset this Level Up before committing.`);
    }
    return true;
  }

  static #mandatoryEntries(configuration) {
    const optionalGroup = Boolean(configuration.optional);
    return (configuration.items ?? [])
      .map(entry => typeof entry === "string" ? { uuid: entry, optional: false } : entry)
      .filter(entry => entry?.uuid && (!optionalGroup || !entry.optional));
  }

  static #countByUuid(entries) {
    const counts = new Map();
    for (const entry of entries) counts.set(entry.uuid, (counts.get(entry.uuid) ?? 0) + 1);
    return counts;
  }

  static #belongsToSelectedProgression(item, draft, state, seen = new Set()) {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);
    if (item.id === state.selectedClassId) return true;
    if (item.type === "class") return item.system?.identifier === state.selectedClassIdentifier;
    if (item.type === "subclass") {
      const classIdentifier = item.system?.classIdentifier ?? item.class?.system?.identifier;
      return classIdentifier === state.selectedClassIdentifier;
    }
    const root = item.getFlag("dnd5e", "advancementRoot") ?? item.getFlag("dnd5e", "advancementOrigin");
    const [rootId] = String(root ?? "").split(".");
    return rootId ? this.#belongsToSelectedProgression(draft.items.get(rootId), draft, state, seen) : false;
  }

  static #currentLevel(owner, draft, state) {
    if (owner.type === "class") return Number(owner.system?.levels ?? state.targetClassLevel ?? 0);
    if (owner.type === "subclass") {
      const identifier = owner.system?.classIdentifier ?? owner.class?.system?.identifier;
      const cls = draft.items.find(item => item.type === "class" && item.system?.identifier === identifier);
      return Number(cls?.system?.levels ?? state.targetClassLevel ?? 0);
    }
    const root = owner.getFlag("dnd5e", "advancementRoot") ?? owner.getFlag("dnd5e", "advancementOrigin");
    const [rootId] = String(root ?? "").split(".");
    const rootItem = rootId ? draft.items.get(rootId) : null;
    if (rootItem && rootItem.id !== owner.id) return this.#currentLevel(rootItem, draft, state);
    return Number(state.targetCharacterLevel ?? draft.system?.details?.level ?? 0);
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

    data.flags ??= {};
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
      reconciled: true
    };
    return data;
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

  static #summaryRow(item, owner, raw, advancementId, repaired) {
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
      repaired
    };
  }
}
