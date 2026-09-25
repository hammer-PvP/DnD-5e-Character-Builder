import { MODULE_ID } from "../constants.mjs";

/**
 * Foreground coordinator for Character Builder transactional workflows.
 *
 * The stack protects z-order, not the entire Foundry UI. Character Builder and
 * native Advancement windows stay above ordinary applications, while inspection
 * and reference windows (Compendium Browser, Item/Journal details, pickers) are
 * allowed above the transaction. No global inert state, blur, or pointer-event
 * trap is applied. Structural Actor safety remains the responsibility of the
 * transaction and Player Sheet Integrity services.
 */
export class ModalStackService {
  static #initialized = false;
  static #hooksApi = null;
  static #scope = null;
  static #pendingCaptures = [];
  static #renderHook = null;
  static #closeHook = null;
  static #listeners = null;
  static #syncQueued = false;

  static initialize() {
    const hooks = globalThis.Hooks;
    if (!hooks?.on) return false;
    if (this.#initialized && this.#hooksApi === hooks) return true;

    if (this.#initialized && this.#hooksApi?.off) {
      if (this.#renderHook !== null) this.#hooksApi.off("renderApplicationV2", this.#renderHook);
      if (this.#closeHook !== null) this.#hooksApi.off("closeApplicationV2", this.#closeHook);
    }

    this.#renderHook = hooks.on("renderApplicationV2", app => this.#onRender(app));
    this.#closeHook = hooks.on("closeApplicationV2", app => this.#onClose(app));
    this.#hooksApi = hooks;
    this.#initialized = true;
    return true;
  }

  static get active() {
    return Boolean(this.#scope?.entries?.length);
  }

  static get depth() {
    return this.#scope?.entries?.length ?? 0;
  }

  static get topApp() {
    return this.#topEntry()?.app ?? null;
  }

  static get topElement() {
    return this.#topEntry()?.element ?? null;
  }

  /**
   * Start a protected foreground scope around an already-rendering application.
   * The owner is restored when the root closes.
   */
  static beginRoot(app, {
    ownerApp = null,
    ownerElement = null,
    label = "Character Builder modal workflow",
    message = "Complete or cancel the active window to continue."
  } = {}) {
    if (!app) return null;
    this.initialize();

    const existing = this.#entryForApp(app);
    if (existing) return existing.token;

    if (this.#scope?.entries?.length) {
      return this.pushChild(app, { label, message });
    }

    const resolvedOwner = this.#applicationElement(ownerApp)
      ?? this.#element(ownerElement)
      ?? this.findForegroundOwnerElement({ excludeApp: app });
    const token = Symbol(label);
    const entry = this.#entry(app, token, label);
    this.#scope = {
      token: Symbol(`${label}:scope`),
      label,
      message,
      ownerApp,
      ownerElement: resolvedOwner,
      ownerFocus: globalThis.document?.activeElement ?? null,
      entries: [entry],
      closingApps: new WeakSet(),
      released: false
    };

    this.#attachListeners();
    this.#scheduleSync({ focus: true });
    return token;
  }

  /** Add a child window above the current top entry. */
  static pushChild(app, { label = "Selection window", message = null } = {}) {
    if (!app) return null;
    this.initialize();

    const existing = this.#entryForApp(app);
    if (existing) {
      this.#scheduleSync({ focus: true });
      return existing.token;
    }

    if (!this.#scope?.entries?.length) {
      return this.beginRoot(app, { label, message: message ?? "Complete or cancel the active selection to continue." });
    }

    const token = Symbol(label);
    this.#scope.entries.push(this.#entry(app, token, label));
    if (message) this.#scope.message = message;
    this.#scheduleSync({ focus: true });
    return token;
  }

  /**
   * Release one stack entry. Releasing a parent also closes and removes every
   * still-open descendant, preventing detached browsers from becoming orphans.
   */
  static end(tokenOrApp, { closeDescendants = true, restoreFocus = true } = {}) {
    const scope = this.#scope;
    if (!scope?.entries?.length) return false;

    const index = typeof tokenOrApp === "symbol"
      ? scope.entries.findIndex(entry => entry.token === tokenOrApp)
      : scope.entries.findIndex(entry => entry.app === tokenOrApp);
    if (index < 0) return false;

    const descendants = scope.entries.slice(index + 1);
    if (closeDescendants) this.#closeEntries(descendants);
    scope.entries.splice(index);

    if (!scope.entries.length) {
      this.#releaseScope({ restoreFocus });
      return true;
    }

    this.#scheduleSync({ focus: true });
    return true;
  }

  /** Focus and raise only the top window. */
  static focusTop() {
    if (!this.#scope?.entries?.length) return false;
    this.#scheduleSync({ focus: true });
    return true;
  }

  static refresh({ focus = false } = {}) {
    if (!this.#scope?.entries?.length) return false;
    this.#scheduleSync({ focus });
    return true;
  }

  /**
   * Render a known child application (for example an Item sheet opened as a
   * details view) under the same parent/child safety rules.
   */
  static renderChild(parentApp, childApp, renderOptions = { force: true }, {
    label = "Details window",
    message = "Close this window to return to the previous Character Builder screen."
  } = {}) {
    if (!childApp?.render) return null;
    const token = this.beginRoot(childApp, {
      ownerApp: parentApp,
      ownerElement: parentApp?.element,
      label,
      message
    });
    try {
      const result = childApp.render(renderOptions);
      Promise.resolve(result).catch(error => {
        this.end(token, { closeDescendants: true });
        console.warn(`${MODULE_ID} | Could not render protected child application.`, error);
      });
      return childApp;
    } catch (error) {
      this.end(token, { closeDescendants: true });
      throw error;
    }
  }

  /**
   * Protect a factory that creates a detached selection application but only
   * returns its eventual value (for example CompendiumBrowser.selectOne).
   */
  static async runDetachedSelection(factory, {
    ownerApp = null,
    ownerElement = null,
    label = "Character Builder selection",
    message = "Complete or cancel the active selection to continue.",
    match = null
  } = {}) {
    if (typeof factory !== "function") throw new TypeError("A detached selection factory is required.");
    this.initialize();

    const capture = {
      ownerApp,
      ownerElement: this.#applicationElement(ownerApp)
        ?? this.#element(ownerElement)
        ?? this.findForegroundOwnerElement(),
      label,
      message,
      match: typeof match === "function" ? match : app => this.#isSelectionApplication(app),
      token: null,
      app: null
    };
    this.#pendingCaptures.push(capture);

    try {
      return await factory();
    } finally {
      const pendingIndex = this.#pendingCaptures.indexOf(capture);
      if (pendingIndex >= 0) this.#pendingCaptures.splice(pendingIndex, 1);
      if (capture.token) this.end(capture.token, { closeDescendants: true });
    }
  }

  /** Highest visible application before a modal child is opened. */
  static findForegroundOwnerElement({ excludeApp = null } = {}) {
    const exclude = this.#applicationElement(excludeApp);
    const candidates = this.#applicationElements()
      .filter(element => element !== exclude && this.#visible(element));
    return candidates.sort((a, b) => this.#zIndex(b) - this.#zIndex(a))[0] ?? null;
  }

  static #entry(app, token, label) {
    return {
      token,
      app,
      label,
      element: this.#applicationElement(app),
      connectedOnce: false
    };
  }

  static #entryForApp(app) {
    return this.#scope?.entries?.find(entry => entry.app === app) ?? null;
  }

  static #topEntry() {
    const entries = this.#scope?.entries;
    return entries?.length ? entries[entries.length - 1] : null;
  }

  static #onRender(app) {
    if (!app) return;

    const capture = [...this.#pendingCaptures].reverse().find(row => {
      try { return row.match(app); } catch (_error) { return false; }
    });
    if (capture && !capture.token) {
      capture.app = app;
      capture.token = this.beginRoot(app, {
        ownerApp: capture.ownerApp,
        ownerElement: capture.ownerElement,
        label: capture.label,
        message: capture.message
      });
      return;
    }

    const existing = this.#entryForApp(app);
    if (existing) {
      existing.element = this.#applicationElement(app) ?? existing.element;
      this.#scheduleSync();
      return;
    }

    if (!this.#scope?.entries?.length) {
      const owner = this.findForegroundOwnerElement({ excludeApp: app });
      if (this.#isDialogApplication(app) && this.#isCharacterBuilderElement(owner)) {
        this.beginRoot(app, {
          ownerElement: owner,
          label: this.#applicationLabel(app),
          message: "Complete or cancel this dialog before returning to Character Builder."
        });
      }
      return;
    }
    if (this.#isChildOfActiveStack(app) || this.#isReferenceApplication(app)) {
      this.pushChild(app, {
        label: this.#applicationLabel(app),
        message: "Complete or cancel the active selection to return to the previous window."
      });
      return;
    }

    // A background sheet can rerender as part of native automatic updates. It
    // is deliberately not promoted into the stack; just restore the top layer.
    this.#scheduleSync();
  }

  static #onClose(app) {
    const scope = this.#scope;
    if (!scope?.entries?.length || !app) return;
    if (scope.closingApps.has(app)) return;

    const closedElement = this.#applicationElement(app);
    if (app === scope.ownerApp || (closedElement && closedElement === scope.ownerElement)) {
      this.#closeEntries(scope.entries);
      scope.entries.length = 0;
      this.#releaseScope({ restoreFocus: false });
      return;
    }

    const index = scope.entries.findIndex(entry => entry.app === app);
    if (index < 0) return;

    const descendants = scope.entries.slice(index + 1);
    this.#closeEntries(descendants);
    scope.entries.splice(index);

    if (!scope.entries.length) this.#releaseScope({ restoreFocus: true });
    else this.#scheduleSync({ focus: true });
  }

  static #isChildOfActiveStack(app) {
    const entries = this.#scope?.entries ?? [];
    if (!entries.length) return false;

    const directParent = app.parent ?? app.parentApp ?? app.options?.parent ?? null;
    if (directParent && entries.some(entry => entry.app === directParent)) return true;

    let parent = app.parent;
    const seen = new Set();
    while (parent && !seen.has(parent)) {
      if (entries.some(entry => entry.app === parent)) return true;
      seen.add(parent);
      parent = parent.parent;
    }

    const appWindowId = this.#windowId(app);
    if (!appWindowId) return false;
    return entries.some(entry => this.#windowId(entry.app) === appWindowId)
      && this.#isSelectionApplication(app);
  }

  static #windowId(app) {
    return app?.window?.windowId
      ?? app?.options?.window?.windowId
      ?? app?._renderOptions?.window?.windowId
      ?? null;
  }

