import { MODULE_ID } from "../constants.mjs";

const BINDING_FLAG = "nativeEnchantmentBinding";
const AGONIZING_IDENTIFIER = "agonizing-blast";

/**
 * Reconciles the Character Builder's managed Invocation target with the native
 * D&D5e Enchant Activity supplied by the PHB. The resulting cantrip remains a
 * single native Item with a native enchantment; no duplicate cantrip, Activity,
 * or roll command is created.
 */
export class AgonizingBlastBindingService {
  static #initialized = false;
  static #timers = new Map();
  static #locks = new Map();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    const scheduleItem = (item, options, userId) => {
      const actor = item?.actor ?? item?.parent?.actor ?? item?.parent;
      if (!actor || options?.characterBuilderRulesAssistance) return;
      if (!this.#canReact(actor, userId)) return;
      this.schedule(actor);
    };
    const scheduleEffect = (effect, options, userId) => {
      const item = effect?.parent;
      const actor = item?.actor ?? item?.parent;
      if (!actor || options?.characterBuilderRulesAssistance) return;
      if (!this.#canReact(actor, userId)) return;
      this.schedule(actor);
    };

    Hooks.on("createItem", scheduleItem);
    Hooks.on("updateItem", scheduleItem);
    Hooks.on("deleteItem", scheduleItem);
    Hooks.on("createActiveEffect", scheduleEffect);
    Hooks.on("updateActiveEffect", scheduleEffect);
    Hooks.on("deleteActiveEffect", scheduleEffect);
  }

  static async ready() {
    if (!game.user?.isGM) return;
    const activeGM = game.users?.activeGM;
    if (activeGM && activeGM.id !== game.user.id) return;
    for (const actor of game.actors?.filter?.(candidate => candidate.type === "character"
      && !candidate.getFlag?.(MODULE_ID, "isDraft")
      && !candidate.getFlag?.(MODULE_ID, "isLevelUpDraft")
      && !candidate.getFlag?.(MODULE_ID, "commitSafetyBackup")) ?? []) {
      try {
        await this.reconcileActor(actor, { reason: "ready" });
      } catch (error) {
        console.warn(`${MODULE_ID} | Agonizing Blast native binding reconciliation failed for ${actor.name}.`, error);
      }
    }
  }

