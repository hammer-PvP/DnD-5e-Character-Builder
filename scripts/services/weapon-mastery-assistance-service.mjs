import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "weapon-mastery-chat-assistance";
const CHAT_ACTIONS = Object.freeze({
  graze: "cbWeaponMasteryGraze",
  cleave: "cbWeaponMasteryCleave"
});
const ACTION_MASTERIES = Object.freeze(Object.fromEntries(
  Object.entries(CHAT_ACTIONS).map(([mastery, action]) => [action, mastery])
));

/**
 * D&D5e 6.x Weapon Mastery chat assistance.
 *
 * The D&D5e system remains authoritative for weapon mastery ownership and for
 * the mastery selected in the attack dialog. Character Builder only adds the
 * small pieces of assistance that are not provided natively:
 *
 * - Graze/Cleave as a third structured usage-card action when eligible;
 * - a compact Topple save DC beside the native mastery link;
 * - native structured DamageRoll chat messages for Graze/Cleave damage.
 *
 * IMPORTANT: hit/miss never controls whether Graze/Cleave is visible. Doing so
 * would disclose target AC / attack resolution to a player through UI state.
 */
export class WeaponMasteryAssistanceService {
  static #initialized = false;

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    Hooks.on("dnd5e.preCreateUsageMessage", (activity, message) => this.#prepareUsageButtons(activity, message));

    // D&D5e calls this hook after its ChatMessage Data Model has rendered and
    // enriched the final HTMLElement, including child attack summaries. The
    // core renderChatMessageHTML hook occurs earlier in that lifecycle and can
    // therefore be too early for mastery markup such as the native Topple row.
    Hooks.on("dnd5e.renderChatMessage", (message, element) => this.#enrich(message, element));
    Hooks.on("renderChatLogHTML", () => setTimeout(() => this.refreshRenderedMessages(), 0));
    Hooks.on("createChatMessage", message => this.#scheduleMessageOriginRefresh(message));
    Hooks.on("updateChatMessage", message => this.#scheduleMessageOriginRefresh(message));
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static refreshRenderedMessages() {
    const messages = game.messages?.contents ?? [...(game.messages ?? [])];
    for (const message of messages) {
      for (const element of this.#renderedMessageElements(message.id)) this.#enrich(message, element);
    }
  }

  /**
   * libWrapper entry point for custom D&D5e 6.x usage-card actions.
   *
   * @returns {Promise<boolean>} True when Character Builder handled the action.
   */
  static async handleChatAction(activity, event, target, message) {
    const mastery = ACTION_MASTERIES[target?.dataset?.action ?? ""];
    if (!mastery) return false;
    if (!this.enabled()) return true;

    const context = this.#context(message, { activity });
    try {
      if (!context?.mastery || context.mastery !== mastery) {
        throw new Error("The weapon mastery context changed. Roll the attack again before using this assistance action.");
      }
      if (!context.lastAttack) {
        throw new Error(`Roll the attack before using ${this.#masteryLabel(mastery)}.`);
      }
      if (!context.item?.isOwner) {
        throw new Error("You do not have permission to roll damage for the Actor that created this weapon card.");
      }

      // Never validate hit/miss here. Graze/Cleave availability must not disclose
      // attack resolution or hidden target AC through a success/error response.
      if (mastery === "graze") await this.#rollGrazeDamage(context, { event, originMessage: message });
      else if (mastery === "cleave") await this.#rollCleaveDamage(context, { event, originMessage: message });
    } catch (error) {
      console.error(`${MODULE_ID} | Weapon Mastery assistance failed.`, error);
      ui.notifications.error(error.message);
    }
    return true;
  }

  /**
   * Add the default assisted mastery as a real D&D5e 6.x usage-card button.
   * The descriptor is persisted on UsageMessageData.system.buttons and follows
   * the native Activity.onChatAction dispatch path.
   */
  static #prepareUsageButtons(activity, message) {
    if (!this.enabled()) return;
    if (!this.#isWeaponAttack(activity)) return;

    const mastery = this.#defaultMastery(activity.item);
    const action = CHAT_ACTIONS[mastery];
    if (!action) return;

    const buttons = foundry.utils.getProperty(message, "data.system.buttons");
    if (!Array.isArray(buttons) || buttons.some(button => button?.action === action)) return;
    buttons.push({
      action,
      canGroup: false,
      dataset: {},
      icon: "fa-solid fa-burst",
      label: { value: this.#masteryLabel(mastery) },
      visibility: "creator"
    });
  }

  static #enrich(message, element) {
    const root = this.#root(element);
    if (!root) return;
    this.#clearPresentation(root);
    if (!this.enabled()) return;

    const context = this.#context(message);
    if (!context?.activity || !this.#isWeaponAttack(context.activity)) return;

    const desiredAction = CHAT_ACTIONS[context.mastery] ?? null;
    const customButtons = [...root.querySelectorAll?.("button[data-action]") ?? []]
      .filter(button => ACTION_MASTERIES[button.dataset.action]);

    // A usage card may have been created before a different mastery was chosen
    // in the attack dialog. Hide stale descriptors in this render only and add
    // the actually selected mastery without rewriting the historical message.
    for (const button of customButtons) {
      button.hidden = !desiredAction || button.dataset.action !== desiredAction;
    }

    if (desiredAction) {
      let button = customButtons.find(candidate => candidate.dataset.action === desiredAction) ?? null;
      if (!button) button = this.#insertDynamicAction(root, desiredAction, context.mastery);
      if (button) this.#prepareActionButton(button, this.#masteryLabel(context.mastery));
    }

    if (context.mastery === "topple" && context.lastAttack) this.#appendToppleDc(root, context);
  }

  static #context(message, { activity=null }={}) {
    if (!message) return null;

    activity ??= message.getAssociatedActivity?.() ?? null;
    if (!activity && message.type === "attack") activity = message.getAssociatedActivity?.() ?? null;
    if (!this.#isWeaponAttack(activity)) return null;

    const item = message.getAssociatedItem?.() ?? activity.item ?? null;
    const actor = message.getAssociatedActor?.() ?? item?.actor ?? activity.actor ?? null;
    if (!item || item.type !== "weapon" || !actor) return null;

    const masteryOptions = this.#masteryOptions(item);

    let lastAttack = null;
    if (message.type === "attack") lastAttack = message;
    else {
      const attacks = message.getAssociatedRolls?.("attack") ?? [];
      lastAttack = attacks.length ? attacks.at(-1) : null;
    }

    const rolledMastery = String(
      lastAttack?.system?.mastery
      ?? lastAttack?.rolls?.[0]?.options?.mastery
      ?? ""
    ).trim();

    let mastery = null;
    // On an actual D&D5e 6.x AttackMessage, system.mastery is the mastery the
    // system itself accepted and recorded for this attack. Treat that value as
    // authoritative even when the associated Item is a snapshot/clone whose
    // prepared masteryOptions getter cannot be reconstructed after the fact.
    // Usage cards still use masteryOptions as the ownership gate before a roll.
    if (rolledMastery && CONFIG.DND5E.weaponMasteries?.[rolledMastery]) mastery = rolledMastery;
    else mastery = this.#defaultMastery(item, masteryOptions);

    const masteryConfig = mastery ? CONFIG.DND5E.weaponMasteries?.[mastery] ?? null : null;
    return { actor, item, activity, masteryOptions, lastAttack, mastery, masteryConfig };
  }

  static #isWeaponAttack(activity) {
    return Boolean(activity && activity.type === "attack" && activity.item?.type === "weapon");
  }

  /**
   * D&D5e's masteryOptions getter is the authoritative ownership gate: it is
   * null unless the Actor actually has mastery of this base weapon.
   */
  static #masteryOptions(item) {
    try {
      return Array.from(item?.system?.masteryOptions ?? []);
    } catch (_error) {
      return [];
    }
  }

  static #defaultMastery(item, options=this.#masteryOptions(item)) {
    if (!options.length) return null;
    const printed = String(item?.system?.mastery ?? "").trim();
    if (printed && options.some(option => String(option?.value ?? "") === printed)) return printed;
    return options.length === 1 ? String(options[0]?.value ?? "") || null : null;
  }

  static #masteryLabel(mastery) {
    const configured = CONFIG.DND5E.weaponMasteries?.[mastery]?.label;
    if (configured) return game.i18n?.localize?.(configured) ?? configured;
    return String(mastery ?? "").capitalize?.() ?? String(mastery ?? "");
  }

  static #prepareActionButton(button, label) {
    if (!(button instanceof HTMLElement)) return;
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
  }

  static #insertDynamicAction(root, action, mastery) {
    const anchor = root.querySelector?.("button[data-action=\"rollDamage\"]")
      ?? root.querySelector?.("button[data-action=\"rollAttack\"]");
    const list = anchor?.closest?.("ul");
    if (!list) return null;

    const entry = document.createElement("li");
    entry.dataset.cbWeaponMasteryDynamic = "true";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon";
    button.dataset.action = action;
    button.dataset.cbWeaponMasteryDynamic = "true";
    button.innerHTML = '<i class="fa-solid fa-burst" inert></i>';
    entry.appendChild(button);
    list.appendChild(entry);
    this.#prepareActionButton(button, this.#masteryLabel(mastery));
    return button;
  }

