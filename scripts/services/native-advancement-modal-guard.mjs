import { MODULE_ID } from "../constants.mjs";

/**
 * Runs a D&D5e AdvancementManager as a protected modal workflow.
 *
 * The native application remains authoritative. This coordinator only owns
 * foreground priority, background input blocking, cancellation settlement,
 * and deterministic cleanup of the temporary backdrop.
 */
export class NativeAdvancementModalGuard {
  static #active = null;

  /**
   * Render a native AdvancementManager and wait for completion or cancellation.
   * Only one guarded manager can be active at a time.
   *
   * @param {ApplicationV2} manager
   * @param {object} [options]
   * @param {Function|null} [options.onComplete]
   * @returns {Promise<{completed: boolean, cancelled?: boolean}>}
   */
  static run(manager, { onComplete = null } = {}) {
    if (!manager) return Promise.reject(new Error("A native AdvancementManager is required."));

    const current = this.#active;
    if (current && current.manager !== manager) {
      this.#syncLayers(current, { focus: true });
      return Promise.reject(new Error(
        "Complete or close the active D&D5e Advancement window before opening another one."
      ));
    }

    return new Promise((resolve, reject) => {
      let completed = false;
      let settled = false;
      let completionHook = null;
      let renderHook = null;
      const originalClose = manager.close.bind(manager);
      const ownerElement = this.#findOwnerElement();
      const ownerInert = ownerElement?.inert ?? false;
      const overlay = this.#createOverlay();
      const active = {
        manager,
        overlay,
        ownerElement,
        ownerInert,
        completionHook: null,
        renderHook: null,
        originalClose,
        focusApplied: false,
        released: false
      };

      const cleanupHooks = () => {
        if (completionHook !== null) Hooks.off("dnd5e.advancementManagerComplete", completionHook);
        if (renderHook !== null) Hooks.off("renderApplicationV2", renderHook);
        completionHook = null;
        renderHook = null;
        active.completionHook = null;
        active.renderHook = null;
      };

      const settle = (result, error = null) => {
        if (settled) return;
        settled = true;
        cleanupHooks();
        if (error) reject(error);
        else resolve(result);
      };

      completionHook = Hooks.on("dnd5e.advancementManagerComplete", async completedManager => {
        if (completedManager !== manager) return;
        completed = true;
        try {
          await onComplete?.();
          settle({ completed: true });
        } catch (error) {
          settle(null, error);
        }
      });
      active.completionHook = completionHook;

      renderHook = Hooks.on("renderApplicationV2", app => {
        if (app === manager || this.#isCharacterBuilderApplication(app)) {
          this.#scheduleLayerSync(active, { focus: app === manager && !active.focusApplied });
        }
      });
      active.renderHook = renderHook;

      manager.close = async (...args) => {
        try {
          return await originalClose(...args);
        } finally {
          if (!completed) settle({ completed: false, cancelled: true });
          this.#release(active);
        }
      };

      try {
        this.#activate(active);
        manager.render(true);
        this.#scheduleLayerSync(active, { focus: true });
      } catch (error) {
        this.#release(active);
        settle(null, error);
      }
    });
  }

  static get active() {
    return this.#active?.manager ?? null;
  }

