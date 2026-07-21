import { MODULE_ID } from "../constants.mjs";
import { AdvancementChoiceAnnotationService } from "./advancement-choice-annotation-service.mjs";

/**
 * Reusable Pact of the Tome selection logic. The acquisition mode is used by
 * Character Creation and Level Up. The same context/apply contract is kept
 * reused by Character Keeper maintenance without creating a second Book of
 * Shadows or changing unrelated Warlock spell ownership.
 */
export class PactOfTheTomeService {
  static INVOCATION_IDENTIFIER = "pact-of-the-tome";
  static BOOK_SOURCE_UUID = "Compendium.dnd-players-handbook.classes.Item.phbwlkBookOfShad";
  static CANTRIP_COUNT = 3;
  static RITUAL_COUNT = 2;

  static findInvocation(actor) {
    return actor?.items?.find(item => item.type === "feat"
      && String(item.system?.identifier ?? "").toLowerCase() === this.INVOCATION_IDENTIFIER) ?? null;
  }

  static isActive(actor) {
    return Boolean(this.findInvocation(actor));
  }

  static async buildContext(actor, registry, {
    mode = "acquisition",
    selectedCantrips = [],
    selectedRituals = [],
    pendingPreparedIdentifiers = [],
    transactionId = null,
    classItem = null,
    forceActive = false,
    invocationOption = null
  } = {}) {
    const invocation = this.findInvocation(actor);
    if (!invocation && !forceActive) return this.#emptyContext();
    const presentationInvocation = invocation ?? {
      id: null,
      name: invocationOption?.name ?? "Pact of the Tome",
      img: invocationOption?.img ?? "icons/sundries/books/book-symbol-skull-grey.webp",
      getFlag: () => null
    };

    const current = this.currentSelection(actor, invocation?.id ?? null);
    const selectedCantripSet = new Set(selectedCantrips.length ? selectedCantrips : current.cantrips.map(row => row.identifier));
    const selectedRitualSet = new Set(selectedRituals.length ? selectedRituals : current.rituals.map(row => row.identifier));
    const unavailable = this.#unavailableSpellMap(actor, invocation?.id ?? null);
    const protectedCantrips = mode === "maintenance" ? this.#protectedCantripMap(actor, invocation?.id ?? null) : new Map();
    for (const identifier of pendingPreparedIdentifiers ?? []) {
      if (!identifier || unavailable.has(identifier)) continue;
      unavailable.set(identifier, "Already selected or prepared through another Warlock spell choice.");
    }

    const preferred = await this.#allClassSpellPool(registry);
    const cantrips = [];
    const rituals = [];
    for (const option of preferred) {
      const level = Number(option.system?.level ?? -1);
      const properties = this.#collection(option.system?.properties);
      const currentOwned = current.allIdentifiers.has(option.identifier);
      const protectedReason = level === 0 && currentOwned ? protectedCantrips.get(option.identifier) ?? "" : "";
      const disabledReason = protectedReason || (!currentOwned ? unavailable.get(option.identifier) ?? "" : "");
      const row = {
        ...option,
        level,
        levelLabel: level === 0 ? "Cantrip" : `Level ${level}`,
        selected: level === 0 ? selectedCantripSet.has(option.identifier) : selectedRitualSet.has(option.identifier),
        checked: level === 0 ? selectedCantripSet.has(option.identifier) : selectedRitualSet.has(option.identifier),
        currentOwned,
        selectionLocked: Boolean(protectedReason),
        ineligible: Boolean(disabledReason && !protectedReason),
        disabled: Boolean(disabledReason),
        disabledReason,
        search: String(option.search ?? option.name ?? "").toLowerCase()
      };
      if (level === 0) cantrips.push(row);
      else if (level === 1 && properties.includes("ritual")) rituals.push(row);
    }

    const selectedCantripCount = cantrips.filter(option => option.checked).length;
    const selectedRitualCount = rituals.filter(option => option.checked).length;
    return {
      active: true,
      mode,
      invocationItemId: invocation?.id ?? null,
      invocationName: presentationInvocation.name,
      invocationImg: presentationInvocation.img,
      classItemId: classItem?.id ?? presentationInvocation.getFlag(MODULE_ID, "invocationInstance")?.classItemId ?? null,
      transactionId,
      cantripCount: this.CANTRIP_COUNT,
      ritualCount: this.RITUAL_COUNT,
      selectedCantripCount,
      selectedRitualCount,
      cantripGroups: registry.groupOptions(cantrips),
      ritualGroups: registry.groupOptions(rituals),
      complete: selectedCantripCount === this.CANTRIP_COUNT && selectedRitualCount === this.RITUAL_COUNT,
      current,
      note: "Choose three cantrips and two level 1 Ritual spells for the Book of Shadows. These are separate Pact of the Tome acquisitions and do not count against normal Pact Magic choices."
    };
  }

