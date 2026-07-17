import { MODULE_ID } from "../constants.mjs";

/**
 * Error raised when a source-native Advancement completed in a state that the
 * module cannot safely continue from. The Level Up application responds by
 * rebuilding the whole pending draft from the unchanged live Actor.
 */
export class StructuralLevelUpError extends Error {
  constructor(message, {
    title = "Level Up Must Be Restarted",
    choiceName = null,
    reason = null,
    diagnostic = null
  } = {}) {
    super(message);
    this.name = "StructuralLevelUpError";
    this.structuralLevelUp = true;
    this.title = title;
    this.choiceName = choiceName;
    this.reason = reason;
    this.diagnostic = diagnostic ?? message;
  }
}

/**
 * Defensive validation around the native D&D5e AdvancementManager. Native
 * Advancements remain authoritative for their own UI, while this service
 * verifies that the resulting temporary Actor is structurally safe before the
 * transaction may continue.
 */
export class NativeAdvancementValidationService {
  static async validate(draft, {
    state,
    beforeItemIds = new Set(),
    beforeAbilities = null,
    workflow = "Class Progression"
  } = {}) {
    const added = draft.items.filter(item => !beforeItemIds.has(item.id));
    this.#validateNonRepeatableDuplicates(draft, added, workflow);
    this.#validateExplicitRequirements(draft, added, state, workflow);
    await this.#validateNativePrerequisites(draft, added, state, workflow);
    this.#validateRequiredAdvancementCounts(draft, state, workflow, new Set(added.map(item => item.id)));
    this.#validateAbilityScoreAdvancements(draft, state, workflow, new Set(added.map(item => item.id)), beforeAbilities);
    return { addedItemIds: added.map(item => item.id) };
  }

  static #validateNonRepeatableDuplicates(draft, added, workflow) {
    const byKey = new Map();
    for (const item of draft.items) {
      const identifier = String(item.system?.identifier ?? "").trim();
      if (!identifier) continue;
      const key = `${item.type}:${identifier}`;
      const rows = byKey.get(key) ?? [];
      rows.push(item);
      byKey.set(key, rows);
    }

    for (const item of added) {
      // Equal spells and automatic class-feature grants can legitimately exist
      // through different acquisition origins. Duplicate rejection is limited
      // to player-selected feat-like choices (ASI/Feat, ItemChoice, managed
      // option replacement), where the source's repeatable flag is authoritative.
      if (item.type !== "feat" || !this.#isChoiceAcquisition(draft, item)) continue;
      const identifier = String(item.system?.identifier ?? "").trim();
      if (!identifier) continue;
      const repeatable = Boolean(item.system?.prerequisites?.repeatable);
      if (repeatable) continue;
      const duplicates = byKey.get(`${item.type}:${identifier}`) ?? [];
      if (duplicates.length <= 1) continue;
      throw new StructuralLevelUpError(
        `${item.name} cannot be selected again.`,
        {
          choiceName: item.name,
          reason: "This option is not repeatable and the character already has it.",
          diagnostic: `[Character Builder Level Up] ${draft.name} must not have taken ${item.name} before in order to take this feature during ${workflow}.`
        }
      );
    }
  }

