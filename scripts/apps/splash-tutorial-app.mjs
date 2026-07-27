import { MODULE_ID } from "../constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const ASSET = name => `modules/${MODULE_ID}/assets/tutorial/${name}`;

function ownsWizardActor() {
  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return game.actors.contents.some(actor => actor.type === "character"
    && actor.testUserPermission(game.user, ownerLevel)
    && actor.items.some(item => item.type === "class"
      && String(item.system?.identifier ?? item.name ?? "").trim().toLowerCase() === "wizard"));
}

function gmPages() {
  return [
    {
      id: "create",
      eyebrow: "CREATE PLAYER CHARACTERS",
      title: "Start from the Gold Button",
      image: ASSET("start-character.png"),
      alt: "A new Player Character sheet with the gold Character Builder launcher highlighted.",
      text: "When Character Builder is active, a new Player Character Actor receives a gold launcher on its sheet.",
      bullets: [
        "Open the Actor and use the gold button to begin the guided creation flow.",
        "The Builder handles origins, species, class, spells, equipment, and final review.",
        "The live Actor is updated only after Finish Character is confirmed."
      ]
    },
    {
      id: "grant",
      eyebrow: "GM PROGRESSION",
      title: "Grant Level Ups Individually or in Groups",
      image: ASSET("grant-level-ups.png"),
      alt: "Character Builder Tool, the Grant Level Up actor control, and the Level Up arrow on a character sheet.",
      text: "Level Ups can be granted from the Actor controls or distributed through Character Builder Tool.",
      bullets: [
        "Use the Actor control for an individual character.",
        "Use Character Builder Tool to select and grant progression to multiple eligible Actors.",
        "After a grant, the Level Up arrow becomes available on the player's sheet."
      ]
    },
    {
      id: "rests",
      eyebrow: "CHARACTER KEEPER",
      title: "Class-Aware Rest Management",
      image: ASSET("rest-management.png"),
      alt: "Character Keeper showing an optional Weapon Mastery action during a Long Rest.",
      text: "Character Keeper opens before a Short or Long Rest when the character has an optional class action available.",
      bullets: [
        "Only actions relevant to that Actor and rest are displayed.",
        "Players may make a change or continue the rest without changing anything.",
        "Normal recovery, slots, uses, dice, and effects remain controlled by D&D5e."
      ]
    },
    {
      id: "transactions",
      eyebrow: "PROTECTED TRANSACTIONS",
      title: "Safe Updates to the Live Actor",
      image: ASSET("protected-transaction.png"),
      alt: "Applying Level Up protected transaction overlay with the interface blocked behind it.",
      text: "Creation, Level Up, and Keeper commits use protected transactions.",
      bullets: [
        "The interface is locked while completed draft documents are applied.",
        "Duplicate submissions and conflicting interactions are blocked.",
        "The live Actor is changed only after the transaction completes successfully."
      ]
    },
    {
      id: "sources",
      eyebrow: "CONTENT AND HELP",
      title: "Choose Sources and Reopen This Guide",
      image: ASSET("content-sources.png"),
      alt: "Character Builder settings showing content sources and source priority.",
      text: "Available classes, feats, spells, species, backgrounds, and equipment depend on the enabled content sources.",
      bullets: [
        "Player's Handbook 2024 and SRD 5.2 Modern are the officially supported sources.",
        "Source priority and other campaign rules are configured in Character Builder Settings.",
        "This tutorial can be opened again from the module settings at any time."
      ]
    }
  ];
}

