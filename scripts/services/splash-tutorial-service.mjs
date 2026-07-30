import { MODULE_ID } from "../constants.mjs";
import { SplashTutorialApp } from "../apps/splash-tutorial-app.mjs";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const OPEN_DELAY_MS = 900;
const SAFE_RETRY_MS = 1000;
const SUPPRESSED_FLAG = "tutorialSuppressed";
const FORCE_REVISION_SEEN_FLAG = "tutorialForceRevisionSeen";

export class SplashTutorialService {
  static #socketReady = false;
  static #scheduled = false;

  static initializeSocket() {
    if (this.#socketReady) return;
    this.#socketReady = true;
    game.socket.on(SOCKET_CHANNEL, payload => {
      if (payload?.type !== "forceSplashTutorial") return;
      this.#processForceRevision(Number(payload.revision ?? 0), { open: true });
    });
  }

  static isSuppressed(user = game.user) {
    return Boolean(user?.getFlag?.(MODULE_ID, SUPPRESSED_FLAG));
  }

  static forceRevisionSeen(user = game.user) {
    return Number(user?.getFlag?.(MODULE_ID, FORCE_REVISION_SEEN_FLAG) ?? 0);
  }

  static async setSuppressed(suppressed, user = game.user) {
    if (!user) throw new Error("A Foundry user is required to save the tutorial preference.");
    await user.setFlag(MODULE_ID, SUPPRESSED_FLAG, Boolean(suppressed));
  }

  static async initializeForCurrentUser() {
    this.initializeSocket();
    const revision = Number(game.settings.get(MODULE_ID, "tutorialForceRevision") ?? 0);
    const seen = this.forceRevisionSeen();
    if (revision > seen) {
      await this.#processForceRevision(revision, { open: true });
      return;
    }
    if (!this.isSuppressed()) this.scheduleOpen();
  }

  static openNow({ parentApp = null } = {}) {
    return SplashTutorialApp.open({ parentApp });
  }

  static scheduleOpen({ delay = OPEN_DELAY_MS } = {}) {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(() => this.#openWhenSafe(0), Math.max(0, delay));
  }

  static async forceForEveryone() {
    if (!game.user.isGM) throw new Error("Only a GM can reopen the tutorial for everyone.");
    const confirmed = await this.#confirmForce();
    if (!confirmed) return false;

    // The preference belongs to each Foundry User, not to the browser client.
    // Clearing it on every User also covers users who are currently offline.
    const resets = await Promise.allSettled(
      game.users.contents.map(user => this.setSuppressed(false, user))
    );
    const failures = resets.filter(result => result.status === "rejected");
    if (failures.length) {
      console.warn(`${MODULE_ID} | Could not clear the tutorial preference for ${failures.length} user(s).`, failures);
    }

    const current = Number(game.settings.get(MODULE_ID, "tutorialForceRevision") ?? 0);
    const revision = Math.max(1, current + 1);
    await game.settings.set(MODULE_ID, "tutorialForceRevision", revision);
    await this.#processForceRevision(revision, { open: true });
    game.socket.emit(SOCKET_CHANNEL, { type: "forceSplashTutorial", revision });
    ui.notifications.info("The Character Builder tutorial will reopen once for every user.");
    return true;
  }

  static async #processForceRevision(revision, { open = false } = {}) {
    if (!Number.isFinite(revision) || revision <= 0) return;
    const seen = this.forceRevisionSeen();
    if (revision <= seen) return;
    await game.user.setFlag(MODULE_ID, FORCE_REVISION_SEEN_FLAG, revision);
    await this.setSuppressed(false);
    if (open) this.scheduleOpen({ delay: 250 });
  }

  static #unsafeWindowOpen() {
    if (document.querySelector(".cb-protected-transaction-backdrop")) return true;
    return [
      '[id^="dnd5e-character-builder-"]',
      '[id^="dnd5e-character-level-up-"]',
      '[id^="dnd5e-character-keeper-"]',
      "#dnd5e-character-builder-shop"
    ].some(selector => Boolean(document.querySelector(selector)));
  }

  static #openWhenSafe(attempt) {
    if (this.#unsafeWindowOpen()) {
      setTimeout(() => this.#openWhenSafe(attempt + 1), SAFE_RETRY_MS);
      return;
    }
    this.#scheduled = false;
    if (!this.isSuppressed()) SplashTutorialApp.open();
  }

  static async #confirmForce() {
    const content = `<p>Reopen the Character Builder tutorial for every user?</p>
      <p>This clears each user's <strong>Don't Show Splash Tutorial</strong> preference when they are online or the next time they log in.</p>`;
    const DialogV2 = foundry.applications.api.DialogV2;
    if (DialogV2?.confirm) {
      return DialogV2.confirm({
        window: { title: "Show Tutorial to Everyone", modal: true },
        content,
        yes: { label: "Show to Everyone Once", icon: "fa-solid fa-users-viewfinder" },
        no: { label: "Cancel", icon: "fa-solid fa-xmark" }
      });
    }
    return Dialog.confirm({
      title: "Show Tutorial to Everyone",
      content,
      yes: () => true,
      no: () => false,
      defaultYes: false
    });
  }
}
