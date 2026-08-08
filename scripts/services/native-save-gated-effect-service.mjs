import { MODULE_ID } from "../constants.mjs";
import { ContextualRollModifierService } from "./contextual-roll-modifier-service.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "contextual-roll-modifiers";
const FLAG_KEY = "nativeSaveGatedEffect";

/**
 * Declarative compatibility adapters for official effects whose source Item
 * contains (or describes) a failed-save debuff but whose Activity does not
 * expose that effect through D&D5e's native EffectApplicationElement tray.
 *
 * Runtime logic is source-agnostic. Bane is only the first source adapter.
 */
const OFFICIAL_SAVE_GATED_EFFECT_ADAPTERS = Object.freeze([
  Object.freeze({
    id: "phb2024-bane",
    source: Object.freeze({
      identifiers: Object.freeze(["bane"]),
      compendiumTokens: Object.freeze(["phbsplBane0"]),
      names: Object.freeze(["Bane"]),
      itemType: "spell",
      rules: "2024"
    }),
    activityTypes: Object.freeze(["save"]),
    effectNames: Object.freeze(["Bane"]),
    onSave: false,
    fallback: Object.freeze({
      name: "Bane",
      img: "icons/magic/control/voodoo-doll-pain-damage-tan.webp",
      modifiers: Object.freeze([
        Object.freeze({
          id: "bane-attack-minus-1d4",
          label: "Bane",
          rollTypes: Object.freeze(["attack"]),
          relation: "self",
          operation: "formula",
          formula: "-1d4",
          priority: 100
        }),
        Object.freeze({
          id: "bane-save-minus-1d4",
          label: "Bane",
          rollTypes: Object.freeze(["save"]),
          relation: "self",
          operation: "formula",
          formula: "-1d4",
          priority: 100
        })
      ])
    })
  })
]);

/**
 * Repairs save-gated effect application by feeding D&D5e's native chat tray.
 *
 * The GM remains responsible for deciding which targets failed and clicking
 * Apply Effect. D&D5e then owns creation of the target ActiveEffect and binds
 * concentrated applications with flags.dnd5e.dependentOn automatically.
 */
