import { MODULE_ID, defaultSettings } from "../constants.mjs";
import { DraftManager } from "./draft-manager.mjs";
import { ShopService } from "./shop-service.mjs";

export class EquipmentService {
  static selectionFingerprint(equipmentState = {}) {
    const normalized = Object.entries(equipmentState ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([itemId, selection]) => [itemId, {
        mode: selection?.mode ?? "package",
        packageIndex: Number(selection?.packageIndex ?? 0),
        selections: Object.fromEntries(Object.entries(selection?.selections ?? {}).sort(([left], [right]) => left.localeCompare(right))),
        wealthAmount: Number.isFinite(Number(selection?.wealthAmount)) ? Number(selection.wealthAmount) : null
      }]);
    return JSON.stringify(normalized);
  }

  static buildPanel(item, registry, actor, saved = {}) {
    if (!item) return null;
    const sourceSnapshot = item.getFlag(MODULE_ID, "sourceSnapshot") ?? {};
    const sourceEntries = sourceSnapshot.startingEquipment?.length
      ? sourceSnapshot.startingEquipment
      : Array.from(item.system.startingEquipment ?? []);
    const entries = Array.from(sourceEntries).map(entry =>
      entry.toObject ? entry.toObject() : foundry.utils.deepClone(entry)
    );
    const normalizeGroup = value => value === "" || value == null ? null : value;
    const children = parentId => entries
      .filter(entry => normalizeGroup(entry.group) === normalizeGroup(parentId))
      .sort((a, b) => Number(a.sort) - Number(b.sort));

    const expand = entry => {
      if (!["AND", "OR"].includes(entry.type)) return [[entry]];
      const childEntries = children(entry._id);
      if (entry.type === "OR") return childEntries.flatMap(expand);
      return childEntries.reduce((sets, child) => {
        const childSets = expand(child);
        return sets.flatMap(set => childSets.map(childSet => [...set, ...childSet]));
      }, [[]]);
    };

    const roots = children(null);
    let packages;
    if (roots.length === 1 && roots[0].type === "OR") packages = roots[0].children?.length
      ? roots[0].children.flatMap(expand)
      : children(roots[0]._id).flatMap(expand);
    else packages = roots.reduce((sets, root) => {
      const rootSets = expand(root);
      return sets.flatMap(set => rootSets.map(rootSet => [...set, ...rootSet]));
    }, [[]]);

    packages = packages.filter(packageEntries => packageEntries.length);
    const packageContexts = packages.map((packageEntries, index) => ({
      index,
      label: `Equipment Package ${String.fromCharCode(65 + index)}`,
      entries: packageEntries.map(entry => this.#entryContext(entry, registry, actor, saved.selections ?? {}))
    }));

    return {
      itemId: item.id,
      itemUuid: item.uuid,
      itemName: item.name,
      itemImg: item.img,
      mode: saved.mode ?? "package",
      selectedPackage: Number(saved.packageIndex ?? 0),
      packages: packageContexts,
      hasPackages: packageContexts.length > 0,
      wealth: sourceSnapshot.wealth || item.system.wealth || null,
      fixedOnly: packageContexts.length === 1 && !sourceSnapshot.wealth &&
        packageContexts[0].entries.every(entry => entry.fixed),
      saved
    };
  }

  /**
   * Capture the visible Class/Background equipment selections and calculate the
   * deterministic currency contribution used by the Shop. Wealth formulas are
   * rolled only once per Draft and retained if the player switches modes.
   */
  static async captureSelection(draft, registry, formData) {
    const plan = await this.#buildSelectionPlan(draft, registry, formData, { requireChoices: false });
    await DraftManager.setBuildState(draft, {
      equipment: plan.equipmentState,
      equipmentSaved: false
    });
    return plan;
  }

  static async apply(draft, registry, formData) {
    const plan = await this.#buildSelectionPlan(draft, registry, formData, { requireChoices: true });
    const settings = foundry.utils.mergeObject(defaultSettings(), game.settings.get(MODULE_ID, "settings") ?? {}, {
      inplace: false
    });
    await ShopService.initializeDraft(draft, registry, plan.budgetBreakdown, settings, {
      equipmentFingerprint: this.selectionFingerprint(plan.equipmentState)
    });
    const checkout = await ShopService.validateCheckout(draft, registry, { allowNoPurchase: true });

    // Shop purchases are committed exclusively by Shop Checkout. Confirming
    // Starting Equipment replaces only Class/Background equipment and must not
    // recreate, delete, or charge for checked-out Shop items a second time.
    const oldIds = draft.items
      .filter(item => item.getFlag(MODULE_ID, "startingEquipment") &&
        !item.getFlag(MODULE_ID, "shopPurchase") && !item.system.container)
      .map(item => item.id);
    if (oldIds.length) await draft.deleteEmbeddedDocuments("Item", oldIds, { deleteContents: true });

    const createData = [];
    for (const source of plan.sourceDocuments) {
      const data = await Item.implementation.createWithContents([source.document], {
        transformAll: (item, { depth }) => {
          const object = item instanceof foundry.abstract.Document ? item.toObject() : foundry.utils.deepClone(item);
          object.flags ??= {};
          object.flags[MODULE_ID] = foundry.utils.mergeObject(object.flags[MODULE_ID] ?? {}, {
            startingEquipment: true,
            sourceItemId: source.sourceItem.id,
            sourceItemName: source.sourceItem.name
          }, { inplace: false, overwrite: true });
          if (depth === 0 && source.count > 1) {
            foundry.utils.setProperty(object, "system.quantity", source.count);
          }
          const armorType = foundry.utils.getProperty(object, "system.type.value");
          if (object.type === "equipment" && ["light", "medium", "heavy", "shield"].includes(armorType)) {
            foundry.utils.setProperty(object, "system.equipped", true);
          }
          return object;
        }
      });
      createData.push(...data);
    }

    if (createData.length) {
      await Item.implementation.createDocuments(createData, { parent: draft, keepId: true });
    }

    const currency = ShopService.cpToCurrency(checkout.remainingCp);
    await draft.update({ "system.currency": currency });
    await DraftManager.setBuildState(draft, { equipment: plan.equipmentState });
  }

  static async invalidate(draft) {
    const oldIds = draft.items
      .filter(item => item.getFlag(MODULE_ID, "startingEquipment") && !item.system.container)
      .map(item => item.id);
    if (oldIds.length) await draft.deleteEmbeddedDocuments("Item", oldIds, { deleteContents: true });

    const baseCurrency = draft.getFlag(MODULE_ID, "baseCurrency") ?? {};
    await draft.update({ "system.currency": foundry.utils.deepClone(baseCurrency) });
    await ShopService.clearCart(draft, { preserveBonus: true });
    await DraftManager.setBuildState(draft, { equipment: {}, equipmentSaved: false });
  }

  static async #buildSelectionPlan(draft, registry, formData, { requireChoices }) {
    const state = DraftManager.getBuildState(draft);
    const baseCurrency = draft.getFlag(MODULE_ID, "baseCurrency") ?? state.baseCurrency ?? {};
    const equipmentState = {};
    const sourceDocuments = [];
    const budgetBreakdown = {
      existingCurrencyCp: ShopService.currencyToCp(baseCurrency),
      classGoldCp: 0,
      backgroundGoldCp: 0
    };
    const sourceItems = [
      draft.items.find(item => item.type === "class"),
      draft.items.find(item => item.type === "background")
    ].filter(Boolean);

    for (const sourceItem of sourceItems) {
      const prefix = `equipment.${sourceItem.id}`;
      const previous = state.equipment?.[sourceItem.id] ?? {};
      const mode = formData[`${prefix}.mode`] ?? previous.mode ?? "package";
      const packageIndex = Number(formData[`${prefix}.packageIndex`] ?? previous.packageIndex ?? 0);
      const selections = Object.fromEntries(
        Object.entries(formData)
          .filter(([key]) => key.startsWith(`${prefix}.selection.`))
          .map(([key, value]) => [key.split(".").at(-1), value])
      );
      const savedSelections = { ...(previous.selections ?? {}), ...selections };
      const sourceSnapshot = sourceItem.getFlag(MODULE_ID, "sourceSnapshot") ?? {};
      const contributionKey = sourceItem.type === "class" ? "classGoldCp" : "backgroundGoldCp";
      let wealthAmount = Number(previous.wealthAmount);

      if (mode === "wealth") {
        if (!Number.isFinite(wealthAmount)) {
          wealthAmount = await this.#evaluateFormula(sourceSnapshot.wealth || sourceItem.system.wealth || "0");
        }
        const denomination = CONFIG.DND5E.defaultCurrency ?? "gp";
        budgetBreakdown[contributionKey] += ShopService.denominationToCp(wealthAmount, denomination);
        equipmentState[sourceItem.id] = {
          mode,
          packageIndex,
          selections: savedSelections,
          wealthAmount
        };
        continue;
      }

      const panel = this.buildPanel(sourceItem, registry, draft, {
        mode,
        packageIndex,
        selections: savedSelections,
        ...(Number.isFinite(wealthAmount) ? { wealthAmount } : {})
      });
      const selectedPackage = panel?.packages?.[packageIndex];
      if (selectedPackage) {
        for (const context of selectedPackage.entries) {
          const entry = context.raw;
          if (entry.type === "currency") {
            budgetBreakdown[contributionKey] += ShopService.denominationToCp(Number(entry.count ?? 1), entry.key);
            continue;
          }

          const uuid = entry.type === "linked" ? entry.key : savedSelections[entry._id];
          if (!uuid) {
            if (requireChoices) throw new Error(`A starting equipment choice is missing for ${sourceItem.name}.`);
            continue;
          }
          const document = await fromUuid(uuid);
          if (!document) {
            if (requireChoices) throw new Error(`Unable to resolve starting equipment document: ${uuid}`);
            continue;
          }
          sourceDocuments.push({ document, count: Number(entry.count ?? 1), sourceItem });
        }
      }

      equipmentState[sourceItem.id] = {
        mode,
        packageIndex,
        selections: savedSelections,
        ...(Number.isFinite(wealthAmount) ? { wealthAmount } : {})
      };
    }

    return { equipmentState, sourceDocuments, budgetBreakdown };
  }

