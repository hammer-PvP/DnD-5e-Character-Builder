import { MODULE_ID } from "../constants.mjs";
import { LibWrapperService } from "./lib-wrapper-service.mjs";
import { ModalStackService } from "./modal-stack-service.mjs";

export class NativeAdvancementBusyError extends Error {
  constructor(message = "Complete or close the active D&D5e Advancement window before opening another one.") {
    super(message);
    this.name = "NativeAdvancementBusyError";
    this.code = "DND5E_CHARACTER_BUILDER_ADVANCEMENT_BUSY";
  }

  static is(error) {
    return error instanceof NativeAdvancementBusyError
      || error?.code === "DND5E_CHARACTER_BUILDER_ADVANCEMENT_BUSY";
  }
}

/**
 * Runs a D&D5e AdvancementManager as a protected modal workflow.
 *
 * The native application remains authoritative. This coordinator only owns
 * foreground priority, background input blocking, cancellation settlement,
 * and deterministic cleanup of the temporary backdrop.
 */
export class NativeAdvancementModalGuard {
  static #active = null;
  static #reservation = null;

  /**
   * Render a native AdvancementManager and wait for completion or cancellation.
   * Interactive workflows settle only after the native window closes, so a
   * sequential remove/add workflow cannot overlap two managers. Fully automatic
   * workflows settle as soon as D&D5e reports completion because no Application
   * exists that could emit a close lifecycle event.
   *
   * @param {ApplicationV2} manager
   * @param {object} [options]
   * @param {Function|null} [options.onComplete]
   * @returns {Promise<{completed: boolean, cancelled?: boolean}>}
   */
  static run(manager, { onComplete = null, reservationToken = null } = {}) {
    if (!manager) return Promise.reject(new Error("A native AdvancementManager is required."));

    this.#releaseStaleActive();
    if (this.#reservation && this.#reservation.token !== reservationToken) {
      this.focusActive();
      return Promise.reject(new NativeAdvancementBusyError());
    }
    const current = this.#active;
    if (current && current.manager !== manager) {
      this.#scheduleLayerSync(current, { focus: true });
      return Promise.reject(new NativeAdvancementBusyError());
    }

    return new Promise((resolve, reject) => {
      let completed = false;
      let closed = false;
      let completionFinished = false;
      let completionError = null;
      let settled = false;
      let completionHook = null;
      let renderHook = null;
      let closeHook = null;
      let removeCloseObserver = null;
      const ownerElement = this.#findOwnerElement();
      const active = {
        manager,
        ownerElement,
        modalToken: null,
        completionHook: null,
        renderHook: null,
        closeHook: null,
        removeCloseObserver: null,
        focusApplied: false,
        modalActivated: false,
        released: false,
        settleStale: null
      };

      const cleanupSettlementHooks = () => {
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
        cleanupSettlementHooks();
        if (error) reject(error);
        else resolve(result);
      };

      const maybeSettle = () => {
        if (settled || !closed) return;
        if (!completed) {
          settle({ completed: false, cancelled: true });
          return;
        }
        if (!completionFinished) return;
        if (completionError) settle(null, completionError);
        else settle({ completed: true });
      };

      completionHook = Hooks.on("dnd5e.advancementManagerComplete", async completedManager => {
        if (completedManager !== manager) return;
        completed = true;
        try {
          await onComplete?.();
        } catch (error) {
          completionError = error;
        } finally {
          completionFinished = true;

          // D&D5e 5.3.3 does not render an Application when every mandatory
          // Advancement step is resolved by automaticApplication. In that path
          // advancementManagerComplete is the terminal lifecycle event: there is
          // no native window and therefore no _onClose/closeApplicationV2 event
          // to wait for. Treat completion as a deterministic close only when no
          // manager element ever became connected. Interactive managers retain
          // the existing completion + native-close settlement contract.
          const managerElement = manager?.element;
          const hasNativeWindow = active.modalActivated
            || (managerElement instanceof HTMLElement && managerElement.isConnected);
          if (!hasNativeWindow) {
            closed = true;
            this.#release(active);
            if (completionError) settle(null, completionError);
            else settle({ completed: true });
            return;
          }

          maybeSettle();
        }
      });
      active.completionHook = completionHook;

      renderHook = Hooks.on("renderApplicationV2", app => {
        if (app === manager) {
          // D&D5e 5.3.3 may process every mandatory Advancement step through
          // automaticApplication without ever creating a visible application.
          // Only promote the workflow to a true modal after the native manager
          // actually renders an interactive window.
          this.#scheduleLayerSync(active, { focus: !active.focusApplied });
          return;
        }
        if (active.modalActivated && this.#isCharacterBuilderApplication(app)) {
          this.#scheduleLayerSync(active);
        }
      });
      active.renderHook = renderHook;

      const handleClose = () => {
        if (closed) return;
        closed = true;
        this.#release(active);
        // Give the D&D5e completion hook in the same event turn a chance to run
        // before treating the close as a cancellation.
        queueMicrotask(maybeSettle);
      };

      active.settleStale = () => {
        if (closed) return;
        closed = true;
        this.#release(active);
        settle({ completed: false, cancelled: true, stale: true });
      };

      removeCloseObserver = LibWrapperService.observeAdvancementClose(manager, handleClose);
      active.removeCloseObserver = removeCloseObserver;

      // Core ApplicationV2 close hook is retained as a defensive fallback if a
      // future D&D5e update moves or renames the wrapped method. Duplicate close
      // notifications are harmless because settlement and release are idempotent.
      closeHook = Hooks.on("closeApplicationV2", closedApp => {
        if (closedApp === manager) handleClose();
      });
      active.closeHook = closeHook;

      try {
        this.#activate(active);
        manager.render(true);
        // For an interactive step the native element may be inserted before the
        // public render hook reaches us. Repeated synchronization detects that
        // element and activates the modal. Fully automatic workflows never gain
        // a connected element and therefore never block the Builder.
        this.#scheduleLayerSync(active, { focus: true });
      } catch (error) {
        this.#release(active);
        settle(null, error);
      }
    });
  }

