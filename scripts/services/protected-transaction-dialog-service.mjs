import { MODULE_ID } from "../constants.mjs";

/**
 * Single-instance transaction confirmation with deterministic foreground
 * priority and double-submit protection.
 *
 * v0.9.914 deliberately does NOT freeze the Foundry UI. The confirmation is
 * kept above ordinary applications, while Actor mutation safety is enforced by
 * the transaction/Sheet Integrity layers. This prevents the old full-screen
 * blur/inert trap without allowing an important confirmation to disappear
 * behind another ordinary window.
 */
export class ProtectedTransactionDialogService {
  static #active = null;

  static async confirm({
    key,
    matchClass,
    dialogOptions,
    fallback = null,
    visualBackdrop: _visualBackdrop = true
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
      renderHook: null,
      closeHook: null,
      pointerHandler: null,
      submitHandler: null,
      submitting: false,
      released: false
    };

    // Native modal=true can install its own page-wide interaction trap. The CB
    // supplies foreground priority itself, so confirmations use a normal V2
    // window and remain transactionally protected without blocking Foundry.
    const options = {
      ...dialogOptions,
      window: { ...(dialogOptions.window ?? {}), modal: false }
    };

    this.#active = active;
    this.#activate(active);
    try {
      return Boolean(await DialogV2.confirm(options));
    } finally {
      this.#release(active);
    }
  }

  static #activate(active) {
    active.pointerHandler = event => {
      if (active.released || this.#insideDialog(active, event.target)) return;
      // Do not cancel the user's click. Foundry is allowed to respond, then the
      // confirmation's z-order is restored without stealing keyboard focus.
      this.#scheduleSync(active, { focus: false });
    };
    document.addEventListener("pointerdown", active.pointerHandler, true);
    document.addEventListener("click", active.pointerHandler, true);

    active.renderHook = Hooks.on("renderApplicationV2", app => {
      const element = app?.element;
      if (element?.classList?.contains(active.matchClass)) {
        active.app = app;
        active.element = element;
        this.#installSubmitGuard(active);
        this.#scheduleSync(active, { focus: true });
        return;
      }
      this.#scheduleSync(active);
    });

    active.closeHook = Hooks.on("closeApplicationV2", app => {
      if (app === active.app) {
        active.element = null;
        active.app = null;
      }
    });
  }

  static #release(active) {
    if (!active || active.released) return;
    active.released = true;
    if (active.renderHook !== null) Hooks.off("renderApplicationV2", active.renderHook);
    if (active.closeHook !== null) Hooks.off("closeApplicationV2", active.closeHook);
    if (active.pointerHandler) {
      document.removeEventListener("pointerdown", active.pointerHandler, true);
      document.removeEventListener("click", active.pointerHandler, true);
    }
    if (active.submitHandler && active.element) active.element.removeEventListener("click", active.submitHandler, true);
    if (this.#active === active) this.#active = null;

    queueMicrotask(() => {
      const owner = [...document.querySelectorAll(".application.dnd5e-character-builder")]
        .filter(element => element.isConnected && !element.hidden)
        .sort((a, b) => this.#zIndex(b) - this.#zIndex(a))[0];
      const focusTarget = owner?.querySelector?.(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      (focusTarget ?? owner)?.focus?.({ preventScroll: true });
    });
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
    const NodeClass = globalThis.Node;
    return Boolean(active.element && NodeClass && target instanceof NodeClass && active.element.contains(target));
  }

  static #scheduleSync(active, { focus = false } = {}) {
    const sync = () => this.#sync(active, { focus });
    queueMicrotask(sync);
    globalThis.requestAnimationFrame?.(sync);
    globalThis.requestAnimationFrame?.(() => globalThis.requestAnimationFrame?.(sync));
  }

  static #sync(active, { focus = false } = {}) {
    if (!active || active.released || this.#active !== active) return;
    const element = active.element;
    const HTMLElementClass = globalThis.HTMLElement;
    if (!HTMLElementClass || !(element instanceof HTMLElementClass) || !element.isConnected) return;

    try { active.app?.bringToFront?.(); } catch (_error) {}
    try { active.app?.bringToTop?.(); } catch (_error) {}
    const maximum = this.#maximumBackgroundZ(element);
    const dialogZ = Math.max(this.#zIndex(element), maximum + 2);
    element.style.zIndex = String(dialogZ);

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

  static #maximumBackgroundZ(dialog) {
    let maximum = 0;
    for (const element of document.querySelectorAll(".application")) {
      if (element === dialog) continue;
      maximum = Math.max(maximum, this.#zIndex(element));
    }
    return maximum;
  }

  static #zIndex(element) {
    if (!element) return 0;
    const value = Number.parseInt(element.style?.zIndex || globalThis.getComputedStyle?.(element)?.zIndex, 10);
    return Number.isFinite(value) ? value : 0;
  }
}
