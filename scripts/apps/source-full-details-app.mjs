import { MODULE_ID } from "../constants.mjs";
import { SourceFullDetailsService } from "../services/source-full-details-service.mjs";
import { ModalStackService } from "../services/modal-stack-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TextEditorImplementation = foundry.applications.ux.TextEditor.implementation;

export class SourceFullDetailsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(item, parentApp = null, options = {}) {
    super(options);
    this.item = item;
    this.parentApp = parentApp;
    this.resolution = null;
    this.modalStackToken = null;
  }

  static DEFAULT_OPTIONS = {
    id: "character-builder-source-full-details",
    classes: ["dnd5e-character-builder", "character-builder", "source-full-details-app"],
    tag: "section",
    position: { width: 1000, height: 820 },
    window: { title: "Character Builder — Full Details", resizable: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/source-full-details.hbs` }
  };

  get id() {
    return `character-builder-source-full-details-${this.item?.id ?? "source"}`;
  }

  async _prepareContext() {
    this.resolution ??= await SourceFullDetailsService.resolve(this.item);
    const { page, sourceDocument, sourceUuid, packageId, reason } = this.resolution;
    let content = "";
    let nativePage = false;

    if (page) {
      try {
        content = await this.#renderNativePage(page);
        nativePage = Boolean(content);
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not render native source page for ${this.item?.name}.`, error);
      }
    }

    if (!content) {
      const raw = String(sourceDocument?.system?.description?.value ?? this.item?.system?.description?.value ?? "").trim();
      try {
        content = await TextEditorImplementation.enrichHTML(raw, {
          async: true,
          relativeTo: sourceDocument ?? this.item,
          secrets: Boolean(game.user?.isGM)
        });
      } catch (_error) {
        content = raw;
      }
    }

    return {
      name: sourceDocument?.name ?? this.item?.name ?? "Source Details",
      img: sourceDocument?.img ?? this.item?.img ?? "icons/svg/book.svg",
      sourceUuid,
      packageId,
      pageName: page?.name ?? null,
      pageType: page?.type ?? null,
      nativePage,
      fallback: !nativePage,
      reason,
      content
    };
  }

  _onRender() {
    this.modalStackToken ??= ModalStackService.beginRoot(this, {
      ownerApp: this.parentApp,
      ownerElement: this.parentApp?.element,
      label: `${this.item?.name ?? "Subclass"} Full Details`,
      message: "Close Full Details to return to Level Up."
    });
  }

  async _onClose(options = {}) {
    if (this.modalStackToken) {
      ModalStackService.end(this.modalStackToken, { closeDescendants: true });
      this.modalStackToken = null;
    }
    return super._onClose(options);
  }

  async #renderNativePage(page) {
    // D&D5e class/subclass Journal pages already know how to build the official
    // art, progression table, linked features, and enriched descriptions. We
    // reuse that view context and template inside our own viewer instead of
    // copying any book content into Character Builder.
    if (["class", "subclass"].includes(page.type) && page.sheet?._prepareContext) {
      const sheet = page.sheet;
      const context = await sheet._prepareContext({ isFirstRender: true });
      const renderer = foundry.applications.handlebars?.renderTemplate ?? globalThis.renderTemplate;
      if (typeof renderer === "function") {
        return renderer(`systems/dnd5e/templates/journal/page-${page.type}-view.hbs`, context);
      }
    }

    const raw = String(page.text?.content ?? "").trim();
    if (!raw) return "";
    return TextEditorImplementation.enrichHTML(raw, {
      async: true,
      relativeTo: page,
      secrets: Boolean(game.user?.isGM)
    });
  }
}
