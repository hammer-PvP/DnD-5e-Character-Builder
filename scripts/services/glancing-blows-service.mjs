import {
  GLANCING_BLOW_BAND_DEFINITIONS,
  defaultGlancingBlowsConfig
} from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "glancing-blows";
const ALLOWED_MULTIPLIERS = Object.freeze([0, 0.25, 0.5, 1]);
const FALLBACK_MULTIPLIERS = Object.freeze([
  Object.freeze({ value: 0, label: "0" }),
  Object.freeze({ value: 0.25, label: "¼" }),
  Object.freeze({ value: 0.5, label: "½" }),
  Object.freeze({ value: 1, label: "1" })
]);

/**
 * Optional global combat homebrew built on D&D5e 6.x's native damage tray.
 *
 * Character Builder decides only which native damage multiplier applies to a
 * target based on attack margin vs. recorded AC. D&D5e remains authoritative
 * for damage rolls, resistance/vulnerability, rounding, HP updates, and the
 * final Apply Damage operation.
 */
export class GlancingBlowsService {
  static #initialized = false;
  static #nativeMultiplierOptions = null;

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    // Presentation only. Runtime damage application is handled by the native
    // DamageApplicationElement through the libWrapper entry point below.
    Hooks.on("dnd5e.renderChatMessage", (message, element) => this.decorateAttackMessage(message, element));
  }

  static enabled(candidate = null) {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID, candidate);
  }

  static configuration(candidate = null) {
    const settings = RulesAssistanceSettingsService.settings(candidate);
    const defaults = defaultGlancingBlowsConfig();
    const stored = settings.rulesAssistance?.glancingBlows ?? {};
    const merge = globalThis.foundry?.utils?.mergeObject;
    const config = merge
      ? merge(defaults, stored, { inplace: false })
      : structuredClone(defaults);

    for (const band of GLANCING_BLOW_BAND_DEFINITIONS) {
      const row = config.bands?.[band.key] ?? (config.bands[band.key] = {});
      row.enabled = row.enabled !== false;
      row.multiplier = this.normalizeMultiplier(row.multiplier, band.defaultMultiplier);
    }
    return config;
  }

  static defaultConfiguration() {
    return defaultGlancingBlowsConfig();
  }

  /**
   * Use D&D5e's own DamageApplicationElement to obtain the native multiplier
   * labels. The local list is only a compatibility fallback if that public
   * component surface changes in a future 6.x build.
   */
  static multiplierOptions() {
    if (this.#nativeMultiplierOptions) return foundry.utils.deepClone(this.#nativeMultiplierOptions);

    let options = [];
    try {
      const cls = globalThis.dnd5e?.applications?.components?.DamageApplicationElement;
      const tag = cls?.tagName ?? "damage-application";
      const element = globalThis.document?.createElement?.(tag);
      const buttons = element?.buildMultiplierButtons?.(new Set()) ?? [];
      options = [...buttons]
        .map(button => ({ value: Number(button.value), label: String(button.textContent ?? "").trim() }))
        .filter(option => ALLOWED_MULTIPLIERS.includes(option.value) && option.label);
    } catch (_error) {
      options = [];
    }

    if (options.length !== ALLOWED_MULTIPLIERS.length
      || ALLOWED_MULTIPLIERS.some(value => !options.some(option => option.value === value))) {
      options = FALLBACK_MULTIPLIERS.map(option => ({ ...option }));
    } else {
      options.sort((a, b) => ALLOWED_MULTIPLIERS.indexOf(a.value) - ALLOWED_MULTIPLIERS.indexOf(b.value));
    }

    this.#nativeMultiplierOptions = options;
    return foundry.utils.deepClone(options);
  }

  static multiplierLabel(value) {
    const normalized = this.normalizeMultiplier(value, 1);
    return this.multiplierOptions().find(option => option.value === normalized)?.label ?? String(normalized);
  }

  static resultLabel(multiplier) {
    const value = this.normalizeMultiplier(multiplier, 1);
    if (value === 0) return "Miss";
    if (value === 1) return "Hit";
    return "Glancing Blow";
  }

  static normalizeMultiplier(value, fallback = 1) {
    const numeric = Number(value);
    return ALLOWED_MULTIPLIERS.includes(numeric) ? numeric : fallback;
  }

  static bandKeyForMargin(margin) {
    if (!Number.isFinite(margin)) return null;
    if (margin >= 1) return "above";
    if (margin === 0) return "exact";
    if (margin === -1) return "minusOne";
    return "below";
  }

  /**
   * Pure resolution helper used by both the damage tray and presentation.
   * Native critical/fumble state always wins over the homebrew bands.
   */
  static resolveOutcome({ total, ac, isCritical = false, isFumble = false } = {}, candidate = null) {
    if (total === null || total === undefined || ac === null || ac === undefined || ac === "") return null;
    total = Number(total);
    ac = Number(ac);
    if (!Number.isFinite(total) || !Number.isFinite(ac)) return null;

    if (isCritical) return {
      bandKey: null,
      margin: total - ac,
      multiplier: 1,
      nativeMultiplier: 1,
      critical: true,
      fumble: false,
      overridden: false
    };
    if (isFumble) return {
      bandKey: null,
      margin: total - ac,
      multiplier: 0,
      nativeMultiplier: 0,
      critical: false,
      fumble: true,
      overridden: false
    };

    const margin = total - ac;
    const bandKey = this.bandKeyForMargin(margin);
    if (!bandKey) return null;
    const nativeMultiplier = total >= ac ? 1 : 0;
    const band = this.configuration(candidate).bands?.[bandKey];
    const multiplier = band?.enabled
      ? this.normalizeMultiplier(band.multiplier, nativeMultiplier)
      : nativeMultiplier;

    return {
      bandKey,
      margin,
      multiplier,
      nativeMultiplier,
      critical: false,
      fumble: false,
      overridden: Boolean(band?.enabled && multiplier !== nativeMultiplier)
    };
  }

  static resolveTarget(attackMessage, targetUuid, candidate = null) {
    const roll = attackMessage?.rolls?.[0];
    if (!roll) return null;
    const target = this.#findAttackTarget(attackMessage, targetUuid);
    if (!target || target.ac === null || target.ac === undefined || !Number.isFinite(Number(target.ac))) return null;
    const outcome = this.resolveOutcome({
      total: roll.total,
      ac: target.ac,
      isCritical: roll.isCritical === true,
      isFumble: roll.isFumble === true
    }, candidate);
    return outcome ? { ...outcome, target, attackMessage, roll } : null;
  }

  static resolveDamageTarget(damageMessage, targetUuid, candidate = null) {
    if (!this.enabled(candidate)) return null;
    const attackMessage = this.#attackMessageForDamage(damageMessage);
    return attackMessage ? this.resolveTarget(attackMessage, targetUuid, candidate) : null;
  }

  /** libWrapper entry point for DamageApplicationElement#getTargetOptions. */
  static wrapGetTargetOptions(application, wrapped, targetUuid, ...args) {
    const options = wrapped(targetUuid, ...args);
    if (!options || !this.enabled()) return options;

    // Respect a native/GM per-target override that already exists. Character
    // Builder supplies only the initial multiplier for untouched target state.
    if (options.multiplier !== undefined) return options;

    const resolution = this.resolveDamageTarget(application?.chatMessage, targetUuid);
    if (!resolution) return options;
    options.multiplier = resolution.multiplier;
    return options;
  }

  /**
   * Add a compact visual hint to rendered AttackMessage targets without
   * changing D&D5e's stored hit/miss result. Hidden attack outcomes stay hidden.
   */
  static decorateAttackMessage(message, element) {
    if (!this.enabled() || !message || !element) return;
    const root = element instanceof HTMLElement ? element : element?.[0] ?? null;
    if (!root) return;

    const attacks = message.type === "attack"
      ? [message]
      : [...(message.getAssociatedRolls?.("attack") ?? [])];
    if (!attacks.length) return;

    for (const attack of attacks) {
      const scope = message.type === "attack"
        ? root
        : root.querySelector?.(`.card-summary[data-message-id="${attack.id}"]`);
      if (!scope) continue;
      this.#decorateAttackScope(attack, scope);
    }
  }

  static #decorateAttackScope(attackMessage, scope) {
    for (const pill of scope.querySelectorAll?.("target-pill") ?? []) {
      pill.removeAttribute("data-cb-glancing");
      pill.removeAttribute("data-cb-homebrew-hit");
      pill.removeAttribute("data-cb-homebrew-miss");
      pill.querySelector?.(".cb-glancing-multiplier")?.remove?.();

      // Respect D&D5e attack-roll visibility. If the system intentionally did
      // not render hit/miss state, do not reveal the homebrew result either.
      const showsResult = pill.hasAttribute("data-hit") || pill.hasAttribute("data-miss");
      if (!showsResult) continue;

      const targetUuid = pill.querySelector?.("option")?.value;
      if (!targetUuid) continue;
      const resolution = this.resolveTarget(attackMessage, targetUuid);
      if (!resolution) continue;

      if (resolution.multiplier > 0 && resolution.multiplier < 1) {
        pill.dataset.cbGlancing = "true";
        const badge = document.createElement("span");
        badge.className = "cb-glancing-multiplier";
        badge.textContent = this.multiplierLabel(resolution.multiplier);
        badge.dataset.tooltip = `Glancing Blow ×${badge.textContent}`;
        pill.querySelector("label")?.after(badge);
      } else if ((resolution.multiplier === 1) && (resolution.nativeMultiplier === 0)) {
        pill.dataset.cbHomebrewHit = "true";
      } else if ((resolution.multiplier === 0) && (resolution.nativeMultiplier === 1)) {
        pill.dataset.cbHomebrewMiss = "true";
      }
    }
  }

  static #attackMessageForDamage(damageMessage) {
    if (!damageMessage || damageMessage.type !== "damage") return null;
    const origin = damageMessage.getOriginatingMessage?.() ?? null;
    if (!origin || origin === damageMessage) return null;
    if (origin.type === "attack") return origin;
    const attacks = origin.getAssociatedRolls?.("attack") ?? [];
    return attacks.length ? attacks.at(-1) : null;
  }

  static #findAttackTarget(attackMessage, targetUuid) {
    const targets = [...(attackMessage?.system?.targets ?? [])];
    const direct = targets.find(target => String(target?.token ?? "") === String(targetUuid ?? ""));
    if (direct) return direct;

    // A damage target can occasionally resolve through a replacement token.
    // Fall back to Actor identity only when that identity is unambiguous.
    let actorUuid = null;
    try {
      actorUuid = globalThis.fromUuidSync?.(targetUuid, { strict: false })?.actor?.uuid ?? null;
    } catch (_error) {
      actorUuid = null;
    }
    if (!actorUuid) return null;
    const matches = targets.filter(target => String(target?.actor ?? "") === String(actorUuid));
    return matches.length === 1 ? matches[0] : null;
  }
}

export const GLANCING_BLOWS_RULE_ID = RULE_ID;
