import { MODULE_ID, defaultSettings } from "../constants.mjs";

/**
 * Plays the configured Level Up-ready cue when an Actor transitions from not
 * eligible to eligible under the currently selected XP or Milestone policy.
 * Playback uses Foundry's Interface audio channel and never stores per-Actor
 * gameplay state.
 */
export class LevelUpReadySoundService {
  static OPTION_KEY = "characterBuilderLevelUpReadySoundTransition";
  static #pendingTransitions = new Map();

  static settings() {
    return foundry.utils.mergeObject(defaultSettings(), game.settings.get(MODULE_ID, "settings") ?? {}, {
      inplace: false
    });
  }

  static path(settings = null) {
    return String((settings ?? this.settings()).levelUpReadySound ?? "").trim();
  }

  static captureTransition(actor, changes = {}, options = {}) {
    if (!actor || actor.type !== "character") return;
    if (actor.getFlag?.(MODULE_ID, "isDraft") || actor.getFlag?.(MODULE_ID, "isLevelUpDraft")) return;
    const settings = this.settings();
    if (!this.path(settings)) return;
    if (!actor.items?.some?.(item => item.type === "class")) return;

    const mode = settings.levelUpMode === "xp" ? "xp" : "milestone";
    let becameReady = false;
    let reason = null;

    if (mode === "xp") {
      const nextXp = this.#changedValue(changes, "system.details.xp.value");
      if (nextXp !== undefined) {
        const previousXp = Math.max(0, Math.trunc(Number(actor.system?.details?.xp?.value ?? 0)));
        const resultingXp = Math.max(0, Math.trunc(Number(nextXp ?? 0)));
        const threshold = Number(actor.system?.details?.xp?.max);
        becameReady = Number.isFinite(threshold) && previousXp < threshold && resultingXp >= threshold;
        if (becameReady) reason = "xp-threshold";
      }
    } else {
      const nextGrant = this.#changedValue(changes, `flags.${MODULE_ID}.levelUpGrant`);
      if (nextGrant !== undefined) {
        const previousAvailable = actor.getFlag?.(MODULE_ID, "levelUpGrant")?.available === true;
        const resultingAvailable = nextGrant?.available === true;
        becameReady = !previousAvailable && resultingAvailable;
        if (becameReady) reason = "milestone-grant";
      }
    }

    if (!becameReady) return;
    const transition = {
      actorId: actor.id,
      reason,
      capturedAt: Date.now()
    };
    options[this.OPTION_KEY] = transition;
    this.#pendingTransitions.set(actor.id, transition);
    setTimeout(() => {
      if (this.#pendingTransitions.get(actor.id)?.capturedAt === transition.capturedAt) {
        this.#pendingTransitions.delete(actor.id);
      }
    }, 10000);
  }

  static completeTransition(actor, _changes = {}, options = {}) {
    const transition = options?.[this.OPTION_KEY] ?? this.#pendingTransitions.get(actor?.id);
    if (!transition || transition.actorId !== actor?.id) return;
    delete options[this.OPTION_KEY];
    this.#pendingTransitions.delete(actor.id);
    if (!this.#transitionIsReadyNow(actor, transition.reason)) return;
    void this.playForActor(actor, { reason: transition.reason }).catch(error => {
      console.warn(`${MODULE_ID} | Could not play the Level Up Ready sound for ${actor?.name ?? "Actor"}.`, error);
    });
  }

  static async playForActor(actor, { reason = "level-up-ready" } = {}) {
    const src = this.path();
    if (!src) return { played: false, reason: "not-configured" };
    const AudioHelper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
    if (!AudioHelper?.play) throw new Error("Foundry AudioHelper is unavailable.");
    if (AudioHelper.hasAudioExtension && !AudioHelper.hasAudioExtension(src)) {
      throw new Error("The configured Level Up Ready Sound is not a supported audio file.");
    }

    const recipients = this.#recipientIds(actor);
    AudioHelper.play({
      src,
      volume: 1,
      autoplay: true,
      loop: false,
      channel: "interface"
    }, recipients.length ? { recipients } : false);

    return { played: true, reason, recipients };
  }

  static async playLocal(src) {
    const path = String(src ?? "").trim();
    if (!path) throw new Error("Choose a Level Up Ready Sound first.");
    const AudioHelper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
    if (!AudioHelper?.play) throw new Error("Foundry AudioHelper is unavailable.");
    if (AudioHelper.hasAudioExtension && !AudioHelper.hasAudioExtension(path)) {
      throw new Error("Choose a supported audio file.");
    }
    AudioHelper.play({
      src: path,
      volume: 1,
      autoplay: true,
      loop: false,
      channel: "interface"
    }, false);
  }

  static #transitionIsReadyNow(actor, reason) {
    if (reason === "milestone-grant") {
      return actor?.getFlag?.(MODULE_ID, "levelUpGrant")?.available === true;
    }
    if (reason === "xp-threshold") {
      const xp = Number(actor?.system?.details?.xp?.value);
      const threshold = Number(actor?.system?.details?.xp?.max);
      return Number.isFinite(xp) && Number.isFinite(threshold) && xp >= threshold;
    }
    return false;
  }

  static #recipientIds(actor) {
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    const ids = [];
    for (const user of game.users ?? []) {
      if (!user?.active || user.isGM) continue;
      const explicitlyOwned = Number(actor?.ownership?.[user.id] ?? 0) >= OWNER;
      const assignedCharacter = user.character?.id === actor?.id;
      if (explicitlyOwned || assignedCharacter) ids.push(user.id);
    }
    return [...new Set(ids)];
  }

  static #changedValue(changes, path) {
    if (Object.hasOwn(changes ?? {}, path)) return changes[path];
    return foundry.utils.getProperty(changes ?? {}, path);
  }
}