  static #entryContext(entry, registry, actor, savedSelections) {
    const count = Number(entry.count ?? 1);
    if (entry.type === "linked") {
      const option = registry.findOption(entry.key);
      return {
        raw: entry,
        id: entry._id,
        type: entry.type,
        fixed: true,
        name: option?.name ?? entry.key,
        img: option?.img ?? "icons/svg/item-bag.svg",
        count
      };
    }
    if (entry.type === "currency") {
      return {
        raw: entry,
        id: entry._id,
        type: entry.type,
        fixed: true,
        name: `${count} ${String(entry.key ?? "gp").toUpperCase()}`,
        img: "icons/commodities/currency/coin-embossed-crown-gold.webp",
        count
      };
    }

    const groups = registry.equipmentCandidates(entry, actor).map(group => ({
      ...group,
      items: group.items.map(item => ({ ...item, selected: savedSelections[entry._id] === item.uuid }))
    }));
    return {
      raw: entry,
      id: entry._id,
      type: entry.type,
      fixed: false,
      label: this.#choiceLabel(entry),
      count,
      selected: savedSelections[entry._id] ?? "",
      groups
    };
  }

  static #choiceLabel(entry) {
    const labels = {
      weapon: "Choose a Weapon",
      armor: "Choose Armor",
      tool: "Choose a Tool",
      focus: "Choose a Spellcasting Focus"
    };
    return labels[entry.type] ?? "Choose Equipment";
  }

  static async #evaluateFormula(formula) {
    const text = String(formula ?? "0").trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
    const roll = await new Roll(text).evaluate();
    return Number(roll.total ?? 0);
  }
}