  static #activate(active) {
    if (this.#active && this.#active !== active) {
      throw new Error("Another native D&D5e Advancement window is already active.");
    }
    this.#active = active;
    document.body.classList.add("cb-native-advancement-active");
    document.body.append(active.overlay);
    if (active.ownerElement) {
      active.ownerElement.classList.add("cb-native-advancement-blocked");
      active.ownerElement.inert = true;
      active.ownerElement.setAttribute("aria-busy", "true");
    }
  }

  static #release(active) {
    if (!active || active.released) return;
    active.released = true;

    if (active.completionHook !== null) Hooks.off("dnd5e.advancementManagerComplete", active.completionHook);
    if (active.renderHook !== null) Hooks.off("renderApplicationV2", active.renderHook);
    active.completionHook = null;
    active.renderHook = null;

    active.overlay?.remove();
    if (active.ownerElement) {
      active.ownerElement.classList.remove("cb-native-advancement-blocked");
      active.ownerElement.inert = active.ownerInert;
      active.ownerElement.removeAttribute("aria-busy");
    }
    document.body.classList.remove("cb-native-advancement-active");
    if (this.#active === active) this.#active = null;

    // The closed native window naturally leaves the Builder immediately below
    // it in the Foundry stack. Restore keyboard focus without forcing an
    // unrelated application above legitimate dialogs or notifications.
    queueMicrotask(() => {
      const owner = active.ownerElement;
      if (!owner?.isConnected) return;
      const focusTarget = owner.querySelector(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      (focusTarget ?? owner).focus?.({ preventScroll: true });
    });
  }

  static #createOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "cb-native-advancement-backdrop";
    overlay.dataset.moduleId = MODULE_ID;
    overlay.setAttribute("role", "presentation");
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="cb-native-advancement-backdrop__message">
        <i class="fa-solid fa-forward" aria-hidden="true"></i>
        <span>Complete or close the D&amp;D5e Advancement window to continue.</span>
      </div>`;
    return overlay;
  }

  static #findOwnerElement() {
    const candidates = [...document.querySelectorAll(".application.character-builder")]
      .filter(element => element.isConnected && !element.hidden && getComputedStyle(element).display !== "none");
    return candidates.sort((a, b) => this.#zIndex(b) - this.#zIndex(a))[0] ?? null;
  }

  static #isCharacterBuilderApplication(app) {
    if (!app) return false;
    const classes = app.options?.classes ?? app.constructor?.DEFAULT_OPTIONS?.classes ?? [];
    return classes.includes?.("character-builder") || app.element?.classList?.contains("character-builder");
  }

  static #scheduleLayerSync(active, { focus = false } = {}) {
    const sync = () => this.#syncLayers(active, { focus });
    queueMicrotask(sync);
    requestAnimationFrame(sync);
    requestAnimationFrame(() => requestAnimationFrame(sync));
  }

  static #syncLayers(active, { focus = false } = {}) {
    if (!active || active.released || this.#active !== active) return;
    const managerElement = active.manager?.element;
    if (!(managerElement instanceof HTMLElement) || !managerElement.isConnected) return;

    active.manager.bringToFront?.();
    active.manager.bringToTop?.();

    const backgroundMaximum = this.#maximumApplicationZ(managerElement);
    let managerZ = this.#zIndex(managerElement);
    if (!Number.isFinite(managerZ) || managerZ <= backgroundMaximum) {
      managerZ = backgroundMaximum + 2;
      managerElement.style.zIndex = String(managerZ);
    }
    active.overlay.style.zIndex = String(Math.max(1, managerZ - 1));

    if (active.ownerElement) {
      const ownerZ = this.#zIndex(active.ownerElement);
      if (ownerZ >= managerZ) {
        managerElement.style.zIndex = String(ownerZ + 2);
        active.overlay.style.zIndex = String(ownerZ + 1);
      }
    }

    if (focus && !active.focusApplied) {
      active.focusApplied = true;
      const focusTarget = managerElement.querySelector(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      (focusTarget ?? managerElement).focus?.({ preventScroll: true });
    }
  }

  static #maximumApplicationZ(exclude = null) {
    let maximum = 0;
    for (const element of document.querySelectorAll(".application")) {
      if (element === exclude || element.classList.contains("cb-native-advancement-backdrop")) continue;
      maximum = Math.max(maximum, this.#zIndex(element));
    }
    return maximum;
  }

  static #zIndex(element) {
    if (!element) return 0;
    const value = Number.parseInt(element.style?.zIndex || getComputedStyle(element).zIndex, 10);
    return Number.isFinite(value) ? value : 0;
  }
}
