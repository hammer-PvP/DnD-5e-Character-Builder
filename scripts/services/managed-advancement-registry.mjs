import { normalizedAdvancementName } from "../utils/advancement-utils.mjs";

/**
 * Advances handled by existing Character Builder UI flows, matched to the
 * Advancement's actual owner (which can be a granted Feature, not the Class).
 * A rule is never inferred merely from the name of a book or a source UUID.
 * Everything not covered by an implemented CB handler remains native.
 */
export class ManagedAdvancementRegistry {
  static #rules = Object.freeze([
    // Legacy class-embedded ItemChoices remain supported as fallbacks.
    { classIdentifier: "warlock", ownerType: "class", type: "ItemChoice", title: "eldritch invocations", handler: "warlock-invocations" },
    { classIdentifier: "sorcerer", ownerType: "class", type: "ItemChoice", title: "metamagic", handler: "sorcerer-metamagic" },
    { classIdentifier: "sorcerer", ownerType: "class", type: "ItemChoice", title: "metamagic options", handler: "sorcerer-metamagic" },
    // Modern PHB sources place the choices on the granted Feature itself.
    { classIdentifier: "warlock", ownerIdentifier: "eldritch-invocations", type: "ItemChoice", choiceType: "feat", handler: "warlock-invocations", workflow: "levelUp" },
    { classIdentifier: "sorcerer", ownerIdentifier: "metamagic", type: "ItemChoice", choiceType: "feat", handler: "sorcerer-metamagic", workflow: "levelUp" },
    { classIdentifier: "bard", ownerIdentifier: "magical-discoveries", type: "ItemChoice", choiceType: "spell", handler: "feature-spells", workflow: "levelUp" },
    { classIdentifier: "warlock", ownerIdentifier: "mystic-arcanum", type: "ItemChoice", choiceType: "spell", handler: "feature-spells", workflow: "levelUp" },
    { classIdentifier: "druid", ownerIdentifier: "primal-order-magician", type: "ItemChoice", choiceType: "spell", handler: "additional-cantrips" },
    // A third-caster subclass's Spellcasting Feature can carry native cantrip
    // selection that the established CB subclass spellcasting UI already owns.
    { classIdentifier: "rogue", ownerIdentifier: "spellcasting", type: "ItemChoice", choiceType: "spell", restrictionLevel: "0", handler: "subclass-cantrips", workflow: "levelUp" },
    { classIdentifier: "warlock", ownerIdentifier: "pact-of-the-tome", type: "ItemChoice", choiceType: "spell", handler: "pact-of-the-tome" }
  ]);

  static descriptor(advancement, { classIdentifier = "", owner = null, workflow = "levelUp" } = {}) {
    const source = advancement?._source ?? advancement ?? {};
    const type = String(advancement?.constructor?.typeName
      ?? advancement?.constructor?.metadata?.type
      ?? source.type ?? "").trim().toLowerCase();
    const title = normalizedAdvancementName(advancement);
    const sourceOwner = owner ?? advancement?.item ?? null;
    const ownerType = String(sourceOwner?.type ?? "").trim().toLowerCase();
    const ownerIdentifier = String(sourceOwner?.system?.identifier ?? "").trim().toLowerCase();
    const choiceType = String(source.configuration?.type ?? advancement?.configuration?.type ?? "").trim().toLowerCase();
    const restrictionLevel = String(source.configuration?.restriction?.level
      ?? advancement?.configuration?.restriction?.level ?? "").trim();
    const requestedClass = String(classIdentifier ?? "").toLowerCase();
    const requestedWorkflow = String(workflow ?? "");

    return this.#rules.find(rule =>
      (!rule.classIdentifier || rule.classIdentifier === requestedClass)
      && (!rule.ownerType || rule.ownerType === ownerType)
      && (!rule.ownerIdentifier || rule.ownerIdentifier === ownerIdentifier)
      && (!rule.title || rule.title === title)
      && (!rule.choiceType || rule.choiceType === choiceType)
      && (!rule.restrictionLevel || rule.restrictionLevel === restrictionLevel)
      && (!rule.workflow || rule.workflow === requestedWorkflow)
      && type.includes(String(rule.type).toLowerCase())
    ) ?? null;
  }

  static isManaged(advancement, context = {}) {
    return Boolean(this.descriptor(advancement, context));
  }

  static isManagedRaw(owner, advancement, { classIdentifier = "", workflow = "levelUp" } = {}) {
    const ownerIdentifier = String(owner?.system?.identifier ?? "");
    return this.isManaged(advancement, {
      owner,
      workflow,
      classIdentifier: classIdentifier || (owner?.type === "class" ? ownerIdentifier : "")
    });
  }
}
