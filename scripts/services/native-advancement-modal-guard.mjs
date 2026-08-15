import { MODULE_ID } from "../constants.mjs";
import { LibWrapperService } from "./lib-wrapper-service.mjs";
import { ModalStackService } from "./modal-stack-service.mjs";

const ADVANCEMENT_NAV_ACTIONS = new Set(["previous", "restart", "next", "complete"]);
const ADVANCEMENT_LOADING_WARNING_MS = 10000;

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
        readinessObserver: null,
        readinessObservedElement: null,
        readinessDocumentObserver: null,
        removeReadinessCapture: null,
        readinessTimer: null,
        readinessStepKey: null,
        readinessWarningShown: false,
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
        this.#installReadinessGuard(active);
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

    active.readinessObserver?.disconnect?.();
    active.readinessDocumentObserver?.disconnect?.();
    active.removeReadinessCapture?.();
    if (active.readinessTimer) clearTimeout(active.readinessTimer);
    active.readinessObserver = null;
    active.readinessObservedElement = null;
    active.readinessDocumentObserver = null;
    active.removeReadinessCapture = null;
    active.readinessTimer = null;
    this.#clearReadinessVisuals(active.manager?.element);

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

  /**
   * Protect the native manager's navigation before its asynchronous child flow
   * has finished rendering. D&D5e inserts the manager shell first, so capture
   * phase is the authoritative safety layer; disabled buttons are feedback.
   */
  static #installReadinessGuard(active) {
    if (!active || active.released || active.removeReadinessCapture) return;

    const capture = event => {
      if (!active || active.released || this.#active !== active) return;
      const target = event.target?.closest?.("[data-action]");
      const action = String(target?.dataset?.action ?? "");
      if (!ADVANCEMENT_NAV_ACTIONS.has(action)) return;

      const managerElement = active.manager?.element;
      if (!(managerElement instanceof HTMLElement) || !managerElement.isConnected || !managerElement.contains(target)) return;
      const ready = this.#isCurrentStepReady(active);
      const complete = ready && this.#isCurrentStepComplete(active);
      const blocked = !ready || (["next", "complete"].includes(action) && !complete);
      if (!blocked) return;

      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      event.stopPropagation?.();
      this.#syncStepReadiness(active);
    };
    const resync = event => {
      const managerElement = active.manager?.element;
      if (!(managerElement instanceof HTMLElement) || !managerElement.contains(event.target)) return;
      queueMicrotask(() => this.#syncStepReadiness(active));
    };
    document.addEventListener("click", capture, { capture: true });
    document.addEventListener("change", resync, { capture: true });
    document.addEventListener("input", resync, { capture: true });
    active.removeReadinessCapture = () => {
      document.removeEventListener("click", capture, { capture: true });
      document.removeEventListener("change", resync, { capture: true });
      document.removeEventListener("input", resync, { capture: true });
    };

    // Observe document insertion only until the native manager root exists.
    // After that a narrow observer follows only that manager's step lifecycle.
    if (document.body && globalThis.MutationObserver) {
      active.readinessDocumentObserver = new MutationObserver(() => this.#syncStepReadiness(active));
      active.readinessDocumentObserver.observe(document.body, { childList: true, subtree: true });
    }
    this.#syncStepReadiness(active);
  }

  static #ensureReadinessObserver(active, managerElement) {
    if (!globalThis.MutationObserver || !(managerElement instanceof HTMLElement)) return;
    if (active.readinessObservedElement === managerElement && active.readinessObserver) return;

    active.readinessObserver?.disconnect?.();
    active.readinessObserver = new MutationObserver(() => this.#syncStepReadiness(active));
    active.readinessObserver.observe(managerElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"]
    });
    active.readinessObservedElement = managerElement;
    active.readinessDocumentObserver?.disconnect?.();
    active.readinessDocumentObserver = null;
  }

  static #syncStepReadiness(active) {
    if (!active || active.released || this.#active !== active) return;
    const managerElement = active.manager?.element;
    if (!(managerElement instanceof HTMLElement) || !managerElement.isConnected) return;

    this.#ensureReadinessObserver(active, managerElement);
    const stepKey = this.#readinessStepKey(active.manager?.step);
    if (stepKey !== active.readinessStepKey) {
      active.readinessStepKey = stepKey;
      active.readinessWarningShown = false;
      if (active.readinessTimer) clearTimeout(active.readinessTimer);
      active.readinessTimer = null;
    }

    const ready = this.#isCurrentStepReady(active);
    const complete = ready && this.#isCurrentStepComplete(active);
    const buttons = [...managerElement.querySelectorAll("[data-action]")]
      .filter(button => ADVANCEMENT_NAV_ACTIONS.has(String(button.dataset?.action ?? "")));

    for (const button of buttons) {
      const action = String(button.dataset?.action ?? "");
      const blockedForLoading = !ready;
      const blockedForChoice = ready && !complete && ["next", "complete"].includes(action);
      const blocked = blockedForLoading || blockedForChoice;
      if (blocked) {
        if (button.dataset.cbAdvancementWaiting !== "true") {
          button.dataset.cbAdvancementWaiting = "true";
          button.dataset.cbAdvancementWasDisabled = button.disabled ? "true" : "false";
        }
        // The readiness observer watches the disabled attribute. Writing the
        // same disabled value from inside its callback creates an endless
        // MutationObserver microtask loop in Chromium, which freezes Foundry
        // without producing a console exception. Only mutate when state truly
        // needs to change.
        if (!button.disabled) button.disabled = true;
        if (blockedForLoading) {
          if (button.getAttribute("aria-busy") !== "true") button.setAttribute("aria-busy", "true");
        } else if (button.hasAttribute("aria-busy")) button.removeAttribute("aria-busy");
        button.dataset.cbAdvancementGuardReason = blockedForLoading ? "loading" : "incomplete";
      } else if (button.dataset.cbAdvancementWaiting === "true") {
        const wasDisabled = button.dataset.cbAdvancementWasDisabled === "true";
        delete button.dataset.cbAdvancementWaiting;
        delete button.dataset.cbAdvancementWasDisabled;
        delete button.dataset.cbAdvancementGuardReason;
        if (!wasDisabled && button.disabled) button.disabled = false;
        if (button.hasAttribute("aria-busy")) button.removeAttribute("aria-busy");
      }
    }

    if (!ready) {
      this.#renderReadinessStatus(managerElement, active.readinessWarningShown ? "warning" : "loading");
      if (!active.readinessTimer && stepKey) {
        active.readinessTimer = setTimeout(() => {
          active.readinessTimer = null;
          if (!active || active.released || this.#active !== active || this.#isCurrentStepReady(active)) return;
          active.readinessWarningShown = true;
          this.#renderReadinessStatus(active.manager?.element, "warning");
        }, ADVANCEMENT_LOADING_WARNING_MS);
      }
      return;
    }

    if (active.readinessTimer) clearTimeout(active.readinessTimer);
    active.readinessTimer = null;
    active.readinessWarningShown = false;
    if (!complete) {
      this.#renderReadinessStatus(managerElement, "incomplete");
      return;
    }
    managerElement.querySelector("[data-cb-advancement-loading-status]")?.remove();
  }

  static #isCurrentStepReady(active) {
    const manager = active?.manager;
    const managerElement = manager?.element;
    const flow = manager?.step?.flow;
    if (!(managerElement instanceof HTMLElement) || !managerElement.isConnected) return false;
    if (!flow) return true;

    const flowElement = this.#flowElement(flow);
    return flowElement instanceof HTMLElement
      && flowElement.isConnected
      && managerElement.contains(flowElement);
  }

  static #isCurrentStepComplete(active) {
    const flow = active?.manager?.step?.flow;
    const advancement = flow?.advancement;
    if (!flow || !advancement) return true;
    const level = flow.level ?? active?.manager?.step?.level ?? 0;
    const config = advancement.configuration ?? {};
    const value = advancement.value ?? {};

    // ItemChoiceAdvancement exposes an authoritative count API. Only the
    // mandatory base count blocks navigation; optional replacement capacity is
    // deliberately ignored here.
    if (typeof advancement.getCounts === "function" && config.choices && !Array.isArray(config.choices)) {
      const required = Number(config.choices?.[level]?.count ?? config.choices?.[String(level)]?.count ?? 0);
      if (required > 0) {
        const counts = advancement.getCounts(level);
        return Number(counts?.current ?? 0) >= required;
      }
    }

    // Trait Advancements store fixed grants and user choices together in
    // value.chosen. When a choice pool exists, require every configured slot.
    if (Array.isArray(config.choices) && config.choices.length && value.chosen !== undefined) {
      const grants = this.#collectionSize(config.grants);
      const required = grants + config.choices.reduce((sum, choice) => sum + Number(choice?.count ?? 0), 0);
      if (required > 0) return this.#collectionSize(value.chosen) >= required;
    }

    // Multi-size Species Advancements must contain an explicit selection.
    const sizeCount = this.#collectionSize(config.sizes);
    if (sizeCount > 1 && value && typeof value === "object" && "size" in value) {
      return Boolean(String(value.size ?? "").trim());
    }

    // Subclass flow has no numeric choice count, but the value document is the
    // mandatory selection when that interactive flow is present.
    const flowName = String(flow.constructor?.name ?? "").toLowerCase();
    if (flowName.includes("subclass") && value && typeof value === "object" && "document" in value) {
      return Boolean(value.document);
    }

    // Unknown Advancement types remain under native authority and the final
    // Character Builder completeness gate. Never invent a requirement here.
    return true;
  }

  static #collectionSize(value) {
    if (value == null) return 0;
    if (Number.isFinite(Number(value.size))) return Number(value.size);
    if (Array.isArray(value)) return value.length;
    if (typeof value === "object") return Object.keys(value).length;
    return 0;
  }

  static #flowElement(flow) {
    const direct = flow?.element;
    if (direct instanceof HTMLElement) return direct;
    if (direct?.[0] instanceof HTMLElement) return direct[0];
    const legacy = flow?._element;
    if (legacy instanceof HTMLElement) return legacy;
    if (legacy?.[0] instanceof HTMLElement) return legacy[0];
    return null;
  }

  static #readinessStepKey(step) {
    const flow = step?.flow;
    if (!flow) return "";
    return [
      step?.type ?? "",
      flow?.id ?? "",
      flow?.level ?? "",
      flow?.advancement?.id ?? flow?._advancementId ?? ""
    ].map(value => String(value ?? "")).join(":");
  }

  static #renderReadinessStatus(managerElement, mode = "loading") {
    if (!(managerElement instanceof HTMLElement) || !managerElement.isConnected) return;
    const nav = managerElement.querySelector("nav");
    if (!nav) return;

    let status = managerElement.querySelector("[data-cb-advancement-loading-status]");
    if (!status) {
      status = managerElement.ownerDocument.createElement("div");
      status.dataset.cbAdvancementLoadingStatus = "true";
      status.className = "cb-advancement-loading-status";
      nav.before(status);
    }
    if (status.dataset.cbAdvancementLoadingMode === mode) return;
    status.dataset.cbAdvancementLoadingMode = mode;
    if (mode === "warning") {
      status.innerHTML = '<i class="fa-solid fa-triangle-exclamation" inert></i><span>Advancement is still loading. Keep waiting, or close and retry.</span>';
    } else if (mode === "incomplete") {
      status.innerHTML = '<i class="fa-solid fa-circle-info" inert></i><span>Complete the required Advancement choice before continuing.</span>';
    } else {
      status.innerHTML = '<i class="fa-solid fa-spinner fa-spin" inert></i><span>Loading Advancement options…</span>';
    }
  }

  static #clearReadinessVisuals(managerElement) {
    if (!(managerElement instanceof HTMLElement)) return;
    managerElement.querySelector("[data-cb-advancement-loading-status]")?.remove();
    for (const button of managerElement.querySelectorAll('[data-cb-advancement-waiting="true"]')) {
      const wasDisabled = button.dataset.cbAdvancementWasDisabled === "true";
      delete button.dataset.cbAdvancementWaiting;
      delete button.dataset.cbAdvancementWasDisabled;
      delete button.dataset.cbAdvancementGuardReason;
      if (!wasDisabled) button.disabled = false;
      button.removeAttribute("aria-busy");
    }
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
    this.#syncStepReadiness(active);

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