  static #isChoiceAcquisition(draft, item) {
    if (item.getFlag(MODULE_ID, "managedOptionReplacement")) return true;
    const origin = String(item.getFlag("dnd5e", "advancementOrigin")
      ?? item.getFlag("dnd5e", "advancementRoot") ?? "");
    const [ownerId, advancementId] = origin.split(".");
    const owner = draft.items.get(ownerId);
    if (!owner || !advancementId) return false;
    const source = owner.toObject().system?.advancement ?? {};
    const rows = Array.isArray(source)
      ? source
      : Object.values(source);
    const advancement = rows.find(row => String(row?._id ?? row?.id ?? "") === advancementId)
      ?? (Array.isArray(source) ? null : source[advancementId]);
    return ["ItemChoice", "AbilityScoreImprovement"].includes(String(advancement?.type ?? ""));
  }

  static #validateExplicitRequirements(draft, added, state, workflow) {
    for (const item of added) {
      const requirement = String(item.system?.requirements ?? "").trim();
      if (!requirement) continue;
      const missing = this.#missingRequirement(draft, requirement, state);
      if (!missing) continue;
      throw new StructuralLevelUpError(
        `${item.name} cannot be selected.`,
        {
          choiceName: item.name,
          reason: `Missing prerequisite: ${missing}.`,
          diagnostic: `[Character Builder Level Up] ${draft.name} failed ${item.name} requirement during ${workflow}: ${missing}.`
        }
      );
    }
  }

  static async #validateNativePrerequisites(draft, added, state, workflow) {
    for (const item of added) {
      const validator = item.system?.validatePrerequisites;
      if (typeof validator !== "function") continue;
      try {
        await validator.call(item.system, draft, {
          level: Number(state?.targetCharacterLevel ?? draft.system?.details?.level ?? 0),
          showMessage: false,
          throwError: true
        });
      } catch (error) {
        throw new StructuralLevelUpError(
          `${item.name} cannot be selected.`,
          {
            choiceName: item.name,
            reason: this.#cleanNativeMessage(error?.message) || "One or more prerequisites are not satisfied.",
            diagnostic: `[Character Builder Level Up] Native prerequisite validation failed for ${item.name} during ${workflow}: ${error?.message ?? error}`
          }
        );
      }
    }
  }

  static #validateRequiredAdvancementCounts(draft, state, workflow, addedItemIds = new Set()) {
    const classIdentifier = String(state?.selectedClassIdentifier ?? "");
    const targetClassLevel = Number(state?.targetClassLevel ?? 0);
    if (!classIdentifier || !targetClassLevel) return;

    for (const owner of draft.items) {
      if (!["class", "subclass", "feat"].includes(owner.type)) continue;
      // A nested ItemChoice at level 0 is part of the creation of that feature
      // (for example Lessons of the First Ones or Blessed Warrior). Existing
      // features are not revalidated as if they had just been acquired on every
      // later class level; their later maintenance is handled by explicit
      // Level Up replacement flows.
      if (owner.type === "feat" && !addedItemIds.has(owner.id)) continue;
      if (owner.type === "class" && owner.system?.identifier !== classIdentifier) continue;
      if (owner.type === "subclass") {
        const parent = owner.system?.classIdentifier ?? owner.system?.class?.identifier ?? owner.system?.class;
        if (parent && parent !== classIdentifier) continue;
      }

      const advancements = owner.toObject().system?.advancement ?? {};
      const advancementRows = Array.isArray(advancements)
        ? advancements.map((advancement, index) => [advancement._id ?? String(index), advancement])
        : Object.entries(advancements);
      for (const [advancementId, advancement] of advancementRows) {
        if (state?.multiclass && advancement?.classRestriction === "primary") continue;
        if (advancement?.type === "ItemChoice") {
          const choices = advancement.configuration?.choices ?? {};
          const row = choices[String(targetClassLevel)] ?? choices["0"] ?? null;
          const expected = Number(row?.count ?? 0);
          if (!expected) continue;

          // ItemChoices nested inside a newly-created feature use level 0. Class
          // and subclass ItemChoices use the actual class level as their key.
          const addedNode = advancement.value?.added ?? {};
          const selected = owner.type === "feat"
            ? this.#countEmbeddedIds(addedNode, draft)
            : this.#countEmbeddedIds(addedNode[String(targetClassLevel)] ?? addedNode, draft);
          if (selected >= expected) continue;
          this.#throwIncomplete(owner, advancementId, advancement, expected, selected, workflow);
        }

        if (advancement?.type === "Trait") {
          const level = Number(advancement.level ?? 0);
          if (owner.type !== "feat" && level !== targetClassLevel) continue;
          const expected = (advancement.configuration?.choices ?? [])
            .reduce((sum, choice) => sum + Number(choice?.count ?? 0), 0);
          if (!expected) continue;
          const grants = new Set(this.#collectionValues(advancement.configuration?.grants).map(String));
          const selected = new Set(this.#collectionValues(advancement.value?.chosen).map(String)
            .filter(value => value && !grants.has(value))).size;
          if (selected >= expected) continue;
          this.#throwIncomplete(owner, advancementId, advancement, expected, selected, workflow);
        }
      }
    }
  }

  static #validateAbilityScoreAdvancements(draft, state, workflow, addedItemIds, beforeAbilities) {
    const classIdentifier = String(state?.selectedClassIdentifier ?? "");
    const targetClassLevel = Number(state?.targetClassLevel ?? 0);
    for (const owner of draft.items) {
      if (!['class', 'subclass', 'feat'].includes(owner.type)) continue;
      if (owner.type === 'feat' && !addedItemIds.has(owner.id)) continue;
      if (owner.type === 'class' && owner.system?.identifier !== classIdentifier) continue;
      if (owner.type === 'subclass') {
        const parent = owner.system?.classIdentifier ?? owner.system?.class?.identifier ?? owner.system?.class;
        if (parent && parent !== classIdentifier) continue;
      }
      const raw = owner.toObject().system?.advancement ?? {};
      const rows = Array.isArray(raw)
        ? raw.map((advancement, index) => [advancement._id ?? String(index), advancement])
        : Object.entries(raw);
      for (const [advancementId, advancement] of rows) {
        if (advancement?.type !== 'AbilityScoreImprovement') continue;
        if (state?.multiclass && advancement?.classRestriction === 'primary') continue;
        const level = Number(advancement.level ?? 0);
        if (owner.type !== 'feat' && level !== targetClassLevel) continue;
        const title = advancement.title || owner.name || 'Ability Score Improvement';
        const value = advancement.value ?? {};
        const points = Number(advancement.configuration?.points ?? 0);
        if (!['asi', 'feat'].includes(String(value.type ?? ''))) {
          throw new StructuralLevelUpError(`${title} was not completed safely.`, {
            choiceName: title,
            reason: 'The native Advancement did not record an Ability Score Improvement or feat choice.',
            diagnostic: `[Character Builder Level Up] ${owner.name}.${advancementId} has no completed ASI/feat value during ${workflow}.`
          });
        }
        if (value.type === 'feat') {
          const count = this.#countEmbeddedIds(value.feat ?? {}, draft);
          if (count < 1) this.#throwIncomplete(owner, advancementId, advancement, 1, count, workflow);
          continue;
        }
        if (points > 0) {
          const assigned = Object.values(value.assignments ?? {}).reduce((sum, amount) => sum + Math.max(0, Number(amount ?? 0)), 0);
          if (assigned < points) this.#throwIncomplete(owner, advancementId, advancement, points, assigned, workflow);
        }
        const fixed = advancement.configuration?.fixed ?? {};
        const fixedEntries = Object.entries(fixed).filter(([, amount]) => Number(amount ?? 0) > 0);
        if (!fixedEntries.length || !beforeAbilities) continue;
        const maximum = Number(advancement.configuration?.max ?? 20);
        for (const [ability, amount] of fixedEntries) {
          const before = Number(beforeAbilities?.[ability]?.value ?? 0);
          const expected = Math.min(maximum, before + Number(amount));
          const actual = Number(draft.system?.abilities?.[ability]?.value ?? 0);
          if (actual >= expected) continue;
          throw new StructuralLevelUpError(`${title} was not applied safely.`, {
            choiceName: title,
            reason: `${String(ability).toUpperCase()} should be at least ${expected}, but the temporary Actor records ${actual}.`,
            diagnostic: `[Character Builder Level Up] ${owner.name}.${advancementId} fixed ASI failed during ${workflow}: ${ability} ${before} + ${amount}, expected ${expected}, found ${actual}.`
          });
        }
      }
    }
  }

  static #throwIncomplete(owner, advancementId, advancement, expected, selected, workflow) {
    const title = advancement.title || owner.name || 'Required Advancement choice';
    throw new StructuralLevelUpError(`${title} was not completed safely.`, {
      choiceName: title,
      reason: `Expected ${expected} selection${expected === 1 ? '' : 's'}, but only ${selected} valid selection${selected === 1 ? ' was' : 's were'} recorded.`,
      diagnostic: `[Character Builder Level Up] ${owner.name}.${advancementId} is incomplete during ${workflow}: expected ${expected}, found ${selected}.`
    });
  }

  static #collectionValues(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return [...value];
    if (typeof value.values === 'function') return [...value.values()];
    if (typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length && entries.every(([, selected]) => typeof selected === 'boolean')) {
        return entries.filter(([, selected]) => selected).map(([key]) => key);
      }
      return Object.values(value);
    }
    return [];
  }

  static #countEmbeddedIds(value, draft) {
    const ids = new Set();
    const walk = node => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      for (const [key, nested] of Object.entries(node)) {
        if (draft.items.get(key)) ids.add(key);
        walk(nested);
      }
    };
    walk(value);
    return ids.size;
  }

  static #missingRequirement(draft, requirement, state) {
    const normalized = requirement.toLowerCase();
    const armor = new Set(Array.from(draft.system?.traits?.armorProf?.value ?? []));
    const weapons = new Set(Array.from(draft.system?.traits?.weaponProf?.value ?? []));
    const identifiers = new Set(draft.items.map(item => String(item.system?.identifier ?? "")).filter(Boolean));

    const armorChecks = [
      [/medium armor training/i, "med", "Medium Armor Training"],
      [/heavy armor training/i, "hvy", "Heavy Armor Training"],
      [/light armor training/i, "lgt", "Light Armor Training"],
      [/shield training/i, "shl", "Shield Training"]
    ];
    for (const [pattern, key, label] of armorChecks) {
      if (pattern.test(requirement) && !armor.has(key)) return label;
    }

    if (/martial weapon training/i.test(requirement) && !weapons.has("mar")) return "Martial Weapon Training";
    if (/simple weapon training/i.test(requirement) && !weapons.has("sim")) return "Simple Weapon Training";

    if (/spellcasting or pact magic/i.test(requirement)
      && !identifiers.has("spellcasting") && !identifiers.has("pact-magic")) {
      return "Spellcasting or Pact Magic feature";
    }
    if (/\bspellcasting\b/i.test(requirement) && !/or pact magic/i.test(requirement)
      && !identifiers.has("spellcasting")) return "Spellcasting feature";
    if (/\bpact magic\b/i.test(requirement) && !/spellcasting or/i.test(requirement)
      && !identifiers.has("pact-magic")) return "Pact Magic feature";

    const levelMatch = normalized.match(/level\s+(\d+)\+?/i);
    if (levelMatch && Number(state?.targetCharacterLevel ?? 0) < Number(levelMatch[1])) {
      return `Character Level ${levelMatch[1]}`;
    }
    return null;
  }

  static #cleanNativeMessage(message) {
    return String(message ?? "")
      .replace(/^\[[^\]]+\]\s*/, "")
      .replace(/^.*? must /i, "The character must ")
      .trim();
  }
}