  static schedule(actor, delay = 80) {
    if (!actor?.id) return;
    const previous = this.#timers.get(actor.id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.#timers.delete(actor.id);
      void this.reconcileActor(actor, { reason: "document-change" }).catch(error => {
        console.warn(`${MODULE_ID} | Agonizing Blast native binding reconciliation failed for ${actor.name}.`, error);
      });
    }, Math.max(0, Number(delay) || 0));
    this.#timers.set(actor.id, timer);
  }

  static async reconcileActor(actor, { reason = "manual" } = {}) {
    if (!actor || actor.type !== "character") return { checked: 0, applied: 0, adopted: 0, removed: 0, missing: 0 };
    const key = actor.id ?? actor.uuid;
    if (this.#locks.has(key)) return this.#locks.get(key);

    const operation = this.#reconcile(actor, { reason }).finally(() => {
      if (this.#locks.get(key) === operation) this.#locks.delete(key);
    });
    this.#locks.set(key, operation);
    return operation;
  }

  static async #reconcile(actor, { reason }) {
    const summary = { checked: 0, applied: 0, adopted: 0, removed: 0, missing: 0, reason };
    const invocations = this.#items(actor).filter(item => this.#identifier(item) === AGONIZING_IDENTIFIER);
    const desiredKeys = new Set();

    for (const invocation of invocations) {
      const instance = invocation.getFlag?.(MODULE_ID, "invocationInstance")
        ?? invocation.flags?.[MODULE_ID]?.invocationInstance
        ?? {};
      if (!instance.targetCantripItemId && !instance.targetCantripIdentifier) continue;
      summary.checked += 1;

      const target = this.#targetCantrip(actor, instance);
      if (!target) {
        summary.missing += 1;
        continue;
      }

      const activity = this.#enchantActivity(invocation);
      const profileId = activity?.availableEnchantments?.[0]?._id
        ?? this.#activityEffectRefs(activity)[0]?._id
        ?? this.#effects(invocation).find(effect => effect.type === "enchantment")?.id
        ?? this.#effects(invocation).find(effect => effect.type === "enchantment")?._id
        ?? null;
      if (!activity?.applyEnchantment || !profileId) {
        summary.missing += 1;
        continue;
      }

      const binding = {
        type: AGONIZING_IDENTIFIER,
        invocationItemId: invocation.id,
        invocationInstanceId: instance.instanceId ?? null,
        targetItemId: target.id,
        activityId: activity.id,
        profileId
      };
      desiredKeys.add(this.#bindingKey(binding));

      let effect = this.#findOwnedEffect(target, binding, activity);
      if (!effect) effect = this.#findAdoptableNativeEffect(target, profileId, activity, invocation);

      if (!effect) {
        effect = await activity.applyEnchantment(profileId, target, { strict: false });
        if (!effect) {
          summary.missing += 1;
          continue;
        }
        summary.applied += 1;
      } else if (!this.#effectBinding(effect)) {
        summary.adopted += 1;
      }

      const current = this.#effectBinding(effect);
      if (this.#bindingKey(current) !== this.#bindingKey(binding)) {
        await effect.update({ [`flags.${MODULE_ID}.${BINDING_FLAG}`]: binding }, {
          characterBuilderRulesAssistance: true
        });
      }
    }

    for (const item of this.#items(actor)) {
      for (const effect of this.#effects(item)) {
        const binding = this.#effectBinding(effect);
        if (binding?.type !== AGONIZING_IDENTIFIER) continue;
        if (desiredKeys.has(this.#bindingKey(binding))) continue;
        await effect.delete({ characterBuilderRulesAssistance: true });
        summary.removed += 1;
      }
    }

    return summary;
  }

  static #targetCantrip(actor, instance) {
    const byId = instance.targetCantripItemId ? actor.items?.get?.(instance.targetCantripItemId) : null;
    if (byId?.type === "spell" && Number(byId.system?.level ?? 0) === 0) return byId;
    return this.#items(actor).find(item => item.type === "spell"
      && Number(item.system?.level ?? 0) === 0
      && String(item.system?.identifier ?? "") === String(instance.targetCantripIdentifier ?? "")
      && this.#classIdentifier(item) === "warlock") ?? null;
  }

  static #enchantActivity(invocation) {
    return this.#activities(invocation).find(activity => activity?.type === "enchant"
      && (/make agonizing/i.test(String(activity.name ?? "")) || this.#activityEffectRefs(activity).length)) ?? null;
  }

  static #findOwnedEffect(target, binding, activity) {
    return this.#effects(target).find(effect => {
      const current = this.#effectBinding(effect);
      if (current && this.#bindingKey(current) === this.#bindingKey(binding)) return true;
      const profile = effect.getFlag?.("dnd5e", "enchantmentProfile")
        ?? effect.flags?.dnd5e?.enchantmentProfile;
      const origin = effect.origin ?? effect.getFlag?.("core", "originText") ?? effect.flags?.core?.originText;
      return profile === binding.profileId && origin === activity.uuid;
    }) ?? null;
  }

  static #findAdoptableNativeEffect(target, profileId, activity, invocation) {
    const augmentRows = target.getFlag?.(MODULE_ID, "eldritchInvocationAugments")
      ?? target.flags?.[MODULE_ID]?.eldritchInvocationAugments
      ?? [];
    const claimed = augmentRows.some(row => row.invocationItemId === invocation.id
      || (row.instanceId && row.instanceId === invocation.getFlag?.(MODULE_ID, "invocationInstance")?.instanceId));
    if (!claimed) return null;

    return this.#effects(target).find(effect => {
      if (effect.type !== "enchantment") return false;
      const profile = effect.getFlag?.("dnd5e", "enchantmentProfile")
        ?? effect.flags?.dnd5e?.enchantmentProfile;
      const origin = effect.origin ?? effect.getFlag?.("core", "originText") ?? effect.flags?.core?.originText;
      if (profile === profileId && (!origin || origin === activity.uuid)) return true;
      const changes = effect.system?.changes ?? effect.changes ?? [];
      return /agonizing blast/i.test(String(effect.name ?? ""))
        && changes.some(change => change.key === "system.damage.bonus"
          && String(change.value ?? "").includes("@abilities.cha.mod"));
    }) ?? null;
  }

  static #effectBinding(effect) {
    return effect?.getFlag?.(MODULE_ID, BINDING_FLAG)
      ?? effect?.flags?.[MODULE_ID]?.[BINDING_FLAG]
      ?? null;
  }

  static #bindingKey(binding) {
    if (!binding) return "";
    return [binding.type, binding.invocationItemId, binding.invocationInstanceId, binding.targetItemId,
      binding.activityId, binding.profileId].map(value => String(value ?? "")).join("|");
  }

  static #identifier(item) {
    return String(item?.system?.identifier ?? "").trim().toLowerCase();
  }

  static #classIdentifier(item) {
    return String(item?.getFlag?.(MODULE_ID, "classIdentifier")
      ?? item?.flags?.[MODULE_ID]?.classIdentifier
      ?? String(item?.system?.sourceItem ?? "").replace(/^class:/, "")
      ?? "").toLowerCase();
  }

  static #items(actor) {
    if (!actor?.items) return [];
    if (Array.isArray(actor.items)) return actor.items;
    if (Array.isArray(actor.items.contents)) return actor.items.contents;
    return [...actor.items];
  }

  static #activities(item) {
    const activities = item?.system?.activities;
    if (!activities) return [];
    if (Array.isArray(activities)) return activities;
    if (Array.isArray(activities.contents)) return activities.contents;
    if (typeof activities.values === "function") return [...activities.values()];
    return Object.values(activities);
  }

  static #activityEffectRefs(activity) {
    const effects = activity?.effects;
    if (!effects) return [];
    if (Array.isArray(effects)) return effects;
    if (Array.isArray(effects.contents)) return effects.contents;
    if (typeof effects.values === "function") return [...effects.values()];
    return Object.values(effects);
  }

  static #effects(item) {
    const effects = item?.effects;
    if (!effects) return [];
    if (Array.isArray(effects)) return effects;
    if (Array.isArray(effects.contents)) return effects.contents;
    return [...effects];
  }

  static #canReact(actor, userId) {
    if (userId && userId !== game.user?.id) return false;
    if (actor.getFlag?.(MODULE_ID, "isDraft") || actor.getFlag?.(MODULE_ID, "isLevelUpDraft")) {
      return Boolean(actor.isOwner);
    }
    const activeGM = game.users?.activeGM;
    if (activeGM) return activeGM.id === game.user?.id;
    return Boolean(game.user?.isGM || actor.isOwner);
  }
}