  static get active() {
    this.#releaseStaleActive();
    return this.#active?.manager ?? null;
  }

  static get busy() {
    this.#releaseStaleActive();
    return Boolean(this.#active || this.#reservation);
  }

  static focusActive() {
    this.#releaseStaleActive();
    if (!this.#active) return false;
    if (this.#active.modalToken) ModalStackService.focusTop();
    else this.#scheduleLayerSync(this.#active, { focus: true });
    return true;
  }

  static assertAvailable(reservationToken = null) {
    this.#releaseStaleActive();
    if (this.#reservation && this.#reservation.token !== reservationToken) {
      this.focusActive();
      throw new NativeAdvancementBusyError();
    }
    if (!this.#active) return true;
    this.#scheduleLayerSync(this.#active, { focus: true });
    throw new NativeAdvancementBusyError();
  }

  /**
   * Reserve the complete native Advancement lane for a sequential transaction
   * such as remove-old then add-new. The reservation prevents another Builder
   * workflow from entering the tiny gap between the two native windows.
   */
  static reserve(label = "Character Builder Advancement transaction") {
    this.#releaseStaleActive();
    if (this.#active || this.#reservation) {
      this.focusActive();
      throw new NativeAdvancementBusyError();
    }
    const token = Symbol(label);
    this.#reservation = { token, label };
    return token;
  }

  static releaseReservation(token) {
    if (!token || this.#reservation?.token !== token) return false;
    this.#reservation = null;
    return true;
  }

  static #activate(active) {
    this.#releaseStaleActive();
    if (this.#active && this.#active !== active) {
      throw new NativeAdvancementBusyError("Another native D&D5e Advancement window is already active.");
    }
    this.#active = active;
  }

  static #activateModal(active) {
    if (!active || active.released || active.modalActivated || this.#active !== active) return false;
    const managerElement = active.manager?.element;
    if (!(managerElement instanceof HTMLElement) || !managerElement.isConnected) return false;

    active.modalActivated = true;
    active.modalToken = ModalStackService.beginRoot(active.manager, {
      ownerElement: active.ownerElement,
      label: "D&D5e Advancement",
      message: "Complete or close the active D&D5e Advancement or selection window to continue."
    });
    return Boolean(active.modalToken);
  }

  static #releaseStaleActive() {
    const active = this.#active;
    if (!active || active.released) {
      if (active?.released && this.#active === active) this.#active = null;
      return;
    }

    // A manager that is resolving mandatory steps automatically is intentionally
    // active without a rendered element. Its completion/close hooks own cleanup.
    // Stale-window recovery applies only after a real modal was displayed.
    if (!active.modalActivated) return;

    const element = active.manager?.element;
    const hasConnectedElement = element instanceof HTMLElement && element.isConnected;
    const hasRenderedState = active.manager?.rendered === true
      || Number(active.manager?._state ?? 0) > 0;
    if (hasConnectedElement || hasRenderedState) return;

    console.warn(`${MODULE_ID} | Releasing stale native Advancement guard state.`);
    active.settleStale?.();
  }

  static #release(active) {
    if (!active || active.released) return;
    active.released = true;

    if (active.completionHook !== null) Hooks.off("dnd5e.advancementManagerComplete", active.completionHook);
    if (active.renderHook !== null) Hooks.off("renderApplicationV2", active.renderHook);
    if (active.closeHook !== null) Hooks.off("closeApplicationV2", active.closeHook);
    active.removeCloseObserver?.();
    active.completionHook = null;
    active.renderHook = null;
    active.closeHook = null;
    active.removeCloseObserver = null;

    if (active.modalToken) {
      ModalStackService.end(active.modalToken, { closeDescendants: true, restoreFocus: false });
      active.modalToken = null;
    }
    if (this.#active === active) this.#active = null;

    // The closed native window naturally leaves the Builder immediately below
    // it in the Foundry stack. Restore keyboard focus without forcing an
    // unrelated application above legitimate dialogs or notifications.
    queueMicrotask(() => {
      const owner = active.ownerElement;
      if (!owner?.isConnected) return;
      if (!active.modalActivated) {
        // Automatic Advancement can rerender the Draft Actor sheet even though
        // no native prompt was opened. Preserve the initiating Builder as the
        // foreground application rather than letting that sheet cover it.
        const maximum = this.#maximumApplicationZ(owner);
        const ownerZ = this.#zIndex(owner);
        if (ownerZ <= maximum) owner.style.zIndex = String(maximum + 1);
      }
      const focusTarget = owner.querySelector(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      (focusTarget ?? owner).focus?.({ preventScroll: true });
    });
  }

  static #findOwnerElement() {
    const candidates = [...document.querySelectorAll(".application.dnd5e-character-builder")]
      .filter(element => element.isConnected && !element.hidden && getComputedStyle(element).display !== "none");
    return candidates.sort((a, b) => this.#zIndex(b) - this.#zIndex(a))[0] ?? null;
  }

  static #isCharacterBuilderApplication(app) {
    if (!app) return false;
    const classes = app.options?.classes ?? app.constructor?.DEFAULT_OPTIONS?.classes ?? [];
    return classes.includes?.("dnd5e-character-builder")
      || app.element?.classList?.contains("dnd5e-character-builder");
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

    this.#activateModal(active);

    // A Compendium Browser, picker, or dialog opened by the Advancement is a
    // child modal. Never raise or focus the manager above that child.
    if (active.modalToken) {
      ModalStackService.refresh({ focus });
      if (ModalStackService.topApp !== active.manager) return;
    }

    active.manager.bringToFront?.();
    active.manager.bringToTop?.();

    const backgroundMaximum = this.#maximumApplicationZ(managerElement);
    let managerZ = this.#zIndex(managerElement);
    if (!Number.isFinite(managerZ) || managerZ <= backgroundMaximum) {
      managerZ = backgroundMaximum + 2;
      managerElement.style.zIndex = String(managerZ);
    }

    if (focus && !active.focusApplied) {
      active.focusApplied = true;
      const focusTarget = managerElement.querySelector(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      (focusTarget ?? managerElement).focus?.({ preventScroll: true });
    } else if (focus) {
      active.manager.bringToFront?.();
      managerElement.focus?.({ preventScroll: true });
    }
  }

  static #maximumApplicationZ(exclude = null) {
    let maximum = 0;
    for (const element of document.querySelectorAll(".application")) {
      if (element === exclude || element.classList.contains("cb-native-advancement-backdrop") || element.classList.contains("cb-modal-stack-backdrop")) continue;
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
