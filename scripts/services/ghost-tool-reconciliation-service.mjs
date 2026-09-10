import { MODULE_ID } from "../constants.mjs";

const OWNER_TYPES = new Set(["class", "subclass", "race", "background", "feat"]);

/**
 * Structural reconciliation for D&D5e TraitAdvancement Tool choices.
 *
 * D&D5e 5.3.3 materializes MappingField entries in system.tools while a Tool
 * choice is applied, but reversing that TraitAdvancement resets `.value` to 0
 * rather than deleting the mapping key. Character Builder treats those entries
 * as transaction residue only when provenance and structure both prove that it
 * is safe to do so.
 */
export class GhostToolReconciliationService {
  /**
   * Final Tool identities proven by local Advancement grants/choice ledgers on
   * the supplied Actor. This intentionally reads only final owner Items and
   * never treats a choice pool itself as proof that a Tool was selected.
   *
   * @param {Actor} actor
   * @returns {Set<string>}
   */
  static authorizedToolKeys(actor) {
    const keys = new Set();
    for (const owner of actor?.items ?? []) {
      if (!OWNER_TYPES.has(owner.type)) continue;
      const advancements = owner?._source?.system?.advancement
        ?? owner?.toObject?.()?.system?.advancement
        ?? owner?.system?.advancement
        ?? {};
      for (const advancement of this.#entries(advancements)) {
        if (String(advancement?.type ?? "") !== "Trait") continue;
        if (String(advancement?.configuration?.mode ?? "") === "mastery") continue;
        for (const token of this.#values(advancement?.configuration?.grants)) this.#collectToolKey(keys, token);
        for (const token of this.#values(advancement?.value?.chosen)) this.#collectToolKey(keys, token);
      }
    }
    return keys;
  }

  /**
   * Reconcile the completed Character Creation Draft against the live Actor's
   * pre-commit snapshot. Existing Tool entries are restored exactly; newly
   * materialized, unreferenced default-shaped zero-rank entries are removed.
   *
   * @param {Actor} draft
   * @param {object} draftSystem  Plain cloned draft system data to be committed.
   * @param {object} previousSystem  Plain cloned live Actor system before commit.
   * @returns {{system: object, removed: string[], restored: string[], preserved: string[]}}
   */
  static reconcileCreationSystem(draft, draftSystem, previousSystem) {
    const system = foundry.utils.deepClone(draftSystem ?? {});
    system.tools ??= {};
    const previousTools = foundry.utils.deepClone(previousSystem?.tools ?? {});
    const authorized = this.authorizedToolKeys(draft);
    const removed = [];
    const restored = [];
    const preserved = [];

    for (const [key, entry] of Object.entries(system.tools ?? {})) {
      if (Number(entry?.value ?? 0) !== 0) continue;
      if (authorized.has(key)) {
        preserved.push(key);
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(previousTools, key)) {
        system.tools[key] = foundry.utils.deepClone(previousTools[key]);
        restored.push(key);
        continue;
      }

      if (!this.isSafeResidualEntry(key, entry)) {
        preserved.push(key);
        continue;
      }
      delete system.tools[key];
      removed.push(key);
    }

    return { system, removed, restored, preserved };
  }

  /**
   * A zero-rank Tool entry is safe to classify as a native rollback residue
   * only when it contains no meaningful custom configuration beyond the
   * default Tool ability and empty roll bonuses.
   */
  static isSafeResidualEntry(key, entry) {
    if (!entry || Number(entry.value ?? 0) !== 0) return false;
    const raw = foundry.utils.deepClone(entry ?? {});
    delete raw.value;

    const expectedAbility = String(CONFIG.DND5E?.tools?.[key]?.ability ?? "int");
    if (Object.prototype.hasOwnProperty.call(raw, "ability")) {
      const ability = String(raw.ability ?? "");
      if (ability && ability !== expectedAbility) return false;
      delete raw.ability;
    }

    if (Object.prototype.hasOwnProperty.call(raw, "bonuses")) {
      if (this.#hasMeaningfulValue(raw.bonuses)) return false;
      delete raw.bonuses;
    }

    // Ignore only schema bookkeeping that can be serialized by Foundry as an
    // empty/default value. Unknown non-empty fields are treated as legitimate
    // custom configuration and are never deleted automatically.
    for (const value of Object.values(raw)) {
      if (this.#hasMeaningfulValue(value)) return false;
    }
    return true;
  }

  static async removeEntry(actor, key, options = {}) {
    if (!actor?.system?.tools || !Object.prototype.hasOwnProperty.call(actor.system.tools, key)) return false;
    await actor.update({ [`system.tools.-=${key}`]: null }, {
      characterBuilderGhostToolCleanup: true,
      ...options
    });
    return !Object.prototype.hasOwnProperty.call(actor.system?.tools ?? {}, key);
  }

  static label(key) {
    const config = CONFIG.DND5E?.tools?.[key];
    let source = null;
    if (config?.id && globalThis.fromUuidSync) {
      try { source = fromUuidSync(config.id, { strict: false }); } catch (_error) { source = null; }
    }
    const label = source?.name ?? config?.label ?? key;
    return game.i18n?.localize?.(label) ?? String(label);
  }

  static #collectToolKey(keys, token) {
    const parts = String(token ?? "").split(":");
    if (parts[0] !== "tool") return;
    const key = String(parts.at(-1) ?? "").trim();
    if (key) keys.add(key);
  }

  static #entries(value) {
    if (value instanceof Map) return [...value.values()];
    if (Array.isArray(value)) return value;
    return Object.values(value ?? {});
  }

  static #values(value) {
    if (value instanceof Set) return [...value];
    if (value instanceof Map) return [...value.values()];
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (typeof value === "object") return Object.values(value);
    return [value];
  }

  static #hasMeaningfulValue(value) {
    if (value == null || value === "" || value === false) return false;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value.trim() !== "" && value.trim() !== "0";
    if (Array.isArray(value)) return value.some(entry => this.#hasMeaningfulValue(entry));
    if (value instanceof Set) return [...value].some(entry => this.#hasMeaningfulValue(entry));
    if (value instanceof Map) return [...value.values()].some(entry => this.#hasMeaningfulValue(entry));
    if (typeof value === "object") return Object.values(value).some(entry => this.#hasMeaningfulValue(entry));
    return Boolean(value);
  }
}

export const GHOST_TOOL_CLEANUP_FLAG = `${MODULE_ID}.ghost-tool-cleanup`;
