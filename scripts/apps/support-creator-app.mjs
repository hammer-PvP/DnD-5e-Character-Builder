const { ApplicationV2 } = foundry.applications.api;

const SUPPORT_URL = "https://buymeacoffee.com/hammer.pvp";

/**
 * Game Settings menu target. It intentionally renders no Character Builder
 * configuration window: the settings surface itself is the support surface.
 */
export class SupportCreatorApp extends ApplicationV2 {
  render(_options = {}) {
    const opened = globalThis.open?.(SUPPORT_URL, "_blank");
    if (opened) {
      try { opened.opener = null; } catch (_error) { /* Browser controls opener policy. */ }
    } else {
      ui.notifications.info(`Support the Creator: ${SUPPORT_URL}`);
    }
    return this;
  }
}
