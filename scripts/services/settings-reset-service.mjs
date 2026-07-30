import { MODULE_ID, MODULE_VERSION, defaultSettings } from "../constants.mjs";
import { ContentSourceService } from "./content-source-service.mjs";
import { ProtectedTransactionDialogService } from "./protected-transaction-dialog-service.mjs";

const RESET_WORD = "RESET";
const RESET_DIALOG_CLASS = "cb-settings-reset-dialog";
const USER_PREFERENCE_FLAGS = Object.freeze([
  "tutorialSuppressed",
  "tutorialForceRevisionSeen"
]);

/**
 * Restores only Character Builder configuration to the defaults declared by
 * the currently installed version. Actor, Item, Scene, transaction, Draft,
 * progression, and campaign data are deliberately outside this service.
 */
export class SettingsResetService {
  static async confirmAndRestore() {
    if (!game.user?.isGM) throw new Error("Only a GM can restore Character Builder defaults.");

    let resetUserPreferences = false;
    const renderHook = Hooks.on("renderApplicationV2", app => {
      const root = app?.element;
      if (!root?.classList?.contains?.(RESET_DIALOG_CLASS)) return;
      this.#prepareConfirmationControls(root);
    });

    const content = `
      <section class="cb-settings-reset-confirmation">
        <p><strong>This restores all Character Builder settings to the defaults defined by version ${foundry.utils.escapeHTML(MODULE_VERSION)}.</strong></p>
        <p>Characters, Items, levels, progress records, transactions, Drafts, and campaign data will not be deleted or modified.</p>
        <label class="cb-settings-reset-user-option">
          <input type="checkbox" name="cbResetUserPreferences">
          <span>Also reset individual user preferences</span>
        </label>
        <p class="hint">This includes each user's splash-tutorial suppression and tutorial revision state. The separate “Show Splash Tutorial to Everyone Once” action is not triggered.</p>
        <label class="cb-settings-reset-typed-confirmation">
          <span>Type <strong>${RESET_WORD}</strong> to continue:</span>
          <input type="text" name="cbResetConfirmation" autocomplete="off" spellcheck="false" aria-label="Type RESET to continue">
        </label>
      </section>`;

    try {
      const confirmed = await ProtectedTransactionDialogService.confirm({
        key: "restore-current-version-defaults",
        matchClass: RESET_DIALOG_CLASS,
        dialogOptions: {
          classes: [
            "dnd5e-character-builder",
            "character-builder",
            "cb-protected-transaction-dialog",
            RESET_DIALOG_CLASS
          ],
          window: { title: "Reset Character Builder Settings?" },
          modal: true,
          content,
          yes: {
            label: "Reset Settings",
            icon: "fa-solid fa-rotate-left",
            callback: (_event, button) => {
              const form = button?.form;
              const typed = String(form?.elements?.cbResetConfirmation?.value ?? "").trim();
              if (typed !== RESET_WORD) return false;
              resetUserPreferences = Boolean(form?.elements?.cbResetUserPreferences?.checked);
              return true;
            }
          },
          no: { label: "Cancel", icon: "fa-solid fa-xmark" }
        },
        fallback: () => this.#legacyConfirm(content).then(result => {
          resetUserPreferences = result.resetUserPreferences;
          return result.confirmed;
        })
      });
      if (!confirmed) return { restored: false, resetUserPreferences: false, resetUsers: 0, failedUsers: 0 };
      return this.restoreCurrentVersionDefaults({ resetUserPreferences });
    } finally {
      Hooks.off("renderApplicationV2", renderHook);
    }
  }

  static async restoreCurrentVersionDefaults({ resetUserPreferences = false } = {}) {
    if (!game.user?.isGM) throw new Error("Only a GM can restore Character Builder defaults.");

    // This is the complete and only world configuration branch restored here.
    // Progression ledgers, tutorial broadcast revision, Actors, Items, Scenes,
    // Drafts, and all transaction flags remain untouched.
    await game.settings.set(MODULE_ID, "settings", foundry.utils.deepClone(defaultSettings()));
    await ContentSourceService.synchronizeWorldSettings({ force: true, persist: true });

    let resetUsers = 0;
    let failedUsers = 0;
    if (resetUserPreferences) {
      const results = await Promise.allSettled(
        game.users.contents.map(user => this.#resetUserPreferences(user))
      );
      resetUsers = results.filter(result => result.status === "fulfilled").length;
      failedUsers = results.length - resetUsers;
      if (failedUsers) {
        console.warn(`${MODULE_ID} | Could not reset individual preferences for ${failedUsers} user(s).`, results);
      }
    }

    return { restored: true, resetUserPreferences, resetUsers, failedUsers };
  }

  static #prepareConfirmationControls(root) {
    const input = root.querySelector('[name="cbResetConfirmation"]');
    const confirmButton = root.querySelector('[data-action="yes"]')
      ?? [...root.querySelectorAll("footer button, .form-footer button")]
        .find(button => button.textContent?.includes?.("Reset Settings"));
    if (!input || !confirmButton) return;

    const sync = () => {
      confirmButton.disabled = String(input.value ?? "").trim() !== RESET_WORD;
    };
    input.addEventListener("input", sync);
    root.addEventListener("keydown", event => {
      if (event.key !== "Enter" || String(input.value ?? "").trim() === RESET_WORD) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      input.focus({ preventScroll: true });
    }, true);
    sync();
    queueMicrotask(() => input.focus({ preventScroll: true }));
  }

  static async #resetUserPreferences(user) {
    for (const flag of USER_PREFERENCE_FLAGS) {
      if (typeof user?.unsetFlag === "function") await user.unsetFlag(MODULE_ID, flag);
      else if (typeof user?.setFlag === "function") {
        await user.setFlag(MODULE_ID, flag, flag === "tutorialSuppressed" ? false : 0);
      }
    }
  }

  static #legacyConfirm(content) {
    return new Promise(resolve => {
      let settled = false;
      let resetUserPreferences = false;
      const finish = confirmed => {
        if (settled) return;
        settled = true;
        resolve({ confirmed, resetUserPreferences });
      };
      new Dialog({
        title: "Reset Character Builder Settings?",
        content,
        buttons: {
          cancel: { label: "Cancel", callback: () => finish(false) },
          reset: {
            label: "Reset Settings",
            callback: html => {
              const typed = String(html.find('[name="cbResetConfirmation"]').val() ?? "").trim();
              if (typed !== RESET_WORD) return finish(false);
              resetUserPreferences = Boolean(html.find('[name="cbResetUserPreferences"]').prop("checked"));
              finish(true);
            }
          }
        },
        default: "cancel",
        render: html => {
          const input = html.find('[name="cbResetConfirmation"]');
          const button = html.closest(".dialog").find('button[data-button="reset"]');
          const sync = () => button.prop("disabled", String(input.val() ?? "").trim() !== RESET_WORD);
          input.on("input", sync);
          sync();
          input.trigger("focus");
        },
        close: () => finish(false)
      }).render(true);
    });
  }
}
