import { MODULE_ID } from "../constants.mjs";
import { ContextualRollModifierService } from "./contextual-roll-modifier-service.mjs";
import { EffectLifecycleService } from "./effect-lifecycle-service.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RUNTIME_RULE_ID = "contextual-roll-modifiers";

// Source-specific knowledge is data, not runtime branching. The engine above
// remains generic; this registry only describes official documents whose
// Foundry implementation lacks the mechanical Active Effect declaration.
const OFFICIAL_EFFECT_ADAPTERS = Object.freeze([
  Object.freeze({
    id: "phb2024-blade-ward",
    source: Object.freeze({
      identifiers: Object.freeze(["blade-ward"]),
      compendiumTokens: Object.freeze(["phbsplBladeWard0"]),
      names: Object.freeze(["Blade Ward"]),
      itemType: "spell",
      rules: "2024"
    }),
    target: "self",
    concentration: true,
    modifiers: Object.freeze([
      Object.freeze({
        id: "incoming-attack-minus-1d4",
        label: "Blade Ward",
        rollTypes: Object.freeze(["attack"]),
        relation: "incoming",
        operation: "formula",
        formula: "-1d4",
        priority: 100
      })
    ])
  })
]);

/** Materializes official missing effect declarations into the generic runtime. */
export class NativeContextualEffectService {
  static #initialized = false;
  static #locks = new Map();
  static #audit = new Map();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => {
      void this.#materializeFromUse(activity, usageConfig, results).catch(error => {
        console.warn(`${MODULE_ID} | Official contextual effect materialization failed.`, error);
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
    return RulesAssistanceSettingsService.ruleEnabled(RUNTIME_RULE_ID);
  }

  static diagnostics(actor) {
    const key = String(actor?.id ?? actor ?? "");
    return (this.#audit.get(key) ?? []).map(row => ({ ...row }));
  }

  static async reconcileActor(actor, { reason = "manual" } = {}) {
    if (!actor || !this.enabled()) return [];
    const results = [];
    for (const concentration of this.#effects(actor).filter(effect => this.#isConcentrationEffect(effect))) {
      const item = this.#sourceItem(actor, concentration);
      const adapter = OFFICIAL_EFFECT_ADAPTERS.find(row => this.#matchesAdapter(item, row));
      if (!adapter || !adapter.concentration || adapter.target !== "self") continue;
      results.push(await this.#ensureEffect(actor, item, concentration, adapter, { reason }));
    }
    return results.filter(Boolean);
  }

  static async #materializeFromUse(activity, _usageConfig, results) {
    if (!this.enabled()) return;
    const item = activity?.item;
    const actor = activity?.actor;
    if (!item || !actor) return;
    const adapter = OFFICIAL_EFFECT_ADAPTERS.find(row => this.#matchesAdapter(item, row));
    if (!adapter) return;

    const concentration = EffectLifecycleService.concentrationEffectFromUsage(activity, results);
    if (adapter.concentration && !concentration) return;
    if (adapter.target !== "self") return;
    await this.#ensureEffect(actor, item, concentration, adapter, { reason: "post-use" });
  }

  static async #ensureEffect(actor, item, concentration, adapter, { reason } = {}) {
    const anchorUuid = concentration?.uuid ?? null;
    const key = `${actor.uuid ?? actor.id}|${adapter.id}|${anchorUuid ?? "none"}`;
    if (this.#locks.has(key)) return this.#locks.get(key);

    const operation = (async () => {
      const existing = this.#effects(actor).find(effect => {
        const source = effect.getFlag?.(MODULE_ID, "contextualEffect")?.source ?? null;
        return source?.adapterId === adapter.id && source?.anchorUuid === anchorUuid;
      });
      if (existing) {
        if (existing.disabled && typeof existing.update === "function") {
          await existing.update({ disabled: false, "flags.dnd5e.dependentOn": anchorUuid, origin: anchorUuid ?? item.uuid ?? null });
        }
        return existing;
      }

      const declaration = ContextualRollModifierService.effectDeclaration({
        modifiers: adapter.modifiers,
        lifecycle: {
          mode: adapter.concentration ? "concentration" : "duration",
          anchorUuid,
          controllerUuid: actor.uuid ?? null,
          sourceUuid: item.uuid ?? null,
          termination: adapter.concentration ? "native-dependent" : "native"
        },
        source: {
          adapterId: adapter.id,
          anchorUuid,
          itemUuid: item.uuid ?? null,
          itemIdentifier: item.system?.identifier ?? null
        }
      });

      const concentrationSource = concentration?.toObject?.() ?? concentration?._source ?? null;
      const duration = foundry.utils.deepClone(concentrationSource?.duration ?? concentration?.duration ?? {});
      const effectData = {
        name: item.name,
        img: item.img,
        disabled: false,
        transfer: false,
        origin: anchorUuid ?? item.uuid ?? null,
        duration,
        changes: [],
        flags: {
          [MODULE_ID]: { contextualEffect: declaration }
        }
      };

      const created = await EffectLifecycleService.createManagedEffect(actor, effectData, {
        mode: adapter.concentration ? "concentration" : "duration",
        anchorUuid,
        controllerUuid: actor.uuid ?? null,
        sourceUuid: item.uuid ?? null,
        termination: adapter.concentration ? "native-dependent" : "native"
      });
      this.#recordAudit(actor, {
        action: "Materialized official contextual effect",
        adapterId: adapter.id,
        sourceItemUuid: item.uuid ?? null,
        concentrationUuid: anchorUuid,
        effectUuid: created?.uuid ?? null,
        reason
      });
      return created;
    })().finally(() => {
      if (this.#locks.get(key) === operation) this.#locks.delete(key);
    });

    this.#locks.set(key, operation);
    return operation;
  }

  static #matchesAdapter(item, adapter) {
    if (!item || item.type !== adapter.source.itemType) return false;
    const rules = String(item.system?.source?.rules ?? "");
    if (adapter.source.rules && rules && rules !== adapter.source.rules) return false;

    const identifier = String(item.system?.identifier ?? "").trim().toLowerCase();
    if (adapter.source.identifiers.includes(identifier)) return true;

    const sourceId = String(item._stats?.compendiumSource ?? item.flags?.core?.sourceId ?? "");
    if (adapter.source.compendiumTokens.some(token => sourceId.includes(token))) return true;

    // Name is a last-resort fallback for imported PHB documents that predate
    // identifier metadata. The structural guards above prevent unrelated Items
    // with the same label from matching casually.
    const properties = item.system?.properties;
    const concentration = properties?.has?.("concentration") || properties?.includes?.("concentration");
    return adapter.source.names.includes(String(item.name ?? ""))
      && Boolean(concentration)
      && Number(item.system?.level ?? -1) === 0;
  }

  static #sourceItem(actor, concentration) {
    const data = concentration?.getFlag?.("dnd5e", "item") ?? concentration?.flags?.dnd5e?.item ?? {};
    return actor?.items?.get?.(data.id) ?? data.data ?? null;
  }

  static #isConcentrationEffect(effect) {
    const concentrating = CONFIG.DND5E?.specialStatusEffects?.CONCENTRATING
      ?? CONFIG.specialStatusEffects?.CONCENTRATING
      ?? "concentrating";
    return Boolean(effect?.statuses?.has?.(concentrating));
  }

  static #effects(actor) {
    if (!actor?.effects) return [];
    if (Array.isArray(actor.effects)) return actor.effects;
    if (Array.isArray(actor.effects.contents)) return actor.effects.contents;
    return [...actor.effects];
  }

  static #recordAudit(actor, entry) {
    const key = String(actor?.id ?? actor ?? "");
    if (!key) return;
    const rows = this.#audit.get(key) ?? [];
    rows.push({ ruleId: RUNTIME_RULE_ID, at: Date.now(), ...entry });
    this.#audit.set(key, rows.slice(-50));
  }
}