export class NativeSaveGatedEffectService {
  static #initialized = false;
  static #locks = new Map();
  static #audit = new Map();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    Hooks.on("createItem", item => {
      if (!game.user?.isGM || !item?.actor) return;
      void this.reconcileItem(item, { reason: "create-item" }).catch(error => {
        console.warn(`${MODULE_ID} | Save-gated effect reconciliation after Item creation failed.`, error);
      });
    });

    Hooks.on("updateItem", item => {
      if (!game.user?.isGM || !item?.actor) return;
      void this.reconcileItem(item, { reason: "update-item" }).catch(error => {
        console.warn(`${MODULE_ID} | Save-gated effect reconciliation after Item update failed.`, error);
      });
    });
  }

  static async ready() {
    if (!game.user?.isGM || !this.enabled()) return;
    for (const actor of game.actors?.filter?.(candidate => ["character", "npc"].includes(candidate.type)) ?? []) {
      await this.reconcileActor(actor, { reason: "ready" });
    }
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static diagnostics(actor) {
    const key = String(actor?.id ?? actor ?? "");
    return (this.#audit.get(key) ?? []).map(row => ({ ...row }));
  }

  static async reconcileActor(actor, { reason = "manual" } = {}) {
    if (!actor || !this.enabled()) return [];
    const results = [];
    for (const item of this.#items(actor)) {
      const row = await this.reconcileItem(item, { reason });
      if (row) results.push(row);
    }
    return results;
  }

  static async reconcileItem(item, { reason = "manual" } = {}) {
    if (!item?.actor || !this.enabled()) return null;
    const adapter = OFFICIAL_SAVE_GATED_EFFECT_ADAPTERS.find(row => this.#matchesAdapter(item, row));
    if (!adapter) return null;

    const key = `${item.uuid ?? item.id}|${adapter.id}`;
    if (this.#locks.has(key)) return this.#locks.get(key);

    const operation = (async () => {
      const activities = this.#activities(item).filter(activity => adapter.activityTypes.includes(String(activity?.type ?? "")));
      if (!activities.length) return null;

      let effect = this.#findEffectProfile(item, adapter);
      let createdFallback = false;
      if (!effect) {
        effect = await this.#createFallbackEffect(item, adapter);
        createdFallback = Boolean(effect);
      }
      if (!effect) return null;

      // If the official effect is already mechanically populated, leave its
      // changes alone. If it is an empty profile, attach the generic contextual
      // declaration so the applied copy still has mechanics.
      const hasNativeChanges = this.#changes(effect).length > 0;
      if (!hasNativeChanges && adapter.fallback?.modifiers?.length) {
        const existingDeclaration = effect.getFlag?.(MODULE_ID, "contextualEffect")
          ?? effect.flags?.[MODULE_ID]?.contextualEffect
          ?? null;
        if (!existingDeclaration) {
          const declaration = ContextualRollModifierService.effectDeclaration({
            modifiers: adapter.fallback.modifiers,
            lifecycle: {
              mode: "concentration",
              anchorUuid: null,
              controllerUuid: item.actor?.uuid ?? null,
              sourceUuid: item.uuid ?? null,
              termination: "native-dependent"
            },
            source: {
              adapterId: adapter.id,
              itemUuid: item.uuid ?? null,
              itemIdentifier: item.system?.identifier ?? null
            }
          });
          await effect.update({
            [`flags.${MODULE_ID}.contextualEffect`]: declaration,
            [`flags.${MODULE_ID}.${FLAG_KEY}`]: { adapterId: adapter.id, fallback: true }
          });
        }
      }

      let changedActivities = 0;
      for (const activity of activities) {
        const refs = this.#activityEffectRefs(activity);
        if (refs.some(ref => String(ref?._id ?? ref?.id ?? "") === String(effect.id))) continue;
        await activity.update({
          effects: [...refs.map(ref => this.#plainRef(ref)), { _id: effect.id, onSave: adapter.onSave === true }]
        });
        changedActivities++;
      }

      if (createdFallback || changedActivities) {
        this.#recordAudit(item.actor, {
          action: "Reconciled native save-gated effect application",
          adapterId: adapter.id,
          itemUuid: item.uuid ?? null,
          effectId: effect.id ?? null,
          createdFallback,
          linkedActivities: changedActivities,
          nativeChanges: hasNativeChanges,
          reason
        });
      }

      return { adapterId: adapter.id, effect, createdFallback, changedActivities, nativeChanges: hasNativeChanges };
    })().finally(() => {
      if (this.#locks.get(key) === operation) this.#locks.delete(key);
    });

    this.#locks.set(key, operation);
    return operation;
  }

  static #findEffectProfile(item, adapter) {
    const effects = this.#effects(item).filter(effect => effect && effect.type !== "enchantment" && effect.transfer !== true);
    const managed = effects.find(effect => effect.getFlag?.(MODULE_ID, FLAG_KEY)?.adapterId === adapter.id
      || effect.flags?.[MODULE_ID]?.[FLAG_KEY]?.adapterId === adapter.id);
    if (managed) return managed;

    const byName = effects.find(effect => adapter.effectNames.includes(String(effect.name ?? "")));
    if (byName) return byName;

    return effects.length === 1 ? effects[0] : null;
  }

  static async #createFallbackEffect(item, adapter) {
    if (!adapter.fallback) return null;
    const declaration = ContextualRollModifierService.effectDeclaration({
      modifiers: adapter.fallback.modifiers,
      lifecycle: {
        mode: "concentration",
        anchorUuid: null,
        controllerUuid: item.actor?.uuid ?? null,
        sourceUuid: item.uuid ?? null,
        termination: "native-dependent"
      },
      source: {
        adapterId: adapter.id,
        itemUuid: item.uuid ?? null,
        itemIdentifier: item.system?.identifier ?? null
      }
    });

    const data = {
      name: adapter.fallback.name ?? item.name,
      img: adapter.fallback.img ?? item.img,
      type: "base",
      disabled: false,
      transfer: false,
      changes: [],
      flags: {
        [MODULE_ID]: {
          contextualEffect: declaration,
          [FLAG_KEY]: { adapterId: adapter.id, fallback: true }
        }
      }
    };

    if (globalThis.ActiveEffect?.implementation?.create) {
      return ActiveEffect.implementation.create(data, { parent: item });
    }
    return (await item.createEmbeddedDocuments?.("ActiveEffect", [data]))?.[0] ?? null;
  }

  static #matchesAdapter(item, adapter) {
    if (!item || item.type !== adapter.source.itemType) return false;
    const rules = String(item.system?.source?.rules ?? "");
    if (adapter.source.rules && rules && rules !== adapter.source.rules) return false;

    const identifier = String(item.system?.identifier ?? "").trim().toLowerCase();
    if (adapter.source.identifiers.includes(identifier)) return true;

    const sourceId = String(item._stats?.compendiumSource
      ?? item.getFlag?.("dnd5e", "sourceId")
      ?? item.flags?.dnd5e?.sourceId
      ?? item.flags?.core?.sourceId
      ?? "");
    if (adapter.source.compendiumTokens.some(token => sourceId.includes(token))) return true;

    return adapter.source.names.includes(String(item.name ?? ""))
      && (!rules || rules === adapter.source.rules);
  }

  static #activityEffectRefs(activity) {
    const refs = activity?.toObject?.().effects ?? activity?.effects ?? [];
    if (Array.isArray(refs)) return refs;
    if (Array.isArray(refs?.contents)) return refs.contents;
    return [...(refs ?? [])];
  }

  static #plainRef(ref) {
    if (!ref) return ref;
    if (typeof ref.toObject === "function") return ref.toObject();
    return foundry.utils.deepClone(ref);
  }

  static #activities(item) {
    const activities = item?.system?.activities;
    if (!activities) return [];
    if (Array.isArray(activities)) return activities;
    if (Array.isArray(activities.contents)) return activities.contents;
    if (typeof activities.values === "function") return [...activities.values()];
    return Object.values(activities);
  }

  static #effects(item) {
    const effects = item?.effects;
    if (!effects) return [];
    if (Array.isArray(effects)) return effects;
    if (Array.isArray(effects.contents)) return effects.contents;
    return [...effects];
  }

  static #changes(effect) {
    const changes = effect?.changes ?? effect?._source?.changes ?? [];
    return Array.isArray(changes) ? changes : [...(changes ?? [])];
  }

  static #items(actor) {
    const items = actor?.items;
    if (!items) return [];
    if (Array.isArray(items)) return items;
    if (Array.isArray(items.contents)) return items.contents;
    return [...items];
  }

  static #recordAudit(actor, entry) {
    const key = String(actor?.id ?? actor ?? "");
    if (!key) return;
    const rows = this.#audit.get(key) ?? [];
    rows.push({ ruleId: RULE_ID, at: Date.now(), ...entry });
    this.#audit.set(key, rows.slice(-50));
  }
}
