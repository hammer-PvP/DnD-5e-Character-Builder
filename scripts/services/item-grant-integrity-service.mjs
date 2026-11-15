import { MODULE_ID } from "../constants.mjs";
import { DraftManager } from "./draft-manager.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";
import { firstValue } from "../utils/safe-collections.mjs";
import { advancementName, writeAdvancementValue, repairAdvancementRecords, hasSerializedAdvancementReplacement, readAdvancementRecords } from "../utils/advancement-utils.mjs";

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
    await repairAdvancementRecords(draft);
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
      const rawAdvancements = readAdvancementRecords(owner);
      for (const [advancementId, raw] of Object.entries(rawAdvancements)) {
        if (raw?.type !== "ItemGrant" || hasSerializedAdvancementReplacement(raw)) continue;
        const advancementLevel = Number(raw.level ?? 0);
        if (advancementLevel > currentLevel) continue;

        const linked = this.#linkedGrantOwners(draft, owner, raw, advancementId);
        const linkedSources = await Promise.all(linked.uuids.map(uuid => fromUuid(uuid)));
        const expected = this.#mandatoryEntries(raw.configuration ?? {}, {
          owner, raw, advancementId, linkedOwners: [...linked.items, ...linkedSources.filter(Boolean)]
        });
        if (!expected.length) continue;
        const advancement = owner.advancement?.byId?.[advancementId] ?? null;
        const origin = `${owner.id}.${advancementId}`;
        const value = foundry.utils.deepClone(raw.value ?? {});
        value.added ??= {};
        let valueChanged = false;

        const expectedCounts = this.#countByUuid(expected);
        const matchesByReference = new Map();
        for (const [configuredUuid, expectedCount] of expectedCounts) {
          const siblingUuid = this.#samePackReference(configuredUuid, owner, registry);
          const enabledSibling = siblingUuid && (!registry || registry.isUuidAllowed(siblingUuid)) ? siblingUuid : null;
          const matches = item => this.#sourceMatches(item, configuredUuid)
            || (enabledSibling && this.#sourceMatches(item, enabledSibling));
          matchesByReference.set(configuredUuid, matches);
          const tracked = Object.entries(value.added)
            .filter(([, uuid]) => uuid === configuredUuid || uuid === enabledSibling)
            .map(([id]) => id);
          const valid = tracked.filter(id => {
            const item = draft.items.get(id);
            return this.#isGrantInstance(item, origin) && matches(item);
          });

          // Recover an existing correctly-originated Item whose value.added link was lost.
          const untracked = draft.items.filter(item =>
            this.#isGrantInstance(item, origin)
            && matches(item)
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
            const resolvedUuid = await this.#resolveUuid(siblingUuid ?? configuredUuid, registry);
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
            this.#normalizeCurrentGrantSpellData(data);
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
            this.#isGrantInstance(item, origin) && matches(item)
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
          // Normalize only Items produced by the active workflow. Existing
          // source-Actor Items are intentionally left untouched so this audit
          // never becomes a migration or a homebrew repair pass.
          const currentFlowRows = rows.filter(item => !sourceItemIds.has(item.id));
          for (const item of currentFlowRows) await this.#normalizeCurrentGrantSpellItem(item);

          const newlyUnlocked = context === "creation"
            || this.#advancementUnlockedInCurrentTransaction(owner, advancementLevel, draft, resolvedState, context)
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
        for (const [id, uuid] of Object.entries(value.added)) {
          const matches = matchesByReference.get(uuid);
          if (!matches) continue;
          const item = draft.items.get(id);
          if (this.#isGrantInstance(item, origin) && matches(item)) continue;
          delete value.added[id];
          valueChanged = true;
        }


        if (valueChanged) {
          await writeAdvancementValue(owner, advancementId, value, {
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
      const rawAdvancements = readAdvancementRecords(owner);
      for (const [advancementId, raw] of Object.entries(rawAdvancements)) {
        if (raw?.type !== "ItemGrant" || Number(raw.level ?? 0) > currentLevel) continue;
        const linked = this.#linkedGrantOwners(draft, owner, raw, advancementId);
        const expectedCounts = this.#countByUuid(this.#mandatoryEntries(raw.configuration ?? {}, {
          owner, raw, advancementId, linkedOwners: linked.items
        }));
        if (!expectedCounts.size) continue;
        if (hasSerializedAdvancementReplacement(raw)) {
          failures.push(`${owner.name}: ${advancementName(raw, "Item Grant")} (invalid saved record)`);
          continue;
        }
        const origin = `${owner.id}.${advancementId}`;
        const added = raw.value?.added ?? {};
        for (const [uuid, expectedCount] of expectedCounts) {
          const actual = Object.entries(added).filter(([id, configuredUuid]) =>
            configuredUuid === uuid && this.#isGrantInstance(draft.items.get(id), origin)
          ).length;
          if (actual < expectedCount) {
            failures.push(`${owner.name}: ${advancementName(raw, "Item Grant")} (${actual}/${expectedCount})`);
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

  static #configuredMandatoryEntries(configuration) {
    return Object.values(configuration?.items ?? {})
      .map(entry => typeof entry === "string" ? { uuid: entry, optional: false } : entry)
      .filter(entry => entry?.uuid && (!configuration.optional || !entry.optional));
  }

  static #linkedGrantOwners(draft, owner, raw, advancementId) {
    const entries = this.#configuredMandatoryEntries(raw.configuration);
    if (!entries.some(({ uuid }) => /^Item\.[A-Za-z0-9]{16}$/.test(uuid))) return { items: [], uuids: [] };
    const source = owner.getFlag("dnd5e", "sourceId") ?? owner._stats?.compendiumSource;
    const pack = /^Compendium\.(.+)\.Item\.[A-Za-z0-9]{16}$/.exec(source ?? "")?.[1];
    if (!pack) return { items: [], uuids: [] };
    const prefix = `Compendium.${pack}.Item.`;
    const uuids = new Set(entries.map(({ uuid }) => uuid).filter(uuid => uuid.startsWith(prefix)));
    const origin = `${owner.id}.${advancementId}`;
    const items = draft.items.filter(item => this.#isGrantInstance(item, origin)
      && uuids.has(item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource));
    for (const item of items) uuids.delete(item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource);
    return { items, uuids: [...uuids] };
  }

  static #mandatoryEntries(configuration, { owner, raw, advancementId, linkedOwners }) {
    return this.#configuredMandatoryEntries(configuration)
      .filter(({ uuid }) => !this.#isRedundantMalformedLocalGrant(uuid, { owner, raw, advancementId, linkedOwners }));
  }

  /** Keep the canonical grant when the same acquisition graph already declares it. */
  static #isRedundantMalformedLocalGrant(uuid, { owner, raw, advancementId, linkedOwners }) {
    const match = /^Item\.([A-Za-z0-9]{16})$/.exec(String(uuid ?? ""));
    if (!match || !owner || !raw) return false;
    const itemId = match[1];
    const level = Number(raw.level ?? 0);
    const siblingGrants = Object.entries(readAdvancementRecords(owner))
      .filter(([id]) => id !== advancementId).map(([, row]) => row);
    const isCanonicalAtLevel = (row, matches) => row?.type === "ItemGrant" && Number(row.level ?? 0) === level
      && this.#configuredMandatoryEntries(row.configuration).some(({ uuid: canonical }) =>
        matches(canonical) && this.#canonicalUuidResolvable(canonical));
    if (siblingGrants.some(row => isCanonicalAtLevel(row, canonical =>
      canonical.startsWith("Compendium.") && canonical.endsWith(`.Item.${itemId}`)
    ))) return true;

    const target = this.#samePackReference(uuid, owner);
    return Boolean(target && (
      isCanonicalAtLevel(raw, canonical => canonical === target)
      || linkedOwners.some(linked => Object.values(readAdvancementRecords(linked)).some(row =>
        isCanonicalAtLevel(row, canonical => canonical === target)
      ))
    ));
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


  static #advancementUnlockedInCurrentTransaction(owner, advancementLevel, draft, state, context) {
    if (context === "creation") return true;
    const level = Number(advancementLevel ?? 0);
    if (!level) return false;

    const owningClass = this.#owningClass(owner, draft);
    if (owningClass) {
      const selectedClass = state?.selectedClassId ? draft.items.get(state.selectedClassId) : null;
      const selectedIdentifier = String(state?.selectedClassIdentifier ?? selectedClass?.system?.identifier ?? "");
      const sameClass = owningClass.id === selectedClass?.id
        || (selectedIdentifier && String(owningClass.system?.identifier ?? "") === selectedIdentifier);
      if (!sameClass) return false;
      const from = Number(state?.sourceClassLevel ?? 0);
      const to = Number(state?.targetClassLevel ?? owningClass.system?.levels ?? 0);
      return level > from && level <= to;
    }

    // Non-class-rooted progression (Species, Background, stand-alone Feats,
    // etc.) follows total character level. This keeps Actor-wide integrity
    // repair intact without confusing an unrelated class level N with an old
    // grant that also happened to unlock at level N.
    const from = Number(state?.sourceCharacterLevel ?? 0);
    const to = Number(state?.targetCharacterLevel ?? draft.system?.details?.level ?? 0);
    return level > from && level <= to;
  }

  static #owningClass(owner, draft, visited = new Set()) {
    if (!owner || visited.has(owner.id)) return null;
    visited.add(owner.id);
    if (owner.type === "class") return owner;
    if (owner.type === "subclass") {
      const identifier = owner.system?.classIdentifier ?? owner.system?.class?.identifier ?? owner.system?.class;
      return draft.items.find(item => item.type === "class" && item.system?.identifier === identifier) ?? null;
    }
    const reference = owner.getFlag?.("dnd5e", "advancementRoot") ?? owner.getFlag?.("dnd5e", "advancementOrigin");
    const rootId = String(reference ?? "").split(".")[0];
    const rootItem = rootId ? draft.items.get(rootId) : null;
    return rootItem && rootItem.id !== owner.id ? this.#owningClass(rootItem, draft, visited) : null;
  }

  static #isGrantInstance(item, origin) {
    if (!item) return false;
    if (item.getFlag("dnd5e", "advancementOrigin") === origin) return true;
    const receipts = item.getFlag(MODULE_ID, "mergedItemGrants") ?? [];
    return receipts.some(receipt => receipt?.advancementOrigin === origin);
  }

  static #sourceMatches(item, configuredUuid) {
    if (!item) return false;
    const grant = item.getFlag(MODULE_ID, "itemGrantInstance");
    if (grant?.configuredUuid === configuredUuid) return true;
    const receipts = item.getFlag(MODULE_ID, "mergedItemGrants") ?? [];
    if (receipts.some(receipt => receipt?.configuredUuid === configuredUuid)) return true;
    const sourceUuid = item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource;
    if (sourceUuid === configuredUuid) return true;
    const configured = fromUuidSync(configuredUuid);
    return Boolean(configured?.system?.identifier
      && item.type === configured.type
      && item.system?.identifier === configured.system.identifier);
  }

  static #samePackReference(configuredUuid, owner, registry) {
    // An unqualified Item reference can name a sibling of the source document.
    // Resolve against that exact pack before consulting world Items.
    const local = /^Item\.([A-Za-z0-9]{16})$/.exec(configuredUuid);
    const ownerSource = owner.getFlag("dnd5e", "sourceId") ?? owner._stats?.compendiumSource;
    const pack = /^Compendium\.(.+)\.Item\.[A-Za-z0-9]{16}$/.exec(ownerSource ?? "")?.[1];
    if (local && pack) {
      const sibling = `Compendium.${pack}.Item.${local[1]}`;
      if (registry?.sourceForUuid?.(sibling) || this.#canonicalUuidResolvable(sibling)) return sibling;
    }
    return null;
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
        ?? owner.getFlag("dnd5e", "advancementOrigin")
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


  static #normalizeCurrentGrantSpellData(data) {
    if (data?.type !== "spell") return false;
    if (Number(foundry.utils.getProperty(data, "system.level") ?? -1) !== 0) return false;
    if (Number(foundry.utils.getProperty(data, "system.prepared") ?? -1)
      === SpellPreparationPolicyService.ALWAYS_PREPARED) return false;
    foundry.utils.setProperty(
      data,
      "system.prepared",
      SpellPreparationPolicyService.ALWAYS_PREPARED
    );
    return true;
  }

  static async #normalizeCurrentGrantSpellItem(item) {
    if (item?.type !== "spell" || Number(item.system?.level ?? -1) !== 0) return false;
    if (Number(item.system?.prepared ?? -1) === SpellPreparationPolicyService.ALWAYS_PREPARED) return false;
    await item.update({
      "system.prepared": SpellPreparationPolicyService.ALWAYS_PREPARED
    }, {
      characterBuilderItemGrantIntegrity: true,
      characterBuilderSpellPreparationPolicy: true
    });
    return true;
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
      ?? owner.getFlag("dnd5e", "advancementOrigin")
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
      foundry.utils.setProperty(itemData, "system.prepared", SpellPreparationPolicyService.resolve({
        level: foundry.utils.getProperty(itemData, "system.level"),
        explicitPrepared: spell.prepared,
        alwaysPrepared: Number(spell.prepared ?? 0) === SpellPreparationPolicyService.ALWAYS_PREPARED,
        category: "native-item-grant"
      }));
    } else if (Number(foundry.utils.getProperty(itemData, "system.level")) === 0) {
      foundry.utils.setProperty(itemData, "system.prepared", SpellPreparationPolicyService.ALWAYS_PREPARED);
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
    return firstValue(value);
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
      advancementTitle: advancementName(raw, "Automatic Grant"),
      level: Number(raw.level ?? 0),
      alwaysPrepared,
      castingMethod: item.system?.method ?? null,
      freeUses: uses.max && uses.recovery?.length ? String(uses.max) : null,
      repaired,
      recoveredFromNativeClone
    };
  }
}
