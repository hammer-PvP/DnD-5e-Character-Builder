import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "contextual-roll-modifiers";
const PROTOCOL_SYMBOL = Symbol.for("dnd5e.contextual-roll-modifiers.v1");
const SCHEMA_VERSION = 1;
const FLAG_PATH = `flags.${MODULE_ID}.contextualEffect`;

/**
 * Generic, source-agnostic contextual roll modifier runtime.
 *
 * Providers describe what an active effect does. The runtime only answers:
 *   - who owns the effect (roller or target),
 *   - what roll type is being built,
 *   - what relationship the effect has to that roll,
 *   - what ephemeral modification belongs on this roll.
 *
 * No modifier is persisted to the roller, Item, weapon, or target statistics.
 */
export class ContextualRollModifierService {
  static #initialized = false;
  static #providersRegistered = false;
  static #audit = new Map();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#ensureProtocol();
    this.#registerBuiltInProvider();

    // Capture target identity before the roll dialog is built. AttackActivity
    // only persists target AC in the process configuration; the modifier layer
    // needs the Actor identity without reading or exposing that AC.
    Hooks.on("dnd5e.preRoll", process => this.#captureContext(process));

    // Generic final roll-config hook. Every BasicRoll passes through this hook,
    // so the engine is not hard-coded to attacks even though Blade Ward is the
    // first official consumer.
    Hooks.on("dnd5e.postBuildRollConfig", (process, rollConfig, index) => {
      try {
        this.#applyContextualModifiers(process, rollConfig, index);
      } catch (error) {
        console.warn(`${MODULE_ID} | Contextual roll modifier application failed.`, error);
      }
    });
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  static api() {
    return this.#ensureProtocol().api;
  }

  static diagnostics(actor) {
    const key = String(actor?.id ?? actor ?? "");
    return (this.#audit.get(key) ?? []).map(row => ({ ...row }));
  }

  /**
   * Build module-owned effect metadata for a contextual modifier effect.
   * Other runtimes should prefer registerProvider rather than writing this flag
   * directly, but the method is public for Character Builder materializers.
   */
  static effectDeclaration({ modifiers = [], lifecycle = null, source = null } = {}) {
    return {
      schema: SCHEMA_VERSION,
      modifiers: modifiers.map(modifier => this.#normalizeModifier(modifier)).filter(Boolean),
      lifecycle: lifecycle && typeof lifecycle === "object" ? foundry.utils.deepClone(lifecycle) : null,
      source: source && typeof source === "object" ? foundry.utils.deepClone(source) : null
    };
  }

  static registerProvider(provider) {
    const state = this.#ensureProtocol();
    if (!provider || typeof provider !== "object" || typeof provider.readEffect !== "function") {
      throw new TypeError("A contextual roll modifier provider requires readEffect(effect).");
    }
    const id = String(provider.id ?? "").trim();
    if (!id) throw new TypeError("A contextual roll modifier provider requires a stable id.");
    state.providers.set(id, Object.freeze({ id, readEffect: provider.readEffect }));
    return () => state.providers.delete(id);
  }

  static #registerBuiltInProvider() {
    if (this.#providersRegistered) return;
    this.#providersRegistered = true;
    this.registerProvider({
      id: `${MODULE_ID}:active-effect-flags`,
      readEffect: effect => effect?.getFlag?.(MODULE_ID, "contextualEffect")
        ?? foundry.utils.getProperty(effect, FLAG_PATH)
        ?? null
    });
  }

  static #ensureProtocol() {
    const root = globalThis;
    let state = root[PROTOCOL_SYMBOL];
    if (!state || typeof state !== "object") {
      state = { version: SCHEMA_VERSION, providers: new Map(), api: null };
      root[PROTOCOL_SYMBOL] = state;
    }
    state.version = Math.max(SCHEMA_VERSION, Number(state.version ?? 0));
    state.providers ??= new Map();
    state.api = Object.freeze({
      version: SCHEMA_VERSION,
      symbol: "dnd5e.contextual-roll-modifiers.v1",
      registerProvider: provider => ContextualRollModifierService.registerProvider(provider),
      effectDeclaration: data => ContextualRollModifierService.effectDeclaration(data)
    });
    return state;
  }

  static #captureContext(process) {
    if (!process || typeof process !== "object") return;
    const targets = [];
    for (const token of game.user?.targets ?? []) {
      const actor = token?.actor;
      if (!actor?.uuid) continue;
      targets.push({ actorUuid: actor.uuid, tokenUuid: token.document?.uuid ?? token.uuid ?? null });
    }
    process.dnd5eCharacterBuilderContextualRoll ??= {};
    process.dnd5eCharacterBuilderContextualRoll.targets = targets;
    process.dnd5eCharacterBuilderContextualRoll.capturedAt = Date.now();
  }

  static #applyContextualModifiers(process, rollConfig, index) {
    if (!this.enabled() || !process || !rollConfig || Number(index ?? 0) !== 0) return;

    const rollType = this.#rollType(process);
    if (!rollType) return;
    const roller = this.#rollerActor(process);
    if (!roller) return;

    const targetRows = process.dnd5eCharacterBuilderContextualRoll?.targets ?? [];
    const targets = targetRows
      .map(row => fromUuidSync?.(row.actorUuid, { strict: false }))
      .map(doc => doc?.documentName === "Actor" ? doc : doc?.actor ?? null)
      .filter(Boolean);

    const candidates = [];
    candidates.push(...this.#effectModifiers(roller, {
      relation: "roller",
      rollType,
      roller,
      targets,
      process
    }));

    // Incoming/target modifiers require one unambiguous target. This protects
    // against accidentally carrying a target's defense effect into a roll made
    // against someone else or into a multi-target action whose individual roll
    // target is not known.
    if (targets.length === 1) {
      candidates.push(...this.#effectModifiers(targets[0], {
        relation: "target",
        rollType,
        roller,
        targets,
        process
      }));
    }

    if (!candidates.length) return;
    rollConfig.parts ??= [];
    rollConfig.data ??= {};
    rollConfig.options ??= {};
    const markers = rollConfig.options.dnd5eCharacterBuilderContextualModifiers ??= {};

    for (const candidate of candidates.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
      if (markers[candidate.id]) continue;
      if (!this.#applyOperation(process, rollConfig, candidate)) continue;
      markers[candidate.id] = true;
      this.#recordAudit(roller, {
        action: "Applied contextual roll modifier",
        modifierId: candidate.id,
        label: candidate.label,
        rollType,
        relation: candidate.relation,
        operation: candidate.operation,
        formula: candidate.formula ?? null,
        effectUuid: candidate.effectUuid,
        ownerActorUuid: candidate.ownerActorUuid
      });
    }
  }

  static #effectModifiers(owner, context) {
    const effects = this.#effects(owner).filter(effect => this.#effectActive(effect));
    const state = this.#ensureProtocol();
    const output = [];

    for (const effect of effects) {
      for (const provider of state.providers.values()) {
        let declaration = null;
        try {
          declaration = provider.readEffect(effect);
        } catch (error) {
          console.warn(`${MODULE_ID} | Contextual effect provider ${provider.id} failed.`, error);
          continue;
        }
        if (!declaration || Number(declaration.schema ?? SCHEMA_VERSION) > SCHEMA_VERSION) continue;
        for (const raw of declaration.modifiers ?? []) {
          const modifier = this.#normalizeModifier(raw);
          if (!modifier || !this.#modifierMatches(modifier, context)) continue;
          output.push({
            ...modifier,
            id: `${provider.id}:${effect.uuid ?? effect.id}:${modifier.id}`,
            effectUuid: effect.uuid ?? null,
            ownerActorUuid: owner.uuid ?? null,
            relation: context.relation
          });
        }
      }
    }
    return output;
  }

  static #modifierMatches(modifier, context) {
    const types = new Set(modifier.rollTypes ?? []);
    if (!types.has("*") && !types.has(context.rollType)) return false;

    const relation = modifier.relation;
    if (context.relation === "roller" && !["roller", "self", "outgoing"].includes(relation)) return false;
    if (context.relation === "target" && !["target", "incoming", "against-owner"].includes(relation)) return false;

    // Optional attack-type filters remain declarative and generic.
    const activity = context.process?.subject;
    if (modifier.activityTypes?.length && !modifier.activityTypes.includes(String(activity?.type ?? ""))) return false;
    const itemTypes = modifier.itemTypes ?? [];
    if (itemTypes.length && !itemTypes.includes(String(activity?.item?.type ?? ""))) return false;
    return true;
  }

  static #applyOperation(process, rollConfig, modifier) {
    switch (modifier.operation) {
      case "formula": {
        if (!modifier.formula) return false;
        rollConfig.parts.push(`(${modifier.formula})`);
        return true;
      }
      case "advantage":
      case "disadvantage": {
        const mode = modifier.operation === "advantage" ? 1 : -1;
        const current = Number(rollConfig.options?.advantageMode ?? 0);
        // Opposing modes cancel; identical modes remain idempotent.
        rollConfig.options.advantageMode = current === -mode ? 0 : (current || mode);
        return true;
      }
      default:
        return false;
    }
  }

  static #normalizeModifier(raw) {
    if (!raw || typeof raw !== "object") return null;
    const operation = String(raw.operation ?? "formula").trim().toLowerCase();
    if (!["formula", "advantage", "disadvantage"].includes(operation)) return null;
    const relation = String(raw.relation ?? "roller").trim().toLowerCase();
    const rollTypes = Array.isArray(raw.rollTypes)
      ? raw.rollTypes.map(type => String(type).trim().toLowerCase()).filter(Boolean)
      : [String(raw.rollType ?? "*").trim().toLowerCase() || "*"];
    const formula = raw.formula == null ? null : String(raw.formula).trim();
    if (operation === "formula" && !formula) return null;
    return {
      id: String(raw.id ?? foundry.utils.randomID?.(12) ?? crypto.randomUUID()).trim(),
      label: String(raw.label ?? "Contextual Modifier").trim(),
      rollTypes,
      relation,
      operation,
      formula,
      priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 100,
      activityTypes: Array.isArray(raw.activityTypes) ? raw.activityTypes.map(String) : [],
      itemTypes: Array.isArray(raw.itemTypes) ? raw.itemTypes.map(String) : []
    };
  }

  static #rollType(process) {
    const names = new Set((process.hookNames ?? []).map(name => String(name ?? "").toLowerCase()));
    if (names.has("attack")) return "attack";
    if (names.has("savingthrow") || names.has("save") || names.has("concentration")) return "save";
    if (names.has("abilitycheck") || names.has("check") || names.has("skill") || names.has("tool")) return "check";
    if (names.has("damage")) return "damage";
    if (names.has("healing") || names.has("heal")) return "healing";
    if (names.has("d20test")) return "d20test";
    return null;
  }

  static #rollerActor(process) {
    const subject = process?.subject;
    if (!subject) return null;
    if (subject.documentName === "Actor" || subject.type === "character" || subject.type === "npc") return subject;
    return subject.actor ?? subject.item?.actor ?? null;
  }

  static #effects(actor) {
    if (!actor?.effects) return [];
    if (Array.isArray(actor.effects)) return actor.effects;
    if (Array.isArray(actor.effects.contents)) return actor.effects.contents;
    return [...actor.effects];
  }

  static #effectActive(effect) {
    return Boolean(effect && !effect.disabled && !effect.isSuppressed && effect.active !== false);
  }

  static #recordAudit(actor, entry) {
    const key = String(actor?.id ?? actor ?? "");
    if (!key) return;
    const rows = this.#audit.get(key) ?? [];
    rows.push({ ruleId: RULE_ID, at: Date.now(), ...entry });
    this.#audit.set(key, rows.slice(-50));
  }
}

export const CONTEXTUAL_ROLL_MODIFIER_RULE_ID = RULE_ID;
export const CONTEXTUAL_ROLL_MODIFIER_SCHEMA_VERSION = SCHEMA_VERSION;
