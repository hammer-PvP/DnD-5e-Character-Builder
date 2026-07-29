import { CURRENCY_CP, MODULE_ID } from "../constants.mjs";
import { DraftManager } from "./draft-manager.mjs";

const PHYSICAL_ITEM_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "container", "loot"]);
const MAGIC_PROPERTIES = new Set(["mgc", "magic", "magical"]);

const CATEGORY_DEFINITIONS = [
  {
    id: "weapons", label: "Weapons", children: [
      {
        id: "weapons-simple", label: "Simple Weapons", children: [
          { id: "weapons-simple-melee", label: "Melee Weapons" },
          { id: "weapons-simple-ranged", label: "Ranged Weapons" }
        ]
      },
      {
        id: "weapons-martial", label: "Martial Weapons", children: [
          { id: "weapons-martial-melee", label: "Melee Weapons" },
          { id: "weapons-martial-ranged", label: "Ranged Weapons" }
        ]
      }
    ]
  },
  {
    id: "armor", label: "Armor", children: [
      { id: "armor-light", label: "Light Armor" },
      { id: "armor-medium", label: "Medium Armor" },
      { id: "armor-heavy", label: "Heavy Armor" },
      { id: "armor-shields", label: "Shields" }
    ]
  },
  {
    id: "adventuring-gear", label: "Adventuring Gear", children: [
      { id: "adventuring-general", label: "General Equipment" },
      { id: "adventuring-consumable", label: "Consumable Gear" },
      {
        id: "spellcasting-foci", label: "Spellcasting Foci", children: [
          { id: "spellcasting-foci-arcane", label: "Arcane Foci" },
          { id: "spellcasting-foci-druidic", label: "Druidic Foci" },
          { id: "spellcasting-foci-holy", label: "Holy Symbols" }
        ]
      }
    ]
  },
  {
    id: "tools", label: "Tools", children: [
      { id: "tools-artisan", label: "Artisan's Tools" },
      { id: "tools-gaming", label: "Gaming Sets" },
      { id: "tools-instrument", label: "Musical Instruments" },
      { id: "tools-other", label: "Other Tools" }
    ]
  },
  { id: "ammunition", label: "Ammunition" },
  { id: "containers", label: "Containers" },
  { id: "packs", label: "Packs" }
];

/**
 * Builds and manages the level-1 mundane starting-equipment shop. Shop prices
 * are stored in copper pieces so quantity multiplication never depends on
 * floating-point GP values.
 *
 * Shopping is intentionally transactional. Quantity changes affect only the
 * pending cart. Actor Items and currency are changed only by checkout.
 */
export class ShopService {
  static #catalogCache = new WeakMap();

  static async buildCatalog(registry) {
    const signature = registry.settingsSignature ?? "";
    const cached = this.#catalogCache.get(registry);
    if (cached?.signature === signature) return cached.value;

    const options = registry.equipmentGroups().flatMap(group => group.items);
    const items = options
      .filter(option => this.#isMundaneBaseItem(option))
      .map(option => this.#catalogItem(option))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    const value = {
      items,
      byUuid: new Map(items.map(item => [item.uuid, item])),
      categories: this.#categoryTree(items)
    };
    this.#catalogCache.set(registry, { signature, value });
    return value;
  }

  static async initializeDraft(
    draft,
    registry,
    budgetBreakdown,
    settings,
    { equipmentFingerprint = null, resetOnEquipmentChange = true } = {}
  ) {
    const state = DraftManager.getBuildState(draft);
    const previous = state.shop ?? {};
    const configuredBonus = Math.max(0, Math.trunc(Number(settings?.shopBonusGold ?? 0)));
    const bonusGold = Number.isFinite(Number(previous.bonusGold))
      ? Math.max(0, Math.trunc(Number(previous.bonusGold)))
      : configuredBonus;

    const totalBudgetCp = Math.max(0,
      Number(budgetBreakdown.existingCurrencyCp ?? 0) +
      Number(budgetBreakdown.classGoldCp ?? 0) +
      Number(budgetBreakdown.backgroundGoldCp ?? 0) +
      bonusGold * CURRENCY_CP.gp
    );
    const budgetFingerprint = this.#budgetFingerprint({
      existingCurrencyCp: Number(budgetBreakdown.existingCurrencyCp ?? 0),
      classGoldCp: Number(budgetBreakdown.classGoldCp ?? 0),
      backgroundGoldCp: Number(budgetBreakdown.backgroundGoldCp ?? 0),
      bonusGold,
      totalBudgetCp
    });

