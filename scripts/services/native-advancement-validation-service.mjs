import { MODULE_ID } from "../constants.mjs";
import { ManagedAdvancementRegistry } from "./managed-advancement-registry.mjs";

/**
 * Error raised when a source-native Advancement completed in a state that the
 * module cannot safely continue from. The Advancement attempt is rolled back
 * to its pre-choice Draft snapshot so the user can reopen the native choice
 * without discarding the selected Class or locked Hit Die result.
 */
export class StructuralLevelUpError extends Error {
  constructor(message, {
    title = "Native Choice Must Be Reopened",
    choiceName = null,
    reason = null,
    diagnostic = null,
    returnStep = "advancements"
  } = {}) {
    super(message);
    this.name = "StructuralLevelUpError";
    this.structuralLevelUp = true;
    this.title = title;
    this.choiceName = choiceName;
    this.reason = reason;
    this.diagnostic = diagnostic ?? message;
    this.returnStep = returnStep;
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
    workflow = "Class Progression",
    validateManagedCounts = workflow !== "Class Progression"
  } = {}) {
    const added = draft.items.filter(item => !beforeItemIds.has(item.id));
    this.#validateNonRepeatableDuplicates(draft, added, workflow);
    this.#validateExplicitRequirements(draft, added, state, workflow);
    await this.#validateNativePrerequisites(draft, added, state, workflow);
    this.#validateRequiredAdvancementCounts(draft, state, workflow, new Set(added.map(item => item.id)), { validateManagedCounts });
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
      // Spell documents are acquisition records, not non-repeatable feature
      // options. Independent native grants (for example Archfey Spells and
      // Steps of the Fey both delivering Misty Step) must coexist.
      if (item.type === "spell") continue;
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

  static #validateRequiredAdvancementCounts(draft, state, workflow, addedItemIds = new Set(), { validateManagedCounts = true } = {}) {
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
      for (const [advancementId, advancement] of Object.entries(advancements)) {
        if (advancement?.type !== "ItemChoice") continue;
        if (!validateManagedCounts && ManagedAdvancementRegistry.isManagedRaw(owner, advancement, { classIdentifier })) continue;
        const choices = advancement.configuration?.choices ?? {};
        // Nested feature choices use their own level-0 bucket. Class and
        // subclass choices must use only the current target-level bucket;
        // never substitute a historical or level-0 row for a missing current
        // choice.
        const row = owner.type === "feat"
          ? choices["0"] ?? null
          : choices[String(targetClassLevel)] ?? null;
        const expected = Number(row?.count ?? 0);
        if (!expected) continue;

        // ItemChoices nested inside a newly-created feature use level 0. Class
        // and subclass ItemChoices use the actual class level as their key.
        const addedNode = advancement.value?.added ?? {};
        const selected = owner.type === "feat"
          ? this.#countEmbeddedIds(addedNode, draft)
          : this.#countEmbeddedIds(addedNode[String(targetClassLevel)] ?? addedNode, draft);
        if (selected >= expected) continue;

        const title = advancement.title || owner.name || "Required Advancement choice";
        throw new StructuralLevelUpError(
          `${title} was not completed safely.`,
          {
            choiceName: title,
            reason: `Expected ${expected} selection${expected === 1 ? "" : "s"}, but only ${selected} valid selection${selected === 1 ? " was" : "s were"} recorded.`,
            diagnostic: `[Character Builder Level Up] ${owner.name}.${advancementId} is incomplete during ${workflow}: expected ${expected}, found ${selected}.`
          }
        );
      }
    }
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
