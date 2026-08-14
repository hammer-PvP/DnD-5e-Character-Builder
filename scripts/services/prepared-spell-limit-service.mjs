import { MODULE_ID, SPELL_ACCESS_MODELS } from "../constants.mjs";
import { ClassProgressionGuard } from "./class-progression-guard.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";

const PREPARED = SpellPreparationPolicyService.PREPARED;
const ALWAYS_PREPARED = SpellPreparationPolicyService.ALWAYS_PREPARED;

/**
 * Enforces normal day-to-day prepared-spell limits without treating spell
 * preparation as build provenance. The service only manages ordinary prepared
 * state (1). Always Prepared and feature-granted spells are never counted or
 * auto-unprepared.
 */
export class PreparedSpellLimitService {
  /**
   * Decide whether an ordinary unprepared spell may be prepared right now.
   * Unprepare is always legal and unknown/ambiguous provenance is never blocked.
   */
  static mayPrepare(actor, spell) {
    if (!actor || spell?.type !== "spell") return { allowed: true };
    const state = Number(spell.system?.prepared ?? 0);
    if (state === PREPARED || state === ALWAYS_PREPARED) return { allowed: true };
    if (Number(spell.system?.level ?? 0) <= 0) return { allowed: true };

    const context = this.classContextForSpell(actor, spell);
    if (!context?.limit) return { allowed: true };

    const prepared = this.normalPreparedSpells(actor, context.cls);
    if (prepared.length < context.limit) {
      return {
        allowed: true,
        classItemId: context.cls.id,
        className: context.cls.name,
        current: prepared.length,
        limit: context.limit
      };
    }

    return {
      allowed: false,
      classItemId: context.cls.id,
      className: context.cls.name,
      current: prepared.length,
      limit: context.limit,
      message: `${context.cls.name} prepared spell limit reached (${prepared.length}/${context.limit}). Unprepare another spell before preparing this one.`
    };
  }

