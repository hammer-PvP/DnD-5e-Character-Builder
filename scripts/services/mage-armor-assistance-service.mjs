import { MODULE_ID, defaultSettings } from "../constants.mjs";

const MAGE_ARMOR_IDENTIFIER = "mage-armor";
const ARMOR_OF_SHADOWS_IDENTIFIER = "armor-of-shadows";
const EFFECT_FLAG = "mageArmorAssistance";
const CONTEXT_KEY = "dnd5eCharacterBuilderMageArmor";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_APPLY = "rulesAssistanceMageArmorApply";
const BODY_ARMOR_TYPES = new Set(["light", "medium", "heavy"]);

/**
 * Applies the native Mage Armor Active Effect after a successful activity use.
 * The source spell remains authoritative: this service copies its own effect
 * profile to the resolved Actor target rather than inventing a parallel AC rule.
 */
export class MageArmorAssistanceService {
  static #hooksRef = null;
  static #socketReady = false;
  static #audit = new Map();
  static #locks = new Map();

  static initialize() {
    if (this.#hooksRef === globalThis.Hooks) return;
    this.#hooksRef = globalThis.Hooks;

    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig, dialogConfig, messageConfig) =>
      this.#validateUse(activity, usageConfig, dialogConfig, messageConfig)
    );
    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) =>
      this.#handleUse(activity, usageConfig, results).catch(error => {
        console.warn(`${MODULE_ID} | Mage Armor automatic effect application failed.`, error);
      })
    );

    const onArmorChanged = (item, _changes, options, userId) => {
      if (options?.characterBuilderRulesAssistance) return;
      if (!this.enabled() || !this.#isEquippedBodyArmor(item)) return;
      const actor = item?.actor ?? item?.parent;
      if (!actor || !this.#canReact(actor, userId)) return;
      return this.#endMageArmor(actor, {
        reason: "body-armor-equipped",
        armorItemId: item.id ?? null
      }).catch(error => {
        console.warn(`${MODULE_ID} | Could not end Mage Armor after armor was equipped.`, error);
      });
    };

    Hooks.on("createItem", onArmorChanged);
    Hooks.on("updateItem", onArmorChanged);
  }

  static async ready() {
    this.#initializeSocket();
  }

  static enabled() {
    const stored = globalThis.game?.settings?.get?.(MODULE_ID, "settings") ?? {};
    const merge = globalThis.foundry?.utils?.mergeObject;
    const settings = merge
      ? merge(defaultSettings(), stored, { inplace: false })
      : { ...defaultSettings(), ...stored };
    return settings.assistWithDiceAutomation === true;
  }

  static diagnostics(actor) {
    const id = String(actor?.id ?? actor ?? "");
    return (this.#audit.get(id) ?? []).map(row => ({ ...row }));
  }

  static #initializeSocket() {
    if (this.#socketReady || !globalThis.game?.socket?.on) return;
    this.#socketReady = true;
    game.socket.on(SOCKET_CHANNEL, payload => {
      if (payload?.type !== SOCKET_APPLY || !this.#isActiveGM()) return;
      void this.#handleSocketApply(payload).catch(error => {
        console.warn(`${MODULE_ID} | GM Mage Armor application request failed.`, error);
      });
    });
  }

  static #validateUse(activity, usageConfig, _dialogConfig, messageConfig) {
    if (!this.enabled()) return;
    const mode = this.#mageArmorMode(activity);
    if (!mode) return;

    const targetResult = this.#resolveUseTarget(activity, messageConfig, mode);
    if (!targetResult.actor) {
      ui.notifications.warn(targetResult.message ?? "Select one eligible target for Mage Armor before casting it.");
      return false;
    }

    const armor = this.#equippedBodyArmor(targetResult.actor);
    if (armor) {
      ui.notifications.warn(`${targetResult.actor.name} cannot receive Mage Armor while wearing ${armor.name}.`);
      return false;
    }

    usageConfig[CONTEXT_KEY] = {
      mode,
      targetActorUuid: targetResult.actor.uuid ?? `Actor.${targetResult.actor.id}`,
      sourceActorUuid: activity.actor?.uuid ?? `Actor.${activity.actor?.id ?? ""}`,
      sourceItemId: activity.item?.id ?? null,
      sourceActivityId: activity.id ?? null
    };

    foundry.utils.setProperty(
      messageConfig,
      `data.flags.${MODULE_ID}.rulesAssistance.mageArmorTargetUuid`,
      usageConfig[CONTEXT_KEY].targetActorUuid
    );
  }

  static async #handleUse(activity, usageConfig, results) {
    if (!this.enabled()) return;
    const context = usageConfig?.[CONTEXT_KEY];
    if (!context || !this.#mageArmorMode(activity)) return;

    const target = await this.#resolveActor(context.targetActorUuid);
    if (!target) {
      this.#recordAudit(activity.actor, {
        ruleId: MAGE_ARMOR_IDENTIFIER,
        action: "Mage Armor target could not be resolved",
        warning: true
      });
      return;
    }

    const armor = this.#equippedBodyArmor(target);
    if (armor) {
      ui.notifications.warn(`${target.name} cannot receive Mage Armor while wearing ${armor.name}.`);
      this.#recordAudit(target, {
        ruleId: MAGE_ARMOR_IDENTIFIER,
        action: "Mage Armor application blocked because body armor was equipped",
        armorItemId: armor.id ?? null,
        warning: true
      });
      return;
    }

    const source = this.#resolveNativeSource(activity, context);
    if (!source.effect) {
      ui.notifications.warn("Mage Armor was cast, but its native Active Effect could not be located.");
      this.#recordAudit(activity.actor, {
        ruleId: MAGE_ARMOR_IDENTIFIER,
        action: "Native Mage Armor Active Effect was not found on the source Item",
        itemId: context.sourceItemId,
        warning: true
      });
      return;
    }

    const application = {
      targetActorUuid: target.uuid ?? context.targetActorUuid,
      sourceActorUuid: activity.actor?.uuid ?? context.sourceActorUuid,
      sourceItemId: source.item?.id ?? context.sourceItemId,
      sourceActivityId: source.activity?.id ?? context.sourceActivityId,
      sourceEffectId: source.effect.id ?? source.effect._id,
      spellLevel: Number(results?.message?.system?.spellLevel
        ?? results?.message?.getFlag?.("dnd5e", "spellLevel")
        ?? activity.item?.system?.level
        ?? 1),
      scaling: results?.message?.system?.scaling ?? null
    };

    if (game.user?.isGM || target.isOwner) {
      await this.#applyFromRequest(application, { requesterId: game.user?.id ?? null });
      return;
    }

    const activeGM = game.users?.activeGM;
    if (!activeGM) {
      ui.notifications.warn("Mage Armor could not be applied automatically because no active GM can update the selected target.");
      return;
    }
    game.socket.emit(SOCKET_CHANNEL, {
      type: SOCKET_APPLY,
      requesterId: game.user?.id ?? null,
      ...application
    });
  }

  static async #handleSocketApply(payload) {
    if (!this.enabled()) return;
    await this.#applyFromRequest(payload, { requesterId: payload.requesterId ?? null });
  }

  static async #applyFromRequest(request, { requesterId = null } = {}) {
    const target = await this.#resolveActor(request.targetActorUuid);
    const sourceActor = await this.#resolveActor(request.sourceActorUuid);
    const sourceItem = sourceActor?.items?.get?.(request.sourceItemId) ?? null;
    const sourceActivity = this.#activities(sourceItem).find(row => row.id === request.sourceActivityId) ?? null;
    const sourceEffect = this.#effects(sourceItem).find(row => (row.id ?? row._id) === request.sourceEffectId)
      ?? this.#nativeMageArmorEffect(sourceActivity, sourceItem);
    if (!target || !sourceEffect) return null;

    const armor = this.#equippedBodyArmor(target);
    if (armor) {
      this.#recordAudit(target, {
        ruleId: MAGE_ARMOR_IDENTIFIER,
        action: "Mage Armor application rejected because body armor was equipped",
        armorItemId: armor.id ?? null,
        warning: true
      });
      return null;
    }

    const key = String(target.id ?? target.uuid);
    if (this.#locks.has(key)) return this.#locks.get(key);
    const operation = this.#applyNativeEffect(target, sourceEffect, {
      sourceActor,
      sourceItem,
      sourceActivity,
      spellLevel: request.spellLevel,
      scaling: request.scaling,
      requesterId
    }).finally(() => {
      if (this.#locks.get(key) === operation) this.#locks.delete(key);
    });
    this.#locks.set(key, operation);
    return operation;
  }

  static async #applyNativeEffect(target, sourceEffect, metadata) {
    const existing = this.#effects(target).find(effect => this.#isMageArmorEffect(effect)) ?? null;
    const ownership = {
      sourceActorId: metadata.sourceActor?.id ?? null,
      sourceItemId: metadata.sourceItem?.id ?? null,
      sourceActivityId: metadata.sourceActivity?.id ?? null,
      sourceEffectId: sourceEffect.id ?? sourceEffect._id ?? null,
      requesterId: metadata.requesterId ?? null,
      appliedAt: Date.now()
    };
    const effectFlags = {
      flags: {
        dnd5e: {
          dependentOn: sourceEffect.uuid,
          scaling: metadata.scaling ?? null,
          spellLevel: Number.isFinite(Number(metadata.spellLevel)) ? Number(metadata.spellLevel) : 1
        },
        [MODULE_ID]: {
          [EFFECT_FLAG]: ownership
        }
      }
    };

    if (existing) {
      const initialDuration = sourceEffect.constructor?.getInitialDuration?.() ?? {};
      const updates = foundry.utils.mergeObject({
        ...initialDuration,
        disabled: false,
        origin: sourceEffect.uuid
      }, effectFlags, { inplace: false });
      await existing.update(updates, { characterBuilderRulesAssistance: true });
      this.#recordAudit(target, {
        ruleId: MAGE_ARMOR_IDENTIFIER,
        action: "Refreshed native Mage Armor Active Effect",
        effectId: existing.id ?? null
      });
      return existing;
    }

    const effectData = foundry.utils.mergeObject({
      ...sourceEffect.toObject(),
      disabled: false,
      transfer: false,
      origin: sourceEffect.uuid
    }, effectFlags, { inplace: false });

    const created = globalThis.ActiveEffect?.implementation?.create
      ? await ActiveEffect.implementation.create(effectData, {
        parent: target,
        characterBuilderRulesAssistance: true
      })
      : (await target.createEmbeddedDocuments("ActiveEffect", [effectData], {
        characterBuilderRulesAssistance: true
      }))?.[0];

    this.#recordAudit(target, {
      ruleId: MAGE_ARMOR_IDENTIFIER,
      action: "Applied native Mage Armor Active Effect",
      effectId: created?.id ?? null
    });
    return created ?? null;
  }

  static async #endMageArmor(actor, metadata = {}) {
    const effects = this.#effects(actor).filter(effect => this.#isMageArmorEffect(effect));
    for (const effect of effects) {
      await effect.delete({ characterBuilderRulesAssistance: true });
    }
    if (effects.length) {
      this.#recordAudit(actor, {
        ruleId: MAGE_ARMOR_IDENTIFIER,
        action: "Ended Mage Armor because body armor was equipped",
        removed: effects.length,
        ...metadata
      });
    }
    return effects.length;
  }

  static #resolveUseTarget(activity, messageConfig, mode) {
    if (mode === "self") return { actor: activity.actor };

    const descriptors = foundry.utils.getProperty(messageConfig, "data.flags.dnd5e.targets") ?? [];
    const actors = descriptors.map(row => this.#resolveActorSync(row?.uuid)).filter(Boolean);
    const unique = [...new Map(actors.map(actor => [actor.uuid ?? actor.id, actor])).values()];
    if (!unique.length) {
      return { actor: null, message: "Select one willing creature as the target of Mage Armor before casting it." };
    }
    if (unique.length > 1) {
      return { actor: null, message: "Mage Armor affects only one creature per casting. Keep exactly one target selected." };
    }
    return { actor: unique[0] };
  }

  static #resolveNativeSource(activity, context) {
    const actor = activity.actor;
    const item = actor?.items?.get?.(context.sourceItemId ?? activity.item?.id) ?? activity.item;
    const liveActivity = this.#activities(item).find(row => row.id === (context.sourceActivityId ?? activity.id))
      ?? activity;
    return {
      item,
      activity: liveActivity,
      effect: this.#nativeMageArmorEffect(liveActivity, item)
    };
  }

  static #nativeMageArmorEffect(activity, item) {
    const candidates = [
      ...(activity?.applicableEffects ?? []),
      ...this.#activityEffectRefs(activity).map(ref => ref?.effect ?? item?.effects?.get?.(ref?._id ?? ref?.id)).filter(Boolean),
      ...this.#effects(item)
    ];
    return candidates.find(effect => this.#isMageArmorEffect(effect)) ?? null;
  }

  static #mageArmorMode(activity) {
    const item = activity?.item;
    if (!item) return null;
    const identifier = this.#identifier(item);
    const sourceId = String(item.getFlag?.("dnd5e", "sourceId")
      ?? item.flags?.dnd5e?.sourceId
      ?? item._stats?.compendiumSource
      ?? "").toLowerCase();

    if (identifier === ARMOR_OF_SHADOWS_IDENTIFIER || sourceId.includes("phbinvarmorofsha")) return "self";
    if (identifier === MAGE_ARMOR_IDENTIFIER || sourceId.includes("magearmor")) {
      const selfTarget = activity.target?.affects?.type === "self"
        || activity.range?.units === "self"
        || item.system?.target?.affects?.type === "self"
        || item.system?.range?.units === "self";
      return selfTarget ? "self" : "target";
    }
    return null;
  }

  static #identifier(item) {
    return String(item?.system?.identifier ?? "").trim().toLowerCase();
  }

  static #equippedBodyArmor(actor) {
    return this.#items(actor).find(item => this.#isEquippedBodyArmor(item)) ?? null;
  }

  static #isEquippedBodyArmor(item) {
    if (item?.type !== "equipment" || item.system?.equipped !== true) return false;
    return BODY_ARMOR_TYPES.has(String(item.system?.type?.value ?? "").toLowerCase());
  }

  static #isMageArmorEffect(effect) {
    const changes = effect?.system?.changes ?? effect?.changes ?? [];
    return changes.some(change => change.key === "system.attributes.ac.calc"
      && String(change.value ?? "").toLowerCase() === "mage");
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

  static #items(actor) {
    const items = actor?.items;
    if (!items) return [];
    if (Array.isArray(items)) return items;
    if (Array.isArray(items.contents)) return items.contents;
    return [...items];
  }

  static #effects(document) {
    const effects = document?.effects;
    if (!effects) return [];
    if (Array.isArray(effects)) return effects;
    if (Array.isArray(effects.contents)) return effects.contents;
    return [...effects];
  }

  static #resolveActorSync(uuid) {
    if (!uuid) return null;
    const document = globalThis.fromUuidSync?.(uuid, { strict: false });
    if (document?.documentName === "Token") return document.actor ?? null;
    if (document?.actor && document.documentName !== "Actor") return document.actor;
    if (document?.type && document?.items) return document;
    const id = String(uuid).replace(/^Actor\./, "");
    return game.actors?.get?.(id) ?? null;
  }

  static async #resolveActor(uuid) {
    const sync = this.#resolveActorSync(uuid);
    if (sync) return sync;
    const document = await globalThis.fromUuid?.(uuid, { strict: false });
    if (document?.documentName === "Token") return document.actor ?? null;
    if (document?.actor && document.documentName !== "Actor") return document.actor;
    return document?.type && document?.items ? document : null;
  }

  static #canReact(actor, userId) {
    if (userId && userId !== game.user?.id) return false;
    const activeGM = game.users?.activeGM;
    if (activeGM) return activeGM.id === game.user?.id || Boolean(actor.isOwner && userId === game.user?.id);
    return Boolean(game.user?.isGM || actor.isOwner);
  }

  static #isActiveGM() {
    if (!game.user?.isGM) return false;
    const activeGM = game.users?.activeGM;
    return !activeGM || activeGM.id === game.user.id;
  }

  static #recordAudit(actor, entry) {
    if (!actor?.id) return;
    const key = String(actor.id);
    const rows = this.#audit.get(key) ?? [];
    rows.push({ at: Date.now(), ...entry });
    this.#audit.set(key, rows.slice(-50));
  }
}
