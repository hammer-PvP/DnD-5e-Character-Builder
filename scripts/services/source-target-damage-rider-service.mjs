import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "source-target-damage-riders";
const BINDING_FLAG = "sourceTargetDamageRiderBinding";
const ADAPTERS = Object.freeze([
  Object.freeze({
    sourceIdentifier: "hunters-mark",
    status: "marked",
    upgradeIdentifier: "foe-slayer",
    effectApplication: null,
    bindAppliedEffect: false
  }),
  Object.freeze({
    sourceIdentifier: "hex",
    status: "cursed",
    upgradeIdentifier: null,
    effectApplication: "direct-native-choice",
    bindAppliedEffect: true
  })
]);

/**
 * Adds a source-owned damage Activity to an Attack Activity's native damage
 * process when the selected target bears the matching source-owned effect.
 * The damage Activity remains authoritative for formula, type, and criticals.
 */
export class SourceTargetDamageRiderService {
  static #initialized = false;
  static #audit = new Map();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    Hooks.on("preCreateActiveEffect", (effect, data) => {
      try {
        this.#bindAppliedTargetEffect(effect, data);
      } catch (error) {
        console.warn(`${MODULE_ID} | Source-target applied-effect binding failed.`, error);
      }
    });
    Hooks.on("dnd5e.preRollDamage", (process, dialog, message) => this.#prepare(process, dialog, message));
    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => {
      void this.#handleNativeTargetEffectApplication(activity, usageConfig, results).catch(error => {
        console.warn(`${MODULE_ID} | Source-target native effect application failed.`, error);
      });
    });
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static diagnostics(actor) {
    const key = String(actor?.id ?? actor ?? "");
    return (this.#audit.get(key) ?? []).map(row => ({ ...row }));
  }

  static #prepare(process) {
    if (!this.enabled()) return;
    const attack = process?.subject;
    if (!attack?.actor || attack.type !== "attack") return;
    if (process?.dnd5eCharacterBuilderSourceTargetRidersApplied) return;

    const targets = Array.from(game.user?.targets ?? []);
    if (targets.length !== 1) return;
    const targetActor = targets[0]?.actor;
    if (!targetActor) return;

    const matches = [];
    for (const effect of targetActor.effects ?? []) {
      if (effect.disabled || effect.isSuppressed) continue;
      const resolved = this.#resolveEffectSource(effect);
      if (!resolved?.sourceItem || resolved.controllerActor?.uuid !== attack.actor.uuid) continue;
      const adapter = ADAPTERS.find(row => row.sourceIdentifier === resolved.sourceItem.system?.identifier);
      if (!adapter || (adapter.status && !effect.statuses?.has?.(adapter.status))) continue;
      const rider = this.#selectRiderActivity(attack.actor, resolved.sourceItem, adapter);
      if (rider) matches.push({ effect, rider, adapter });
    }
    if (!matches.length) return;

    process.rolls ??= [];
    const seen = new Set();
    for (const { effect, rider, adapter } of matches) {
      const key = `${adapter.sourceIdentifier}:${rider.uuid ?? rider.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const riderConfig = rider.getDamageConfig?.({
        attackMode: process.attackMode,
        ammunition: process.ammunition,
        scaling: process.scaling
      });
      if (!riderConfig?.rolls?.length) continue;
      for (const roll of riderConfig.rolls) {
        roll.options ??= {};
        roll.options.dnd5eCharacterBuilderDamageRider = {
          sourceIdentifier: adapter.sourceIdentifier,
          sourceItemUuid: rider.item?.uuid ?? null,
          activityUuid: rider.uuid ?? null,
          effectUuid: effect.uuid ?? null
        };
        process.rolls.push(roll);
      }
      this.#record(attack.actor, {
        ruleId: RULE_ID,
        action: "Added source-target damage rider",
        sourceIdentifier: adapter.sourceIdentifier,
        riderActivity: rider.name ?? rider.id,
        targetActorUuid: targetActor.uuid ?? null
      });
    }
    if (seen.size) process.dnd5eCharacterBuilderSourceTargetRidersApplied = true;
  }

  static async #handleNativeTargetEffectApplication(activity, usageConfig, results) {
    if (!this.enabled() || usageConfig?.dnd5eCharacterBuilderEffectPrompt) return;

    const sourceIdentifier = activity?.item?.system?.identifier;
    const adapter = ADAPTERS.find(row => row.sourceIdentifier === sourceIdentifier);
    if (adapter?.effectApplication !== "direct-native-choice") return;

    const declaredEffectIds = this.#declaredEffectIds(activity);
    if (!declaredEffectIds.length) return;

    const sourceActor = activity?.actor;
    const liveItem = sourceActor?.items?.get?.(activity.item?.id) ?? null;
    if (!sourceActor || !liveItem) return;

    const effects = declaredEffectIds
      .map(id => liveItem.effects?.get?.(id))
      .filter(effect => effect && (!adapter.status || effect.statuses?.has?.(adapter.status)));
    if (!effects.length) return;

    const message = results?.message ?? null;
    const targets = this.#resolveUsageTargetActors(message);
    if (targets.length !== 1) {
      ui.notifications?.warn?.(`${liveItem.name}: target exactly one creature before using this activity.`);
      this.#record(sourceActor, {
        ruleId: RULE_ID,
        action: "Skipped native target-effect choice because target count was not one",
        sourceIdentifier,
        targetCount: targets.length
      });
      return;
    }

    // The native D&D5e usage card can retain effect UUIDs without rendering a
    // usable EffectApplicationElement in this Hex path. The Character Builder
    // owns the choice for this adapter, so clear the unusable tray payload and
    // present one deterministic choice instead of creating a second usage card.
    if (message?.update && Array.isArray(message.system?.effects) && message.system.effects.length) {
      try {
        await message.update({ "system.effects": [] });
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not clear the unused native Hex effect tray.`, error);
      }
    }

    const targetActor = targets[0];
    const chosen = await this.#chooseNativeTargetEffect(liveItem, targetActor, effects);
    if (!chosen) {
      this.#record(sourceActor, {
        ruleId: RULE_ID,
        action: "Native target-effect choice canceled",
        sourceIdentifier,
        targetActorUuid: targetActor.uuid ?? null
      });
      return;
    }

    const concentrationId = message?.system?.concentration ?? null;
    const concentration = sourceActor.effects?.get?.(concentrationId)
      ?? this.#concentrationForSourceItem(sourceActor, liveItem);
    if (!concentration) {
      ui.notifications?.warn?.(`${liveItem.name}: the active concentration effect could not be found, so the curse was not applied.`);
      this.#record(sourceActor, {
        ruleId: RULE_ID,
        action: "Skipped native target effect because concentration was unavailable",
        sourceIdentifier,
        targetActorUuid: targetActor.uuid ?? null,
        chosenEffectId: chosen.id ?? null
      });
      return;
    }

    const applied = await this.#applyNativeTargetEffect(chosen, targetActor, {
      concentration,
      message,
      sourceItem: liveItem
    });
    if (!applied) return;

    this.#record(sourceActor, {
      ruleId: RULE_ID,
      action: "Applied selected native target effect",
      sourceIdentifier,
      targetActorUuid: targetActor.uuid ?? null,
      chosenEffectId: chosen.id ?? null,
      appliedEffectUuid: applied.uuid ?? null,
      anchorUuid: concentration.uuid ?? null
    });
  }

  static #resolveUsageTargetActors(message) {
    const actors = [];
    const seen = new Set();
    const push = actor => {
      if (!actor?.uuid || seen.has(actor.uuid)) return;
      seen.add(actor.uuid);
      actors.push(actor);
    };

    const descriptors = foundry.utils.getProperty(message, "flags.dnd5e.targets")
      ?? message?.getFlag?.("dnd5e", "targets")
      ?? [];
    for (const descriptor of Array.from(descriptors ?? [])) {
      const uuid = typeof descriptor === "string" ? descriptor : descriptor?.uuid;
      const document = this.#fromUuid(uuid, message);
      if (document?.documentName === "Actor") push(document);
      else if (document?.actor?.documentName === "Actor") push(document.actor);
    }

    if (!actors.length) {
      for (const token of Array.from(game.user?.targets ?? [])) push(token?.actor);
    }
    return actors;
  }

  static async #chooseNativeTargetEffect(sourceItem, targetActor, effects) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      ui.notifications?.warn?.(`${sourceItem.name}: Foundry DialogV2 is unavailable, so the curse choice could not be shown.`);
      return null;
    }

    const targetName = foundry.utils.escapeHTML(targetActor?.name ?? "target");
    const content = `<div class="character-builder-prompt">
      <p>Choose the ability that <strong>${foundry.utils.escapeHTML(sourceItem.name)}</strong> curses on <strong>${targetName}</strong>.</p>
      <p>The selected native D&D5e effect will be applied to that target and linked to this concentration.</p>
    </div>`;

    const buttons = effects.map(effect => ({
      action: `effect-${effect.id}`,
      label: String(effect.name ?? "Curse").replace(/^Hexed\s+/i, ""),
      icon: "fa-solid fa-bolt"
    }));
    buttons.push({ action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" });

    const action = await DialogV2.wait({
      window: { title: `${sourceItem.name} — Choose Curse`, modal: true },
      content,
      buttons,
      close: () => "cancel"
    });
    if (!action || action === "cancel") return null;
    const id = String(action).replace(/^effect-/, "");
    return effects.find(effect => effect.id === id) ?? null;
  }

  static async #applyNativeTargetEffect(effect, targetActor, { concentration, message, sourceItem }) {
    if (!game.user?.isGM && !targetActor?.isOwner) {
      ui.notifications?.warn?.(`${sourceItem.name}: you do not have permission to apply an effect to ${targetActor?.name ?? "that target"}.`);
      return null;
    }

    const origin = concentration ?? effect;
    const existing = Array.from(targetActor.effects ?? []).find(candidate =>
      !candidate?.disabled && candidate.origin === origin.uuid
    );
    if (existing) return existing;

    const effectFlags = {
      flags: {
        dnd5e: {
          dependentOn: origin.uuid,
          scaling: message?.system?.scaling ?? 0,
          spellLevel: message?.system?.spellLevel ?? sourceItem.system?.level ?? null
        }
      }
    };
    const effectData = foundry.utils.mergeObject({
      ...effect.toObject(),
      disabled: false,
      transfer: false,
      origin: origin.uuid
    }, effectFlags, { inplace: false });

    return ActiveEffect.implementation.create(effectData, { parent: targetActor });
  }

  static #declaredEffectIds(activity) {
    const ids = [];
    const entries = activity?.effects?.contents
      ?? Array.from(activity?.effects?.values?.() ?? activity?.effects ?? []);
    for (const entry of entries) {
      const id = entry?.effect?.id ?? entry?._id ?? entry?.id ?? null;
      if (id && !ids.includes(String(id))) ids.push(String(id));
    }
    if (ids.length) return ids;
    for (const effect of Array.from(activity?.applicableEffects ?? [])) {
      if (effect?.id && !ids.includes(String(effect.id))) ids.push(String(effect.id));
    }
    return ids;
  }

  /**
   * Capture the source/controller relationship at the exact point where
   * D&D5e creates the selected native target effect. Hex can reach this hook
   * through either of two native paths:
   *   - origin/dependentOn = the caster's Concentration ActiveEffect; or
   *   - origin/dependentOn = the selected Hex ActiveEffect embedded in the
   *     caster's Hex Item when an intermediary usage card lost concentration.
   *
   * The second shape was the missing case in v0.9.9l. Preserve the native
   * chosen Hex effect, but repair it back onto the live concentration when it
   * is discoverable and persist an explicit source-target binding for damage
   * resolution. Hunter's Mark does not use this repair path.
   */
  static #bindAppliedTargetEffect(effect, data) {
    if (!this.enabled() || !data || typeof data !== "object") return;

    const statuses = new Set(Array.from(data.statuses ?? effect?.statuses ?? []));
    const candidates = ADAPTERS.filter(adapter => adapter.bindAppliedEffect && (!adapter.status || statuses.has(adapter.status)));
    if (!candidates.length) return;

    const originUuid = data.origin ?? effect?.origin ?? null;
    const dependentUuid = foundry.utils.getProperty(data, "flags.dnd5e.dependentOn")
      ?? effect?.getFlag?.("dnd5e", "dependentOn")
      ?? null;

    let resolved = this.#sourceFromUuid(originUuid, effect);
    if (!resolved?.sourceItem && dependentUuid && dependentUuid !== originUuid) {
      resolved = this.#sourceFromUuid(dependentUuid, effect);
    }
    if (!resolved?.controllerActor || !resolved.sourceItem) return;

    const adapter = candidates.find(row => row.sourceIdentifier === resolved.sourceItem.system?.identifier);
    if (!adapter) return;

    const concentration = this.#concentrationForSourceItem(resolved.controllerActor, resolved.sourceItem);
    const anchorUuid = concentration?.uuid ?? (resolved.anchorEffect?.parent?.documentName === "Actor"
      ? resolved.anchorEffect.uuid
      : null);

    // If D&D5e fell back to Hex.Item.ActiveEffect as the origin, restore the
    // native concentration dependency. This makes concentration cleanup work
    // exactly as it does when the original usage card carried the anchor.
    if (concentration) {
      data.origin = concentration.uuid;
      foundry.utils.setProperty(data, "flags.dnd5e.dependentOn", concentration.uuid);
    }

    foundry.utils.setProperty(data, `flags.${MODULE_ID}.${BINDING_FLAG}`, {
      version: 1,
      sourceIdentifier: adapter.sourceIdentifier,
      controllerActorUuid: resolved.controllerActor.uuid ?? null,
      sourceItemUuid: resolved.sourceItem.uuid ?? null,
      anchorUuid
    });

    this.#record(resolved.controllerActor, {
      ruleId: RULE_ID,
      action: "Bound native target effect to source controller",
      sourceIdentifier: adapter.sourceIdentifier,
      targetActorUuid: effect?.parent?.uuid ?? null,
      anchorUuid,
      repairedConcentrationDependency: Boolean(concentration && originUuid !== concentration.uuid)
    });
  }

  static #resolveEffectSource(effect) {
    const binding = effect.getFlag?.(MODULE_ID, BINDING_FLAG)
      ?? effect.flags?.[MODULE_ID]?.[BINDING_FLAG]
      ?? null;
    if (binding?.controllerActorUuid && binding?.sourceItemUuid) {
      const controllerActor = this.#fromUuid(binding.controllerActorUuid, effect);
      const sourceItem = this.#fromUuid(binding.sourceItemUuid, controllerActor ?? effect);
      if (controllerActor?.documentName === "Actor" && sourceItem?.documentName === "Item") {
        return { controllerActor, sourceItem };
      }
    }

    const origin = this.#sourceFromUuid(effect.origin, effect);
    if (origin?.sourceItem) return origin;

    const dependent = effect.getFlag?.("dnd5e", "dependentOn");
    const dependency = this.#sourceFromUuid(dependent, effect);
    if (dependency?.sourceItem) return dependency;

    return null;
  }

  static #sourceFromUuid(uuid, relative) {
    const document = this.#fromUuid(uuid, relative);
    if (!document) return null;

    if (document.documentName === "ActiveEffect" && document.parent?.documentName === "Actor") {
      const actor = document.parent;
      const itemRef = document.getFlag?.("dnd5e", "item") ?? document.flags?.dnd5e?.item ?? {};
      const sourceItem = actor.items?.get?.(itemRef.id)
        ?? this.#fromUuid(itemRef.uuid, actor);
      return sourceItem ? { controllerActor: actor, sourceItem, anchorEffect: document } : null;
    }

    // Native D&D5e EffectApplicationElement uses the selected Item-embedded
    // ActiveEffect as origin whenever its ChatMessage cannot resolve a
    // concentration effect. This is the Hex shape v0.9.9l did not resolve.
    if (document.documentName === "ActiveEffect" && document.parent?.documentName === "Item") {
      const sourceItem = document.parent;
      const controllerActor = sourceItem.actor ?? sourceItem.parent;
      if (controllerActor?.documentName === "Actor") {
        return { controllerActor, sourceItem, anchorEffect: document };
      }
    }

    if (document.documentName === "Item" && document.actor) {
      return { controllerActor: document.actor, sourceItem: document, anchorEffect: null };
    }

    return null;
  }

  static #concentrationForSourceItem(actor, sourceItem) {
    if (!actor || !sourceItem) return null;
    const concentrating = CONFIG.DND5E?.specialStatusEffects?.CONCENTRATING
      ?? CONFIG.specialStatusEffects?.CONCENTRATING
      ?? "concentrating";
    const effects = Array.from(actor.concentration?.effects ?? actor.effects ?? []);
    return effects.find(candidate => {
      if (!candidate || candidate.disabled || candidate.isSuppressed) return false;
      if (concentrating && !candidate.statuses?.has?.(concentrating)) return false;
      const itemRef = candidate.getFlag?.("dnd5e", "item") ?? candidate.flags?.dnd5e?.item ?? {};
      return itemRef.id === sourceItem.id || itemRef.uuid === sourceItem.uuid;
    }) ?? null;
  }

  static #fromUuid(uuid, relative) {
    if (!uuid) return null;
    try {
      return globalThis.fromUuidSync?.(uuid, { relative, strict: false }) ?? null;
    } catch (_error) {
      return null;
    }
  }

  static #selectRiderActivity(actor, sourceItem, adapter) {
    if (adapter.upgradeIdentifier) {
      const upgrade = actor.items?.find?.(item => item.system?.identifier === adapter.upgradeIdentifier);
      const upgradedDamage = upgrade?.system?.activities?.find?.(activity => activity.type === "damage");
      if (upgradedDamage) return upgradedDamage;
    }
    return sourceItem.system?.activities?.find?.(activity => activity.type === "damage") ?? null;
  }

  static #record(actor, row) {
    const key = String(actor?.id ?? "");
    if (!key) return;
    const rows = this.#audit.get(key) ?? [];
    rows.push({ ...row, at: Date.now() });
    this.#audit.set(key, rows.slice(-50));
  }
}
