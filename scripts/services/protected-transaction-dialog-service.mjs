import { MODULE_ID } from "../constants.mjs";

/**
 * Runs a module-owned confirmation as a true foreground modal.
 *
 * Foundry's DialogV2 modal flag is retained, but this coordinator also owns
 * global background blocking, deterministic z-order, single-instance reuse,
 * single-submit protection, and cleanup. This is intentionally generic so
 * every transaction confirmation can adopt the same policy.
 */
export class ProtectedTransactionDialogService {
  static #active = null;

  static async confirm({
    key,
    matchClass,
    dialogOptions,
    fallback = null
  } = {}) {
    if (!key || !matchClass || !dialogOptions) {
      throw new Error("A protected transaction dialog requires a key, match class, and dialog options.");
    }

    const existing = this.#active;
    if (existing) {
      this.#scheduleSync(existing, { focus: true });
      return false;
    }

    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2?.confirm) {
      return typeof fallback === "function" ? Boolean(await fallback()) : false;
    }

    const active = {
      key,
      matchClass,
      app: null,
      element: null,
      overlay: this.#createOverlay(),
      blocked: new Map(),
      renderHook: null,
      pointerHandler: null,
      focusHandler: null,
      submitHandler: null,
      submitting: false,
      released: false
    };

    this.#active = active;
    this.#activate(active);
    try {
      return Boolean(await DialogV2.confirm(dialogOptions));
    } finally {
      this.#release(active);
    }
  }

  static #activate(active) {
    document.body.classList.add("cb-protected-transaction-active");
    document.body.append(active.overlay);
    active.overlay.style.zIndex = String(this.#maximumBackgroundZ(null, active.overlay) + 1);

    active.pointerHandler = event => {
      if (active.released || this.#insideDialog(active, event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#scheduleSync(active, { focus: true });
    };
    active.focusHandler = event => {
      if (active.released || this.#insideDialog(active, event.target)) return;
      event.stopImmediatePropagation();
      this.#scheduleSync(active, { focus: true });
    };
    document.addEventListener("pointerdown", active.pointerHandler, true);
    document.addEventListener("click", active.pointerHandler, true);
    document.addEventListener("focusin", active.focusHandler, true);

    active.renderHook = Hooks.on("renderApplicationV2", app => {
      const element = app?.element;
      if (element?.classList?.contains(active.matchClass)) {
        active.app = app;
        active.element = element;
        this.#unblockElement(active, element);
        this.#installSubmitGuard(active);
        this.#scheduleSync(active, { focus: true });
        return;
      }
      this.#scheduleSync(active);
    });

    this.#blockBackground(active);
    this.#scheduleSync(active);
  }

  static #release(active) {
    if (!active || active.released) return;
    active.released = true;
    if (active.renderHook !== null) Hooks.off("renderApplicationV2", active.renderHook);
    if (active.pointerHandler) {
      document.removeEventListener("pointerdown", active.pointerHandler, true);
      document.removeEventListener("click", active.pointerHandler, true);
    }
    if (active.focusHandler) document.removeEventListener("focusin", active.focusHandler, true);
    if (active.submitHandler && active.element) {
      active.element.removeEventListener("click", active.submitHandler, true);
    }
    active.overlay?.remove();
    for (const [element, prior] of active.blocked) {
      if (!element?.isConnected) continue;
      element.inert = prior.inert;
      element.classList.remove("cb-protected-transaction-blocked");
      if (prior.ariaBusy == null) element.removeAttribute("aria-busy");
      else element.setAttribute("aria-busy", prior.ariaBusy);
    }
    active.blocked.clear();
    document.body.classList.remove("cb-protected-transaction-active");
    if (this.#active === active) this.#active = null;

    queueMicrotask(() => {
      const owner = [...document.querySelectorAll(".application.character-builder")]
        .filter(element => element.isConnected && !element.hidden)
        .sort((a, b) => this.#zIndex(b) - this.#zIndex(a))[0];
      const focusTarget = owner?.querySelector?.(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      (focusTarget ?? owner)?.focus?.({ preventScroll: true });
    });
  }

  static #createOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "cb-protected-transaction-backdrop";
    overlay.dataset.moduleId = MODULE_ID;
    overlay.setAttribute("role", "presentation");
    overlay.setAttribute("aria-hidden", "true");
    return overlay;
  }

  static #blockBackground(active) {
    for (const element of document.querySelectorAll(".application")) {
      if (element === active.element || element.classList.contains(active.matchClass)) continue;
      if (!active.blocked.has(element)) {
        active.blocked.set(element, {
          inert: Boolean(element.inert),
          ariaBusy: element.getAttribute("aria-busy")
        });
      }
      element.classList.add("cb-protected-transaction-blocked");
      element.inert = true;
      element.setAttribute("aria-busy", "true");
    }
  }

  static #unblockElement(active, element) {
    const prior = active.blocked.get(element);
    if (!prior) return;
    element.inert = prior.inert;
    element.classList.remove("cb-protected-transaction-blocked");
    if (prior.ariaBusy == null) element.removeAttribute("aria-busy");
    else element.setAttribute("aria-busy", prior.ariaBusy);
    active.blocked.delete(element);
  }

  static #installSubmitGuard(active) {
    if (!active.element || active.submitHandler) return;
    active.submitHandler = event => {
      const button = event.target?.closest?.("footer button, .form-footer button");
      if (!button) return;
      if (active.submitting) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      active.submitting = true;
      queueMicrotask(() => {
        active.element?.querySelectorAll?.("footer button, .form-footer button")
          .forEach(control => { control.disabled = true; });
      });
    };
    active.element.addEventListener("click", active.submitHandler, true);
  }

  static #insideDialog(active, target) {
    return Boolean(active.element && target instanceof Node && active.element.contains(target));
  }

  static #scheduleSync(active, { focus = false } = {}) {
    const sync = () => this.#sync(active, { focus });
    queueMicrotask(sync);
    requestAnimationFrame(sync);
    requestAnimationFrame(() => requestAnimationFrame(sync));
  }

  static #sync(active, { focus = false } = {}) {
    if (!active || active.released || this.#active !== active) return;
    this.#blockBackground(active);
    const element = active.element;
    if (!(element instanceof HTMLElement) || !element.isConnected) return;

    active.app?.bringToFront?.();
    active.app?.bringToTop?.();
    const maximum = this.#maximumBackgroundZ(element, active.overlay);
    const dialogZ = Math.max(this.#zIndex(element), maximum + 2);
    element.style.zIndex = String(dialogZ);
    active.overlay.style.zIndex = String(Math.max(1, dialogZ - 1));

    if (focus) {
      const focusTarget = element.querySelector(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      (focusTarget ?? element).focus?.({ preventScroll: true });
      element.animate?.([
        { transform: "scale(1)" },
        { transform: "scale(1.01)" },
        { transform: "scale(1)" }
      ], { duration: 150 });
    }
  }

  static #maximumBackgroundZ(dialog, overlay) {
    let maximum = 0;
    for (const element of document.querySelectorAll(".application")) {
      if (element === dialog || element === overlay) continue;
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