  static #isSelectionApplication(app) {
    const element = this.#applicationElement(app);
    const classes = new Set([
      ...(app?.options?.classes ?? []),
      ...(app?.constructor?.DEFAULT_OPTIONS?.classes ?? []),
      ...this.#classNames(element)
    ].map(value => String(value).toLowerCase()));
    const name = String(app?.constructor?.name ?? "").toLowerCase();
    const id = String(app?.id ?? app?.options?.id ?? element?.id ?? "").toLowerCase();

    if (classes.has("compendium-browser") || name.includes("compendiumbrowser") || id.includes("compendium-browser")) {
      return true;
    }
    if (classes.has("file-picker") || name.includes("filepicker") || id.includes("file-picker")) return true;
    if (name.includes("documentselect") || name.includes("itemselect") || name.includes("spellselect")) return true;

    return this.#isDialogApplication(app);
  }

  static #isReferenceApplication(app) {
    if (this.#isSelectionApplication(app)) return true;
    const element = this.#applicationElement(app);
    if (this.#isReferenceElement(element)) return true;
    const document = app?.document ?? app?.object ?? null;
    if (document?.pack || document?.compendium) return true;
    return false;
  }

  static #isReferenceElement(element) {
    if (!element) return false;
    const haystack = `${String(element.id ?? "")} ${this.#classNames(element).join(" ")}`.toLowerCase();
    return haystack.includes("compendium")
      || haystack.includes("item-sheet")
      || haystack.includes("journal-sheet")
      || haystack.includes("document-sheet")
      || haystack.includes("file-picker")
      || haystack.includes("document-select")
      || haystack.includes("item-select")
      || haystack.includes("spell-select");
  }

  static #isStackElement(element) {
    return (this.#scope?.entries ?? []).some(entry => entry.element === element);
  }

  static #isDialogApplication(app) {
    const element = this.#applicationElement(app);
    const classes = new Set([
      ...(app?.options?.classes ?? []),
      ...(app?.constructor?.DEFAULT_OPTIONS?.classes ?? []),
      ...this.#classNames(element)
    ].map(value => String(value).toLowerCase()));
    const name = String(app?.constructor?.name ?? "").toLowerCase();
    const modal = app?.options?.window?.modal === true || app?.window?.modal === true;
    const dialog = classes.has("dialog") || name.includes("dialog") || element?.tagName === "DIALOG";
    return modal || dialog;
  }

  static #isCharacterBuilderElement(element) {
    return Boolean(element?.classList?.contains?.("dnd5e-character-builder")
      || element?.classList?.contains?.("character-builder"));
  }

  static #classNames(element) {
    if (!element?.classList) return [];
    try { return [...element.classList]; } catch (_error) {}
    const raw = String(element.className ?? "").trim();
    return raw ? raw.split(/\s+/) : [];
  }

  static #applicationLabel(app) {
    return String(app?.window?.title ?? app?.options?.window?.title ?? app?.title ?? app?.constructor?.name ?? "Selection window");
  }

  static #attachListeners() {
    if (this.#listeners || !globalThis.document?.addEventListener) return;

    // Outside interaction is never cancelled. After Foundry finishes handling
    // the click, ordinary applications are simply kept below the active
    // transaction. Reference/inspection applications are intentionally exempt.
    const preservePriority = event => {
      const top = this.topElement;
      if (!top?.isConnected || this.#eventInside(event, top)) return;
      const application = event.target?.closest?.(".application") ?? null;
      if (application && this.#isStackElement(application)) return;
      if (application && this.#isReferenceElement(application)) return;
      this.#scheduleSync({ focus: false });
    };

    this.#listeners = { pointerdown: preservePriority, click: preservePriority };
    for (const [name, handler] of Object.entries(this.#listeners)) {
      document.addEventListener(name, handler, true);
    }
  }

  static #detachListeners() {
    if (!this.#listeners || !globalThis.document?.removeEventListener) return;
    for (const [name, handler] of Object.entries(this.#listeners)) document.removeEventListener(name, handler, true);
    this.#listeners = null;
  }

  static #eventInside(event, element) {
    if (!event || !element) return false;
    const path = event.composedPath?.();
    if (Array.isArray(path) && path.includes(element)) return true;
    const target = event.target;
    return target === element || Boolean(element.contains?.(target));
  }

  static #closeEntries(entries) {
    const scope = this.#scope;
    if (!scope) return;
    for (const entry of [...entries].reverse()) {
      const app = entry.app;
      if (!app || scope.closingApps.has(app)) continue;
      scope.closingApps.add(app);
      try {
        const result = app.close?.({ animate: false, characterBuilderModalStack: true });
        Promise.resolve(result).catch(error => {
          console.warn(`${MODULE_ID} | Could not close orphaned modal child.`, error);
        });
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not close orphaned modal child.`, error);
      }
    }
  }

  static #scheduleSync({ focus = false } = {}) {
    const scope = this.#scope;
    if (!scope?.entries?.length) return;
    if (focus) scope.focusRequested = true;
    if (this.#syncQueued) return;
    this.#syncQueued = true;

    const run = () => {
      this.#syncQueued = false;
      const requested = Boolean(this.#scope?.focusRequested);
      if (this.#scope) this.#scope.focusRequested = false;
      this.#sync({ focus: requested });
    };
    queueMicrotask(run);
    globalThis.requestAnimationFrame?.(() => this.#sync());
    globalThis.requestAnimationFrame?.(() => globalThis.requestAnimationFrame?.(() => this.#sync()));
  }

  static #sync({ focus = false } = {}) {
    const scope = this.#scope;
    if (!scope?.entries?.length || scope.released) return;

    for (const entry of scope.entries) {
      entry.element = this.#applicationElement(entry.app) ?? entry.element;
      if (entry.element?.isConnected) entry.connectedOnce = true;
    }
    while (scope.entries.length > 1) {
      const top = scope.entries[scope.entries.length - 1];
      if (top.element?.isConnected || !top.connectedOnce) break;
      scope.entries.pop();
    }

    const connectedEntries = scope.entries.filter(entry => entry.element?.isConnected);
    const top = connectedEntries.at(-1);
    if (!top?.element) return;

    const stackElements = new Set(connectedEntries.map(entry => entry.element));
    let maximum = 0;
    for (const element of this.#applicationElements()) {
      if (stackElements.has(element)) continue;
      maximum = Math.max(maximum, this.#zIndex(element));
    }

    // Keep the root above ordinary Foundry applications and each legitimate
    // inspection child above its parent. No application is made inert.
    connectedEntries.forEach((entry, index) => {
      entry.element.style.zIndex = String(maximum + 2 + (index * 2));
    });
    try { top.app?.bringToFront?.(); } catch (_error) {}
    try { top.app?.bringToTop?.(); } catch (_error) {}
    // bringToFront may assign a lower z-index on some Foundry applications;
    // restore the deterministic stack one microtask later as well.
    const topZ = maximum + 2 + ((connectedEntries.length - 1) * 2);
    top.element.style.zIndex = String(topZ);

    if (focus) this.#focusElement(top.element);
  }

  static #releaseScope({ restoreFocus = true } = {}) {
    const scope = this.#scope;
    if (!scope || scope.released) return;
    scope.released = true;
    this.#detachListeners();
    this.#scope = null;

    if (!restoreFocus) return;
    queueMicrotask(() => {
      const owner = scope.ownerElement;
      const prior = scope.ownerFocus;
      if (prior?.isConnected && !prior.inert) {
        prior.focus?.({ preventScroll: true });
        return;
      }
      if (owner?.isConnected && !owner.inert) this.#focusElement(owner);
    });
  }

  static #focusElement(element) {
    if (!element?.isConnected) return;
    const selector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const target = element.querySelector?.(selector) ?? element;
    target?.focus?.({ preventScroll: true });
  }

  static #applicationElements() {
    if (!globalThis.document?.querySelectorAll) return [];
    return [...document.querySelectorAll(".application")].filter(element => this.#element(element));
  }

  static #applicationElement(app) {
    return this.#element(app?.element ?? app);
  }

  static #element(value) {
    if (!value) return null;
    const HTMLElementClass = globalThis.HTMLElement;
    if (HTMLElementClass && value instanceof HTMLElementClass) return value;
    if (HTMLElementClass && value?.[0] instanceof HTMLElementClass) return value[0];
    return value?.nodeType === 1 ? value : null;
  }

  static #visible(element) {
    if (!element?.isConnected || element.hidden) return false;
    const style = globalThis.getComputedStyle?.(element);
    return style?.display !== "none" && style?.visibility !== "hidden";
  }

  static #zIndex(element) {
    if (!element) return 0;
    const raw = element.style?.zIndex || globalThis.getComputedStyle?.(element)?.zIndex;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : 0;
  }
}
