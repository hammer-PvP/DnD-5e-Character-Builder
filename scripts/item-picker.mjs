import { MODULE_ID } from "./constants.mjs";
import { banKey, buildCatalog, entriesForProfile, nativeSubtypeLabel, normalizeText } from "./catalog.mjs";
import { getConfiguration } from "./settings.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function titleCase(value) {
  return String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function packageShortLabel(packageName) {
  const known = {
    dnd5e: "D&D5e Core",
    "dnd-players-handbook": "PHB 2024",
    "dnd-dungeon-masters-guide": "DMG 2024"
  };
  if (known[packageName]) return known[packageName];
  return game.modules.get(packageName)?.title
    ?? (packageName === game.system.id ? game.system.title : titleCase(packageName));
}

function sourceDisplay(entry) {
  return `${entry.packLabel} — ${packageShortLabel(entry.packageName)}`;
}

export class SupplierItemPicker extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dnd5e-supplier-item-picker",
    classes: ["dnd5e-supplier", "dnd5e-supplier-picker"],
    position: { width: 860, height: 740 },
    window: {
      title: "DND5E_SUPPLIER.Picker.Title",
      icon: "fa-solid fa-magnifying-glass",
      resizable: true
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/item-picker.hbs` }
  };

  constructor({
    profile,
    onSelect,
    multiple = false,
    includeBanned = false,
    title = null,
    configuration = null,
    rawSourceDocuments = false,
    banMode = false
  } = {}, options = {}) {
    super(options);
    this.profile = profile;
    this.onSelect = onSelect;
    this.multiple = multiple;
    this.includeBanned = includeBanned;
    this.customTitle = title;
    this.configuration = configuration;
    this.rawSourceDocuments = rawSourceDocuments;
    this.banMode = banMode;
    this.selected = new Map();
  }

  async _prepareContext() {
    const configuration = this.configuration ?? getConfiguration();
    const catalog = await buildCatalog({ configurationOverride: configuration });
    const sourceIds = new Set(this.profile?.sourceIds ?? []);

    const entries = (this.rawSourceDocuments
      ? catalog.rawEntries.filter(entry => !sourceIds.size || sourceIds.has(entry.packId))
      : entriesForProfile(catalog, this.profile, configuration, { includeBanned: this.includeBanned }))
      .filter(entry => entry.type !== "spell")
      .sort((a, b) => a.name.localeCompare(b.name) || sourceDisplay(a).localeCompare(sourceDisplay(b)));

    const types = [...new Set(entries.map(entry => entry.type).filter(Boolean))].sort();
    const subtypes = [...new Set(entries.flatMap(entry => entry.subtypeKeys ?? [entry.primarySubtypeKey]).filter(Boolean))]
      .sort((a, b) => nativeSubtypeLabel(a).localeCompare(nativeSubtypeLabel(b)));
    const sources = [...new Map(entries.map(entry => [entry.packId, sourceDisplay(entry)])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1]));

    return {
      title: this.customTitle,
      multiple: this.multiple,
      banMode: this.banMode,
      typeOptions: types.map(value => ({ value, label: titleCase(value) })),
      subtypeOptions: subtypes.map(value => ({ value, label: nativeSubtypeLabel(value) })),
      sourceOptions: sources.map(([value, label]) => ({ value, label })),
      entries: entries.map(entry => {
        const subtypeKeys = entry.subtypeKeys ?? [entry.primarySubtypeKey].filter(Boolean);
        return {
          ...entry,
          canonicalKey: banKey(entry),
          normalizedType: normalizeText(entry.type),
          subtypeLabel: nativeSubtypeLabel(entry.primarySubtypeKey),
          normalizedSubtypes: subtypeKeys.map(normalizeText).join("|"),
          normalizedPack: normalizeText(entry.packId),
          sourceDisplay: sourceDisplay(entry),
          searchText: normalizeText(`${entry.name} ${entry.identifier} ${entry.type} ${(entry.subtypeAliases ?? [entry.subtype]).join(" ")} ${entry.packLabel} ${packageShortLabel(entry.packageName)}`)
        };
      })
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root) return;

    const searchInput = root.querySelector("[data-action='search']");
    const typeSelect = root.querySelector("[data-filter='type']");
    const subtypeSelect = root.querySelector("[data-filter='subtype']");
    const sourceSelect = root.querySelector("[data-filter='source']");
    const rows = [...root.querySelectorAll("[data-picker-row]")];
    const count = root.querySelector("[data-selected-count]");
    const visibleCount = root.querySelector("[data-visible-count]");

    const applyFilters = () => {
      const query = normalizeText(searchInput?.value ?? "");
      const type = normalizeText(typeSelect?.value ?? "");
      const subtype = normalizeText(subtypeSelect?.value ?? "");
      const source = normalizeText(sourceSelect?.value ?? "");
      let visible = 0;
      for (const row of rows) {
        row.hidden = Boolean(
          (query && !row.dataset.search.includes(query))
          || (type && row.dataset.type !== type)
          || (subtype && !(row.dataset.subtypes ?? "").split("|").includes(subtype))
          || (source && row.dataset.source !== source)
        );
        if (!row.hidden) visible += 1;
      }
      if (visibleCount) visibleCount.textContent = String(visible);
    };

    const updateCount = () => {
      if (count) count.textContent = String(this.selected.size);
    };

    searchInput?.addEventListener("input", applyFilters);
    typeSelect?.addEventListener("change", applyFilters);
    subtypeSelect?.addEventListener("change", applyFilters);
    sourceSelect?.addEventListener("change", applyFilters);
    searchInput?.focus();
    applyFilters();

    root.querySelectorAll("[data-action='select-item']").forEach(button => {
      button.addEventListener("click", async () => {
        const result = {
          id: foundry.utils.randomID(),
          uuid: button.dataset.uuid,
          key: button.dataset.key,
          name: button.dataset.name,
          img: button.dataset.img,
          type: button.dataset.itemType,
          subtype: button.dataset.itemSubtype,
          subtypeKey: button.dataset.itemSubtypeKey,
          packId: button.dataset.packId,
          packLabel: button.dataset.pack,
          packageName: button.dataset.packageName,
          allSources: false
        };

        if (!this.multiple) {
          await this.onSelect?.(result);
          this.close();
          return;
        }

        if (this.selected.has(result.uuid)) {
          this.selected.delete(result.uuid);
          button.classList.remove("selected");
        } else {
          this.selected.set(result.uuid, result);
          button.classList.add("selected");
        }
        updateCount();
      });
    });

    root.querySelector("[data-action='confirm-selection']")?.addEventListener("click", async () => {
      if (!this.selected.size) return;
      const allSources = this.banMode
        ? root.querySelector("input[name='banScope']:checked")?.value === "all"
        : false;
      const selected = [...this.selected.values()].map(item => ({ ...item, allSources }));
      await this.onSelect?.(selected);
      this.close();
    });
  }
}