function playerPages() {
  const pages = [
    {
      id: "create",
      eyebrow: "START YOUR CHARACTER",
      title: "Use the Gold Button on Your Sheet",
      image: ASSET("start-character.png"),
      alt: "A new Player Character sheet with the gold Character Builder launcher highlighted.",
      text: "Open the Player Character Actor assigned to you and click the gold Character Builder button.",
      bullets: [
        "The guided flow covers your origin, species, class, spells, equipment, and review.",
        "Your sheet is filled only after you confirm Finish Character.",
        "Use the Character Builder launcher instead of the native Add Class flow."
      ]
    },
    {
      id: "level-up",
      eyebrow: "LEVEL UP",
      title: "Look for the Level Up Arrow",
      image: ASSET("level-up-ready.png"),
      alt: "A completed character sheet showing the Level Up arrow in the upper-right controls.",
      text: "When the GM grants a Level Up, an arrow becomes available on your character sheet.",
      bullets: [
        "Click it to choose the class to advance and complete the required choices.",
        "The flow reviews Hit Points, class progression, features, spells, and the final result.",
        "When allowed by the GM, the same flow can add a new class."
      ]
    },
    {
      id: "rests",
      eyebrow: "SHORT AND LONG RESTS",
      title: "Character Keeper Shows Optional Actions",
      image: ASSET("rest-management.png"),
      alt: "Character Keeper showing an optional class action and the Continue Long Rest button.",
      text: "If your character has something optional to manage during a rest, Character Keeper opens before the rest completes.",
      bullets: [
        "Make any class-related change you want, or leave everything unchanged.",
        "Use Continue Short Rest or Continue Long Rest to finish normally.",
        "D&D5e still handles normal recovery, spell preparation, slots, uses, and effects."
      ]
    }
  ];

  if (ownsWizardActor()) {
    pages.push({
      id: "wizard",
      eyebrow: "WIZARD SPELLBOOK",
      title: "Scribe Eligible Spell Scrolls",
      image: ASSET("wizard-spellbook.png"),
      alt: "A Wizard character sheet showing the purple spellbook-management launcher.",
      text: "Wizards receive a spellbook-management button for copying eligible written spells.",
      bullets: [
        "Open it to review eligible Spell Scrolls.",
        "Cost, time, check requirements, and consequences are shown before confirmation.",
        "Nothing is consumed until the protected confirmation is accepted."
      ]
    });
  }

  return pages;
}

export class SplashTutorialApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  constructor({ pageIndex = 0, options = {} } = {}) {
    super(options);
    this.pageIndex = Math.max(0, Number(pageIndex) || 0);
  }

  static DEFAULT_OPTIONS = {
    id: "character-builder-splash-tutorial",
    classes: ["character-builder", "splash-tutorial-app", "standard-form"],
    tag: "form",
    position: { width: 940, height: 780 },
    window: { title: "Character Builder Tutorial", resizable: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/splash-tutorial.hbs` }
  };

  static open({ pageIndex = 0 } = {}) {
    const existing = this.#instance;
    if (existing && !existing._stateIsClosing) {
      existing.pageIndex = Math.max(0, Number(pageIndex) || 0);
      existing.render({ force: true });
      existing.bringToFront?.();
      return existing;
    }
    const app = new this({ pageIndex });
    this.#instance = app;
    app.render({ force: true });
    return app;
  }

  get pages() {
    return game.user.isGM ? gmPages() : playerPages();
  }

  async _prepareContext() {
    const pages = this.pages;
    this.pageIndex = Math.min(Math.max(0, this.pageIndex), Math.max(0, pages.length - 1));
    const page = pages[this.pageIndex];
    return {
      page,
      pageIndex: this.pageIndex,
      pageNumber: this.pageIndex + 1,
      pageCount: pages.length,
      first: this.pageIndex === 0,
      last: this.pageIndex === pages.length - 1,
      roleLabel: game.user.isGM ? "Game Master Guide" : "Player Guide",
      suppressed: Boolean(game.settings.get(MODULE_ID, "tutorialSuppressed")),
      steps: pages.map((entry, index) => ({
        id: entry.id,
        index,
        active: index === this.pageIndex,
        complete: index < this.pageIndex
      }))
    };
  }

  _onRender() {
    const root = this.element;
    root.querySelector('[data-action="back"]')?.addEventListener("click", event => {
      event.preventDefault();
      if (this.pageIndex <= 0) return;
      this.pageIndex -= 1;
      this.render({ force: true });
    });
    root.querySelector('[data-action="next"]')?.addEventListener("click", event => {
      event.preventDefault();
      if (this.pageIndex >= this.pages.length - 1) return;
      this.pageIndex += 1;
      this.render({ force: true });
    });
    root.querySelectorAll('[data-action="go-to-page"]').forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        this.pageIndex = Math.max(0, Number(button.dataset.pageIndex) || 0);
        this.render({ force: true });
      });
    });
    root.querySelector('[data-action="finish"]')?.addEventListener("click", event => this.#finish(event));
  }

  async #finish(event) {
    event.preventDefault();
    const suppress = Boolean(this.element.querySelector('[name="tutorialSuppressed"]')?.checked);
    await game.settings.set(MODULE_ID, "tutorialSuppressed", suppress);
    await this.close();
  }

  async _onClose(options = {}) {
    SplashTutorialApp.#instance = null;
    return super._onClose(options);
  }
}
