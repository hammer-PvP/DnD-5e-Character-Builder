import { MODULE_ID } from "../constants.mjs";
import { SourceResolver } from "./source-resolver.mjs";
import { NativeAdvancementModalGuard } from "./native-advancement-modal-guard.mjs";

/**
 * Character Builder-owned Sorcerer Metamagic selection and replacement.
 *
 * The source ItemChoice remains the structural authority. Character Builder
 * owns only the selection UI, projected duplicate validation, exact embedded
 * Item creation/removal, and the native Advancement value records.
 */
export class MetamagicService {
  static async buildContext(draft, cls, registry, {
    oldClassLevel = 0,
    newClassLevel = 0,
    stateChoices = {}
  } = {}) {
    if (String(cls?.system?.identifier ?? "") !== "sorcerer") return this.emptyContext();

    const targetLevel = Number(newClassLevel ?? cls.system?.levels ?? 0);
    const previousLevel = Number(oldClassLevel ?? Math.max(0, targetLevel - 1));
    const advancement = this.#findAdvancement(cls);
    if (!advancement) {
      if (targetLevel >= 2) {
        throw new Error("The Sorcerer source does not contain the Metamagic ItemChoice Advancement required for this Level Up.");
      }
      return this.emptyContext();
    }

    const row = advancement.configuration?.choices?.[String(targetLevel)] ?? {};
    const sourceCount = Number(row.count ?? 0) || 0;
    const fallbackCount = [2, 10, 17].includes(targetLevel) && previousLevel < targetLevel ? 2 : 0;
    const count = sourceCount || fallbackCount;
    const allowReplacement = previousLevel >= 2 && targetLevel > previousLevel;

    const pool = await this.#loadPool(advancement, registry);
    const poolUuids = new Set(pool.map(option => option.uuid));
    const poolIdentifiers = new Set(pool.map(option => option.identifier));
    const advancementItemIds = this.#advancementItemIds(advancement);
    const advancementOrigin = `${cls.id}.${advancement._id}`;

    const existingItems = draft.items.filter(item => {
      if (advancementItemIds.has(item.id)) return true;
      const origin = item.getFlag("dnd5e", "advancementOrigin") ?? item.getFlag("dnd5e", "advancementRoot");
      if (origin === advancementOrigin) return true;
      const sourceUuid = item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource;
      const identifier = String(item.system?.identifier ?? this.#slug(item.name));
      return (sourceUuid && poolUuids.has(String(sourceUuid))) || poolIdentifiers.has(identifier);
    });

    const existing = (await Promise.all(existingItems.map(async item => {
      const sourceUuid = String(item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? "");
      const source = sourceUuid ? registry.sourceForUuid(sourceUuid) : null;
      return {
        id: item.id,
        name: item.name,
        img: item.img,
        identifier: String(item.system?.identifier ?? this.#slug(item.name)),
        uuid: sourceUuid || item.uuid,
        sourceLabel: source?.sourceLabel ?? source?.label ?? item.system?.source?.book ?? "Owned Metamagic",
        description: await this.#enrichDescription(item),
        acquiredLevel: this.#findAdvancementItemLevel(advancement, item.id, targetLevel)
      };
    }))).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    const knownIdentifiers = new Set(existing.map(item => item.identifier));
    const knownUuids = new Set(existing.map(item => item.uuid).filter(Boolean));
    const selectedUuids = new Set(stateChoices.metamagicSelections ?? []);
    const selectedReplacementUuid = String(stateChoices.metamagicReplacement?.uuid ?? "");

    const options = pool.map(option => {
      const alreadyKnown = knownIdentifiers.has(option.identifier) || knownUuids.has(option.uuid);
      const checked = selectedUuids.has(option.uuid);
      return {
        ...option,
        alreadyKnown,
        checked,
        disabled: alreadyKnown && !checked,
        disabledReason: alreadyKnown ? "Already known" : ""
      };
    });

    const groups = registry.groupOptions(options);
    const replacementOptions = options.map(option => ({
      ...option,
      checked: false,
      disabled: option.alreadyKnown,
      disabledReason: option.alreadyKnown ? "Already known" : "",
      selected: selectedReplacementUuid === option.uuid
    }));

    const selectedRemoveId = String(stateChoices.metamagicReplacement?.removeId ?? "");
    const selectedCount = [...selectedUuids].filter(uuid => options.some(option => option.uuid === uuid)).length;
    const pairComplete = Boolean(selectedRemoveId) === Boolean(selectedReplacementUuid);
    const selectionComplete = selectedCount === count;

    return {
      active: count > 0 || (allowReplacement && existing.length > 0),
      advancementId: advancement._id,
      count,
      selectedCount,
      options,
      groups,
      existing,
      existingIdentifiers: [...knownIdentifiers],
      existingIdentifiersString: [...knownIdentifiers].join("|"),
      replacement: {
        available: allowReplacement && existing.length > 0,
        selectedRemoveId,
        selectedUuid: selectedReplacementUuid,
        existing,
        options: replacementOptions,
        groups: registry.groupOptions(replacementOptions)
      },
      complete: selectionComplete && pairComplete,
      note: count
        ? `Choose ${count} new Metamagic option${count === 1 ? "" : "s"}. Options already known remain visible but unavailable.`
        : "This Sorcerer level allows one optional Metamagic replacement.",
      warning: ""
    };
  }

  static async apply(draft, cls, registry, formData, context, state) {
    if (!context?.active) {
      return {
        createdItemIds: [],
        deletedItemIds: [],
        choices: { selections: [], replacement: null }
      };
    }

    const selectedUuids = [...new Set(formData.getAll("levelUp.metamagic").map(String).filter(Boolean))];
    if (selectedUuids.length !== Number(context.count ?? 0)) {
      throw new Error(`Choose exactly ${context.count} new Metamagic option${context.count === 1 ? "" : "s"}.`);
    }

    const byUuid = new Map(context.options.map(option => [option.uuid, option]));
    const selectedIdentifiers = new Set();
    for (const uuid of selectedUuids) {
      const option = byUuid.get(uuid);
      if (!option) throw new Error("A selected Metamagic option is not available from the enabled sources.");
      if (option.alreadyKnown) throw new Error(`${option.name} is already known and cannot be selected again.`);
      if (selectedIdentifiers.has(option.identifier)) throw new Error(`${option.name} cannot be selected more than once.`);
      selectedIdentifiers.add(option.identifier);
    }

    const removeId = String(formData.get("levelUp.replaceMetamagic.remove") ?? "");
    const replacementUuid = String(formData.get("levelUp.replaceMetamagic.add") ?? "");
    if (Boolean(removeId) !== Boolean(replacementUuid)) {
      throw new Error("Choose both sides of the optional Metamagic replacement, or leave both blank.");
    }

    const original = removeId
      ? context.replacement.existing.find(item => item.id === removeId)
      : null;
    if (removeId && !original) throw new Error("The Metamagic option selected for replacement is not eligible.");

    const replacementOption = replacementUuid ? byUuid.get(replacementUuid) : null;
    if (replacementUuid && !replacementOption) {
      throw new Error("The replacement Metamagic option is not available from the enabled sources.");
    }
    if (replacementOption?.alreadyKnown) {
      throw new Error(`${replacementOption.name} is already known and cannot be used as a replacement.`);
    }
    if (replacementOption && selectedIdentifiers.has(replacementOption.identifier)) {
      throw new Error(`${replacementOption.name} is already selected as a new Metamagic option during this Level Up.`);
    }
    if (replacementOption && original?.identifier === replacementOption.identifier) {
      throw new Error("A Metamagic option cannot replace itself.");
    }

    const createdItemIds = [];
    const deletedItemIds = [];
    for (const uuid of selectedUuids) {
      const item = await this.#createOption(draft, cls, context, byUuid.get(uuid), state, registry);
      createdItemIds.push(item.id);
    }

    let replacementRecord = null;
    if (original && replacementOption) {
      const originalLevel = Number(original.acquiredLevel ?? this.#findAdvancementItemLevel(
        this.#findAdvancement(cls), original.id, state.targetClassLevel
      ));
      await draft.deleteEmbeddedDocuments("Item", [original.id], {
        deleteContents: true,
        characterBuilderMetamagicReplacement: true
      });
      deletedItemIds.push(original.id);
      const item = await this.#createOption(draft, cls, context, replacementOption, state, registry);
      createdItemIds.push(item.id);
      replacementRecord = {
        original: original.id,
        originalLevel,
        replacement: item.id
      };
    }

    await this.#writeAdvancementValue(
      cls,
      context.advancementId,
      state.targetClassLevel,
      createdItemIds,
      replacementRecord
    );

    return {
      createdItemIds,
      deletedItemIds,
      choices: {
        selections: selectedUuids,
        replacement: replacementRecord ? {
          removeId,
          uuid: replacementUuid,
          originalIdentifier: original.identifier,
          replacementIdentifier: replacementOption.identifier
        } : null
      }
    };
  }

