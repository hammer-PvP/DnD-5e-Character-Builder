import { MODULE_ID, defaultSettings } from "../constants.mjs";

/**
 * Optional immersion homebrew: player Skill and Tool checks are posted using
 * Foundry's native Blind GM visibility without changing the user's global Chat
 * roll mode or any D&D5e roll-configuration choices.
 */
export class BlindSkillToolCheckService {
  static #initialized = false;

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    Hooks.on("dnd5e.postSkillRollConfiguration", (_rolls, config, _dialog, message) => {
      this.#forceBlindForPlayer(config, message, "skill");
    });
    Hooks.on("dnd5e.postToolRollConfiguration", (_rolls, config, _dialog, message) => {
      this.#forceBlindForPlayer(config, message, "tool");
    });
  }

  static enabled() {
    const stored = game.settings?.get?.(MODULE_ID, "settings") ?? {};
    const settings = foundry.utils.mergeObject(defaultSettings(), stored, { inplace: false });
    return settings.blindSkillToolChecks === true;
  }

  static #forceBlindForPlayer(config, message, expectedType) {
    if (!this.enabled() || game.user?.isGM) return;
    const actor = config?.subject ?? null;
    if (!actor || actor.documentName !== "Actor") return;

    const declaredType = String(foundry.utils.getProperty(message, "data.flags.dnd5e.roll.type")
      ?? expectedType
      ?? "").toLowerCase();
    if (declaredType !== expectedType) return;

    message.rollMode = CONST.DICE_ROLL_MODES.BLIND;
  }
}
