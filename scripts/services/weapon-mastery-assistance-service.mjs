import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "weapon-mastery-chat-assistance";
const BUTTON_ACTIONS = Object.freeze({
  graze: "graze-damage",
  cleave: "cleave-damage"
});

/**
 * Adds compact Weapon Mastery assistance to the native D&D5e attack Activity
 * chat card. D&D5e remains authoritative for whether the originating Actor can
 * use a mastery and, where the attack dialog offers more than one mastery, for
 * which mastery was actually selected on the roll.
 *
 * No Actor state, target tracking, turn tracking, or Action Economy state is
 * created. Graze and Cleave only produce native DamageRoll chat messages; the
 * normal D&D5e target/selected-token application flow remains authoritative.
 */
export class WeaponMasteryAssistanceService {
  static #initialized = false;

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    Hooks.on("renderChatMessageHTML", (message, element) => this.#enrich(message, element));
    Hooks.on("renderChatMessage", (message, element) => this.#enrich(message, element));
    Hooks.on("createChatMessage", message => this.#scheduleMessageOriginRefresh(message));
    Hooks.on("dnd5e.rollAttack", rolls => this.#scheduleOriginRefresh(rolls));
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static refreshRenderedMessages() {
    const messages = game.messages?.contents ?? [...(game.messages ?? [])];
    for (const message of messages) {
      const element = document.querySelector?.(`[data-message-id="${message.id}"]`);
      if (element) this.#enrich(message, element);
    }
  }

  static #enrich(message, element) {
    const root = this.#root(element);
    if (!root) return;
    this.#clear(root);
    if (!this.enabled()) return;

    const context = this.#context(message);
    if (!context?.mastery) return;

    const card = root.querySelector?.(".chat-card.activation-card")
      ?? root.querySelector?.(".chat-card");
    if (!card) return;

    const controls = card.querySelector?.(".card-buttons");
    const action = BUTTON_ACTIONS[context.mastery];
    const showGraze = context.mastery === "graze" && this.#isMiss(context.lastAttack);
    const showButton = action && (context.mastery !== "graze" || showGraze);

    if (showButton && controls) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.cbWeaponMasteryControl = "true";
      button.dataset.cbWeaponMasteryAction = action;
      button.dataset.cbWeaponMasteryMessageId = message.id;
      button.innerHTML = `<i class="fa-solid fa-burst" inert></i><span>${context.mastery === "graze" ? "Graze Damage" : "Cleave Damage"}</span>`;
      button.addEventListener("click", event => this.#onDamageButton(event, message, context.mastery));
      controls.appendChild(button);
    }

    const supplement = document.createElement("p");
    supplement.className = "supplement cb-weapon-mastery-assistance";
    supplement.dataset.cbWeaponMasteryControl = "true";

    const link = this.#masteryLink(context.masteryConfig);
    if (link) supplement.appendChild(link);
    else supplement.textContent = context.masteryConfig?.label ?? context.mastery;

    if (context.mastery === "topple") {
      const dc = this.#toppleDc(context);
      if (Number.isFinite(dc)) {
        const value = document.createElement("span");
        value.className = "cb-weapon-mastery-dc";
        value.textContent = ` · DC ${dc}`;
        supplement.appendChild(value);
      }
    }

    if (controls) controls.insertAdjacentElement("afterend", supplement);
    else card.appendChild(supplement);
  }

  static #context(message) {
    if (!message) return null;
    if (message.getFlag?.("dnd5e", "messageType") === "roll") return null;

    const flags = message.flags?.dnd5e ?? {};
    if (String(flags.activity?.type ?? "") !== "attack") return null;

    const actor = message.getAssociatedActor?.()
      ?? game.actors?.get?.(message.speaker?.actor)
      ?? null;
    if (!actor) return null;

    const itemId = flags.item?.id ?? null;
    const activityId = flags.activity?.id ?? null;
    const item = itemId ? actor.items?.get?.(itemId) : null;
    const activity = activityId ? item?.system?.activities?.get?.(activityId) : null;
    if (!item || item.type !== "weapon" || !activity || activity.type !== "attack") return null;

    const masteryOptions = Array.from(item.system?.masteryOptions ?? []);
    if (!masteryOptions.length) return null;

    const associated = message.getAssociatedRolls?.("attack") ?? [];
    const lastAttack = associated.length ? associated.at(-1) : null;
    const rolledMastery = String(
      lastAttack?.getFlag?.("dnd5e", "roll.mastery")
      ?? lastAttack?.rolls?.[0]?.options?.mastery
      ?? ""
    );

    let mastery = null;
    if (rolledMastery && masteryOptions.some(option => option.value === rolledMastery)) mastery = rolledMastery;
    // Before an attack is rolled, one native option is unambiguous and can be
    // advertised on the Activity card. Once a roll exists, however, D&D5e's
    // recorded roll mastery is authoritative; never infer a missing selection
    // from the weapon's printed/default mastery.
    else if (!lastAttack && masteryOptions.length === 1) mastery = masteryOptions[0].value;
    if (!mastery) return { actor, item, activity, masteryOptions, lastAttack, mastery: null };

    const masteryConfig = CONFIG.DND5E.weaponMasteries?.[mastery];
    if (!masteryConfig) return null;
    return { actor, item, activity, masteryOptions, lastAttack, mastery, masteryConfig };
  }

  static async #onDamageButton(event, message, mastery) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    if (button?.disabled) return;
    button.disabled = true;
    try {
      const context = this.#context(message);
      if (!context?.mastery || context.mastery !== mastery) {
        throw new Error("The weapon mastery context changed. Roll the attack again before using this assistance button.");
      }
      if (!context.item.isOwner) {
        throw new Error("You do not have permission to roll damage for the Actor that created this weapon card.");
      }
      if (mastery === "graze") {
        if (!this.#isMiss(context.lastAttack)) {
          throw new Error("Graze Damage is available only when the recorded attack missed its target.");
        }
        await this.#rollGrazeDamage(context, { event, originMessage: message });
      } else if (mastery === "cleave") {
        await this.#rollCleaveDamage(context, { event, originMessage: message });
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Weapon Mastery assistance failed.`, error);
      ui.notifications.error(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  static async #rollGrazeDamage(context, { event, originMessage } = {}) {
    const { activity, item, actor } = context;
    const base = this.#baseDamageContext(context);
    if (!base) throw new Error(`${item.name} has no native weapon damage to use for Graze.`);

    const modifier = Number(activity.getRollData?.({ deterministic: true })?.mod ?? 0);
    // D&D damage cannot become healing when a negative modifier is involved.
    const amount = Math.max(0, Number.isFinite(modifier) ? modifier : 0);
    await this.#postDamageRoll({
      actor,
      activity,
      formula: String(amount),
      data: {},
      options: this.#damageOptions(base),
      flavor: `${item.name} - Graze Damage`,
      event,
      originMessage
    });
  }

  static async #rollCleaveDamage(context, { event, originMessage } = {}) {
    const { activity, item, actor } = context;
    const base = this.#baseDamageContext(context);
    if (!base) throw new Error(`${item.name} has no native weapon damage to use for Cleave.`);

    const parts = [];
    const baseFormula = String(base.parts?.[0] ?? "").trim();
    if (baseFormula) parts.push(baseFormula);

    // Cleave keeps the weapon's own prepared damage package, including an
    // intrinsic/enchantment damage bonus and magical weapon/ammunition bonus,
    // but does not import Actor damage riders or arbitrary extra damage parts.
    const itemDamageBonus = String(item.system?.damageBonus ?? "").trim();
    if (itemDamageBonus && !/^0+(?:\.0+)?$/.test(itemDamageBonus)) parts.push(itemDamageBonus);

    const modifier = Number(base.data?.mod ?? activity.getRollData?.({ deterministic: true })?.mod ?? 0);
    if (Number.isFinite(modifier) && modifier < 0) parts.push("@mod");
    if (base.parts?.includes?.("@magicalBonus")) parts.push("@magicalBonus");
    if (base.parts?.includes?.("@ammoBonus")) parts.push("@ammoBonus");

    if (!parts.length) throw new Error(`${item.name} has no Cleave damage formula.`);
    await this.#postDamageRoll({
      actor,
      activity,
      formula: parts.join(" + "),
      data: foundry.utils.deepClone(base.data ?? {}),
      options: this.#damageOptions(base),
      flavor: `${item.name} - Cleave Damage`,
      event,
      originMessage
    });
  }

  static #baseDamageContext(context) {
    const { activity, lastAttack, actor } = context;
    const attackMode = lastAttack?.getFlag?.("dnd5e", "roll.attackMode")
      ?? context.item.getFlag?.("dnd5e", `last.${activity.id}.attackMode`)
      ?? undefined;

    let ammunition;
    if (lastAttack) {
      const storedData = lastAttack.getFlag?.("dnd5e", "roll.ammunitionData");
      ammunition = storedData
        ? new Item.implementation(storedData, { parent: actor })
        : actor.items?.get?.(lastAttack.getFlag?.("dnd5e", "roll.ammunition"));
    }

    const config = activity.getDamageConfig?.({ attackMode, ammunition });
    const rolls = config?.rolls ?? [];
    return rolls.find(row => row.base) ?? rolls[0] ?? null;
  }

  static #damageOptions(base) {
    return {
      base: true,
      type: base.options?.type ?? null,
      types: foundry.utils.deepClone(base.options?.types ?? []),
      properties: foundry.utils.deepClone(base.options?.properties ?? [])
    };
  }

  static async #postDamageRoll({ actor, activity, formula, data, options, flavor, event, originMessage }) {
    const DamageRoll = CONFIG.Dice?.DamageRoll;
    if (!DamageRoll) throw new Error("D&D5e DamageRoll is unavailable.");
    const roll = await new DamageRoll(formula, data, options).evaluate();
    const dnd5eFlags = {
      ...activity.messageFlags,
      messageType: "roll",
      roll: { type: "damage" }
    };
    if (originMessage?.id) dnd5eFlags.originatingMessage = originMessage.id;

    // Post through the D&D5e roll pipeline's native final stage. This preserves
    // the standard damage-roll ChatMessage shape, current target descriptors,
    // and origin association without running the normal damage configuration
    // pipeline that would re-add modifiers intentionally excluded by Graze or
    // Cleave.
    await DamageRoll.buildPost([roll], { event }, {
      create: true,
      data: {
        flavor,
        speaker: ChatMessage.getSpeaker({ actor }),
        flags: { dnd5e: dnd5eFlags }
      }
    });
    return roll;
  }

  static #isMiss(attackMessage) {
    const roll = attackMessage?.rolls?.[0];
    const targets = attackMessage?.getFlag?.("dnd5e", "targets") ?? [];
    if (!roll || targets.length !== 1) return false;
    const ac = Number(targets[0]?.ac);
    if (!Number.isFinite(ac)) return false;
    return !roll.isCritical && ((Number(roll.total) < ac) || Boolean(roll.isFumble));
  }

  static #toppleDc(context) {
    const proficiency = Number(context.actor?.system?.attributes?.prof);
    const modifier = Number(context.activity?.getRollData?.({ deterministic: true })?.mod ?? 0);
    if (!Number.isFinite(proficiency) || !Number.isFinite(modifier)) return null;
    return 8 + proficiency + modifier;
  }

  static #masteryLink(config) {
    const label = String(config?.label ?? "").trim();
    const reference = String(config?.reference ?? "").trim();
    if (!label) return null;
    if (!reference) {
      const span = document.createElement("span");
      span.textContent = label;
      return span;
    }
    const link = document.createElement("a");
    link.className = "content-link";
    link.draggable = true;
    link.dataset.link = "";
    link.dataset.uuid = reference;
    link.dataset.tooltip = label;
    link.textContent = label;
    return link;
  }

  static #scheduleMessageOriginRefresh(message) {
    if (message?.getFlag?.("dnd5e", "messageType") !== "roll") return;
    if (message?.getFlag?.("dnd5e", "roll.type") !== "attack") return;
    const originId = message.getFlag?.("dnd5e", "originatingMessage");
    if (!originId) return;
    this.#refreshOriginSoon(originId);
  }

  static #scheduleOriginRefresh(rolls) {
    const attackMessage = rolls?.map?.(roll => roll?.parent)
      ?.find?.(parent => parent?.documentName === "ChatMessage") ?? null;
    const originId = attackMessage?.getFlag?.("dnd5e", "originatingMessage");
    if (!originId) return;
    this.#refreshOriginSoon(originId);
  }

  static #refreshOriginSoon(originId) {
    setTimeout(() => {
      const message = game.messages?.get?.(originId);
      const element = document.querySelector?.(`[data-message-id="${originId}"]`);
      if (message && element) this.#enrich(message, element);
    }, 0);
  }

  static #clear(root) {
    root.querySelectorAll?.('[data-cb-weapon-mastery-control="true"]').forEach(element => element.remove());
  }

  static #root(element) {
    if (element instanceof HTMLElement) return element;
    if (element?.[0] instanceof HTMLElement) return element[0];
    return null;
  }
}