    const previousEquipmentFingerprint = previous.equipmentFingerprint ?? null;
    const previousBudgetFingerprint = previous.budgetFingerprint ?? null;
    const equipmentChanged = Boolean(
      resetOnEquipmentChange &&
      equipmentFingerprint &&
      (
        (previousEquipmentFingerprint && equipmentFingerprint !== previousEquipmentFingerprint) ||
        (!previousEquipmentFingerprint && previousBudgetFingerprint && previousBudgetFingerprint !== budgetFingerprint)
      )
    );
    const hadPurchases = Boolean(
      previous.checkout?.transactionId ||
      Array.from(previous.pendingCart ?? previous.cart ?? []).length ||
      Array.from(previous.committedCart ?? []).length
    );

    if (equipmentChanged) {
      const rootIds = this.#shopPurchaseRootIds(draft);
      if (rootIds.length) await draft.deleteEmbeddedDocuments("Item", rootIds, { deleteContents: true });
      // A changed Class/Background equipment choice creates a brand-new Shop
      // budget. Restore that full budget and require any purchases to be made
      // through a fresh Checkout transaction.
      await draft.update({ "system.currency": this.cpToCurrency(totalBudgetCp) });
    }

    const catalog = await this.buildCatalog(registry);
    const committedCart = equipmentChanged
      ? []
      : this.#sanitizeCart(previous.committedCart ?? [], catalog);
    const legacyPending = equipmentChanged
      ? []
      : previous.pendingCart ?? previous.cart ?? committedCart;
    const pendingCart = this.#sanitizeCart(legacyPending, catalog);
    const pendingSpentCp = this.#cartSpent(pendingCart);
    const committedSpentCp = this.#cartSpent(committedCart);

