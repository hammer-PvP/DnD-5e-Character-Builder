import { MODULE_ID } from "../constants.mjs";
import { ShopService } from "../services/shop-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class EquipmentShopApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(draft, registry, parentApp, options = {}) {
    super(options);
    this.draft = draft;
    this.registry = registry;
    this.parentApp = parentApp;
    this.selectedCategory = "all";
    this.searchQuery = "";
    this.catalogScroll = 0;
    this.filterScroll = 0;
    this.cartScroll = 0;
    this.localCart = null;
    this.checkoutBusy = false;
  }

  static DEFAULT_OPTIONS = {
    id: "dnd5e-character-builder-shop",
    classes: ["character-builder", "cb-shop-app"],
    tag: "section",
    position: { width: 1180, height: 760 },
    window: { title: "Starting Equipment Shop", resizable: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/equipment-shop.hbs` }
  };

  get id() {
    return `dnd5e-character-builder-shop-${this.draft.id}`;
  }

  async _prepareContext() {
    const initial = await ShopService.context(this.draft, this.registry);
    this.localCart ??= foundry.utils.deepClone(initial.cartRows ?? []);
    const shop = await ShopService.context(this.draft, this.registry, { cartOverride: this.localCart });
    return {
      shop,
      checkoutBusy: this.checkoutBusy,
      selectedCategory: this.selectedCategory,
      selectedCategoryPath: this.#categoryPath(shop.categories, this.selectedCategory),
      searchQuery: this.searchQuery
    };
  }

  _onRender() {
    const root = this.element;
    root.querySelector('[name="shopSearch"]')?.addEventListener("input", event => {
      this.searchQuery = event.currentTarget.value;
      this.#applyFilters();
    });

    root.querySelectorAll('[data-action="shop-category"]').forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        this.selectedCategory = event.currentTarget.dataset.category || "all";
        root.querySelectorAll('[data-action="shop-category"]').forEach(row => {
          row.classList.toggle("active", row.dataset.category === this.selectedCategory);
        });
        this.#applyFilters();
      });
    });

    root.querySelectorAll('[data-action="shop-add"], [data-action="shop-increase"], [data-action="shop-decrease"]').forEach(button => {
      button.addEventListener("click", event => this.#changeQuantity(event));
    });

    root.querySelectorAll('[data-action="shop-details"]').forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        const document = await fromUuid(event.currentTarget.dataset.uuid);
        document?.sheet.render(true);
      });
    });

    root.querySelector('[data-action="shop-checkout"]')?.addEventListener("click", event => this.#checkout(event));
    root.querySelector('[data-action="return-equipment"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.close();
    });

    root.querySelectorAll('[data-action="shop-category"]').forEach(row => {
      row.classList.toggle("active", row.dataset.category === this.selectedCategory);
    });

    requestAnimationFrame(() => {
      const list = this.element?.querySelector?.(".cb-shop-items");
      const filters = this.element?.querySelector?.(".cb-shop-filters");
      const cart = this.element?.querySelector?.(".cb-shop-cart-items");
      if (list) list.scrollTop = this.catalogScroll;
      if (filters) filters.scrollTop = this.filterScroll;
      if (cart) cart.scrollTop = this.cartScroll;
      this.#applyFilters();
    });
  }

  async #changeQuantity(event) {
    event.preventDefault();
    this.#rememberScroll();
    const action = event.currentTarget.dataset.action;
    const delta = action === "shop-decrease" ? -1 : 1;
    try {
      this.localCart = await ShopService.changePendingQuantity(
        this.draft,
        this.registry,
        this.localCart,
        event.currentTarget.dataset.uuid,
        delta
      );
      this.render({ force: true });
    } catch (error) {
      ui.notifications.warn(error.message);
    }
  }

  async #checkout(event) {
    event.preventDefault();
    if (this.checkoutBusy) return;
    this.checkoutBusy = true;
    this.#rememberScroll();
    try {
      const result = await ShopService.checkout(this.draft, this.registry, this.localCart ?? []);
      ui.notifications.info(`Shop Checkout completed. ${ShopService.formatCp(result.remainingCp)} remains.`);
      await super.close();
      this.parentApp?.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Shop checkout failed.`, error);
      ui.notifications.error(`Shop Checkout failed: ${error.message}`);
      this.checkoutBusy = false;
      this.render({ force: true });
    }
  }

  #rememberScroll() {
    const list = this.element?.querySelector?.(".cb-shop-items");
    const filters = this.element?.querySelector?.(".cb-shop-filters");
    const cart = this.element?.querySelector?.(".cb-shop-cart-items");
    this.catalogScroll = list?.scrollTop ?? 0;
    this.filterScroll = filters?.scrollTop ?? 0;
    this.cartScroll = cart?.scrollTop ?? 0;
  }

  #categoryPath(categories, selectedId) {
    if (!selectedId || selectedId === "all") return "All Items";
    const visit = (rows, trail = []) => {
      for (const row of rows ?? []) {
        const next = [...trail, row.label];
        if (row.id === selectedId) return next.join(" › ");
        const nested = visit(row.children, next);
        if (nested) return nested;
      }
      return null;
    };
    return visit(categories) ?? "All Items";
  }

  #applyFilters() {
    const root = this.element;
    const query = String(this.searchQuery ?? "").trim().toLowerCase();
    const category = this.selectedCategory ?? "all";
    let visible = 0;
    root.querySelectorAll("[data-shop-item]").forEach(card => {
      const matchesQuery = !query || String(card.dataset.search ?? "").includes(query);
      const matchesCategory = category === "all" || String(card.dataset.categories ?? "").split(" ").includes(category);
      const show = matchesQuery && matchesCategory;
      card.hidden = !show;
      if (show) visible += 1;
    });
    root.querySelector("[data-visible-count]")?.replaceChildren(document.createTextNode(String(visible)));
    root.querySelector(".cb-shop-empty-results")?.toggleAttribute("hidden", visible > 0);
  }
}