  /**
   * Resolve the daily-preparation class that owns a spell. Character Builder
   * provenance is preferred. Ambiguous legacy spells are intentionally left
   * alone rather than guessed into a class bucket.
   */
  static classContextForSpell(actor, spell) {
    if (!actor || spell?.type !== "spell" || this.#excludedGrant(spell)) return null;
    const flags = spell.flags?.[MODULE_ID] ?? {};
    let cls = flags.classItemId ? actor.items?.get?.(flags.classItemId) : null;

    const classIdentifier = String(flags.classIdentifier ?? "").trim();
    if (!cls && classIdentifier) cls = this.#classByIdentifier(actor, classIdentifier);

    // D&D5e 5.3 derives classIdentifier from system.sourceItem, including
    // subclass parentage. Prefer that native association when available so
    // Sheet Integrity also works for class-owned spells not created by CB.
    const nativeClassIdentifier = String(spell.system?.classIdentifier ?? "").trim();
    if (!cls && nativeClassIdentifier) cls = this.#classByIdentifier(actor, nativeClassIdentifier);

    const sourceItem = String(spell.system?.sourceItem ?? "").trim();
    const sourceMatch = /^class:([^:]+)$/i.exec(sourceItem);
    if (!cls && sourceMatch?.[1]) cls = this.#classByIdentifier(actor, sourceMatch[1]);

    if (!cls || cls.type !== "class" || !this.#usesDailyPreparation(cls)) return null;
    const limit = this.maxPrepared(cls);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    return { cls, limit };
  }

  /** Get all ordinary prepared spells that count against one class limit. */
  static normalPreparedSpells(actor, cls) {
    if (!actor || !cls) return [];
    return [...(actor.items ?? [])].filter(spell => {
      if (spell?.type !== "spell") return false;
      if (Number(spell.system?.level ?? 0) <= 0) return false;
      if (Number(spell.system?.prepared ?? 0) !== PREPARED) return false;
      if (this.#excludedGrant(spell)) return false;
      return this.#belongsToClass(actor, spell, cls);
    });
  }

  /**
   * Resolve the current prepared-spell limit. D&D5e's own prepared value is
   * authoritative when available because it evaluates the class preparation
   * formula against the live Actor. ScaleValue is retained as a conservative
   * fallback for exported/test data where derived fields are not serialized.
   */
  static maxPrepared(cls) {
    const nativeMax = Number(cls?.system?.spellcasting?.preparation?.max);
    if (Number.isFinite(nativeMax) && nativeMax > 0) return Math.max(0, Math.trunc(nativeMax));

    const level = Math.max(0, Number(cls?.system?.levels ?? 0));
    if (!level) return 0;
    const advancements = Object.values(cls?.system?.advancement ?? {});
    const scaleAdvancement = advancements.find(advancement => {
      if (advancement?.type !== "ScaleValue") return false;
      const identifier = String(advancement.configuration?.identifier ?? "").trim().toLowerCase();
      const title = String(advancement.title ?? "").trim().toLowerCase();
      return identifier === "max-prepared" || title.includes("max prepared");
    });
    const scale = scaleAdvancement?.configuration?.scale ?? {};
    let bestLevel = -1;
    let value = 0;
    for (const [rawLevel, row] of Object.entries(scale)) {
      const rowLevel = Number(rawLevel);
      const rowValue = Number(row?.value ?? row);
      if (!Number.isFinite(rowLevel) || !Number.isFinite(rowValue) || rowLevel > level || rowLevel < bestLevel) continue;
      bestLevel = rowLevel;
      value = rowValue;
    }
    return Math.max(0, Math.trunc(value));
  }

  /**
   * Reconcile one Actor when the GM activates the rule. Excess ordinary spells
   * are unprepared from highest spell level to lowest, and within the same
   * level from the bottom of the Actor's current Item sort order upward.
   */
  static async reconcileActor(actor) {
    if (!ClassProgressionGuard.isProtectedActor(actor)) return { actorId: actor?.id ?? null, changed: 0, classes: [] };
    const classes = [...(actor.items ?? [])].filter(item => item?.type === "class" && this.#usesDailyPreparation(item));
    const updates = [];
    const details = [];

    for (const cls of classes) {
      const limit = this.maxPrepared(cls);
      if (!limit) continue;
      const prepared = this.normalPreparedSpells(actor, cls);
      const excess = Math.max(0, prepared.length - limit);
      if (!excess) continue;

      const toUnprepare = [...prepared]
        .sort((a, b) => Number(b.system?.level ?? 0) - Number(a.system?.level ?? 0)
          || Number(b.sort ?? 0) - Number(a.sort ?? 0)
          || String(b.name ?? "").localeCompare(String(a.name ?? ""), game.i18n?.lang))
        .slice(0, excess);

      for (const spell of toUnprepare) updates.push({ _id: spell.id, "system.prepared": SpellPreparationPolicyService.UNPREPARED });
      details.push({
        classItemId: cls.id,
        className: cls.name,
        limit,
        before: prepared.length,
        removed: toUnprepare.map(spell => ({ id: spell.id, name: spell.name, level: Number(spell.system?.level ?? 0) }))
      });
    }

    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, {
        characterBuilderPlayerSheetIntegrity: true,
        characterBuilderPreparedSpellLimitReconcile: true
      });
    }
    return { actorId: actor.id, actorName: actor.name, changed: updates.length, classes: details };
  }

  /** Reconcile all live player-owned character Actors after rule activation. */
  static async reconcileWorld() {
    if (!game.user?.isGM) return { actors: 0, changed: 0, results: [] };
    const candidates = [...(game.actors ?? [])].filter(actor => ClassProgressionGuard.isProtectedActor(actor) && this.#hasPlayerOwner(actor));
    const results = [];
    let changed = 0;
    for (const actor of candidates) {
      try {
        const result = await this.reconcileActor(actor);
        results.push(result);
        changed += Number(result.changed ?? 0);
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not reconcile prepared-spell limits for ${actor.name}.`, error);
      }
    }
    return { actors: candidates.length, changed, results };
  }

  static #usesDailyPreparation(cls) {
    const identifier = String(cls?.system?.identifier ?? "").trim().toLowerCase();
    if (!identifier) return false;
    return SPELL_ACCESS_MODELS.fullList.has(identifier) || SPELL_ACCESS_MODELS.spellbook.has(identifier);
  }

  static #excludedGrant(spell) {
    if (Number(spell?.system?.prepared ?? 0) === ALWAYS_PREPARED) return true;
    const flags = spell?.flags?.[MODULE_ID] ?? {};
    if (flags.featureGrantedSpell === true || Array.isArray(flags.featureSpellOwners) && flags.featureSpellOwners.length > 0) return true;
    const advancement = String(spell?.flags?.dnd5e?.advancementOrigin ?? spell?.flags?.dnd5e?.advancementRoot ?? "").trim();
    return Boolean(advancement && flags.classSpellAccess !== true);
  }

  static #classByIdentifier(actor, identifier) {
    const normalized = String(identifier ?? "").trim().toLowerCase();
    if (!normalized) return null;
    return [...(actor?.items ?? [])].find(item => item?.type === "class"
      && String(item.system?.identifier ?? "").trim().toLowerCase() === normalized) ?? null;
  }

  static #belongsToClass(actor, spell, cls) {
    const flags = spell.flags?.[MODULE_ID] ?? {};
    if (flags.classItemId) return String(flags.classItemId) === String(cls.id);
    const classIdentifier = String(cls.system?.identifier ?? "").trim().toLowerCase();
    if (flags.classIdentifier) return String(flags.classIdentifier).trim().toLowerCase() === classIdentifier;
    if (spell.system?.classIdentifier) return String(spell.system.classIdentifier).trim().toLowerCase() === classIdentifier;
    const sourceItem = String(spell.system?.sourceItem ?? "").trim().toLowerCase();
    if (sourceItem) return sourceItem === `class:${classIdentifier}`;

    // A missing owner on an otherwise modern CB spell is ambiguous. Do not
    // count it against a class or auto-unprepare it; Character Validation owns
    // provenance repair for that case.
    return false;
  }

  static #hasPlayerOwner(actor) {
    const users = [...(game.users ?? [])].filter(user => !user?.isGM);
    return users.some(user => {
      try { return actor.testUserPermission?.(user, "OWNER") === true; }
      catch (_error) { return Number(actor.ownership?.[user.id] ?? actor.ownership?.default ?? 0) >= 3; }
    });
  }
}