  static currentSelection(actor, invocationItemId = null) {
    const rows = actor?.items?.filter(item => item.type === "spell"
      && item.getFlag(MODULE_ID, "pactOfTheTomeSelection")
      && (!invocationItemId || item.getFlag(MODULE_ID, "pactOfTheTomeSelection")?.invocationItemId === invocationItemId)) ?? [];
    const cantrips = rows.filter(item => item.getFlag(MODULE_ID, "pactOfTheTomeSelection")?.kind === "cantrip")
      .map(item => ({ id: item.id, identifier: item.system?.identifier, name: item.name, img: item.img }));
    const rituals = rows.filter(item => item.getFlag(MODULE_ID, "pactOfTheTomeSelection")?.kind === "ritual")
      .map(item => ({ id: item.id, identifier: item.system?.identifier, name: item.name, img: item.img }));
    return {
      cantrips,
      rituals,
      allIdentifiers: new Set([...cantrips, ...rituals].map(row => row.identifier).filter(Boolean))
    };
  }

  static async apply(actor, registry, {
    mode = "acquisition",
    selectedCantrips = [],
    selectedRituals = [],
    transactionId = null,
    characterLevel = 1,
    classLevel = 1,
    classItem = null
  } = {}) {
    const invocation = this.findInvocation(actor);
    if (!invocation) return { active: false, createdItemIds: [], deletedItemIds: [] };

    const context = await this.buildContext(actor, registry, {
      mode,
      selectedCantrips,
      selectedRituals,
      transactionId,
      classItem
    });
    this.#validate(context, selectedCantrips, selectedRituals);

    const existingBook = actor.items.find(item => item.getFlag(MODULE_ID, "pactOfTheTomeBook")?.invocationItemId === invocation.id) ?? null;
    if (mode === "maintenance" && !existingBook) {
      throw new Error("The existing Book of Shadows could not be found. Character Keeper will not create a second or replacement book automatically.");
    }
    const sameCantrips = this.#sameIdentifiers(selectedCantrips, context.current.cantrips.map(row => row.identifier));
    const sameRituals = this.#sameIdentifiers(selectedRituals, context.current.rituals.map(row => row.identifier));
    if (mode === "maintenance" && sameCantrips && sameRituals) {
      await invocation.setFlag(MODULE_ID, "pactOfTheTomeLastMaintenance", {
        transactionId, confirmedAt: Date.now(), confirmedBy: game.user.id,
        changed: false, cantrips: [...selectedCantrips], rituals: [...selectedRituals]
      });
      const book = existingBook;
      return {
        active: true, changed: false, invocationItemId: invocation.id, bookItemId: book?.id ?? null,
        createdItemIds: [], deletedItemIds: []
      };
    }

    const previousModuleFlags = foundry.utils.deepClone(invocation.flags?.[MODULE_ID] ?? {});
    const previousSpellData = actor.items
      .filter(item => item.type === "spell" && item.getFlag(MODULE_ID, "pactOfTheTomeSelection")?.invocationItemId === invocation.id)
      .map(item => item.toObject());
    const previousSpellIds = previousSpellData.map(item => item._id);
    const dependentInvocations = this.#dependentInvocations(actor, invocation.id, previousSpellData);
    let createdBook = false;
    let book = existingBook;
    let created = [];

    try {
      const invocationData = await this.ensureInvocationMetadata(actor, invocation, {
        transactionId,
        characterLevel,
        classLevel,
        classItem
      });
      const instanceId = invocationData.instanceId;

      if (!book) {
        const source = await fromUuid(this.BOOK_SOURCE_UUID);
        if (!source) throw new Error("The official Book of Shadows document could not be loaded.");
        const data = source.toObject();
        delete data._id;
        data.flags ??= {};
        data.flags.dnd5e ??= {};
        data.flags.dnd5e.sourceId = source.uuid;
        data.flags[MODULE_ID] = {
          ...(data.flags[MODULE_ID] ?? {}),
          pactOfTheTomeBook: {
            invocationItemId: invocation.id,
            invocationInstanceId: instanceId,
            classItemId: classItem?.id ?? invocationData.classItemId ?? null,
            transactionId,
            createdIn: mode
          }
        };
        [book] = await actor.createEmbeddedDocuments("Item", [data], {
          characterBuilderPactOfTheTome: true
        });
        createdBook = true;
      }

      const optionByIdentifier = new Map([
        ...context.cantripGroups.flatMap(group => group.items),
        ...context.ritualGroups.flatMap(group => group.items)
      ].map(option => [option.identifier, option]));
      const createData = [];
      for (const [kind, identifiers] of [["cantrip", selectedCantrips], ["ritual", selectedRituals]]) {
        for (const identifier of identifiers) {
          const option = optionByIdentifier.get(identifier);
          const source = option ? await fromUuid(option.uuid) : null;
          if (!source) throw new Error(`Unable to load Pact of the Tome spell ${identifier}.`);
          const data = source.toObject();
          delete data._id;
          data.system ??= {};
          data.system.ability = classItem?.system?.spellcasting?.ability ?? "cha";
          data.system.method = "pact";
          data.system.prepared = kind === "cantrip" ? 1 : 2;
          data.system.sourceItem = "invocation:pact-of-the-tome";
          data.flags ??= {};
          data.flags.dnd5e ??= {};
          data.flags.dnd5e.sourceId = source.uuid;
          const owner = {
            category: "pact-of-the-tome",
            label: kind === "cantrip" ? "Pact of the Tome Cantrip" : "Pact of the Tome Ritual",
            classIdentifier: "warlock",
            classItemId: classItem?.id ?? invocationData.classItemId ?? null,
            subclassItemId: null,
            featureItemId: invocation.id,
            ownerItemId: invocation.id,
            transactionId,
            acquiredAtCharacterLevel: Number(characterLevel),
            acquiredAtClassLevel: Number(classLevel),
            sourceUuid: source.uuid,
            spellLevel: Number(data.system.level ?? 0),
            alwaysPrepared: true,
            pactOfTheTome: true
          };
          data.flags[MODULE_ID] = {
            ...(data.flags[MODULE_ID] ?? {}),
            classSpellAccess: true,
            classIdentifier: "warlock",
            classItemId: owner.classItemId,
            accessModel: "pact-of-the-tome",
            category: `pact-of-the-tome-${kind}`,
            featureGrantedSpell: true,
            featureSpellOwners: [owner],
            pactOfTheTomeSelection: {
              kind,
              invocationItemId: invocation.id,
              invocationInstanceId: instanceId,
              bookItemId: book.id,
              classItemId: owner.classItemId,
              transactionId,
              sourceUuid: source.uuid,
              identifier
            }
          };
          createData.push(data);
        }
      }

      // Resolve every source before replacing the previous valid selection.
      // Once mutation begins, any failure restores the exact previous IDs and
      // Invocation metadata so Character Creation and Level Up stay retryable.
      if (previousSpellIds.length) {
        await actor.deleteEmbeddedDocuments("Item", previousSpellIds, {
          characterBuilderPactOfTheTome: true,
          deleteContents: false
        });
      }
      created = createData.length
        ? await actor.createEmbeddedDocuments("Item", createData, { characterBuilderPactOfTheTome: true })
        : [];
      const createdCantrips = created.filter(item => item.getFlag(MODULE_ID, "pactOfTheTomeSelection")?.kind === "cantrip");
      const createdRituals = created.filter(item => item.getFlag(MODULE_ID, "pactOfTheTomeSelection")?.kind === "ritual");
      await invocation.update({
        [`flags.${MODULE_ID}.invocationInstance.selectedCantrips`]: createdCantrips.map(item => ({ id: item.id, identifier: item.system?.identifier, name: item.name })),
        [`flags.${MODULE_ID}.invocationInstance.selectedRituals`]: createdRituals.map(item => ({ id: item.id, identifier: item.system?.identifier, name: item.name })),
        [`flags.${MODULE_ID}.pactOfTheTome`]: {
          mode,
          bookItemId: book.id,
          cantripItemIds: createdCantrips.map(item => item.id),
          ritualItemIds: createdRituals.map(item => item.id),
          cantrips: createdCantrips.map(item => item.name),
          rituals: createdRituals.map(item => item.name),
          transactionId
        }
      });

      await this.#remapDependentInvocations(actor, dependentInvocations, createdCantrips, transactionId);

      try {
        await AdvancementChoiceAnnotationService.refresh(actor, {
          state: {
            context: mode === "maintenance"
              ? "restManagement"
              : mode === "acquisition" && String(transactionId ?? "").startsWith("creation:") ? "creation" : "levelUp",
            transactionId,
            selectedClassIdentifier: "warlock",
            targetCharacterLevel: Number(characterLevel),
            targetClassLevel: Number(classLevel)
          }
        });
      } catch (error) {
        console.warn(`${MODULE_ID} | Pact of the Tome badges could not be refreshed.`, error);
      }

      return {
        active: true,
        changed: true,
        invocationItemId: invocation.id,
        bookItemId: book.id,
        createdItemIds: [...(createdBook ? [book.id] : []), ...created.map(item => item.id)],
        deletedItemIds: previousSpellIds
      };
    } catch (error) {
      try {
        const currentIds = actor.items
          .filter(item => item.type === "spell" && item.getFlag(MODULE_ID, "pactOfTheTomeSelection")?.invocationItemId === invocation.id)
          .map(item => item.id);
        if (currentIds.length) {
          await actor.deleteEmbeddedDocuments("Item", currentIds, {
            characterBuilderPactOfTheTomeRollback: true,
            deleteContents: false
          });
        }
        if (previousSpellData.length) {
          await actor.createEmbeddedDocuments("Item", previousSpellData, {
            keepId: true,
            characterBuilderPactOfTheTomeRollback: true
          });
        }
        if (createdBook && book && actor.items.get(book.id)) {
          await actor.deleteEmbeddedDocuments("Item", [book.id], {
            characterBuilderPactOfTheTomeRollback: true,
            deleteContents: false
          });
        }
        await invocation.update({ [`flags.${MODULE_ID}`]: previousModuleFlags }, {
          characterBuilderPactOfTheTomeRollback: true
        });
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Pact of the Tome rollback failed.`, rollbackError);
      }
      throw error;
    }
  }

  static async cleanup(actor, invocationItemId) {
    if (!actor?.items || !invocationItemId) return [];
    const ids = actor.items.filter(item => {
      const selection = item.getFlag(MODULE_ID, "pactOfTheTomeSelection");
      const book = item.getFlag(MODULE_ID, "pactOfTheTomeBook");
      return selection?.invocationItemId === invocationItemId || book?.invocationItemId === invocationItemId;
    }).map(item => item.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids, {
      characterBuilderPactOfTheTome: true,
      deleteContents: false
    });
    return ids;
  }

  static async ensureInvocationMetadata(actor, invocation, {
    transactionId = null,
    characterLevel = 1,
    classLevel = 1,
    classItem = null
  } = {}) {
    const current = invocation.getFlag(MODULE_ID, "invocationInstance") ?? {};
    const sourceUuid = invocation.getFlag("dnd5e", "sourceId") ?? invocation._stats?.compendiumSource ?? null;
    const next = {
      instanceId: current.instanceId ?? foundry.utils.randomID(),
      transactionId: current.transactionId ?? transactionId ?? `creation:${actor.id}`,
      classIdentifier: "warlock",
      classItemId: current.classItemId ?? classItem?.id ?? actor.items.find(item => item.type === "class" && item.system?.identifier === "warlock")?.id ?? null,
      advancementId: current.advancementId ?? this.#advancementIdForInvocation(actor, invocation.id),
      sourceUuid: current.sourceUuid ?? sourceUuid,
      identifier: current.identifier ?? invocation.system?.identifier ?? this.INVOCATION_IDENTIFIER,
      acquiredAtCharacterLevel: Number(current.acquiredAtCharacterLevel ?? characterLevel),
      acquiredAtWarlockLevel: Number(current.acquiredAtWarlockLevel ?? classLevel),
      targetCantripItemId: current.targetCantripItemId ?? null,
      targetCantripIdentifier: current.targetCantripIdentifier ?? null,
      targetCantripName: current.targetCantripName ?? null,
      repeatable: Boolean(current.repeatable ?? invocation.system?.prerequisites?.repeatable),
      selectedCantrips: current.selectedCantrips ?? [],
      selectedRituals: current.selectedRituals ?? []
    };
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      await invocation.update({ [`flags.${MODULE_ID}.invocationInstance`]: next });
    }
    return next;
  }

  static #sameIdentifiers(left, right) {
    const a = [...new Set((left ?? []).map(String))].sort();
    const b = [...new Set((right ?? []).map(String))].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  static #dependentInvocations(actor, tomeInvocationItemId, previousSpellData) {
    const oldById = new Map(previousSpellData.map(data => [data._id, data]));
    return actor.items.filter(item => item.type === "feat" && item.id !== tomeInvocationItemId).map(item => {
      const instance = item.getFlag(MODULE_ID, "invocationInstance");
      const oldTarget = oldById.get(instance?.targetCantripItemId);
      if (!instance || !oldTarget) return null;
      return {
        itemId: item.id,
        instanceId: instance.instanceId ?? null,
        identifier: item.system?.identifier ?? instance.identifier ?? null,
        name: item.name,
        sourceUuid: item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? instance.sourceUuid ?? null,
        targetIdentifier: oldTarget.system?.identifier ?? instance.targetCantripIdentifier ?? null
      };
    }).filter(Boolean);
  }

  static #protectedCantripMap(actor, tomeInvocationItemId) {
    const selection = this.currentSelection(actor, tomeInvocationItemId);
    const byId = new Map(selection.cantrips.map(row => [row.id, row]));
    const names = new Map();
    for (const item of actor.items.filter(candidate => candidate.type === "feat" && candidate.id !== tomeInvocationItemId)) {
      const instance = item.getFlag(MODULE_ID, "invocationInstance");
      const target = byId.get(instance?.targetCantripItemId);
      if (!target?.identifier) continue;
      const rows = names.get(target.identifier) ?? [];
      rows.push(item.name);
      names.set(target.identifier, rows);
    }
    return new Map([...names.entries()].map(([identifier, rows]) => [
      identifier,
      `Required by ${[...new Set(rows)].join(", ")}. Retarget or replace that Invocation before removing this cantrip.`
    ]));
  }

  static async #remapDependentInvocations(actor, dependencies, createdCantrips, transactionId) {
    if (!dependencies.length) return;
    const byIdentifier = new Map(createdCantrips.map(item => [item.system?.identifier, item]));
    const augments = new Map();
    for (const dependency of dependencies) {
      const target = byIdentifier.get(dependency.targetIdentifier);
      if (!target) {
        throw new Error(`${dependency.name} still requires ${dependency.targetIdentifier}. Keep that Pact of the Tome cantrip or reconfigure the Invocation first.`);
      }
      const invocation = actor.items.get(dependency.itemId);
      if (!invocation) throw new Error(`The dependent Invocation ${dependency.name} no longer exists.`);
      await invocation.update({
        [`flags.${MODULE_ID}.invocationInstance.targetCantripItemId`]: target.id,
        [`flags.${MODULE_ID}.invocationInstance.targetCantripIdentifier`]: target.system?.identifier ?? dependency.targetIdentifier,
        [`flags.${MODULE_ID}.invocationInstance.targetCantripName`]: target.name,
        [`flags.${MODULE_ID}.invocationInstance.lastRetargetTransactionId`]: transactionId
      }, { characterBuilderPactOfTheTome: true });
      const rows = augments.get(target.id) ?? [];
      rows.push({
        invocationItemId: invocation.id,
        instanceId: dependency.instanceId,
        name: invocation.name,
        identifier: dependency.identifier,
        sourceUuid: dependency.sourceUuid,
        acquiredAtCharacterLevel: invocation.getFlag(MODULE_ID, "invocationInstance")?.acquiredAtCharacterLevel ?? null,
        acquiredAtWarlockLevel: invocation.getFlag(MODULE_ID, "invocationInstance")?.acquiredAtWarlockLevel ?? null
      });
      augments.set(target.id, rows);
    }
    for (const [spellId, rows] of augments) {
      const spell = actor.items.get(spellId);
      if (spell) await spell.setFlag(MODULE_ID, "eldritchInvocationAugments", rows);
    }
  }

  static validateSelection(context, selectedCantrips, selectedRituals) {
    return this.#validate(context, selectedCantrips, selectedRituals);
  }

  static #validate(context, selectedCantrips, selectedRituals) {
    const cantrips = [...new Set(selectedCantrips.map(String))];
    const rituals = [...new Set(selectedRituals.map(String))];
    if (cantrips.length !== this.CANTRIP_COUNT) throw new Error(`Choose exactly ${this.CANTRIP_COUNT} Pact of the Tome cantrips.`);
    if (rituals.length !== this.RITUAL_COUNT) throw new Error(`Choose exactly ${this.RITUAL_COUNT} Pact of the Tome Ritual spells.`);
    const validCantrips = new Map(context.cantripGroups.flatMap(group => group.items).map(item => [item.identifier, item]));
    const validRituals = new Map(context.ritualGroups.flatMap(group => group.items).map(item => [item.identifier, item]));
    for (const option of validCantrips.values()) {
      if (option.selectionLocked && option.currentOwned && !cantrips.includes(option.identifier)) {
        throw new Error(option.disabledReason || `${option.name} cannot be removed while an Eldritch Invocation targets it.`);
      }
    }
    for (const identifier of cantrips) {
      const option = validCantrips.get(identifier);
      if (!option || option.ineligible) throw new Error(`${option?.name ?? identifier} is not eligible for Pact of the Tome.`);
    }
    for (const identifier of rituals) {
      const option = validRituals.get(identifier);
      if (!option || option.ineligible) throw new Error(`${option?.name ?? identifier} is not eligible for Pact of the Tome.`);
    }
    const overlap = cantrips.find(identifier => rituals.includes(identifier));
    if (overlap) throw new Error("Pact of the Tome selections must be distinct acquisitions.");
    return true;
  }

  static #unavailableSpellMap(actor, invocationItemId) {
    const rows = new Map();
    for (const spell of actor?.items?.filter(item => item.type === "spell") ?? []) {
      if (spell.getFlag(MODULE_ID, "pactOfTheTomeSelection")?.invocationItemId === invocationItemId) continue;
      if (Number(spell.system?.prepared ?? 0) <= 0) continue;
      const identifier = String(spell.system?.identifier ?? "");
      if (!identifier) continue;
      rows.set(identifier, `Already prepared from ${this.#spellOwnerLabel(actor, spell)}.`);
    }
    return rows;
  }

  static #spellOwnerLabel(actor, spell) {
    const owners = spell.getFlag(MODULE_ID, "featureSpellOwners") ?? [];
    if (owners[0]?.label) return owners[0].label;
    const sourceItem = String(spell.system?.sourceItem ?? "");
    if (sourceItem.startsWith("subclass:")) {
      const id = sourceItem.slice("subclass:".length);
      return actor.items.find(item => item.type === "subclass" && item.system?.identifier === id)?.name ?? "a subclass feature";
    }
    if (sourceItem.startsWith("class:")) return `${sourceItem.slice("class:".length)} spell access`;
    return "another feature";
  }

  static #advancementIdForInvocation(actor, invocationItemId) {
    const cls = actor.items.find(item => item.type === "class" && item.system?.identifier === "warlock");
    if (!cls) return null;
    const advancements = cls.toObject().system?.advancement ?? {};
    for (const [id, advancement] of Object.entries(advancements)) {
      const added = advancement?.value?.added ?? {};
      const values = Object.values(added).flatMap(row => Object.keys(row ?? {}));
      if (values.includes(invocationItemId)) return id;
    }
    return Object.entries(advancements).find(([, advancement]) => String(advancement?.title ?? "").toLowerCase() === "eldritch invocations")?.[0] ?? null;
  }


