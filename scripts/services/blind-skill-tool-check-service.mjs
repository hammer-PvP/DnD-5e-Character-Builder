import { MODULE_ID, defaultSettings } from "../constants.mjs";

/**
 * Optional immersion policy: Skill and Tool checks are posted using Foundry
 * v14's native Blind chat visibility without changing the user's global Chat
 * visibility mode or any D&D5e roll-configuration choices.
 *
 * The policy intentionally applies regardless of whether a Player or GM clicks
 * the roll. Blind visibility already grants GMs access while keeping the result
 * hidden from Players, which is the purpose of this world setting.
 */
export class BlindSkillToolCheckService {
  static #initialized = false;

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    Hooks.on("dnd5e.postSkillRollConfiguration", (_rolls, config, _dialog, message) => {
      this.#forceBlind(config, message, "skill");
    });
    Hooks.on("dnd5e.postToolRollConfiguration", (_rolls, config, _dialog, message) => {
      this.#forceBlind(config, message, "tool");
    });
  }

  static enabled() {
    const stored = game.settings?.get?.(MODULE_ID, "settings") ?? {};
    const settings = foundry.utils.mergeObject(defaultSettings(), stored, { inplace: false });
    return settings.blindSkillToolChecks === true;
  }

  static #forceBlind(config, message, expectedType) {
    if (!this.enabled()) return;
    const actor = config?.subject ?? null;
    if (!actor || actor.documentName !== "Actor") return;

    // The D&D5e 6.x post-configuration hook is the type authority. Do not read
    // legacy flags.dnd5e.roll.type: migrated Check messages use structured
    // ChatMessage data instead. These lightweight guards protect against a
    // future hook contract accidentally routing the wrong roll type here.
    if (expectedType === "skill" && !config?.skill) return;
    if (expectedType === "tool" && !config?.tool) return;

    // Foundry v14 replaced legacy Roll Modes ("blindroll") with Chat Message
    // Visibility Modes. D&D5e BasicRoll forwards this value as messageMode, so
    // it must be the modern CONFIG.ChatMessage.modes key.
    message.rollMode = "blind";
  }
}