  static emptyContext({ warning = "" } = {}) {
    return {
      active: false,
      advancementId: null,
      count: 0,
      selectedCount: 0,
      options: [],
      groups: [],
      existing: [],
      existingIdentifiers: [],
      existingIdentifiersString: "",
      replacement: {
        available: false,
        selectedRemoveId: "",
        selectedUuid: "",
        existing: [],
        options: [],
        groups: []
      },
      complete: true,
      note: "",
      warning
    };
  }

  static #findAdvancement(cls) {
    return this.#advancementData(cls).find(entry => {
      if (String(entry.type ?? "") !== "ItemChoice") return false;
      const title = String(entry.title ?? "").trim().toLowerCase();
      return title === "metamagic" || title === "metamagic options";
    }) ?? null;
  }

  static async #loadPool(advancement, registry) {
    const options = new Map();
    for (const poolEntry of advancement.configuration?.pool ?? []) {
      const sourceUuid = typeof poolEntry === "string" ? poolEntry : poolEntry?.uuid;
      if (!sourceUuid || !registry.isUuidAllowed(sourceUuid)) continue;
      const document = await fromUuid(sourceUuid);
      if (!document) continue;
      const identifier = String(document.system?.identifier ?? this.#slug(document.name));
      const preferred = registry.preferredOption(document.type, identifier) ?? registry.sourceForUuid(sourceUuid);
      const uuid = preferred?.uuid ?? sourceUuid;
      if (!registry.isUuidAllowed(uuid)) continue;
      const preferredDocument = uuid === sourceUuid ? document : await fromUuid(uuid);
      if (!preferredDocument) continue;
      options.set(identifier, {
        uuid,
        name: preferredDocument.name,
        img: preferredDocument.img,
        identifier,
        sourceId: preferred?.sourceId ?? registry.sourceForUuid(uuid)?.sourceId ?? "unknown",
        sourceLabel: preferred?.sourceLabel ?? registry.sourceForUuid(uuid)?.sourceLabel ?? "Source",
        sourceRank: preferred?.sourceRank ?? registry.sourceRankForUuid(uuid),
        detailMeta: `Metamagic • ${preferred?.sourceLabel ?? registry.sourceForUuid(uuid)?.sourceLabel ?? "Enabled Source"}`,
        description: await this.#enrichDescription(preferredDocument)
      });
    }
    return [...options.values()].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  }


  static async #enrichDescription(document) {
    const raw = String(document?.system?.description?.value ?? "");
    if (!raw) return "<p>No description is available from the selected source.</p>";
    try {
      return await TextEditorImplementation.enrichHTML(raw, {
        async: true,
        relativeTo: document,
        secrets: Boolean(document?.isOwner)
      });
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to enrich Metamagic description.`, error);
      return raw;
    }
  }

  static async #createOption(draft, cls, context, option, state, registry) {
    if (!option) throw new Error("The selected Metamagic option is no longer available.");
    const document = await fromUuid(option.uuid);
    if (!document) throw new Error(`Unable to load ${option.name}.`);

    document.system?.validatePrerequisites?.(draft, {
      level: Number(state.targetClassLevel),
      showMessage: false,
      throwError: true
    });

    const beforeIds = new Set(draft.items.map(item => item.id));
    let data = SourceResolver.filterAdvancementPools(document.toObject(), registry);
    delete data._id;
    const Manager = globalThis.dnd5e?.applications?.advancement?.AdvancementManager;
    if (!Manager) throw new Error("D&D5e AdvancementManager is unavailable.");
    const manager = Manager.forNewItem(draft, data, {
      automaticApplication: true,
      showVisualizer: false
    });
    if (manager.steps.length) {
      const result = await NativeAdvancementModalGuard.run(manager);
      if (!result.completed) throw new Error(`${option.name} Advancement was cancelled.`);
    } else {
      await draft.createEmbeddedDocuments("Item", [data]);
    }

    const item = draft.items.find(candidate => !beforeIds.has(candidate.id)
      && candidate.type === document.type
      && String(candidate.system?.identifier ?? this.#slug(candidate.name)) === option.identifier);
    if (!item) throw new Error(`${option.name} was not created on the Level Up draft.`);

    await item.update({
      "flags.dnd5e.sourceId": document.uuid,
      "flags.dnd5e.advancementOrigin": `${cls.id}.${context.advancementId}`,
      "flags.dnd5e.advancementRoot": `${cls.id}.${context.advancementId}`,
      [`flags.${MODULE_ID}.metamagicAcquisition`]: {
        transactionId: state.transactionId,
        classIdentifier: "sorcerer",
        classItemId: cls.id,
        advancementId: context.advancementId,
        sourceUuid: document.uuid,
        identifier: option.identifier,
        acquiredAtCharacterLevel: state.targetCharacterLevel,
        acquiredAtSorcererLevel: state.targetClassLevel
      }
    });
    return item;
  }

  static async #writeAdvancementValue(cls, advancementId, targetLevel, itemIds, replacementRecord = null) {
    if (!advancementId || (!itemIds.length && !replacementRecord)) return;
    const source = cls.toObject();
    const advancement = source.system?.advancement?.[advancementId];
    if (!advancement) throw new Error("The Sorcerer Metamagic Advancement could not be found while saving choices.");

    advancement.value ??= { added: {}, replaced: {} };
    advancement.value.added ??= {};
    advancement.value.replaced ??= {};
    advancement.value.added[String(targetLevel)] ??= {};
    for (const id of itemIds) {
      const item = cls.actor.items.get(id);
      const uuid = item?.getFlag("dnd5e", "sourceId") ?? item?._stats?.compendiumSource;
      if (uuid) advancement.value.added[String(targetLevel)][id] = uuid;
    }
    if (replacementRecord) {
      advancement.value.replaced[String(targetLevel)] = {
        level: Number(replacementRecord.originalLevel ?? targetLevel),
        original: replacementRecord.original,
        replacement: replacementRecord.replacement
      };
    }
    await cls.update({
      [`system.advancement.${advancementId}.value`]: advancement.value
    });
  }

  static #advancementItemIds(advancement) {
    const ids = new Set();
    for (const rows of Object.values(advancement.value?.added ?? {})) {
      for (const id of Object.keys(rows ?? {})) ids.add(id);
    }
    return ids;
  }

  static #findAdvancementItemLevel(advancement, itemId, fallback = 0) {
    for (const [level, rows] of Object.entries(advancement?.value?.added ?? {})) {
      if (Object.prototype.hasOwnProperty.call(rows ?? {}, itemId)) return Number(level);
    }
    return Number(fallback ?? 0);
  }

  static #advancementData(item) {
    const collection = item?.advancement;
    if (collection?.contents) {
      return collection.contents.map(entry => entry.toObject ? entry.toObject() : foundry.utils.deepClone(entry));
    }
    if (collection?.values) {
      return [...collection.values()].map(entry => entry.toObject ? entry.toObject() : foundry.utils.deepClone(entry));
    }
    return Object.values(item?.toObject?.().system?.advancement
      ?? item?._source?.system?.advancement
      ?? item?.system?.advancement
      ?? {});
  }

  static #slug(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
