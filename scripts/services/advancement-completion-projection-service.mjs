import { MODULE_ID } from "../constants.mjs";
import { advancementName, readAdvancementRecords } from "../utils/advancement-utils.mjs";
import { effectiveWarcraftAdvancements } from "./warcraft-progression-service.mjs";

/**
 * Read-only completeness checks for the Builder's active transaction.
 * This is not a sheet validator: it cannot clone/repair old Actors or replay
 * missing grants. Ambiguous ownership is deliberately not a commit blocker.
 * All checks derive from the same native sources and Advancement receipts
 * used by Character Creation and Level Up.
 */
export class AdvancementCompletionProjectionService {
  static async scan(actor, registry) {
    const issues = [];
    const owners = actor.items.filter(item => ["class", "subclass", "race", "background", "feat"].includes(item.type));
    for (const owner of owners) {
      const source = await this.#source(owner, registry);
      if (!source) continue;
      const sourceAdvancements = await effectiveWarcraftAdvancements(actor, owner, source, registry)
        ?? source.toObject().system?.advancement ?? {};
      const localAdvancements = readAdvancementRecords(owner);
      const level = this.#level(owner, actor);
      for (const [id, advancement] of Object.entries(sourceAdvancements)) {
        if (!this.#active(advancement, level)) continue;
        const local = localAdvancements[id] ?? this.#equivalent(advancement, localAdvancements);
        const name = advancementName(advancement, owner.name);
        const report = (kind, expected, actual, token = "") => {
          if (actual >= expected) return;
          issues.push({
            kind, title: `${owner.name} — ${name} Incomplete`,
            data: { ownerId: owner.id, sourceAdvancementId: id, expected, actual, token }
          });
        };
        if (advancement.type === "Subclass" && owner.type === "class") {
          const hasSubclass = actor.items.some(item => item.type === "subclass"
            && String(item.system?.classIdentifier ?? item.system?.class?.identifier ?? item.system?.class ?? "")
              === String(owner.system?.identifier ?? ""));
          report("subclass-entitlement-incomplete", 1, Number(hasSubclass));
        } else if (advancement.type === "ItemChoice") {
          const expected = Object.entries(advancement.configuration?.choices ?? {})
            .reduce((n, [atLevel, choice]) => n + (Number(atLevel) <= level
              ? Math.max(0, Number(choice?.count ?? 0)) : 0), 0);
          if (!expected) continue;
          const type = String(advancement.configuration?.type ?? "");
          if (["weapon", "equipment", "consumable", "tool", "container", "loot"].includes(type)) continue;
          const selected = this.#selectedItems(actor, owner, local, type);
          const subtype = String(advancement.configuration?.restriction?.subtype ?? "");
          // Styles can also be provided through a legitimate class feat that
          // the system materializes outside the ItemChoice's original ID.
          if (subtype === "fightingStyle") {
            const styles = actor.items.filter(item => item.type === "feat"
              && item.system?.type?.subtype === "fightingStyle");
            report("fighting-style-incomplete", expected, Math.max(selected.size, Math.min(expected, styles.length)));
          } else if (subtype === "eldritchInvocation") {
            // The canonical Invocation scale is checked below; a replacement
            // may legitimately retire an old choice without a new Item ID.
            continue;
          } else {
            report("advancement-choice-incomplete", expected, selected.size);
          }
        } else if (advancement.type === "Trait") {
          if (!this.#traitApplies(owner, advancement, actor)) continue;
          const mode = String(advancement.configuration?.mode ?? "default");
          const pools = (advancement.configuration?.choices ?? [])
            .flatMap(choice => this.#values(choice?.pool)).map(String);
          const expected = (advancement.configuration?.choices ?? []).reduce((n, choice) =>
            n + (this.#values(choice?.pool).length ? Math.max(0, Number(choice?.count ?? 0)) : 0), 0);
          const localChoices = this.#values(local?.value?.chosen).filter(token =>
            pools.some(pool => this.#matches(token, pool)));
          if (mode === "mastery") {
            // A generic actor-wide mastery pool cannot satisfy a missing
            // level-4 choice: it may be the two earlier level-1 choices.
            // Require the native Advancement's own chosen entries.
            report("weapon-mastery-incomplete", expected, localChoices.length);
          } else if (expected) {
            // Require proof from the native choice ledger, not unrelated
            // proficiencies that may have a second class/background owner.
            report("trait-choice-incomplete", expected, new Set(localChoices).size);
          }
          for (const token of this.#values(advancement.configuration?.grants)) {
            const present = this.#traitPresent(actor, token);
            if (present === false) report("trait-grant-missing", 1, 0, String(token));
          }
          for (const token of localChoices) {
            const present = mode === "mastery"
              ? this.#values(actor.system?.traits?.weaponProf?.mastery?.value)
                .map(String).includes(String(token).split(":").at(-1))
              : this.#traitPresent(actor, token);
            if (present === false) report("trait-choice-mechanical-missing", 1, 0, String(token));
          }
        }
      }
      if (owner.type === "class" && owner.system?.identifier === "warlock") {
        const sourceSteps = Object.values(sourceAdvancements);
        const scale = sourceSteps.find(step => step.type === "ScaleValue"
          && step.configuration?.identifier === "invocations-known")?.configuration?.scale ?? {};
        let expected = 0;
        for (const [atLevel, row] of Object.entries(scale)) {
          if (Number(atLevel) <= level) expected = Math.max(expected, Number(row?.value ?? 0));
        }
        if (expected) {
          const invocationChoice = sourceSteps.find(step => step.type === "ItemChoice"
            && step.configuration?.restriction?.subtype === "eldritchInvocation");
          const pool = new Set((invocationChoice?.configuration?.pool ?? []).map(row => row?.uuid).filter(Boolean));
          const actual = actor.items.filter(item => item.type === "feat" && (
            item.system?.type?.subtype === "eldritchInvocation"
            || Boolean(item.getFlag?.(MODULE_ID, "invocationInstance"))
            || pool.has(item.getFlag?.("dnd5e", "sourceId"))
          )).length;
          if (actual < expected) issues.push({ kind: "warlock-invocation-entitlement",
            title: `Warlock — Eldritch Invocations Incomplete`,
            data: { ownerId: owner.id, expected, actual } });
        }
      }
    }
    return issues;
  }

  static async #source(owner, registry) {
    const candidates = [owner.getFlag?.("dnd5e", "sourceId"), owner._stats?.compendiumSource,
      owner.getFlag?.(MODULE_ID, "sourceSnapshot")?.uuid,
      owner.getFlag?.(MODULE_ID, "rulesSourceUuid")].filter(value => String(value ?? "").startsWith("Compendium."));
    const identifier = String(owner.system?.identifier ?? "");
    for (const row of registry.optionsForKey?.(owner.type, identifier) ?? []) candidates.push(row.uuid);
    for (const uuid of new Set(candidates)) {
      if (!registry.isUuidAllowed(uuid)) continue;
      try {
        const document = await fromUuid(uuid);
        if (document?.type === owner.type) return document;
      } catch { /* Source not currently available; do not infer a missing choice. */ }
    }
    return null;
  }

  static #equivalent(source, locals) {
    const sourceLevel = Number(source?.level ?? 0);
    const sourceName = String(advancementName(source, "")).trim().toLowerCase();
    return Object.values(locals).find(local => local.type === source.type
      && Number(local.level ?? 0) === sourceLevel
      && String(advancementName(local, "")).trim().toLowerCase() === sourceName) ?? null;
  }

  static #selectedItems(actor, owner, local, type) {
    if (!local) return new Set();
    const value = local.value ?? {};
    const added = new Map();
    for (const [level, row] of Object.entries(value.added ?? {})) {
      if (typeof row === "string") added.set(level, row);
      else for (const [id, uuid] of Object.entries(row ?? {})) added.set(id, uuid);
    }
    const replaced = new Map();
    for (const row of Object.values(value.replaced ?? {})) {
      if (row?.original && row?.replacement) replaced.set(row.original, row.replacement);
    }
    const active = new Set();
    for (const id of added.keys()) {
      let current = id;
      const seen = new Set();
      while (replaced.has(current) && !seen.has(current)) {
        seen.add(current);
        current = replaced.get(current);
      }
      if (seen.has(current)) continue;
      const item = actor.items.get(current);
      if (!item || (type && item.type !== type)) continue;
      const origin = item.getFlag?.("dnd5e", "advancementOrigin");
      if (origin && origin !== `${owner.id}.${local._id ?? local.id}`) continue;
      active.add(item.id);
    }
    return active;
  }

  static #traitApplies(owner, advancement, actor) {
    if (owner.type !== "class") return true;
    const restriction = String(advancement.classRestriction ?? advancement.configuration?.classRestriction ?? "");
    if (!restriction) return true;
    const classes = actor.items.filter(item => item.type === "class");
    const original = String(actor.system?.details?.originalClass ?? "").split(".").at(-1) ||
      (classes.length === 1 ? classes[0].id : "");
    if (!original) return false; // Multiclass ownership is ambiguous; do not block.
    return restriction === "primary" ? owner.id === original
      : restriction === "secondary" ? owner.id !== original : true;
  }

  static #traitPresent(actor, token) {
    const [family, ...parts] = String(token ?? "").split(":");
    const id = parts.at(-1);
    const values = rows => this.#values(rows).map(String);
    if (family === "skills") return Number(actor.system?.skills?.[id]?.value ?? 0) > 0;
    if (family === "saves") return Number(actor.system?.abilities?.[id]?.proficient ?? 0) > 0;
    if (family === "tool") return Number(actor.system?.tools?.[id]?.value ?? 0) > 0;
    if (family === "weapon") return values(actor.system?.traits?.weaponProf?.value).includes(id);
    if (family === "armor") return values(actor.system?.traits?.armorProf?.value).includes(id);
    if (family === "languages") return values(actor.system?.traits?.languages?.value).includes(id);
    if (["dr", "di", "dv", "ci"].includes(family)) return values(actor.system?.traits?.[family]?.value).includes(id);
    return null; // Unsupported families cannot be guessed into a blocker.
  }

  static #matches(value, pattern) {
    if (value === pattern) return true;
    if (!String(pattern).includes("*")) return false;
    const regexp = new RegExp(`^${String(pattern).split("*").map(row => row.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return regexp.test(String(value));
  }

  static #level(owner, actor) {
    if (owner.type === "class") return Number(owner.system?.levels ?? 0);
    const root = String(owner.getFlag?.("dnd5e", "advancementRoot")
      ?? owner.getFlag?.("dnd5e", "advancementOrigin") ?? "");
    const parent = actor.items.get(root.split(".")[0]);
    if (parent && parent.id !== owner.id) return this.#level(parent, actor);
    if (owner.type === "subclass") return Number(actor.items.find(item => item.type === "class"
      && item.system?.identifier === owner.system?.classIdentifier)?.system?.levels ?? 0);
    return actor.items.filter(item => item.type === "class").reduce((n, item) => n + Number(item.system?.levels ?? 0), 0);
  }

  static #active(advancement, level) {
    if (advancement.type === "ItemChoice") return Object.keys(advancement.configuration?.choices ?? {})
      .some(atLevel => Number(atLevel) <= level);
    return Number(advancement.level ?? 0) <= level;
  }

  static #values(value) {
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return [...value];
    if (!value) return [];
    if (typeof value.values === "function") return [...value.values()];
    if (typeof value === "object") return Object.values(value);
    return [];
  }
}