  static #appendToppleDc(root, context) {
    const dc = this.#toppleDc(context);
    if (!Number.isFinite(dc)) return;

    const scopes = [];
    if (context.lastAttack?.id) {
      const summary = root.querySelector?.(`.card-summary[data-message-id="${context.lastAttack.id}"]`);
      if (summary) scopes.push(summary);
    }
    scopes.push(root);

    const reference = String(context.masteryConfig?.reference ?? "");
    const label = this.#masteryLabel("topple").trim().toLowerCase();

    for (const scope of scopes) {
      if (scope.querySelector?.(".cb-weapon-mastery-dc")) return;

      // Anchor to the native mastery element itself rather than to a historical
      // Usage-card wrapper. This works for the live AttackMessage as well as a
      // summary embedded in its originating UsageMessage.
      let anchor = null;
      if (reference) {
        anchor = [...scope.querySelectorAll?.("a[data-uuid]") ?? []]
          .find(candidate => String(candidate.dataset.uuid ?? "") === reference) ?? null;
      }
      if (!anchor) {
        anchor = [...scope.querySelectorAll?.("a.content-link, a[data-link]") ?? []]
          .find(candidate => candidate.textContent?.trim?.().toLowerCase() === label) ?? null;
      }

      // Text-only mastery rows are valid when the system configuration has no
      // reference link. In that case attach to the native supplement row.
      if (!anchor) {
        anchor = [...scope.querySelectorAll?.("p.supplement") ?? []]
          .find(row => row.textContent?.toLowerCase?.().includes(label)) ?? null;
      }
      if (!anchor) continue;

      const value = document.createElement("span");
      value.className = "cb-weapon-mastery-dc";
      const conKey = CONFIG.DND5E?.abilities?.con?.abbreviation ?? "DND5E.AbilityConAbbr";
      const con = game.i18n?.localize?.(conKey) ?? "CON";
      value.textContent = ` · DC ${dc} ${con}`;

      if (anchor.matches?.("a")) anchor.insertAdjacentElement("afterend", value);
      else anchor.appendChild(value);
      return;
    }
  }

  static async #rollGrazeDamage(context, { event, originMessage }={}) {
    const { activity, item, actor } = context;
    const base = this.#baseDamageContext(context);
    if (!base) throw new Error(`${item.name} has no native weapon damage to use for Graze.`);

    const modifier = this.#attackModifier(context);
    const amount = Math.max(0, Number.isFinite(modifier) ? modifier : 0);
    await this.#postDamageRoll({
      actor,
      activity,
      context,
      formula: String(amount),
      data: {},
      options: this.#damageOptions(base),
      flavor: `${item.name} - ${this.#masteryLabel("graze")}`,
      event,
      originMessage
    });
  }

  static async #rollCleaveDamage(context, { event, originMessage }={}) {
    const { activity, item, actor } = context;
    const base = this.#baseDamageContext(context);
    if (!base) throw new Error(`${item.name} has no native weapon damage to use for Cleave.`);

    const parts = [];
    const baseFormula = String(base.parts?.[0] ?? "").trim();
    if (baseFormula) parts.push(baseFormula);

    // D&D5e 6.x moved the prepared/effect damage-bonus target to damage.bonus.
    const itemDamageBonus = String(item.system?.damage?.bonus ?? "").trim();
    if (itemDamageBonus && !/^0+(?:\.0+)?$/.test(itemDamageBonus)) parts.push(itemDamageBonus);

    const modifier = this.#attackModifier(context);
    if (Number.isFinite(modifier) && modifier < 0) parts.push("@mod");
    if (base.parts?.includes?.("@magicalBonus")) parts.push("@magicalBonus");
    if (base.parts?.includes?.("@ammoBonus")) parts.push("@ammoBonus");

    if (!parts.length) throw new Error(`${item.name} has no Cleave damage formula.`);
    const data = foundry.utils.deepClone(base.data ?? {});
    if (Number.isFinite(modifier)) data.mod = modifier;
    await this.#postDamageRoll({
      actor,
      activity,
      context,
      formula: parts.join(" + "),
      data,
      options: this.#damageOptions(base),
      flavor: `${item.name} - ${this.#masteryLabel("cleave")}`,
      event,
      originMessage
    });
  }

  static #baseDamageContext(context) {
    const { activity, lastAttack, actor, item } = context;
    const attackMode = lastAttack?.system?.mode
      ?? item.getFlag?.("dnd5e", `last.${activity.id}.attackMode`)
      ?? undefined;
    const ammunition = lastAttack?.system?.ammunitionItem
      ?? (lastAttack?.system?.ammunition ? actor.items?.get?.(lastAttack.system.ammunition) : null)
      ?? undefined;

    const config = activity.getDamageConfig?.({ attackMode, ammunition });
    const rolls = config?.rolls ?? [];
    return rolls.find(row => row.base) ?? rolls[0] ?? null;
  }

  static #attackModifier(context) {
    const ability = String(
      context.lastAttack?.system?.ability
      ?? context.lastAttack?.rolls?.[0]?.options?.ability
      ?? context.item?.getFlag?.("dnd5e", `last.${context.activity?.id}.ability`)
      ?? ""
    ).trim();
    if (ability === "none") return 0;

    const direct = Number(context.actor?.system?.abilities?.[ability]?.mod);
    if (ability && Number.isFinite(direct)) return direct;

    // Defensive fallback for unusual Activities that expose their effective
    // attack modifier only through roll data.
    const attackMode = context.lastAttack?.system?.mode
      ?? context.lastAttack?.rolls?.[0]?.options?.attackMode
      ?? undefined;
    const rollData = context.activity?.getRollData?.({
      deterministic: true,
      roll: { ability: ability || undefined, attackMode }
    }) ?? {};
    const modifier = Number(rollData.mod ?? 0);
    return Number.isFinite(modifier) ? modifier : 0;
  }

  static #damageOptions(base) {
    return {
      base: true,
      type: base.options?.type ?? null,
      types: foundry.utils.deepClone(base.options?.types ?? []),
      properties: foundry.utils.deepClone(base.options?.properties ?? [])
    };
  }

  static async #postDamageRoll({ actor, activity, context, formula, data, options, flavor, event, originMessage }) {
    const DamageRoll = CONFIG.Dice?.DamageRoll;
    if (!DamageRoll) throw new Error("D&D5e DamageRoll is unavailable.");
    const roll = await new DamageRoll(formula, data, options).evaluate();

    const origin = originMessage?.getOriginatingMessage?.() ?? originMessage ?? null;
    const targets = context?.lastAttack?.system?.targets
      ?? originMessage?.system?.targets
      ?? [];
    const system = {
      ...activity.messageSources,
      targets: foundry.utils.deepClone(Array.from(targets ?? []))
    };
    if (origin?.id) system.origin = origin.id;

    await DamageRoll.buildPost([roll], { event }, {
      create: true,
      data: {
        flavor,
        speaker: ChatMessage.getSpeaker({ actor }),
        system,
        type: "damage"
      }
    });
    return roll;
  }

  static #toppleDc(context) {
    const rawProficiency = context.actor?.system?.attributes?.prof;
    const proficiency = Number(rawProficiency?.value ?? rawProficiency?.flat ?? rawProficiency);
    const modifier = this.#attackModifier(context);
    if (!Number.isFinite(proficiency) || !Number.isFinite(modifier)) return null;
    return 8 + proficiency + modifier;
  }

  static #scheduleMessageOriginRefresh(message) {
    if (!message) return;
    if (message.type === "attack") {
      const origin = message.getOriginatingMessage?.();
      if (origin && origin !== message) this.#refreshOriginSoon(origin.id);
      return;
    }
    if (message.type === "usage") this.#refreshOriginSoon(message.id);
  }

  static #refreshOriginSoon(originId) {
    if (!originId) return;
    setTimeout(() => {
      const message = game.messages?.get?.(originId);
      if (!message) return;
      for (const element of this.#renderedMessageElements(originId)) this.#enrich(message, element);
    }, 0);
  }

  static #clearPresentation(root) {
    root.querySelectorAll?.('[data-cb-weapon-mastery-dynamic="true"]').forEach(element => {
      const entry = element.closest?.("li[data-cb-weapon-mastery-dynamic=true]");
      (entry ?? element).remove();
    });
    root.querySelectorAll?.(".cb-chat-action-label").forEach(element => element.remove());
    root.querySelectorAll?.(".cb-weapon-mastery-dc").forEach(element => element.remove());
    root.querySelectorAll?.("button.cb-labeled-chat-action").forEach(button => {
      button.classList.remove("cb-labeled-chat-action");
      if (ACTION_MASTERIES[button.dataset.action]) button.hidden = false;
    });
  }

  static #renderedMessageElements(messageId) {
    if (!messageId) return [];
    const selector = `[data-message-id="${messageId}"]`;
    const elements = [];
    const seen = new Set();
    const collect = root => {
      for (const element of root?.querySelectorAll?.(selector) ?? []) {
        if (!(element instanceof HTMLElement) || seen.has(element)) continue;
        seen.add(element);
        elements.push(element);
      }
    };

    // Foundry v14 can keep chat markup in the live document or in a detached
    // application root. Query both; an empty NodeList from one must not mask
    // the other (the x2 nullish-coalescing lookup did exactly that).
    collect(document);
    collect(foundry.applications?.detached);
    return elements;
  }

  static #root(element) {
    return element instanceof HTMLElement ? element : null;
  }
}
