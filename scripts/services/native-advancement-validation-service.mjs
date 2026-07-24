import { MODULE_ID } from "../constants.mjs";
import { ManagedAdvancementRegistry } from "./managed-advancement-registry.mjs";
import { NativeFeatChoiceGuard } from "./native-feat-choice-guard.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";

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
    returnStep = "advancements",
    concise = false,
    actionLabel = null
  } = {}) {
    super(message);
    this.name = "StructuralLevelUpError";
    this.structuralLevelUp = true;
    this.title = title;
    this.choiceName = choiceName;
    this.reason = reason;
    this.diagnostic = diagnostic ?? message;
    this.returnStep = returnStep;
    this.concise = concise;
    this.actionLabel = actionLabel;
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
    await SpellPreparationPolicyService.normalizeNewCantrips(draft, {
      beforeItemIds,
      updateOptions: { characterBuilderNativeAdvancementValidation: true }
    });
    const added = draft.items.filter(item => !beforeItemIds.has(item.id));
    this.#validateNonRepeatableDuplicates(draft, added, workflow);
    this.#validateProgressionChoicePolicy(draft, added, state, workflow);
    this.#validateEpicBoonEligibility(draft, added, state, workflow);
    this.#validateExplicitRequirements(draft, added, state, workflow);
    await this.#validateNativePrerequisites(draft, added, state, workflow);
    this.#validateRequiredAdvancementCounts(draft, state, workflow, new Set(added.map(item => item.id)), { validateManagedCounts });
    return { addedItemIds: added.map(item => item.id) };
  }

  static #validateNonRepeatableDuplicates(draft, added, workflow) {
    for (const item of added) {
      // Spell documents are acquisition records, not non-repeatable feature
      // options. Independent native grants must remain able to coexist.
      if (item.type === "spell" || NativeFeatChoiceGuard.isRepeatable(item)) continue;

      const sourceUuid = NativeFeatChoiceGuard.sourceUuid(item);
      const identifier = String(item.system?.identifier ?? "").trim();
      const subtype = String(item.system?.type?.subtype ?? "").trim();
      if (!sourceUuid && !identifier) continue;

      const duplicate = draft.items.find(other => {
        if (other.id === item.id || other.type !== item.type) return false;
        if (this.#isIndependentMulticlassFeature(draft, item, other)) return false;
        const otherSource = NativeFeatChoiceGuard.sourceUuid(other);
        if (sourceUuid && otherSource && sourceUuid === otherSource) return true;
        if (!identifier || identifier !== String(other.system?.identifier ?? "").trim()) return false;
        // Feats use identifier + subtype so mirrored PHB/SRD documents resolve
        // as the same option without relying on display name alone.
        if (item.type === "feat") {
          return subtype === String(other.system?.type?.subtype ?? "").trim();
        }
        return true;
      });
      if (!duplicate) continue;

      throw new StructuralLevelUpError(
        `${item.name} cannot be selected again.`,
        {
          choiceName: item.name,
          reason: "Already owned — this option cannot be selected more than once.",
          diagnostic: `[Character Builder Level Up] ${draft.name} already owns the non-repeatable ${item.name} during ${workflow}.`
        }
      );
    }
  }


  static #isIndependentMulticlassFeature(draft, item, other) {
    if (item.type !== "feat" || other.type !== "feat") return false;
    const itemCategory = String(item.system?.type?.value ?? "").trim();
    const otherCategory = String(other.system?.type?.value ?? "").trim();
    // Player-selectable Feats (including every +1 half-feat and Epic Boon)
    // remain globally non-repeatable. This exception is only for class-owned
    // progression resources such as each class's legitimate Spellcasting Item.
    if (itemCategory === "feat" || otherCategory === "feat") return false;
    const itemClass = this.#acquisitionClassIdentifier(draft, item);
    const otherClass = this.#acquisitionClassIdentifier(draft, other);
    return Boolean(itemClass && otherClass && itemClass !== otherClass);
  }

  static #acquisitionClassIdentifier(draft, item) {
    let current = item;
    const visited = new Set();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.type === "class") return String(current.system?.identifier ?? "") || null;
      if (current.type === "subclass") {
        const parent = current.system?.classIdentifier ?? current.system?.class?.identifier ?? current.system?.class;
        return parent ? String(parent) : null;
      }
      const grantOwnerId = current.getFlag(MODULE_ID, "itemGrantInstance")?.ownerItemId;
      const root = current.getFlag("dnd5e", "advancementRoot") ?? current.getFlag("dnd5e", "advancementOrigin");
      const [rootId] = String(root ?? "").split(".");
      const nextId = grantOwnerId || rootId;
      if (!nextId || nextId === current.id) break;
      current = draft.items.get(nextId);
    }
    const sourceItem = String(item.system?.sourceItem ?? "");
    const match = /^class:([^:]+)$/i.exec(sourceItem);
    return match?.[1] ?? null;
  }

  static #validateProgressionChoicePolicy(draft, added, state, workflow) {
    const settings = NativeFeatChoiceGuard.settings();
    if (settings.enableFeats && settings.enableAbilityScoreImprovement && settings.enableEpicBoons) return;

    const classIdentifier = String(state?.selectedClassIdentifier ?? "");
    const targetClassLevel = Number(state?.targetClassLevel ?? 0);
    if (!classIdentifier || !targetClassLevel) return;

    const addedById = new Map(added.map(item => [item.id, item]));
    for (const owner of draft.items) {
      if (!["class", "subclass"].includes(owner.type)) continue;
      if (owner.type === "class" && String(owner.system?.identifier ?? "") !== classIdentifier) continue;
      if (owner.type === "subclass") {
        const parent = owner.system?.classIdentifier ?? owner.system?.class?.identifier ?? owner.system?.class;
        if (parent && String(parent) !== classIdentifier) continue;
      }

      const advancements = owner.toObject().system?.advancement ?? {};
      for (const [advancementId, advancement] of Object.entries(advancements)) {
        if (advancement?.type !== "AbilityScoreImprovement") continue;
        if (Number(advancement.level ?? 0) !== targetClassLevel) continue;

        const choiceType = String(advancement.value?.type ?? "");
        if (choiceType === "asi" && !settings.enableAbilityScoreImprovement) {
          throw new StructuralLevelUpError(
            "ASI +2 is not allowed for this advancement.",
            {
              title: "ASI +2 Not Allowed",
              choiceName: "ASI +2",
              reason: settings.enableFeats
                ? "The GM does not allow ASI +2 for this advancement. Select a different Feat."
                : "The GM does not allow ASI +2 or Feats for this advancement. Select another permitted option.",
              diagnostic: `[Character Builder Level Up] ${draft.name} selected the generic two-point ASI while it was disabled during ${workflow} (${owner.name}.${advancementId}).`,
              concise: true,
              actionLabel: settings.enableFeats ? "Select Another Feat" : "Select Another Option"
            }
          );
        }

        if (choiceType !== "feat") continue;
        const selectedIds = this.#embeddedItemIds(advancement.value?.feat ?? advancement.value?.added ?? {}, draft);
        const selectedItems = [...selectedIds].map(id => addedById.get(id) ?? draft.items.get(id)).filter(Boolean);
        for (const feat of selectedItems) {
          if (feat.type !== "feat" || feat.system?.type?.value !== "feat") continue;
          const epicBoon = NativeFeatChoiceGuard.isEpicBoon(feat);
          if (epicBoon && !settings.enableEpicBoons) {
            throw new StructuralLevelUpError(
              `${feat.name} cannot be selected.`,
              {
                title: "Epic Boon Not Allowed",
                choiceName: feat.name,
                reason: "The GM does not allow Epic Boons for this advancement. Select another permitted option.",
                diagnostic: `[Character Builder Level Up] ${draft.name} selected Epic Boon ${feat.name} while Epic Boons were disabled during ${workflow}.`,
                concise: true,
                actionLabel: "Select Another Option"
              }
            );
          }
          if (!epicBoon && !settings.enableFeats) {
            throw new StructuralLevelUpError(
              `${feat.name} cannot be selected.`,
              {
                title: "Feat Not Allowed",
                choiceName: feat.name,
                reason: settings.enableAbilityScoreImprovement
                  ? "The GM only allows ASI +2 for this advancement. Choose +2 to one Ability Score or +1 to two different Ability Scores."
                  : "The GM does not allow Feats or ASI +2 for this advancement. Select another permitted option.",
                diagnostic: `[Character Builder Level Up] ${draft.name} selected Feat ${feat.name} while Feats were disabled during ${workflow}.`,
                concise: true,
                actionLabel: settings.enableAbilityScoreImprovement ? "Choose ASI +2" : "Select Another Option"
              }
            );
          }
        }
      }
    }
  }

  static #embeddedItemIds(value, draft) {
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
    return ids;
  }

  static #validateEpicBoonEligibility(draft, added, state, workflow) {
    const projectedCharacterLevel = Number(state?.targetCharacterLevel ?? draft.system?.details?.level ?? 0);
    if (projectedCharacterLevel >= 19) return;

    const invalid = added.find(item => NativeFeatChoiceGuard.isEpicBoon(item));
    if (!invalid) return;
    throw new StructuralLevelUpError(
      `${invalid.name} cannot be selected.`,
      {
        choiceName: invalid.name,
        reason: `Epic Boon feats require character level 19 or higher. The projected character level is ${projectedCharacterLevel}.`,
        diagnostic: `[Character Builder Level Up] ${draft.name} selected Epic Boon ${invalid.name} below character level 19 during ${workflow}.`
      }
    );
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