    const shop = {
      bonusGold,
      existingCurrencyCp: Number(budgetBreakdown.existingCurrencyCp ?? 0),
      classGoldCp: Number(budgetBreakdown.classGoldCp ?? 0),
      backgroundGoldCp: Number(budgetBreakdown.backgroundGoldCp ?? 0),
      totalBudgetCp,
      budgetFingerprint,
      equipmentFingerprint: equipmentFingerprint ?? previousEquipmentFingerprint,
      pendingCart,
      committedCart,
      // Keep the legacy key synchronized for older Drafts and diagnostics.
      cart: pendingCart,
      spentCp: pendingSpentCp,
      remainingCp: totalBudgetCp - pendingSpentCp,
      committedSpentCp,
      committedRemainingCp: totalBudgetCp - committedSpentCp,
      checkout: equipmentChanged ? null : foundry.utils.deepClone(previous.checkout ?? null)
    };
    await DraftManager.setBuildState(draft, { shop, equipmentSaved: false });
    return { ...shop, resetPurchases: equipmentChanged && hadPurchases };
  }

  static async context(draft, registry, { cartOverride = null, view = "pending" } = {}) {
    const state = DraftManager.getBuildState(draft);
    const shop = state.shop ?? {};
    const catalog = await this.buildCatalog(registry);
    const committedCart = this.#sanitizeCart(shop.committedCart ?? [], catalog);
    const pendingCart = this.#sanitizeCart(shop.pendingCart ?? shop.cart ?? committedCart, catalog);
    const cart = cartOverride
      ? this.#sanitizeCart(cartOverride, catalog)
      : view === "committed" ? committedCart : pendingCart;
    const spentCp = this.#cartSpent(cart);
    const totalBudgetCp = Number(shop.totalBudgetCp ?? 0);
    const remainingCp = totalBudgetCp - spentCp;
    const checkout = shop.checkout ?? null;
    const checkoutBudgetCurrent = Boolean(checkout?.transactionId && checkout.budgetFingerprint === shop.budgetFingerprint);
    const pendingDirty = !this.#cartEquals(pendingCart, committedCart) || !checkoutBudgetCurrent;
    const checkoutRequired = pendingCart.length > 0
      ? pendingDirty
      : Boolean(committedCart.length || checkout?.transactionId) && pendingDirty;
    const cartItems = cart.map(row => {
      const item = catalog.byUuid.get(row.uuid);
      return {
        ...item,
        quantity: row.quantity,
        lineTotalCp: item.priceCp * row.quantity,
        lineTotalLabel: this.formatCp(item.priceCp * row.quantity)
      };
    }).filter(row => row.uuid);

    return {
      initialized: Number.isFinite(Number(shop.bonusGold)),
      bonusGold: Number(shop.bonusGold ?? 0),
      existingCurrencyCp: Number(shop.existingCurrencyCp ?? 0),
      classGoldCp: Number(shop.classGoldCp ?? 0),
      backgroundGoldCp: Number(shop.backgroundGoldCp ?? 0),
      totalBudgetCp,
      spentCp,
      remainingCp,
      overspent: remainingCp < 0,
      existingCurrencyLabel: this.formatCp(Number(shop.existingCurrencyCp ?? 0)),
      classGoldLabel: this.formatCp(Number(shop.classGoldCp ?? 0)),
      backgroundGoldLabel: this.formatCp(Number(shop.backgroundGoldCp ?? 0)),
      bonusGoldLabel: `${Number(shop.bonusGold ?? 0)} GP`,
      totalBudgetLabel: this.formatCp(totalBudgetCp),
      spentLabel: this.formatCp(spentCp),
      remainingLabel: this.formatCp(Math.max(0, remainingCp)),
      cart: cartItems,
      cartRows: cart,
      cartCount: cart.reduce((sum, row) => sum + row.quantity, 0),
      hasCartItems: cartItems.length > 0,
      categories: catalog.categories,
      items: catalog.items.map(item => ({
        ...item,
        affordable: item.priceCp <= Math.max(0, remainingCp),
        inCart: cart.find(row => row.uuid === item.uuid)?.quantity ?? 0
      })),
      pendingDirty,
      checkoutRequired,
      checkoutComplete: checkoutBudgetCurrent && this.#cartEquals(pendingCart, committedCart),
      checkoutTransactionId: checkout?.transactionId ?? null,
      checkoutMessage: checkoutRequired
        ? "Checkout is required before these purchases are added to the character."
        : checkoutBudgetCurrent
          ? "The current Shopping Cart has been checked out."
          : "No Shop purchase has been checked out yet."
    };
  }

  static async changePendingQuantity(draft, registry, cart, uuid, delta) {
    const state = DraftManager.getBuildState(draft);
    const shop = state.shop ?? {};
    const catalog = await this.buildCatalog(registry);
    const item = catalog.byUuid.get(uuid);
    if (!item) throw new Error("That item is no longer available from an enabled source.");

    const currentCart = this.#sanitizeCart(cart ?? shop.pendingCart ?? shop.cart ?? [], catalog);
    const current = currentCart.find(row => row.uuid === uuid);
    const currentQuantity = current?.quantity ?? 0;
    const nextQuantity = Math.max(0, currentQuantity + Number(delta ?? 0));
    const provisionalSpent = this.#cartSpent(currentCart) - currentQuantity * item.priceCp + nextQuantity * item.priceCp;
    const totalBudgetCp = Number(shop.totalBudgetCp ?? 0);
    if (nextQuantity > currentQuantity && provisionalSpent > totalBudgetCp) {
      throw new Error("There is not enough remaining starting gold for that purchase.");
    }

    const nextCart = currentCart.filter(row => row.uuid !== uuid);
    if (nextQuantity > 0) nextCart.push({ uuid, quantity: nextQuantity, priceCp: item.priceCp });
    nextCart.sort((a, b) => catalog.byUuid.get(a.uuid).name.localeCompare(catalog.byUuid.get(b.uuid).name, game.i18n.lang));
    await this.savePendingCart(draft, registry, nextCart);
    return nextCart;
  }

  // Backward-compatible wrapper for any already-rendered 0.0.6 template.
  static async changeQuantity(draft, registry, uuid, delta) {
    const state = DraftManager.getBuildState(draft);
    return this.changePendingQuantity(draft, registry, state.shop?.pendingCart ?? state.shop?.cart ?? [], uuid, delta);
  }

  static async savePendingCart(draft, registry, cart) {
    const state = DraftManager.getBuildState(draft);
    const shop = foundry.utils.deepClone(state.shop ?? {});
    const catalog = await this.buildCatalog(registry);
    const pendingCart = this.#sanitizeCart(cart ?? [], catalog);
    const spentCp = this.#cartSpent(pendingCart);
    const totalBudgetCp = Number(shop.totalBudgetCp ?? 0);
    if (spentCp > totalBudgetCp) throw new Error("The Shopping Cart exceeds the available starting gold.");
    shop.pendingCart = pendingCart;
    shop.cart = pendingCart;
    shop.spentCp = spentCp;
    shop.remainingCp = totalBudgetCp - spentCp;
    await DraftManager.setBuildState(draft, { shop, equipmentSaved: false });
    return shop;
  }

  static async checkout(draft, registry, requestedCart) {
    const state = DraftManager.getBuildState(draft);
    const previousShop = foundry.utils.deepClone(state.shop ?? {});
    const previousCurrency = foundry.utils.deepClone(draft.system.currency ?? {});
    const catalog = await this.buildCatalog(registry);
    const cart = this.#sanitizeCart(requestedCart ?? previousShop.pendingCart ?? previousShop.cart ?? [], catalog);
    const spentCp = this.#cartSpent(cart);
    const totalBudgetCp = Number(previousShop.totalBudgetCp ?? 0);
    if (spentCp > totalBudgetCp) throw new Error("The Shopping Cart exceeds the available starting gold.");

    const transactionId = foundry.utils.randomID?.(16) ?? crypto.randomUUID();
    const purchase = await this.purchaseDocuments(draft, registry, { cart, transactionId });
    const oldShopItems = draft.items.filter(item => item.getFlag(MODULE_ID, "shopPurchase"));
    const oldRootIds = this.#shopPurchaseRootIds(draft);
    const oldShopData = oldShopItems.map(item => item.toObject());
    let newRootIds = [];

    try {
      if (purchase.createData.length) {
        await Item.implementation.createDocuments(purchase.createData, { parent: draft, keepId: true });
      }

      const manifest = this.#buildCheckoutManifest(draft, transactionId, cart, catalog);
      newRootIds = manifest.lines.flatMap(line => line.rootItemIds);

      const remainingCp = Math.max(0, totalBudgetCp - spentCp);
      await draft.update({ "system.currency": this.cpToCurrency(remainingCp) });
      const checkout = {
        transactionId,
        budgetFingerprint: previousShop.budgetFingerprint ?? this.#budgetFingerprint(previousShop),
        spentCp,
        remainingCp,
        committedAt: Date.now(),
        manifest
      };
      const nextShop = {
        ...previousShop,
        pendingCart: cart,
        committedCart: cart,
        cart,
        spentCp,
        remainingCp,
        committedSpentCp: spentCp,
        committedRemainingCp: remainingCp,
        checkout
      };
      await DraftManager.setBuildState(draft, { shop: nextShop, equipmentSaved: false });

      if (oldRootIds.length) {
        const rootsToDelete = oldRootIds.filter(id => !newRootIds.includes(id));
        if (rootsToDelete.length) await draft.deleteEmbeddedDocuments("Item", rootsToDelete, { deleteContents: true });
      }

      return { transactionId, cart, spentCp, remainingCp, manifest };
    } catch (error) {
      try {
        if (newRootIds.length) await draft.deleteEmbeddedDocuments("Item", newRootIds, { deleteContents: true });
        else {
          const transactionRoots = this.#shopPurchaseRootIds(draft, transactionId);
          if (transactionRoots.length) await draft.deleteEmbeddedDocuments("Item", transactionRoots, { deleteContents: true });
        }
        await draft.update({ "system.currency": previousCurrency });
        await DraftManager.setBuildState(draft, { shop: previousShop, equipmentSaved: false });

        const existingIds = new Set(draft.items.map(item => item.id));
        const missingOldData = oldShopData.filter(data => !existingIds.has(data._id));
        if (missingOldData.length) {
          await Item.implementation.createDocuments(missingOldData, { parent: draft, keepId: true });
        }
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Shop checkout rollback failed.`, rollbackError);
      }
      throw error;
    }
  }

  static async validateCheckout(draft, registry, { allowNoPurchase = true } = {}) {
    const state = DraftManager.getBuildState(draft);
    const shop = state.shop ?? {};
    const catalog = await this.buildCatalog(registry);
    const pendingCart = this.#sanitizeCart(shop.pendingCart ?? shop.cart ?? [], catalog);
    const committedCart = this.#sanitizeCart(shop.committedCart ?? [], catalog);
    const checkout = shop.checkout ?? null;
    const checkoutCurrent = Boolean(checkout?.transactionId && checkout.budgetFingerprint === shop.budgetFingerprint);

    if (!this.#cartEquals(pendingCart, committedCart) || (committedCart.length && !checkoutCurrent)) {
      throw new Error("Return to the Shop and complete Checkout before confirming Starting Equipment.");
    }
    if (!committedCart.length) {
      if (!allowNoPurchase && !checkoutCurrent) throw new Error("Complete Shop Checkout before confirming Starting Equipment.");
      return { cart: [], spentCp: 0, remainingCp: Number(shop.totalBudgetCp ?? 0) };
    }

    const transactionId = checkout.transactionId;
    const manifest = checkout.manifest;
    if (manifest?.lines?.length) {
      const missing = [];
      for (const line of manifest.lines) {
        const roots = Array.from(line.rootItemIds ?? []).map(id => draft.items.get(id)).filter(Boolean);
        if (roots.length !== Array.from(line.rootItemIds ?? []).length) {
          missing.push(`${line.name}${Number(line.quantity ?? 1) > 1 ? ` ×${line.quantity}` : ""}`);
          continue;
        }

        const validRoots = roots.every(item =>
          item.getFlag(MODULE_ID, "shopPurchase") &&
          item.getFlag(MODULE_ID, "shopRoot") === true &&
          item.getFlag(MODULE_ID, "shopTransactionId") === transactionId &&
          item.getFlag(MODULE_ID, "shopLineId") === line.lineId &&
          item.getFlag(MODULE_ID, "shopSourceUuid") === line.uuid
        );
        const representedQuantity = roots.reduce((sum, item) =>
          sum + (item.type === "container" ? 1 : Math.max(1, Number(item.system.quantity ?? 1))), 0);
        if (!validRoots || representedQuantity !== Number(line.quantity ?? 1)) {
          missing.push(`${line.name}${Number(line.quantity ?? 1) > 1 ? ` ×${line.quantity}` : ""}`);
        }
      }
      if (missing.length) {
        throw new Error(`Checked-out Shop purchase is incomplete: ${missing.join(", ")}. Reopen the Shop and complete Checkout again.`);
      }
    } else {
      // Compatibility fallback for Drafts checked out with the first 0.0.6 hotfix.
      // New transactions always use the exact root-Item manifest above.
      const actual = new Map();
      for (const item of draft.items) {
        if (!item.getFlag(MODULE_ID, "shopPurchase")) continue;
        if (item.getFlag(MODULE_ID, "shopTransactionId") !== transactionId) continue;
        const explicitRoot = item.getFlag(MODULE_ID, "shopRoot");
        if (explicitRoot === false) continue;
        if ((explicitRoot === undefined || explicitRoot === null) && item.system.container) continue;
        const uuid = item.getFlag(MODULE_ID, "shopSourceUuid");
        if (!uuid) continue;
        const quantity = item.type === "container" ? 1 : Math.max(1, Number(item.system.quantity ?? 1));
        actual.set(uuid, (actual.get(uuid) ?? 0) + quantity);
      }
      const expected = new Map(committedCart.map(row => [row.uuid, row.quantity]));
      const matches = expected.size === actual.size && [...expected.entries()].every(([uuid, quantity]) => actual.get(uuid) === quantity);
      if (!matches) {
        throw new Error("Checked-out Shop items no longer match the character. Reopen the Shop and Checkout again to restore them.");
      }
    }

    return {
      cart: committedCart,
      spentCp: Number(checkout.spentCp ?? this.#cartSpent(committedCart)),
      remainingCp: Number(checkout.remainingCp ?? Math.max(0, Number(shop.totalBudgetCp ?? 0) - this.#cartSpent(committedCart))),
      transactionId
    };
  }

  static async clearCart(draft, { preserveBonus = true } = {}) {
    const state = DraftManager.getBuildState(draft);
    const previous = state.shop ?? {};
    const bonusGold = preserveBonus && Number.isFinite(Number(previous.bonusGold))
      ? Math.max(0, Math.trunc(Number(previous.bonusGold)))
      : undefined;
    const rootIds = this.#shopPurchaseRootIds(draft);
    if (rootIds.length) await draft.deleteEmbeddedDocuments("Item", rootIds, { deleteContents: true });
    const shop = {
      ...(bonusGold === undefined ? {} : { bonusGold }),
      existingCurrencyCp: 0,
      classGoldCp: 0,
      backgroundGoldCp: 0,
      pendingCart: [],
      committedCart: [],
      cart: [],
      totalBudgetCp: 0,
      spentCp: 0,
      remainingCp: 0,
      committedSpentCp: 0,
      committedRemainingCp: 0,
      checkout: null
    };
    await DraftManager.setBuildState(draft, { shop, equipmentSaved: false });
  }

  static async purchaseDocuments(draft, registry, { cart, transactionId }) {
    const catalog = await this.buildCatalog(registry);
    const sanitizedCart = this.#sanitizeCart(cart ?? [], catalog);
    const createData = [];
    for (const row of sanitizedCart) {
      const item = catalog.byUuid.get(row.uuid);
      if (!item || !registry.isUuidAllowed(item.uuid)) {
        throw new Error("The Shopping Cart contains an item from a disabled or unavailable source.");
      }
      const document = await fromUuid(item.uuid);
      if (!document) throw new Error(`Unable to load purchased item: ${item.name}`);

      // Containers and packs can own embedded contents. Create one complete
      // container document per purchased unit so buying two packs also creates
      // two independent sets of contents with valid container references.
      const copies = document.type === "container" ? row.quantity : 1;
      const lineId = foundry.utils.randomID?.(16) ?? crypto.randomUUID();
      for (let copy = 0; copy < copies; copy++) {
        const data = await Item.implementation.createWithContents([document], {
          transformAll: (entry, { depth }) => {
            const object = entry instanceof foundry.abstract.Document
              ? entry.toObject()
              : foundry.utils.deepClone(entry);
            object.flags ??= {};
            object.flags[MODULE_ID] = foundry.utils.mergeObject(object.flags[MODULE_ID] ?? {}, {
              startingEquipment: true,
              shopPurchase: true,
              shopTransactionId: transactionId,
              shopLineId: lineId,
              shopRoot: depth === 0,
              shopSourceUuid: item.uuid,
              shopPurchasedQuantity: depth === 0 ? (document.type === "container" ? 1 : row.quantity) : 0,
              sourceItemName: "Shopping Cart",
              shopPriceCp: item.priceCp
            }, { inplace: false, overwrite: true });
            if (depth === 0) {
              foundry.utils.setProperty(object, "system.quantity", document.type === "container" ? 1 : row.quantity);
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
    }
    return { createData, spentCp: this.#cartSpent(sanitizedCart), cart: sanitizedCart };
  }

  static currencyToCp(currency = {}) {
    return Object.entries(CURRENCY_CP).reduce((total, [denomination, multiplier]) =>
      total + Number(currency?.[denomination] ?? 0) * multiplier, 0);
  }

  static denominationToCp(amount, denomination = "gp") {
    const multiplier = CURRENCY_CP[String(denomination).toLowerCase()] ?? CURRENCY_CP.gp;
    return Math.max(0, Number(amount ?? 0) * multiplier);
  }

  static cpToCurrency(cp) {
    let remaining = Math.max(0, Math.trunc(Number(cp ?? 0)));
    const pp = Math.floor(remaining / CURRENCY_CP.pp);
    remaining -= pp * CURRENCY_CP.pp;
    const gp = Math.floor(remaining / CURRENCY_CP.gp);
    remaining -= gp * CURRENCY_CP.gp;
    const sp = Math.floor(remaining / CURRENCY_CP.sp);
    remaining -= sp * CURRENCY_CP.sp;
    return { pp, gp, ep: 0, sp, cp: remaining };
  }

  static formatCp(cp) {
    let remaining = Math.max(0, Math.trunc(Number(cp ?? 0)));
    const parts = [];
    const pp = Math.floor(remaining / CURRENCY_CP.pp);
    if (pp) {
      parts.push(`${pp} PP`);
      remaining -= pp * CURRENCY_CP.pp;
    }
    const gp = Math.floor(remaining / CURRENCY_CP.gp);
    if (gp) {
      parts.push(`${gp} GP`);
      remaining -= gp * CURRENCY_CP.gp;
    }
    const sp = Math.floor(remaining / CURRENCY_CP.sp);
    if (sp) {
      parts.push(`${sp} SP`);
      remaining -= sp * CURRENCY_CP.sp;
    }
    if (remaining || !parts.length) parts.push(`${remaining} CP`);
    return parts.join(" · ");
  }


  static #shopPurchaseRootIds(draft, transactionId = null) {
    return draft.items
      .filter(item => {
        if (!item.getFlag(MODULE_ID, "shopPurchase")) return false;
        if (transactionId && item.getFlag(MODULE_ID, "shopTransactionId") !== transactionId) return false;
        const explicitRoot = item.getFlag(MODULE_ID, "shopRoot");
        if (explicitRoot !== undefined && explicitRoot !== null) return explicitRoot === true;
        // Compatibility with the earliest 0.0.6 transaction format.
        return !item.system.container;
      })
      .map(item => item.id);
  }

  static #buildCheckoutManifest(draft, transactionId, cart, catalog) {
    const transactionRoots = draft.items.filter(item =>
      item.getFlag(MODULE_ID, "shopPurchase") &&
      item.getFlag(MODULE_ID, "shopRoot") === true &&
      item.getFlag(MODULE_ID, "shopTransactionId") === transactionId
    );
    const lines = [];
    for (const row of cart) {
      const catalogItem = catalog.byUuid.get(row.uuid);
      const roots = transactionRoots.filter(item => item.getFlag(MODULE_ID, "shopSourceUuid") === row.uuid);
      const lineIds = new Set(roots.map(item => item.getFlag(MODULE_ID, "shopLineId")).filter(Boolean));
      const representedQuantity = roots.reduce((sum, item) =>
        sum + (item.type === "container" ? 1 : Math.max(1, Number(item.system.quantity ?? 1))), 0);
      if (!roots.length || lineIds.size !== 1 || representedQuantity !== Number(row.quantity ?? 1)) {
        throw new Error(`Unable to verify the checked-out Shop item: ${catalogItem?.name ?? row.uuid}.`);
      }
      lines.push({
        lineId: [...lineIds][0],
        uuid: row.uuid,
        name: catalogItem?.name ?? row.uuid,
        quantity: Number(row.quantity ?? 1),
        rootItemIds: roots.map(item => item.id)
      });
    }
    return { version: 1, lines };
  }

  static #budgetFingerprint(shop) {
    return JSON.stringify({
      existingCurrencyCp: Number(shop.existingCurrencyCp ?? 0),
      classGoldCp: Number(shop.classGoldCp ?? 0),
      backgroundGoldCp: Number(shop.backgroundGoldCp ?? 0),
      bonusGold: Number(shop.bonusGold ?? 0),
      totalBudgetCp: Number(shop.totalBudgetCp ?? 0)
    });
  }

  static #cartEquals(left, right) {
    const normalize = cart => [...Array.from(cart ?? [])]
      .map(row => `${row.uuid}:${Number(row.quantity ?? 0)}:${Number(row.priceCp ?? 0)}`)
      .sort();
    const a = normalize(left);
    const b = normalize(right);
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  static #sanitizeCart(cart, catalog) {
    const consolidated = new Map();
    for (const row of Array.from(cart ?? [])) {
      const item = catalog.byUuid.get(row.uuid);
      if (!item) continue;
      const quantity = Math.max(0, Math.trunc(Number(row.quantity ?? 0)));
      if (!quantity) continue;
      consolidated.set(row.uuid, (consolidated.get(row.uuid) ?? 0) + quantity);
    }
    return [...consolidated.entries()].map(([uuid, quantity]) => ({
      uuid,
      quantity,
      priceCp: catalog.byUuid.get(uuid).priceCp
    }));
  }

  static #cartSpent(cart) {
    return Array.from(cart ?? []).reduce((total, row) =>
      total + Math.max(0, Number(row.quantity ?? 0)) * Math.max(0, Number(row.priceCp ?? 0)), 0);
  }

  static #isMundaneBaseItem(option) {
    if (!option || !PHYSICAL_ITEM_TYPES.has(option.type)) return false;
    const system = option.system ?? {};
    const rarity = String(system.rarity ?? "").trim().toLowerCase();
    if (rarity && !["none", "mundane"].includes(rarity)) return false;

    const magicalBonus = Number(system.magicalBonus ?? system.armor?.magicalBonus ?? 0);
    if (magicalBonus) return false;

    const properties = this.#properties(system.properties);
    if (properties.some(property => MAGIC_PROPERTIES.has(String(property).toLowerCase()))) return false;

    const attunement = system.attunement;
    if (attunement && ![0, "0", "none", ""].includes(attunement)) return false;

    const typeValue = String(system.type?.value ?? "").toLowerCase();
    const subtype = String(system.type?.subtype ?? "").toLowerCase();
    const name = String(option.name ?? "").toLowerCase();
    if (["vehicle", "mount", "service"].includes(typeValue) || ["vehicle", "mount", "service"].includes(subtype)) return false;
    if (/\b(service|hireling|spellcasting service|mount|warhorse|sailing ship|airship)\b/i.test(name)) return false;

    if (this.#isFocus(option)) return true;
    const price = Number(system.price?.value ?? 0);
    const denomination = String(system.price?.denomination ?? "gp").toLowerCase();
    return Number.isFinite(price) && price > 0 && Boolean(CURRENCY_CP[denomination]);
  }

  static #catalogItem(option) {
    const focus = this.#isFocus(option);
    const priceCp = focus
      ? CURRENCY_CP.gp
      : this.denominationToCp(option.system?.price?.value, option.system?.price?.denomination);
    if (!Number.isFinite(priceCp) || priceCp <= 0) return null;

    const categoryIds = this.#categoryIds(option, focus);
    if (!categoryIds.length) return null;
    return {
      id: option.id,
      uuid: option.uuid,
      identifier: option.identifier,
      name: option.name,
      img: option.img,
      type: option.type,
      sourceId: option.sourceId,
      sourceLabel: option.sourceLabel,
      sourceRank: option.sourceRank,
      search: `${option.name} ${option.identifier} ${option.sourceLabel}`.toLowerCase(),
      categoryIds,
      categoriesText: categoryIds.join(" "),
      priceCp,
      priceLabel: this.formatCp(priceCp),
      focusPriceOverride: focus
    };
  }

  static #categoryIds(option, focus) {
    const system = option.system ?? {};
    const typeValue = String(system.type?.value ?? "");
    const subtype = String(system.type?.subtype ?? "").toLowerCase();
    const name = String(option.name ?? "").toLowerCase();
    const identifier = String(option.identifier ?? "").toLowerCase();
    const properties = this.#properties(system.properties).map(value => String(value).toLowerCase());

    if (option.type === "weapon") {
      let categories;
      if (typeValue === "simpleM") categories = ["weapons", "weapons-simple", "weapons-simple-melee"];
      else if (typeValue === "simpleR") categories = ["weapons", "weapons-simple", "weapons-simple-ranged"];
      else if (typeValue === "martialM") categories = ["weapons", "weapons-martial", "weapons-martial-melee"];
      else if (typeValue === "martialR") categories = ["weapons", "weapons-martial", "weapons-martial-ranged"];
      else categories = ["weapons"];
      if (focus) {
        const focusType = this.#focusType(option);
        categories.push("adventuring-gear", "spellcasting-foci", `spellcasting-foci-${focusType}`);
      }
      return categories;
    }

    if (option.type === "equipment" && ["light", "medium", "heavy", "shield"].includes(typeValue)) {
      const suffix = typeValue === "shield" ? "shields" : typeValue;
      return ["armor", `armor-${suffix}`];
    }

    if (focus) {
      const focusType = this.#focusType(option);
      return ["adventuring-gear", "spellcasting-foci", `spellcasting-foci-${focusType}`];
    }

    const ammunition = properties.includes("amm") || ["ammo", "ammunition"].includes(subtype) ||
      /\b(arrows?|bolts?|sling bullets?|needles?)\b/i.test(name);
    if (ammunition) return ["ammunition"];

    if (option.type === "container") {
      if (/pack$/i.test(identifier) || /\bpack\b/i.test(name)) return ["packs"];
      return ["containers"];
    }

    if (option.type === "tool") {
      const combined = `${name} ${identifier} ${typeValue.toLowerCase()} ${subtype}`;
      if (/dice|cards|chess|dragonchess|gaming/.test(combined)) return ["tools", "tools-gaming"];
      if (/lute|lyre|flute|horn|drum|viol|bagpipe|dulcimer|shawm|instrument/.test(combined)) {
        return ["tools", "tools-instrument"];
      }
      if (/supplies|tools|kit|utensils/.test(combined)) return ["tools", "tools-artisan"];
      return ["tools", "tools-other"];
    }

    if (option.type === "consumable") return ["adventuring-gear", "adventuring-consumable"];
    if (["equipment", "loot"].includes(option.type)) return ["adventuring-gear", "adventuring-general"];
    return [];
  }

  static #isFocus(option) {
    const system = option.system ?? {};
    const properties = this.#properties(system.properties).map(value => String(value).toLowerCase());
    const typeValue = String(system.type?.value ?? "").toLowerCase();
    const subtype = String(system.type?.subtype ?? "").toLowerCase();
    const identifier = String(option.identifier ?? "").toLowerCase();
    const name = String(option.name ?? "").toLowerCase();
    const explicitlyFocus = properties.includes("foc") || typeValue === "focus" || subtype.includes("focus");
    if (explicitlyFocus) return true;

    // Name-based fallback is only for non-weapon mundane focus objects. This
    // prevents a Quarterstaff or another ordinary weapon from receiving the
    // symbolic 1 GP focus price merely because its name contains “staff”.
    if (option.type === "weapon") return false;
    return /\b(arcane focus|druidic focus|holy symbol|amulet|emblem|reliquary|orb|crystal|rod|wand|staff|totem|mistletoe|charm)\b/i
      .test(`${name} ${identifier}`);
  }

  static #focusType(option) {
    const text = `${option.name} ${option.identifier} ${option.system?.type?.subtype ?? ""}`.toLowerCase();
    if (/amulet|emblem|reliquary|holy symbol/.test(text)) return "holy";
    if (/druid|mistletoe|totem|wooden staff|yew wand/.test(text)) return "druidic";
    return "arcane";
  }

  static #properties(value) {
    if (value?.has && value?.values) return [...value.values()];
    if (value instanceof Set) return [...value];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && !value[Symbol.iterator]) {
      return Object.entries(value).filter(([, enabled]) => Boolean(enabled)).map(([key]) => key);
    }
    return Array.from(value ?? []);
  }

  static #categoryTree(items) {
    const countFor = id => items.filter(item => item.categoryIds.includes(id)).length;
    const build = definitions => definitions.map(definition => {
      const children = build(definition.children ?? []);
      const count = countFor(definition.id);
      return { ...definition, count, children, hasChildren: children.length > 0 };
    }).filter(definition => definition.count > 0);
    return build(CATEGORY_DEFINITIONS);
  }
}