  static async #allClassSpellPool(registry) {
    const classIdentifiers = [
      "bard", "cleric", "druid", "paladin", "ranger", "sorcerer", "warlock", "wizard"
    ];
    const spellLists = globalThis.dnd5e?.registry?.spellLists;
    if (!spellLists) throw new Error("The D&D5e spell-list registry is unavailable.");
    for (let attempt = 0; attempt < 20 && !spellLists.ready; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const byIdentifier = new Map();
    for (const classIdentifier of classIdentifiers) {
      const list = spellLists.forType("class", classIdentifier);
      if (!list) continue;
      for (const index of list.indexes ?? []) {
        const identifier = String(index.system?.identifier ?? "");
        if (!identifier || byIdentifier.has(identifier)) continue;
        const option = registry.preferredOption("spell", identifier);
        if (option) byIdentifier.set(identifier, option);
      }
    }
    return [...byIdentifier.values()].sort((a, b) => {
      const levelDifference = Number(a.system?.level ?? 0) - Number(b.system?.level ?? 0);
      return levelDifference || a.name.localeCompare(b.name, game.i18n.lang);
    });
  }

  static #collection(value) {
    if (!value) return [];
    if (value instanceof Set || value?.values) return [...value.values()];
    if (Array.isArray(value)) return value;
    return Object.keys(value).filter(key => value[key]);
  }

  static #emptyContext() {
    return {
      active: false,
      mode: "acquisition",
      invocationItemId: null,
      cantripCount: 0,
      ritualCount: 0,
      selectedCantripCount: 0,
      selectedRitualCount: 0,
      cantripGroups: [],
      ritualGroups: [],
      complete: true,
      current: { cantrips: [], rituals: [], allIdentifiers: new Set() },
      note: ""
    };
  }
}
