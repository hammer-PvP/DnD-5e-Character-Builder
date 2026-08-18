import { MODULE_ID, SPELL_ACCESS_MODELS } from "../constants.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";
import { FeatureSpellOwnershipService } from "./feature-spell-ownership-service.mjs";
import { NativeAdvancementModalGuard } from "./native-advancement-modal-guard.mjs";
import { AdditionalCantripEntitlementService } from "./additional-cantrip-entitlement-service.mjs";

const BUILD_TRAIT_OWNER_TYPES = new Set(["class", "subclass", "race", "background", "feat"]);
const ALWAYS_PREPARED = SpellPreparationPolicyService.ALWAYS_PREPARED;

/**
 * Full-build projection layer for Character Validation.
 *
 * This service is intentionally isolated from creation, Level Up, rest, roll,
 * lifecycle, and runtime management. It only reads a revised validation clone,
 * projects canonical 2024 build entitlements, and repairs that clone when the
 * GM explicitly accepts a finding.
 *
 * The projection is source-driven. Classes are not hard-coded feature-by-
 * feature: D&D5e class spell lists, ScaleValue rows, and Trait Advancements are
 * interpreted as reusable entitlement contracts.
 */
export class CharacterValidationBuildProjectionService {
  static async scanTraitCompletion(actor, graph) {
    return this.#scanTraitEntitlements(actor, graph);
  }

  static async scan(actor, registry, graph) {
    const issues = [];
    issues.push(...this.#scanMalformedSpells(actor));

    const spellProjection = await this.#buildSpellProjection(actor, registry, graph);
    issues.push(...spellProjection.issues);
    issues.push(...await this.#scanGrantedSpellOwnership(actor, registry, graph));
    issues.push(...await this.#scanTraitEntitlements(actor, graph));

    return {
      issues,
      coverage: [
        { id: "build-projection", label: "Full Build Projection v1", status: "checked" },
        { id: "class-spell-access", label: "Class Spell Access / Repertoire", status: spellProjection.available ? "checked" : "audit" },
        { id: "spell-provenance", label: "Spell Ownership / Orphan Reconciliation", status: "checked" },
        { id: "spell-placeholders", label: "Malformed / Placeholder Spells", status: "checked" },
        { id: "trait-projection", label: "Skills / Expertise / Saves / Languages / Tools / Training / Resistances", status: "checked" }
      ]
    };
  }

  static canRepair(kind) {
    return new Set([
      "malformed-empty-spell",
      "class-spell-access-missing",
      "class-spell-choice-incomplete",
      "class-spell-access-unlinked",
      "granted-spell-unlinked",
      "granted-spell-ownership-incomplete",
      "granted-spell-metadata-incomplete",
      "additional-cantrip-entitlement-incomplete",
      "trait-grant-missing",
      "trait-choice-mechanical-missing",
      "trait-choice-ledger-incomplete",
      "trait-choice-reconcile-existing",
      "trait-choice-incomplete"
    ]).has(kind);
  }

  static async applyRepair(actor, issue) {
    switch (issue?.kind) {
      case "malformed-empty-spell":
        return this.#removeMalformedSpell(actor, issue);
      case "class-spell-access-missing":
        return this.#restoreDeterministicClassSpell(actor, issue);
      case "class-spell-choice-incomplete":
      case "class-spell-access-unlinked":
        return this.#resolveSpellChoice(actor, issue);
      case "granted-spell-unlinked":
        return this.#resolveGrantedSpellLink(actor, issue);
      case "granted-spell-ownership-incomplete":
        return this.#repairGrantedSpellOwnership(actor, issue);
      case "granted-spell-metadata-incomplete":
        return this.#repairGrantedSpellMetadataBatch(actor, issue);
      case "additional-cantrip-entitlement-incomplete":
        return this.#resolveAdditionalCantripChoice(actor, issue);
      case "trait-grant-missing":
      case "trait-choice-mechanical-missing":
        return this.#restoreTraitMechanicalState(actor, issue);
      case "trait-choice-ledger-incomplete":
      case "trait-choice-reconcile-existing":
        return this.#reconcileTraitChoices(actor, issue);
      case "trait-choice-incomplete":
        return this.#resolveTraitChoice(actor, issue);
      default:
        return null;
    }
  }

  // -----------------------------------------------------------------------
  // Spell projection
  // -----------------------------------------------------------------------

  static #scanMalformedSpells(actor) {
    const issues = [];
    for (const spell of actor.items.filter(item => item.type === "spell")) {
      const identifier = String(spell.system?.identifier ?? "").trim();
      const sourceId = String(spell.getFlag?.("dnd5e", "sourceId") ?? spell._stats?.compendiumSource ?? "").trim();
      const advancement = String(spell.getFlag?.("dnd5e", "advancementOrigin") ?? spell.getFlag?.("dnd5e", "advancementRoot") ?? "").trim();
      const moduleFlags = spell.flags?.[MODULE_ID] ?? {};
      const sourceItem = String(spell.system?.sourceItem ?? "").trim();
      const name = String(spell.name ?? "").trim();
      const raw = spell.toObject?.() ?? spell;
      const emptyDescription = !String(raw.system?.description?.value ?? "").trim();
      const emptyActivities = Object.keys(raw.system?.activities ?? {}).length === 0;
      const emptyEffects = (raw.effects ?? []).length === 0;
      const placeholderName = /^(new\s+spell|spell)$/i.test(name);
      const placeholderIdentifier = !identifier || /^(new-?spell|spell)$/i.test(identifier);
      // `system.sourceItem` is intentionally weak evidence. Foundry can stamp a
      // generic source such as `class:rogue` on an accidentally-created empty
      // spell, so that field alone must never rescue a default placeholder.
      const hasStrongProvenance = Boolean(sourceId || advancement
        || moduleFlags.classSpellAccess || moduleFlags.levelUpSpell
        || moduleFlags.featureGrantedSpell || (moduleFlags.featureSpellOwners ?? []).length);
      const hasAnyProvenance = Boolean(hasStrongProvenance || sourceItem);

      if (placeholderName && placeholderIdentifier && !hasStrongProvenance && emptyDescription && emptyActivities && emptyEffects) {
        issues.push({
          id: `malformed-empty-spell:${spell.id}`,
          kind: "malformed-empty-spell",
          severity: "error",
          repairable: true,
          repairMode: "safe",
          repairLabel: "Remove Empty Placeholder",
          title: `${name || "New Spell"} — Empty Placeholder Spell`,
          summary: "This Spell has no usable identity, source, acquisition record, description, activities, or effects.",
          details: "This matches an accidentally-created empty Foundry Spell document rather than a build entitlement. The Validator can remove it from the revised copy only.",
          data: { spellId: spell.id }
        });
        continue;
      }

      if ((!identifier || placeholderIdentifier) && !hasAnyProvenance) {
        issues.push({
          id: `malformed-spell-review:${spell.id}`,
          kind: "malformed-spell-review",
          severity: "warning",
          repairable: false,
          repairMode: "review",
          title: `${name || "Unnamed Spell"} — Spell Identity Needs Review`,
          summary: "This Spell has no reliable spell identifier or acquisition provenance.",
          details: "The Validator will not delete a non-empty or potentially custom spell automatically. Review whether it is intentional homebrew/custom content or an accidental sheet document.",
          data: { spellId: spell.id }
        });
      }
    }
    return issues;
  }

  static async #buildSpellProjection(actor, registry, graph) {
    const issues = [];
    let available = true;
    const classes = (graph?.owners ?? []).filter(row => row.owner.type === "class");
    const classContexts = [];

    for (const row of classes) {
      const cls = row.owner;
      const sourceClass = row.source?.document;
      const identifier = String(cls.system?.identifier ?? sourceClass?.system?.identifier ?? "").trim();
      const classLevel = Number(cls.system?.levels ?? 0);
      const progression = String(sourceClass?.system?.spellcasting?.progression ?? cls.system?.spellcasting?.progression ?? "none");
      const model = this.#spellModel(identifier, progression);
      if (!identifier || !classLevel || progression === "none" || model === "none") continue;

      let pool;
      try {
        pool = await this.#classSpellPool(identifier, registry);
      } catch (error) {
        available = false;
        issues.push({
          id: `spell-projection-unavailable:${cls.id}`,
          kind: "spell-projection-unavailable",
          severity: "warning",
          repairable: false,
          repairMode: "review",
          title: `${cls.name} — Spell Projection Unavailable`,
          summary: `The D&D5e class spell-list registry could not be read for ${cls.name}.`,
          details: `Spell build validation for this class was skipped rather than guessed. ${error?.message ?? ""}`.trim(),
          data: { classItemId: cls.id, classIdentifier: identifier }
        });
        continue;
      }

      const maximumSpellLevel = this.#maximumSpellLevel(progression, classLevel);
      // The canonical ScaleValue is the base class entitlement. Additive
      // feature grants are projected separately and never subtracted from it.
      const cantripTarget = this.#scaleValue(sourceClass, classLevel, { title: "cantrips known" });
      const maxPrepared = this.#scaleValue(sourceClass, classLevel, { identifier: "max-prepared", title: "max prepared" });
      const leveledPool = pool.filter(option => {
        const level = Number(option.system?.level ?? -1);
        return level >= 1 && level <= maximumSpellLevel;
      });
      const cantripPool = pool.filter(option => Number(option.system?.level ?? -1) === 0);
      const context = {
        cls,
        sourceClass,
        identifier,
        classLevel,
        progression,
        model,
        pool,
        leveledPool,
        cantripPool,
        maximumSpellLevel,
        cantripTarget,
        maxPrepared
      };
      classContexts.push(context);

      const classSpells = actor.items.filter(item => item.type === "spell" && this.#isNormalClassSpell(item, cls, actor));
      const classCantrips = classSpells.filter(spell => Number(spell.system?.level ?? -1) === 0);
      const classLeveled = classSpells.filter(spell => Number(spell.system?.level ?? -1) > 0);

      // Report class-owned spells that do not belong to the current canonical
      // spell list / current spell-level access. They are review findings, not
      // deletion instructions: legacy/homebrew provenance can be meaningful.
      for (const spell of classSpells) {
        const option = pool.find(row => row.identifier === spell.system?.identifier);
        const level = Number(spell.system?.level ?? -1);
        if (option && (level === 0 || level <= maximumSpellLevel)) continue;
        issues.push({
          id: `class-spell-illegal:${cls.id}:${spell.id}`,
          kind: "class-spell-illegal",
          severity: "warning",
          repairable: false,
          repairMode: "review",
          title: `${spell.name} — ${cls.name} Spell Access Needs Review`,
          summary: `${spell.name} is recorded as a normal ${cls.name} spell but is not in the currently projected legal ${cls.name} spell access.`,
          details: "The Validator will not delete or reassign it automatically because it may represent legacy, custom, or manually granted content.",
          data: { classItemId: cls.id, spellId: spell.id }
        });
      }

      if (model === "fullList") {
        issues.push(...this.#fullListSpellIssues(actor, context, classLeveled));
      } else if (model === "limited") {
        const slots = this.#scaleChoiceSlots(sourceClass, classLevel, { identifier: "max-prepared", title: "max prepared" });
        issues.push(...this.#choiceSpellIssues(actor, context, classLeveled, leveledPool, slots, "leveled"));
      } else if (model === "spellbook") {
        const slots = this.#wizardSpellbookSlots(classLevel);
        issues.push(...this.#choiceSpellIssues(actor, context, classLeveled, leveledPool, slots, "spellbook", { allowExcess: true }));
      }

      if (cantripTarget > 0) {
        const cantripSlots = this.#scaleChoiceSlots(sourceClass, classLevel, { title: "cantrips known" });
        issues.push(...this.#choiceSpellIssues(actor, context, classCantrips, cantripPool, cantripSlots, "cantrip"));
      }
      issues.push(...this.#additionalCantripIssues(actor, context));
    }

    // Once all class deficits have been projected, surface only truly unowned
    // spells that are plausible current class choices. They can be adopted by
    // a missing entitlement on the next repair pass, or left for GM review if
    // every canonical entitlement is already satisfied.
    const deficitCandidateIds = new Set(issues.flatMap(issue => issue.data?.orphanCandidates?.map(row => row.id) ?? []));
    for (const spell of actor.items.filter(item => item.type === "spell" && this.#isUnownedSpell(item))) {
      if (deficitCandidateIds.has(spell.id)) continue;
      const compatible = classContexts.filter(context => this.#spellOption(context.pool, spell.system?.identifier)
        && Number(spell.system?.level ?? -1) <= context.maximumSpellLevel);
      if (!compatible.length) continue;
      issues.push({
        id: `unresolved-spell-provenance:${spell.id}`,
        kind: "unresolved-spell-provenance",
        severity: "warning",
        repairable: false,
        repairMode: "review",
        title: `${spell.name} — Unresolved Spell Provenance`,
        summary: `${spell.name} is a legal spell for ${compatible.map(row => row.cls.name).join(" / ")}, but no build source currently owns this copy.`,
        details: "All currently projected class spell entitlements were already satisfied before this copy was needed. The Validator leaves it untouched because it may be a legitimate extra grant, migration artifact, or custom reward.",
        data: { spellId: spell.id, compatibleClassIds: compatible.map(row => row.cls.id) }
      });
    }

    return { issues, available };
  }

  static #fullListSpellIssues(actor, context, classLeveled) {
    const issues = [];
    const normalByIdentifier = new Map(classLeveled.map(spell => [String(spell.system?.identifier ?? ""), spell]));
    for (const option of context.leveledPool) {
      if (normalByIdentifier.has(option.identifier)) continue;
      const orphanCandidates = actor.items.filter(item => item.type === "spell"
        && this.#isUnownedSpell(item)
        && String(item.system?.identifier ?? "") === String(option.identifier));
      if (orphanCandidates.length) {
        issues.push({
          id: `class-spell-unlinked:${context.cls.id}:${option.identifier}`,
          kind: "class-spell-access-unlinked",
          severity: "error",
          repairable: true,
          repairMode: "guided",
          repairLabel: "Resolve Existing Spell",
          title: `${context.cls.name} — ${option.name} Access Unlinked`,
          summary: `${option.name} belongs to ${context.cls.name}'s automatic spell access, and an unowned copy already exists on the Actor.`,
          details: "Choose whether to adopt the existing copy as the class spell or restore a fresh canonical copy. The Validator will not silently repurpose an unowned spell.",
          data: this.#spellIssueData(context, {
            category: "full-list",
            entitlementLevel: this.#firstAccessibleSpellLevel(context.progression, Number(option.system?.level ?? 1)),
            expectedIdentifier: option.identifier,
            orphanCandidates,
            legalOptions: [option],
            deterministic: true
          })
        });
      } else {
        issues.push({
          id: `class-spell-access:${context.cls.id}:${option.identifier}`,
          kind: "class-spell-access-missing",
          severity: "error",
          repairable: true,
          repairMode: "safe",
          repairLabel: "Restore Class Spell",
          title: `${context.cls.name} — ${option.name} Missing from Spell Access`,
          summary: `${option.name} is part of ${context.cls.name}'s automatic class spell access at level ${context.classLevel}, but no normal class copy is present.`,
          details: "This is deterministic access, not a player choice. The Validator can restore the prioritized enabled-source spell without changing prepared-state choices or spell slots.",
          data: this.#spellIssueData(context, {
            category: "full-list",
            entitlementLevel: this.#firstAccessibleSpellLevel(context.progression, Number(option.system?.level ?? 1)),
            expectedIdentifier: option.identifier,
            resolvedUuid: option.uuid,
            deterministic: true
          })
        });
      }
    }
    return issues;
  }

  static #choiceSpellIssues(actor, context, classSpells, legalPool, slots, category, { allowExcess = false } = {}) {
    const issues = [];
    const legalIdentifiers = new Set(legalPool.map(option => String(option.identifier)));
    const validClassSpells = classSpells.filter(spell => legalIdentifiers.has(String(spell.system?.identifier ?? "")));
    const replacementAware = context.model === "limited" && category === "leveled";
    const assigned = this.#assignSpellsToSlots(validClassSpells, slots, context, category, { replacementAware });
    const missingSlots = assigned.filter(row => !row.spell);

    if (!allowExcess && validClassSpells.length > slots.length) {
      issues.push({
        id: `class-spell-count-over:${context.cls.id}:${category}`,
        kind: "class-spell-count-over",
        severity: "warning",
        repairable: false,
        repairMode: "review",
        title: `${context.cls.name} — ${this.#spellCategoryLabel(category)} Count Above Projection`,
        summary: `${context.cls.name} projects ${slots.length} normal ${this.#spellCategoryLabel(category).toLowerCase()} choice${slots.length === 1 ? "" : "s"}, but ${validClassSpells.length} class-owned copies are present.`,
        details: "The Validator does not delete excess spells automatically. Review legacy replacement history or custom grants before changing the Actor.",
        data: { classItemId: context.cls.id, expected: slots.length, actual: validClassSpells.length, category }
      });
    }

    // Existing unowned spells can be proposed only if they are legal for the
    // missing entitlement and have not already been proposed to an earlier
    // slot in this class/category.
    const proposed = new Set();
    for (const slot of missingSlots) {
      // Limited-list casters can replace older repertoire choices as they level.
      // When migration history is missing, validate the current legal repertoire
      // instead of falsely requiring every surviving spell to have been legal at
      // the level where the original count slot first appeared.
      const maximumForSlot = category === "cantrip" ? 0
        : replacementAware ? context.maximumSpellLevel
          : this.#maximumSpellLevel(context.progression, slot.level);
      const orphanCandidates = actor.items.filter(item => item.type === "spell"
        && this.#isUnownedSpell(item)
        && !proposed.has(item.id)
        && legalIdentifiers.has(String(item.system?.identifier ?? ""))
        && Number(item.system?.level ?? -1) <= maximumForSlot);
      for (const candidate of orphanCandidates) proposed.add(candidate.id);

      const existingIdentifiers = new Set(actor.items.filter(item => item.type === "spell")
        .map(item => String(item.system?.identifier ?? "")).filter(Boolean));
      const legalOptions = legalPool.filter(option => {
        const level = Number(option.system?.level ?? -1);
        if (category === "cantrip") return level === 0 && !existingIdentifiers.has(String(option.identifier));
        return level >= 1 && level <= maximumForSlot && !existingIdentifiers.has(String(option.identifier));
      });

      issues.push({
        id: `class-spell-choice:${context.cls.id}:${category}:${slot.level}:${slot.index}`,
        kind: "class-spell-choice-incomplete",
        severity: "error",
        repairable: true,
        repairMode: "guided",
        repairLabel: orphanCandidates.length ? "Link or Choose Spell" : "Choose Missing Spell",
        title: `${context.cls.name} — ${this.#spellCategoryLabel(category)} Choice Missing`,
        summary: `${context.cls.name} is missing one ${this.#spellCategoryLabel(category).toLowerCase()} entitlement${slot.level ? ` projected from class level ${slot.level}` : ""}.`,
        details: orphanCandidates.length
          ? `The Actor already has ${orphanCandidates.map(item => item.name).join(" / ")} without build provenance that could legally satisfy this entitlement. Link an existing spell or select a new legal spell.`
          : "No existing unowned spell could safely satisfy this entitlement. Select a legal spell from the prioritized enabled class list.",
        data: this.#spellIssueData(context, {
          category,
          entitlementLevel: slot.level,
          slotIndex: slot.index,
          orphanCandidates,
          legalOptions,
          deterministic: false
        })
      });
    }
    return issues;
  }

  static #additionalCantripIssues(actor, context) {
    const issues = [];
    const grants = AdditionalCantripEntitlementService.grants(actor, context.cls);
    if (!grants.length) return issues;
    const existingIdentifiers = new Set(actor.items.filter(item => item.type === "spell")
      .map(item => String(item.system?.identifier ?? "")).filter(Boolean));

    for (const grant of grants) {
      const owned = actor.items.filter(item => item.type === "spell"
        && Number(item.system?.level ?? -1) === 0
        && AdditionalCantripEntitlementService.hasOwner(item, grant));
      const missing = Math.max(0, Number(grant.count ?? 0) - owned.length);
      for (let slotIndex = 0; slotIndex < missing; slotIndex++) {
        const orphanCandidates = actor.items.filter(item => item.type === "spell"
          && Number(item.system?.level ?? -1) === 0
          && this.#isUnownedSpell(item)
          && context.cantripPool.some(option => String(option.identifier) === String(item.system?.identifier ?? "")));
        const legalOptions = context.cantripPool.filter(option => !existingIdentifiers.has(String(option.identifier)));
        issues.push({
          id: `additional-cantrip:${context.cls.id}:${grant.featureItemId ?? grant.key}:${slotIndex}`,
          kind: "additional-cantrip-entitlement-incomplete",
          severity: "error",
          repairable: true,
          repairMode: "guided",
          repairLabel: orphanCandidates.length ? "Link or Choose Additional Cantrip" : "Choose Additional Cantrip",
          title: `${grant.featureName} — Additional Cantrip Missing`,
          summary: `${grant.featureName} grants ${grant.count} additional ${context.cls.name} cantrip${grant.count === 1 ? "" : "s"}, but only ${owned.length} feature-owned acquisition${owned.length === 1 ? " is" : "s are"} recorded.`,
          details: "This entitlement is additive to the class Cantrips Known ScaleValue. It never replaces or reduces a normal class cantrip choice.",
          data: {
            ...this.#spellIssueData(context, {
              category: grant.category,
              entitlementLevel: context.classLevel,
              slotIndex,
              orphanCandidates,
              legalOptions,
              deterministic: false
            }),
            featureItemId: grant.featureItemId,
            featureName: grant.featureName,
            featureCategory: grant.category,
            additionalCantrip: true
          }
        });
      }
    }
    return issues;
  }

  static #assignSpellsToSlots(spells, slots, context, category, { replacementAware = false } = {}) {
    const result = slots.map(slot => ({ ...slot, spell: null }));
    const remaining = [...spells];

    if (replacementAware) {
      // The current repertoire is the authoritative mechanical state for a
      // limited caster when replacement history is unavailable. Each legal
      // current class spell consumes one projected repertoire slot. Slot levels
      // remain useful for explaining when capacity increased, but are not used
      // to invent an acquisition history that may have been replaced later.
      for (const spell of remaining) {
        const slot = result.find(row => !row.spell);
        if (!slot) break;
        slot.spell = spell;
      }
      return result;
    }

    // For non-replacement models, strong acquisition levels fill their
    // corresponding historical slot first.
    for (const spell of [...remaining]) {
      const level = this.#recordedClassAcquisitionLevel(spell, context.cls);
      if (!level) continue;
      const slot = result.find(row => !row.spell && row.level === level && this.#spellLegalForSlot(spell, context, row, category));
      if (!slot) continue;
      slot.spell = spell;
      remaining.splice(remaining.indexOf(spell), 1);
    }

    // Legacy class-owned spells without a surviving acquisition-level ledger
    // are still valid evidence. Assign them greedily to compatible slots rather
    // than forcing a migration-only false positive.
    for (const spell of [...remaining]) {
      const slot = result.find(row => !row.spell && this.#spellLegalForSlot(spell, context, row, category));
      if (!slot) continue;
      slot.spell = spell;
      remaining.splice(remaining.indexOf(spell), 1);
    }
    return result;
  }

  static #spellLegalForSlot(spell, context, slot, category) {
    const level = Number(spell.system?.level ?? -1);
    if (category === "cantrip") return level === 0;
    return level >= 1 && level <= this.#maximumSpellLevel(context.progression, slot.level);
  }

  static #spellIssueData(context, {
    category,
    entitlementLevel,
    slotIndex = 0,
    orphanCandidates = [],
    legalOptions = [],
    expectedIdentifier = null,
    resolvedUuid = null,
    deterministic = false
  } = {}) {
    return {
      classItemId: context.cls.id,
      classIdentifier: context.identifier,
      className: context.cls.name,
      classLevel: context.classLevel,
      progression: context.progression,
      accessModel: context.model,
      category,
      entitlementLevel: Number(entitlementLevel ?? context.classLevel),
      slotIndex,
      expectedIdentifier,
      resolvedUuid,
      deterministic,
      orphanCandidates: orphanCandidates.map(item => ({
        id: item.id,
        name: item.name,
        identifier: item.system?.identifier ?? "",
        level: Number(item.system?.level ?? 0),
        sourceUuid: item.getFlag?.("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? null
      })),
      legalOptions: legalOptions.map(option => ({
        uuid: option.uuid,
        name: option.name,
        identifier: option.identifier,
        level: Number(option.system?.level ?? 0),
        sourceLabel: option.sourceLabel ?? "enabled source"
      }))
    };
  }

  static async #scanGrantedSpellOwnership(actor, registry, graph) {
    const issues = [];
    const metadataBatches = new Map();
    for (const node of graph?.nodes ?? []) {
      const { owner, source, sourceAdvancementId, sourceAdvancement, local } = node;
      if (!["ItemGrant", "ItemChoice"].includes(String(sourceAdvancement?.type ?? ""))) continue;
      const advancementId = local?.id ?? sourceAdvancementId;
      const expectedOrigin = `${owner.id}.${advancementId}`;
      const mappedRows = this.#flattenAddedMappings(local?.advancement?.value?.added ?? {});

      const expectedRows = [];
      if (sourceAdvancement.type === "ItemGrant") {
        for (const entry of sourceAdvancement.configuration?.items ?? []) {
          if (entry?.optional || !entry?.uuid) continue;
          expectedRows.push({ uuid: entry.uuid, mappedItemId: null });
        }
      } else if (String(sourceAdvancement.configuration?.type ?? "") === "spell") {
        // Spell ItemChoice Advancements (Blessed Warrior, feature cantrip
        // choices, etc.) have no deterministic source list. Their local
        // value.added mapping is the proof of the actual chosen spell(s).
        for (const row of mappedRows) {
          if (!row?.uuid) continue;
          expectedRows.push({ uuid: row.uuid, mappedItemId: row.itemId });
        }
      } else continue;

      for (const expected of expectedRows) {
        let sourceSpell;
        try { sourceSpell = await fromUuid(expected.uuid); } catch (_error) { sourceSpell = null; }
        if (!sourceSpell || sourceSpell.type !== "spell" || !registry.isUuidAllowed(expected.uuid)) continue;

        const exactMapped = expected.mappedItemId
          ? [actor.items.get(expected.mappedItemId)].filter(Boolean)
          : mappedRows.map(row => actor.items.get(row.itemId)).filter(Boolean)
            .filter(item => item.type === "spell" && this.#sameSpellIdentity(item, sourceSpell));
        const exactOrigin = actor.items.filter(item => item.type === "spell"
          && String(item.getFlag?.("dnd5e", "advancementOrigin") ?? "") === expectedOrigin
          && this.#sameSpellIdentity(item, sourceSpell));
        const candidates = [...new Map([...exactMapped, ...exactOrigin]
          .filter(item => item?.type === "spell" && this.#sameSpellIdentity(item, sourceSpell))
          .map(item => [item.id, item])).values()];
        if (!candidates.length) {
          // A deterministic spell grant can already exist mechanically while
          // having lost every ownership record during migration. Do not create
          // a duplicate. Offer the GM an explicit adoption-vs-fresh-source
          // decision before the generic missing-grant path can normalize it.
          if (sourceAdvancement.type === "ItemGrant") {
            const orphanCandidates = actor.items.filter(item => item.type === "spell"
              && this.#isUnownedSpell(item) && this.#sameSpellIdentity(item, sourceSpell));
            if (orphanCandidates.length) {
              const expectedSourceItem = this.#expectedGrantSourceItem(owner, actor, sourceAdvancement);
              const expectedAlways = Number(sourceAdvancement.configuration?.spell?.prepared) === ALWAYS_PREPARED
                || Number(sourceSpell.system?.level ?? 0) === 0;
              issues.push({
                id: `granted-spell-unlinked:${owner.id}:${advancementId}:${sourceSpell.system?.identifier ?? this.#slug(sourceSpell.name)}`,
                kind: "granted-spell-unlinked",
                severity: "error",
                repairable: true,
                repairMode: "guided",
                repairLabel: "Link or Restore Granted Spell",
                title: `${sourceSpell.name} — Granted Spell Has No Ownership`,
                summary: `${sourceSpell.name} is required by ${owner.name}, and an unowned copy already exists on the Actor.`,
                details: "Link the existing legal copy to this proven grant, or restore a fresh canonical source copy. The Validator will not silently claim an unowned spell for a class/subclass/feature.",
                data: {
                  ownerId: owner.id,
                  sourceOwnerUuid: source?.uuid ?? null,
                  advancementId,
                  sourceAdvancementId,
                  sourceUuid: expected.uuid,
                  expectedOrigin,
                  expectedSourceItem,
                  expectedAlways,
                  entitlementLevel: Number(sourceAdvancement.level ?? 0),
                  orphanCandidates: orphanCandidates.map(item => ({
                    id: item.id, name: item.name, identifier: item.system?.identifier ?? "",
                    level: Number(item.system?.level ?? 0),
                    sourceUuid: item.getFlag?.("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? null
                  })),
                  legalOptions: [{
                    uuid: expected.uuid, name: sourceSpell.name, identifier: sourceSpell.system?.identifier ?? "",
                    level: Number(sourceSpell.system?.level ?? 0), sourceLabel: "canonical grant"
                  }],
                  deterministic: true
                }
              });
            }
          }
          continue; // Missing choice/grant remains handled by the existing completion scanners.
        }

        const spell = candidates[0];
        const expectedSourceItem = this.#expectedGrantSourceItem(owner, actor, sourceAdvancement);
        const currentSourceItem = String(spell.system?.sourceItem ?? "");
        const advancementOrigin = String(spell.getFlag?.("dnd5e", "advancementOrigin") ?? "");
        const advancementRoot = String(spell.getFlag?.("dnd5e", "advancementRoot") ?? "");
        const owners = spell.getFlag?.(MODULE_ID, "featureSpellOwners") ?? [];
        const hasOwner = owners.some(row => String(row.ownerItemId ?? "") === String(owner.id)
          && String(row.advancementId ?? "") === String(advancementId));
        const mergedReceipt = this.#mergedGrantReceipt(spell, {
          ownerId: owner.id,
          advancementId,
          sourceUuid: expected.uuid
        });
        const expectedAlways = Number(sourceAdvancement.configuration?.spell?.prepared) === ALWAYS_PREPARED
          || Number(spell.system?.level ?? 0) === 0;
        const missing = [];
        if (expectedSourceItem && currentSourceItem !== expectedSourceItem) missing.push("sourceItem");
        // A canonical spell that also satisfies a native grant intentionally
        // keeps its normal class-access provenance. The merge receipt is the
        // authoritative Advancement link, so requiring the canonical spell to
        // masquerade as the removed grant copy creates false ownership repairs.
        if (advancementOrigin !== expectedOrigin && !mergedReceipt) missing.push("advancementOrigin");
        if (advancementRoot !== expectedOrigin && !mergedReceipt) missing.push("advancementRoot");
        if (!hasOwner) missing.push("featureSpellOwners");
        if (expectedAlways && Number(spell.system?.prepared ?? -1) !== ALWAYS_PREPARED) missing.push("Always Prepared");
        if (!missing.length) continue;

        // Native D&D5e provenance (sourceItem + Advancement origin/root +
        // prepared state) already proves the acquisition mechanically. Missing
        // only Character Builder ownership metadata is one migration-quality
        // finding per owning feature, not a separate structural error per spell.
        if (missing.length === 1 && missing[0] === "featureSpellOwners") {
          const key = `${owner.id}:${advancementId}`;
          const batch = metadataBatches.get(key) ?? { owner, advancementId, entries: [] };
          batch.entries.push({
            spellId: spell.id,
            ownerId: owner.id,
            advancementId,
            sourceAdvancementId,
            sourceUuid: expected.uuid,
            expectedOrigin,
            expectedSourceItem,
            expectedAlways,
            entitlementLevel: Number(sourceAdvancement.level ?? 0)
          });
          metadataBatches.set(key, batch);
          continue;
        }

        issues.push({
          id: `granted-spell-ownership:${owner.id}:${advancementId}:${spell.id}`,
          kind: "granted-spell-ownership-incomplete",
          severity: "error",
          repairable: true,
          repairMode: "safe",
          repairLabel: "Reconcile Spell Ownership",
          title: `${spell.name} — Grant Ownership Incomplete`,
          summary: `${spell.name} is provably linked to ${owner.name}, but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} incomplete or inconsistent.`,
          details: "The Validator can reconcile the existing Spell's ownership/provenance without replacing the Spell or changing the player's proven choice.",
          data: {
            spellId: spell.id,
            ownerId: owner.id,
            advancementId,
            sourceAdvancementId,
            sourceUuid: expected.uuid,
            expectedOrigin,
            expectedSourceItem,
            expectedAlways,
            entitlementLevel: Number(sourceAdvancement.level ?? 0)
          }
        });
      }
    }
    for (const [key, batch] of metadataBatches) {
      issues.push({
        id: `granted-spell-metadata:${key}`,
        kind: "granted-spell-metadata-incomplete",
        severity: "warning",
        repairable: true,
        repairMode: "safe",
        repairLabel: "Reconcile Spell Ownership Metadata",
        title: `${batch.owner.name} — Spell Ownership Metadata Incomplete`,
        summary: `${batch.entries.length} native spell acquisition${batch.entries.length === 1 ? " is" : "s are"} mechanically correct but missing Character Builder ownership metadata.`,
        details: "The Validator can attach the missing ownership ledger to the existing spells without replacing them, changing their choices, or creating duplicate spell documents.",
        data: { entries: batch.entries }
      });
    }
    return issues;
  }

  // -----------------------------------------------------------------------
  // Trait / proficiency projection
  // -----------------------------------------------------------------------

  static async #scanTraitEntitlements(actor, graph) {
    const issues = [];
    const entitlements = [];
    const ambiguousClasses = new Set();
    const unsupportedFamilies = new Set();

    for (const node of graph?.nodes ?? []) {
      const { owner, source, sourceAdvancementId, sourceAdvancement, local } = node;
      if (sourceAdvancement?.type !== "Trait" || sourceAdvancement.configuration?.mode === "mastery") continue;
      if (!BUILD_TRAIT_OWNER_TYPES.has(owner.type)) continue;

      const applies = this.#traitAdvancementApplies(actor, owner, sourceAdvancement);
      if (applies === null) {
        if (owner.type === "class" && !ambiguousClasses.has(owner.id)) {
          ambiguousClasses.add(owner.id);
          issues.push({
            id: `class-trait-origin-ambiguous:${owner.id}`,
            kind: "class-trait-origin-ambiguous",
            severity: "warning",
            repairable: false,
            repairMode: "review",
            title: `${owner.name} — Primary/Multiclass Trait Scope Needs Review`,
            summary: "The Actor has multiple classes but no reliable original-class record, so primary-vs-multiclass proficiency Advancements cannot be projected safely.",
            details: "The Validator skips only the class-restricted Trait rows rather than guessing which class was taken first.",
            data: { classItemId: owner.id }
          });
        }
        continue;
      }
      if (!applies) continue;

      const grants = this.#collectionValues(sourceAdvancement.configuration?.grants).map(String).filter(Boolean);
      const pools = this.#traitPools(sourceAdvancement);
      const expected = this.#traitChoiceCapacity(sourceAdvancement);
      const requiredRank = sourceAdvancement.configuration?.mode === "expertise" ? 2 : 1;
      const localChosen = this.#collectionValues(local?.advancement?.value?.chosen).map(String).filter(Boolean);
      const badgeChosen = this.#badgeChosenTokens(actor, owner, local?.id ?? sourceAdvancementId, pools, requiredRank);
      const choiceChosen = [...new Set([
        ...localChosen.filter(token => !grants.includes(token)),
        ...badgeChosen.filter(token => !grants.includes(token))
      ])];
      entitlements.push({
        owner, source, sourceAdvancementId, sourceAdvancement, local,
        grants, pools, expected, requiredRank, localChosen, badgeChosen, choiceChosen
      });
    }

    const noteUnsupported = (token, entitlement) => {
      const family = String(token ?? "").split(":")[0] || "unknown";
      const key = `${family}:${entitlement.owner.id}:${entitlement.sourceAdvancementId}`;
      if (unsupportedFamilies.has(key)) return;
      unsupportedFamilies.add(key);
      issues.push({
        id: `trait-family-unsupported:${entitlement.owner.id}:${entitlement.sourceAdvancementId}:${family}`,
        kind: "trait-family-unsupported",
        severity: "warning",
        repairable: false,
        repairMode: "review",
        title: `${entitlement.owner.name} — ${this.#title(family)} Trait Family Not Yet Audited`,
        summary: `The canonical Advancement uses the Trait token family ${family}:*, which this Validator build will not guess about.`,
        details: "Unsupported Trait families are skipped instead of being reported as missing or causing a repair failure.",
        data: { ownerId: entitlement.owner.id, sourceAdvancementId: entitlement.sourceAdvancementId, family }
      });
    };

    // Reservation is layered. Rank-1 proficiency and rank-2 Expertise are
    // distinct entitlements and may legitimately use the same skill.
    const reserved = new Set();
    for (const entitlement of entitlements) {
      for (const token of entitlement.grants) {
        const present = this.#mechanicalTraitPresent(actor, token, entitlement.requiredRank);
        if (present === null) {
          noteUnsupported(token, entitlement);
          continue;
        }
        reserved.add(this.#traitReservationKey(token, entitlement.requiredRank));
        if (present) continue;
        issues.push({
          id: `trait-grant-missing:${entitlement.owner.id}:${entitlement.sourceAdvancementId}:${token}`,
          kind: "trait-grant-missing",
          severity: "error",
          repairable: true,
          repairMode: "safe",
          repairLabel: "Restore Trait",
          title: `${entitlement.owner.name} — ${this.#traitTokenLabel(token)} Missing`,
          summary: `${this.#traitTokenLabel(token)} is a deterministic grant from ${entitlement.sourceAdvancement.title || entitlement.owner.name}, but the Actor's mechanical state no longer contains it.`,
          details: "The source choice is already known; the Validator restores only the missing trait/proficiency state on the revised copy.",
          data: {
            ownerId: entitlement.owner.id,
            sourceAdvancementId: entitlement.sourceAdvancementId,
            localAdvancementId: entitlement.local?.id ?? null,
            token,
            requiredRank: entitlement.requiredRank
          }
        });
      }
    }

    // Local Advancement records and Character Builder choice badges are strong
    // evidence. Badges can recover a choice ledger lost by older materializers
    // without changing the already-correct mechanical state.
    for (const entitlement of entitlements) {
      const legalLocal = new Set(entitlement.localChosen.filter(token => this.#traitTokenMatchesPools(token, entitlement.pools)));
      const badgeOnly = entitlement.badgeChosen.filter(token => this.#traitTokenMatchesPools(token, entitlement.pools) && !legalLocal.has(token));
      const recoverableBadgeTokens = [];

      for (const token of entitlement.choiceChosen) {
        if (!this.#traitTokenMatchesPools(token, entitlement.pools)) {
          issues.push({
            id: `trait-choice-illegal:${entitlement.owner.id}:${entitlement.local?.id ?? entitlement.sourceAdvancementId}:${token}`,
            kind: "trait-choice-illegal",
            severity: "warning",
            repairable: false,
            repairMode: "review",
            title: `${entitlement.owner.name} — Recorded Trait Choice Needs Review`,
            summary: `${this.#traitTokenLabel(token)} is recorded in ${entitlement.sourceAdvancement.title || "a Trait Advancement"} but is outside the current canonical choice pool.`,
            details: "The Validator preserves the existing choice because source editions, homebrew, or migration history may explain it.",
            data: { ownerId: entitlement.owner.id, token }
          });
          continue;
        }
        const present = this.#mechanicalTraitPresent(actor, token, entitlement.requiredRank);
        if (present === null) {
          noteUnsupported(token, entitlement);
          continue;
        }
        reserved.add(this.#traitReservationKey(token, entitlement.requiredRank));
        if (!present) {
          issues.push({
            id: `trait-choice-mechanical:${entitlement.owner.id}:${entitlement.local?.id ?? entitlement.sourceAdvancementId}:${token}`,
            kind: "trait-choice-mechanical-missing",
            severity: "error",
            repairable: true,
            repairMode: "safe",
            repairLabel: "Restore Recorded Choice",
            title: `${entitlement.owner.name} — Recorded ${this.#traitTokenLabel(token)} Missing`,
            summary: `${this.#traitTokenLabel(token)} is still recorded as the legal choice for ${entitlement.sourceAdvancement.title || entitlement.owner.name}, but its proficiency/training state was removed from the Actor.`,
            details: "Because the exact original choice is proven by the Advancement ledger or Character Builder history, the Validator can restore the mechanical state without asking the GM to choose again.",
            data: {
              ownerId: entitlement.owner.id,
              sourceAdvancementId: entitlement.sourceAdvancementId,
              localAdvancementId: entitlement.local?.id ?? null,
              token,
              requiredRank: entitlement.requiredRank
            }
          });
        } else if (badgeOnly.includes(token)) {
          recoverableBadgeTokens.push(token);
        }
      }

      if (recoverableBadgeTokens.length) {
        issues.push({
          id: `trait-choice-ledger:${entitlement.owner.id}:${entitlement.sourceAdvancementId}`,
          kind: "trait-choice-ledger-incomplete",
          severity: "error",
          repairable: true,
          repairMode: "safe",
          repairLabel: "Reconcile Choice Ledger",
          title: `${entitlement.owner.name} — ${entitlement.sourceAdvancement.title || "Trait Choice"} Ledger Incomplete`,
          summary: `Character Builder history proves ${recoverableBadgeTokens.map(token => this.#traitTokenLabel(token)).join(" / ")}, but the native Advancement ledger no longer records ${recoverableBadgeTokens.length === 1 ? "that choice" : "those choices"}.`,
          details: "This repair restores only the choice ledger on the revised copy. It does not add another proficiency or change the Actor's mechanical state.",
          data: {
            ownerId: entitlement.owner.id,
            sourceUuid: entitlement.source.uuid,
            sourceAdvancementId: entitlement.sourceAdvancementId,
            localAdvancementId: entitlement.local?.id ?? null,
            tokens: recoverableBadgeTokens,
            requiredRank: entitlement.requiredRank,
            mode: entitlement.local ? "modify" : "add"
          }
        });
      }
    }

    const mechanicalTokens = this.#actorTraitTokens(actor);
    const unresolved = entitlements.map(entitlement => {
      if (!entitlement.expected) return null;
      const proven = entitlement.choiceChosen.filter(token => this.#traitTokenMatchesPools(token, entitlement.pools)).length;
      const deficit = Math.max(0, entitlement.expected - proven);
      return deficit ? { entitlement, proven, deficit } : null;
    }).filter(Boolean);

    const candidateClaims = new Map();
    for (const row of unresolved) {
      for (const token of mechanicalTokens) {
        if (!this.#traitTokenMatchesPools(token, row.entitlement.pools)) continue;
        if (reserved.has(this.#traitReservationKey(token, row.entitlement.requiredRank))) continue;
        if (this.#mechanicalTraitPresent(actor, token, row.entitlement.requiredRank) !== true) continue;
        const key = this.#traitReservationKey(token, row.entitlement.requiredRank);
        const claimers = candidateClaims.get(key) ?? new Set();
        claimers.add(`${row.entitlement.owner.id}:${row.entitlement.sourceAdvancementId}`);
        candidateClaims.set(key, claimers);
      }
    }

    for (const { entitlement, proven, deficit } of unresolved) {
      const candidates = mechanicalTokens.filter(token => this.#traitTokenMatchesPools(token, entitlement.pools)
        && !reserved.has(this.#traitReservationKey(token, entitlement.requiredRank))
        && this.#mechanicalTraitPresent(actor, token, entitlement.requiredRank) === true);
      const exclusive = candidates.filter(token => (candidateClaims.get(this.#traitReservationKey(token, entitlement.requiredRank))?.size ?? 0) === 1);

      if (exclusive.length === deficit && candidates.length === deficit) {
        for (const token of exclusive) reserved.add(this.#traitReservationKey(token, entitlement.requiredRank));
        issues.push({
          id: `trait-choice-reconcile:${entitlement.owner.id}:${entitlement.sourceAdvancementId}`,
          kind: "trait-choice-reconcile-existing",
          severity: "error",
          repairable: true,
          repairMode: "safe",
          repairLabel: "Reconcile Existing Choices",
          title: `${entitlement.owner.name} — ${entitlement.sourceAdvancement.title || "Trait Choice"} Ownership Missing`,
          summary: `${entitlement.sourceAdvancement.title || entitlement.owner.name} requires ${entitlement.expected} choice${entitlement.expected === 1 ? "" : "s"}; the Actor already has exactly the legal unclaimed state needed to satisfy the ${deficit} missing slot${deficit === 1 ? "" : "s"}.`,
          details: `The Validator can link ${exclusive.map(token => this.#traitTokenLabel(token)).join(" / ")} to this entitlement without adding or upgrading any proficiency.`,
          data: {
            ownerId: entitlement.owner.id,
            sourceUuid: entitlement.source.uuid,
            sourceAdvancementId: entitlement.sourceAdvancementId,
            localAdvancementId: entitlement.local?.id ?? null,
            tokens: exclusive,
            requiredRank: entitlement.requiredRank,
            mode: entitlement.local ? "modify" : "add"
          }
        });
        continue;
      }

      issues.push({
        id: `trait-choice-incomplete:${entitlement.owner.id}:${entitlement.sourceAdvancementId}:0`,
        kind: "trait-choice-incomplete",
        severity: "error",
        repairable: true,
        repairMode: "guided",
        repairLabel: candidates.length ? "Link or Resolve Choice" : "Resolve Missing Choice",
        title: `${entitlement.owner.name} — ${entitlement.sourceAdvancement.title || "Trait Choice"} Incomplete`,
        summary: `${entitlement.sourceAdvancement.title || entitlement.owner.name} requires ${entitlement.expected} choice${entitlement.expected === 1 ? "" : "s"}, but only ${proven} ${proven === 1 ? "is" : "are"} currently proven by its Advancement record or Character Builder history.`,
        details: candidates.length
          ? `Existing legal but unclaimed Actor state may satisfy this entitlement: ${candidates.map(token => this.#traitTokenLabel(token)).join(" / ")}. Link an existing choice or reopen the native Advancement.`
          : "No existing unclaimed state can safely satisfy this entitlement. Reopen the native D&D5e Advancement to make the missing legal choice.",
        data: {
          ownerId: entitlement.owner.id,
          sourceUuid: entitlement.source.uuid,
          sourceAdvancementId: entitlement.sourceAdvancementId,
          localAdvancementId: entitlement.local?.id ?? null,
          level: this.#firstAdvancementLevel(entitlement.sourceAdvancement),
          requiredRank: entitlement.requiredRank,
          candidates: candidates.map(token => ({ token, label: this.#traitTokenLabel(token) })),
          expected: entitlement.expected,
          actual: proven,
          mode: entitlement.local ? "modify" : "add"
        }
      });
    }

    return issues;
  }

  // -----------------------------------------------------------------------
  // Repairs
  // -----------------------------------------------------------------------

  static async #removeMalformedSpell(actor, issue) {
    const spell = actor.items.get(issue.data?.spellId);
    if (!spell) return { status: "repaired", issueId: issue.id, title: issue.title, message: "The empty placeholder Spell was already removed." };
    await actor.deleteEmbeddedDocuments("Item", [spell.id], {
      deleteContents: true,
      characterBuilderValidationRepair: true,
      characterBuilderValidationBuildProjection: true
    });
    return { status: "repaired", issueId: issue.id, title: issue.title, message: `Removed the empty placeholder Spell ${spell.name} from the revised copy.` };
  }

  static async #restoreDeterministicClassSpell(actor, issue) {
    const cls = actor.items.get(issue.data?.classItemId);
    if (!cls) throw new Error("The class that owns this spell entitlement no longer exists.");
    const source = await fromUuid(issue.data?.resolvedUuid);
    if (!source || source.type !== "spell") throw new Error("The canonical spell source is unavailable.");
    const data = this.#normalClassSpellData(source, cls, issue.data, { category: "full-list" });
    const [created] = await actor.createEmbeddedDocuments("Item", [data], {
      characterBuilderValidationRepair: true,
      characterBuilderValidationBuildProjection: true
    });
    if (!created) throw new Error(`D&D5e did not restore ${source.name}.`);
    return { status: "repaired", issueId: issue.id, title: issue.title, message: `Restored ${created.name} to ${cls.name}'s deterministic class spell access.` };
  }

  static async #resolveSpellChoice(actor, issue) {
    const cls = actor.items.get(issue.data?.classItemId);
    if (!cls) throw new Error("The class that owns this spell entitlement no longer exists.");
    const choice = await this.#promptSpellResolution(issue);
    if (!choice) {
      return { status: "skipped", issueId: issue.id, title: issue.title, message: `${issue.title} remains unresolved because the spell choice dialog was cancelled.` };
    }

    if (choice.mode === "existing") {
      const spell = actor.items.get(choice.id);
      if (!spell) throw new Error("The selected existing spell no longer exists.");
      const update = this.#normalClassSpellUpdate(spell, cls, issue.data);
      await spell.update(update, {
        characterBuilderValidationRepair: true,
        characterBuilderValidationBuildProjection: true
      });
      return { status: "repaired", issueId: issue.id, title: issue.title, message: `Linked existing ${spell.name} to ${cls.name}'s missing spell entitlement.`, guided: true };
    }

    const option = (issue.data?.legalOptions ?? []).find(row => row.uuid === choice.uuid)
      ?? (issue.data?.resolvedUuid === choice.uuid ? { uuid: choice.uuid } : null);
    if (!option?.uuid) throw new Error("The selected spell is no longer a legal option for this entitlement.");
    const source = await fromUuid(option.uuid);
    if (!source || source.type !== "spell") throw new Error("The selected canonical spell source is unavailable.");
    const data = this.#normalClassSpellData(source, cls, issue.data, { category: issue.data?.category });
    const [created] = await actor.createEmbeddedDocuments("Item", [data], {
      characterBuilderValidationRepair: true,
      characterBuilderValidationBuildProjection: true
    });
    if (!created) throw new Error(`D&D5e did not add ${source.name}.`);
    return { status: "repaired", issueId: issue.id, title: issue.title, message: `Added ${created.name} for ${cls.name}'s missing spell entitlement.`, guided: true };
  }

  static async #resolveAdditionalCantripChoice(actor, issue) {
    const cls = actor.items.get(issue.data?.classItemId);
    const feature = actor.items.get(issue.data?.featureItemId);
    if (!cls || !feature) throw new Error("The class or feature that owns this additional cantrip entitlement no longer exists.");
    const choice = await this.#promptSpellResolution(issue);
    if (!choice) return { status: "skipped", issueId: issue.id, title: issue.title, message: `${issue.title} remains unresolved because the spell choice dialog was cancelled.` };

    let spell;
    if (choice.mode === "existing") {
      spell = actor.items.get(choice.id);
      if (!spell) throw new Error("The selected existing cantrip no longer exists.");
    } else {
      const source = await fromUuid(choice.uuid);
      if (!source || source.type !== "spell" || Number(source.system?.level ?? -1) !== 0) throw new Error("The selected canonical cantrip source is unavailable.");
      const itemData = foundry.utils.deepClone(source.toObject());
      delete itemData._id;
      itemData.system ??= {};
      itemData.system.ability = cls.system?.spellcasting?.ability ?? itemData.system.ability ?? "";
      itemData.system.method = cls.system?.spellcasting?.progression === "pact" ? "pact" : "spell";
      itemData.system.prepared = ALWAYS_PREPARED;
      itemData.system.sourceItem = `class:${issue.data?.classIdentifier ?? cls.system?.identifier}`;
      itemData.flags ??= {};
      itemData.flags.dnd5e ??= {};
      itemData.flags.dnd5e.sourceId = source.uuid;
      [spell] = await actor.createEmbeddedDocuments("Item", [itemData], {
        characterBuilderValidationRepair: true,
        characterBuilderValidationBuildProjection: true
      });
      if (!spell) throw new Error(`D&D5e did not add ${source.name}.`);
    }

    const grant = {
      category: issue.data?.featureCategory ?? issue.data?.category,
      featureName: issue.data?.featureName ?? feature.name,
      classIdentifier: issue.data?.classIdentifier ?? cls.system?.identifier,
      classItemId: cls.id,
      featureItemId: feature.id
    };
    const ownerRecord = AdditionalCantripEntitlementService.ownerRecord(grant, spell, {
      acquiredAtClassLevel: Number(issue.data?.entitlementLevel ?? cls.system?.levels ?? 0),
      alwaysPrepared: true,
      validationReconciled: true
    });
    await FeatureSpellOwnershipService.addOwner(spell, ownerRecord, { prepared: ALWAYS_PREPARED });
    await spell.update({
      "system.ability": cls.system?.spellcasting?.ability ?? spell.system?.ability ?? "",
      "system.method": cls.system?.spellcasting?.progression === "pact" ? "pact" : "spell",
      "system.prepared": ALWAYS_PREPARED,
      "system.sourceItem": `class:${issue.data?.classIdentifier ?? cls.system?.identifier}`,
      [`flags.${MODULE_ID}.classSpellAccess`]: true,
      [`flags.${MODULE_ID}.classIdentifier`]: issue.data?.classIdentifier ?? cls.system?.identifier,
      [`flags.${MODULE_ID}.classItemId`]: cls.id,
      [`flags.${MODULE_ID}.accessModel`]: "additional-cantrip",
      [`flags.${MODULE_ID}.category`]: grant.category,
      [`flags.${MODULE_ID}.featureGrantedSpell`]: true
    }, { characterBuilderValidationRepair: true, characterBuilderValidationBuildProjection: true });
    return { status: "repaired", issueId: issue.id, title: issue.title, message: `Linked ${spell.name} to ${feature.name}'s additional cantrip entitlement.`, guided: true };
  }

  static async #repairGrantedSpellMetadataBatch(actor, issue) {
    const entries = issue.data?.entries ?? [];
    let repaired = 0;
    for (const entry of entries) {
      const result = await this.#repairGrantedSpellOwnership(actor, {
        id: `${issue.id}:${entry.spellId}`,
        title: issue.title,
        data: entry
      });
      if (result?.status === "repaired") repaired++;
    }
    return {
      status: repaired ? "repaired" : "skipped",
      issueId: issue.id,
      title: issue.title,
      message: repaired
        ? `Reconciled ownership metadata for ${repaired} spell acquisition${repaired === 1 ? "" : "s"} without replacing any spell.`
        : `${issue.title} did not require any remaining metadata changes.`
    };
  }

  static async #resolveGrantedSpellLink(actor, issue) {
    const owner = actor.items.get(issue.data?.ownerId);
    if (!owner) throw new Error("The source Item for this spell grant no longer exists.");
    const choice = await this.#promptSpellResolution(issue);
    if (!choice) {
      return { status: "skipped", issueId: issue.id, title: issue.title, message: `${issue.title} remains unresolved because the spell ownership dialog was cancelled.` };
    }

    let spell;
    if (choice.mode === "existing") {
      spell = actor.items.get(choice.id);
      if (!spell) throw new Error("The selected existing granted spell no longer exists.");
    } else {
      const sourceSpell = await fromUuid(choice.uuid);
      if (!sourceSpell || sourceSpell.type !== "spell") throw new Error("The canonical granted spell source is unavailable.");
      const itemData = foundry.utils.deepClone(sourceSpell.toObject());
      delete itemData._id;
      itemData.system ??= {};

      let sourceAdvancement = owner.toObject?.().system?.advancement?.[issue.data?.advancementId] ?? null;
      if (!sourceAdvancement && issue.data?.sourceOwnerUuid) {
        const sourceOwner = await fromUuid(issue.data.sourceOwnerUuid);
        sourceAdvancement = sourceOwner?.toObject?.().system?.advancement?.[issue.data?.sourceAdvancementId] ?? null;
      }
      const spellConfig = sourceAdvancement?.configuration?.spell ?? {};
      const abilities = this.#collectionValues(spellConfig.ability);
      if (abilities[0]) itemData.system.ability = abilities[0];
      if (spellConfig.method) itemData.system.method = spellConfig.method;
      if (issue.data?.expectedAlways) itemData.system.prepared = ALWAYS_PREPARED;
      else if (spellConfig.prepared != null) itemData.system.prepared = Number(spellConfig.prepared);
      if (issue.data?.expectedSourceItem) itemData.system.sourceItem = issue.data.expectedSourceItem;
      itemData.flags ??= {};
      itemData.flags.dnd5e ??= {};
      itemData.flags.dnd5e.sourceId = sourceSpell.uuid;
      itemData.flags.dnd5e.advancementOrigin = issue.data?.expectedOrigin;
      itemData.flags.dnd5e.advancementRoot = issue.data?.expectedOrigin;
      const [created] = await actor.createEmbeddedDocuments("Item", [itemData], {
        characterBuilderValidationRepair: true,
        characterBuilderValidationBuildProjection: true
      });
      if (!created) throw new Error(`D&D5e did not restore ${sourceSpell.name}.`);
      spell = created;
    }

    return this.#repairGrantedSpellOwnership(actor, {
      ...issue,
      data: { ...issue.data, spellId: spell.id }
    });
  }

  static async #repairGrantedSpellOwnership(actor, issue) {
    const spell = actor.items.get(issue.data?.spellId);
    const owner = actor.items.get(issue.data?.ownerId);
    if (!spell || !owner) throw new Error("The granted spell or owning build source no longer exists.");
    const ownerRecord = {
      category: this.#slug(owner.name || "validation-grant"),
      label: owner.name,
      classIdentifier: this.#classIdentifier(owner, actor),
      classItemId: this.#classItem(owner, actor)?.id ?? null,
      subclassItemId: owner.type === "subclass" ? owner.id : null,
      featureItemId: owner.type === "feat" ? owner.id : null,
      ownerItemId: owner.id,
      advancementId: issue.data?.advancementId ?? null,
      transactionId: null,
      acquiredAtCharacterLevel: null,
      acquiredAtClassLevel: Number(issue.data?.entitlementLevel ?? 0),
      sourceUuid: issue.data?.sourceUuid ?? spell.getFlag?.("dnd5e", "sourceId") ?? spell._stats?.compendiumSource ?? null,
      spellLevel: Number(spell.system?.level ?? 0),
      alwaysPrepared: Boolean(issue.data?.expectedAlways),
      nativeGrant: true,
      validationReconciled: true
    };
    await FeatureSpellOwnershipService.addOwner(spell, ownerRecord, {
      prepared: issue.data?.expectedAlways ? ALWAYS_PREPARED : null
    });
    await spell.update({
      ...(issue.data?.expectedSourceItem ? { "system.sourceItem": issue.data.expectedSourceItem } : {}),
      "flags.dnd5e.advancementOrigin": issue.data?.expectedOrigin,
      "flags.dnd5e.advancementRoot": issue.data?.expectedOrigin,
      ...(issue.data?.sourceUuid ? { "flags.dnd5e.sourceId": issue.data.sourceUuid } : {})
    }, {
      characterBuilderValidationRepair: true,
      characterBuilderValidationBuildProjection: true
    });
    return { status: "repaired", issueId: issue.id, title: issue.title, message: `Reconciled ${spell.name} ownership to ${owner.name}.` };
  }

  static async #restoreTraitMechanicalState(actor, issue) {
    const token = String(issue.data?.token ?? "");
    if (!token) throw new Error("The trait/proficiency token is missing from this validation finding.");
    await this.#writeMechanicalTrait(actor, token, Number(issue.data?.requiredRank ?? 1));
    return { status: "repaired", issueId: issue.id, title: issue.title, message: `Restored ${this.#traitTokenLabel(token)} on the revised Actor.` };
  }

  static async #reconcileTraitChoices(actor, issue) {
    const owner = actor.items.get(issue.data?.ownerId);
    if (!owner) throw new Error("The source Item for this Trait entitlement no longer exists.");
    const tokens = [...new Set((issue.data?.tokens ?? []).map(String).filter(Boolean))];
    if (!tokens.length) throw new Error("No existing Trait choices were supplied for reconciliation.");
    const localAdvancementId = await this.#ensureLocalTraitAdvancement(owner, issue);
    const raw = owner.toObject().system?.advancement?.[localAdvancementId];
    if (!raw) throw new Error("The Trait Advancement could not be reconstructed on the revised Actor.");
    const chosen = this.#collectionValues(raw.value?.chosen).map(String).filter(Boolean);
    for (const token of tokens) if (!chosen.includes(token)) chosen.push(token);
    await owner.update({ [`system.advancement.${localAdvancementId}.value.chosen`]: chosen }, {
      characterBuilderValidationRepair: true,
      characterBuilderValidationBuildProjection: true
    });
    for (const token of tokens) {
      await this.#recordValidationLink(owner, {
        kind: "trait",
        advancementId: localAdvancementId,
        value: token
      });
    }
    return {
      status: "repaired",
      issueId: issue.id,
      title: issue.title,
      message: `Reconciled existing ${tokens.map(token => this.#traitTokenLabel(token)).join(" / ")} to ${owner.name} without changing mechanical proficiency state.`
    };
  }

  static async #resolveTraitChoice(actor, issue) {
    const owner = actor.items.get(issue.data?.ownerId);
    if (!owner) throw new Error("The source Item for this Trait choice no longer exists.");
    const candidates = issue.data?.candidates ?? [];
    let action = "native";
    if (candidates.length) {
      action = await this.#promptTraitResolution(issue);
      if (!action) {
        return { status: "skipped", issueId: issue.id, title: issue.title, message: `${issue.title} remains unresolved because the choice dialog was cancelled.` };
      }
    }

    if (action !== "native") {
      const candidate = candidates.find(row => row.token === action);
      if (!candidate) throw new Error("The selected existing proficiency is no longer available to link.");
      const localAdvancementId = await this.#ensureLocalTraitAdvancement(owner, issue);
      const raw = owner.toObject().system?.advancement?.[localAdvancementId];
      if (!raw) throw new Error("The Trait Advancement could not be reconstructed on the revised Actor.");
      const chosen = this.#collectionValues(raw.value?.chosen).map(String).filter(Boolean);
      if (!chosen.includes(candidate.token)) chosen.push(candidate.token);
      await owner.update({ [`system.advancement.${localAdvancementId}.value.chosen`]: chosen }, {
        characterBuilderValidationRepair: true,
        characterBuilderValidationBuildProjection: true
      });
      await this.#recordValidationLink(owner, {
        kind: "trait",
        advancementId: localAdvancementId,
        value: candidate.token
      });
      return { status: "repaired", issueId: issue.id, title: issue.title, message: `Linked existing ${candidate.label} to ${owner.name}'s unresolved Trait entitlement.`, guided: true };
    }

    return this.#runNativeAdvancement(actor, issue);
  }

  static async #promptSpellResolution(issue) {
    const existing = issue.data?.orphanCandidates ?? [];
    const legal = issue.data?.legalOptions ?? [];
    const expectedIdentifier = issue.data?.expectedIdentifier ?? null;
    const deterministic = Boolean(issue.data?.deterministic);
    const choices = [];
    for (const row of existing) choices.push({ value: `existing:${row.id}`, label: `Link existing — ${row.name}${row.level ? ` (Level ${row.level})` : " (Cantrip)"}` });
    for (const row of legal) choices.push({ value: `new:${row.uuid}`, label: `${deterministic ? "Restore canonical" : "Choose new"} — ${row.name}${row.level ? ` (Level ${row.level})` : " (Cantrip)"}` });
    if (expectedIdentifier && issue.data?.resolvedUuid && !legal.some(row => row.uuid === issue.data.resolvedUuid)) {
      choices.push({ value: `new:${issue.data.resolvedUuid}`, label: "Restore canonical source copy" });
    }
    if (!choices.length) throw new Error("No legal spell resolution is currently available for this entitlement.");

    const selectOptions = choices.map(row => `<option value="${foundry.utils.escapeHTML(row.value)}">${foundry.utils.escapeHTML(row.label)}</option>`).join("");
    const content = `<form class="standard-form"><p>${foundry.utils.escapeHTML(issue.summary ?? "Resolve the missing spell entitlement.")}</p><div class="form-group"><label>Resolution</label><div class="form-fields"><select name="resolution">${selectOptions}</select></div></div></form>`;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2?.wait) throw new Error("Foundry DialogV2 is unavailable for guided spell reconciliation.");
    const result = await DialogV2.wait({
      window: { title: issue.title ?? "Resolve Spell Entitlement", modal: true },
      content,
      buttons: [
        {
          action: "apply", label: "Apply", icon: "fa-solid fa-check", default: true,
          callback: (_event, button) => new foundry.applications.ux.FormDataExtended(button.form).object.resolution
        },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => null }
      ],
      close: () => null
    });
    if (!result) return null;
    if (String(result).startsWith("existing:")) return { mode: "existing", id: String(result).slice("existing:".length) };
    if (String(result).startsWith("new:")) return { mode: "new", uuid: String(result).slice("new:".length) };
    return null;
  }

  static async #promptTraitResolution(issue) {
    const options = (issue.data?.candidates ?? [])
      .map(row => `<option value="${foundry.utils.escapeHTML(row.token)}">Link existing — ${foundry.utils.escapeHTML(row.label)}</option>`)
      .join("");
    const content = `<form class="standard-form"><p>${foundry.utils.escapeHTML(issue.summary ?? "Resolve the missing choice.")}</p><div class="form-group"><label>Resolution</label><div class="form-fields"><select name="resolution">${options}<option value="native">Open native D&D5e choice</option></select></div></div></form>`;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2?.wait) throw new Error("Foundry DialogV2 is unavailable for guided Trait reconciliation.");
    return DialogV2.wait({
      window: { title: issue.title ?? "Resolve Trait Entitlement", modal: true },
      content,
      buttons: [
        {
          action: "apply", label: "Apply", icon: "fa-solid fa-check", default: true,
          callback: (_event, button) => new foundry.applications.ux.FormDataExtended(button.form).object.resolution
        },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => null }
      ],
      close: () => null
    });
  }

  static async #runNativeAdvancement(actor, issue) {
    const owner = actor.items.get(issue.data?.ownerId);
    const Manager = globalThis.dnd5e?.applications?.advancement?.AdvancementManager;
    if (!owner || !Manager) throw new Error("D&D5e AdvancementManager is unavailable for this repair.");
    let manager;
    if (issue.data?.mode === "add") {
      const sourceDocument = await fromUuid(issue.data?.sourceUuid);
      const advancement = sourceDocument?.advancement?.byId?.[issue.data?.sourceAdvancementId]
        ?? this.#collectionValues(sourceDocument?.advancement).find(row => (row.id ?? row._id) === issue.data?.sourceAdvancementId);
      if (!advancement) throw new Error("The canonical source Advancement is unavailable.");
      manager = Manager.forNewAdvancement(actor, owner.id, [advancement], {
        automaticApplication: true,
        showVisualizer: false,
        characterBuilderValidationRepair: true,
        characterBuilderValidationBuildProjection: true
      });
    } else {
      manager = Manager.forModifyChoices(actor, owner.id, Number(issue.data?.level ?? 0), {
        automaticApplication: true,
        showVisualizer: false,
        characterBuilderValidationRepair: true,
        characterBuilderValidationBuildProjection: true
      });
      const targetId = String(issue.data?.localAdvancementId ?? "");
      if (targetId) {
        manager.steps = manager.steps.filter(step => {
          const id = step?.flow?.advancement?.id ?? step?.flow?.advancement?._id ?? null;
          return String(id ?? "") === targetId;
        });
      }
    }
    if (!manager?.steps?.length) throw new Error("No native Advancement step could be created for this missing choice.");
    const result = await NativeAdvancementModalGuard.run(manager);
    if (!result.completed) return { status: "skipped", issueId: issue.id, title: issue.title, message: `${issue.title} remains unresolved because the native Advancement was cancelled.` };
    return { status: "repaired", issueId: issue.id, title: issue.title, message: `${issue.title} was resolved through the native D&D5e Advancement workflow.`, guided: true };
  }

  static #normalClassSpellData(source, cls, data, { category } = {}) {
    const itemData = foundry.utils.deepClone(source.toObject());
    delete itemData._id;
    itemData.system ??= {};
    itemData.system.ability = cls.system?.spellcasting?.ability ?? itemData.system.ability ?? "";
    itemData.system.method = cls.system?.spellcasting?.progression === "pact" ? "pact" : "spell";
    const prepared = category === "cantrip" ? ALWAYS_PREPARED
      : data?.accessModel === "limited" ? 1
      : 0;
    itemData.system.prepared = prepared;
    itemData.system.sourceItem = `class:${data?.classIdentifier ?? cls.system?.identifier}`;
    itemData.flags ??= {};
    itemData.flags.dnd5e ??= {};
    itemData.flags.dnd5e.sourceId = source.uuid;
    itemData.flags[MODULE_ID] ??= {};
    itemData.flags[MODULE_ID].levelUpSpell = {
      transactionId: `validation:${cls.actor?.id ?? "actor"}:${cls.id}:${data?.category ?? category}:${data?.entitlementLevel ?? 0}:${data?.slotIndex ?? 0}`,
      classIdentifier: data?.classIdentifier ?? cls.system?.identifier,
      classItemId: cls.id,
      subclassItemId: null,
      accessModel: data?.accessModel ?? null,
      acquiredAtCharacterLevel: null,
      acquiredAtClassLevel: Number(cls.system?.levels ?? 0) || null,
      validationEntitlementLevel: Number(data?.entitlementLevel ?? 0) || null,
      category: data?.category ?? category,
      featureItemId: null,
      sourceUuid: source.uuid,
      validationReconciled: true
    };
    if (data?.accessModel === "fullList") {
      itemData.flags[MODULE_ID].classSpellAccess = true;
      itemData.flags[MODULE_ID].classIdentifier = data?.classIdentifier ?? cls.system?.identifier;
      itemData.flags[MODULE_ID].classItemId = cls.id;
      itemData.flags[MODULE_ID].accessModel = "fullList";
      itemData.flags[MODULE_ID].category = "full-list";
    }
    return itemData;
  }

  static #normalClassSpellUpdate(spell, cls, data) {
    const sourceUuid = spell.getFlag?.("dnd5e", "sourceId") ?? spell._stats?.compendiumSource ?? null;
    const category = data?.category ?? (Number(spell.system?.level ?? 0) === 0 ? "cantrip" : data?.accessModel ?? "limited");
    const prepared = category === "cantrip" ? ALWAYS_PREPARED
      : data?.accessModel === "limited" ? 1
      : Number(spell.system?.prepared ?? 0);
    return {
      "system.ability": cls.system?.spellcasting?.ability ?? spell.system?.ability ?? "",
      "system.method": cls.system?.spellcasting?.progression === "pact" ? "pact" : "spell",
      "system.prepared": prepared,
      "system.sourceItem": `class:${data?.classIdentifier ?? cls.system?.identifier}`,
      ...(sourceUuid ? { "flags.dnd5e.sourceId": sourceUuid } : {}),
      [`flags.${MODULE_ID}.levelUpSpell`]: {
        transactionId: `validation:${spell.actor?.id ?? "actor"}:${cls.id}:${category}:${data?.entitlementLevel ?? 0}:${data?.slotIndex ?? 0}`,
        classIdentifier: data?.classIdentifier ?? cls.system?.identifier,
        classItemId: cls.id,
        subclassItemId: null,
        accessModel: data?.accessModel ?? null,
        acquiredAtCharacterLevel: null,
        acquiredAtClassLevel: Number(spell.getFlag?.(MODULE_ID, "levelUpSpell")?.acquiredAtClassLevel) || null,
        validationEntitlementLevel: Number(data?.entitlementLevel ?? 0) || null,
        category,
        featureItemId: null,
        sourceUuid,
        validationReconciled: true
      },
      ...(data?.accessModel === "fullList" ? {
        [`flags.${MODULE_ID}.classSpellAccess`]: true,
        [`flags.${MODULE_ID}.classIdentifier`]: data?.classIdentifier ?? cls.system?.identifier,
        [`flags.${MODULE_ID}.classItemId`]: cls.id,
        [`flags.${MODULE_ID}.accessModel`]: "fullList",
        [`flags.${MODULE_ID}.category`]: "full-list"
      } : {})
    };
  }

  static async #ensureLocalTraitAdvancement(owner, issue) {
    if (issue.data?.localAdvancementId && owner.toObject().system?.advancement?.[issue.data.localAdvancementId]) {
      return issue.data.localAdvancementId;
    }
    const source = await fromUuid(issue.data?.sourceUuid);
    const raw = source?.toObject?.().system?.advancement?.[issue.data?.sourceAdvancementId];
    if (!raw) throw new Error("The canonical Trait Advancement could not be loaded for reconciliation.");
    const id = issue.data.sourceAdvancementId;
    const data = foundry.utils.deepClone(raw);
    data.value = foundry.utils.deepClone(data.value ?? {});
    data.value.chosen = this.#collectionValues(data.value.chosen).map(String).filter(Boolean);
    await owner.update({ [`system.advancement.${id}`]: data }, {
      characterBuilderValidationRepair: true,
      characterBuilderValidationBuildProjection: true
    });
    return id;
  }

  static async #recordValidationLink(owner, row) {
    const existing = foundry.utils.deepClone(owner.getFlag?.(MODULE_ID, "validationEntitlementLinks") ?? []);
    const key = `${row.kind}:${row.advancementId}:${row.value}`;
    const filtered = existing.filter(entry => entry?.key !== key);
    filtered.push({ key, ...row, reconciledAt: Date.now(), reconciledBy: game.user?.id ?? null });
    await owner.setFlag(MODULE_ID, "validationEntitlementLinks", filtered);
  }

  // -----------------------------------------------------------------------
  // Spell helpers
  // -----------------------------------------------------------------------

  static #spellModel(identifier, progression) {
    if (SPELL_ACCESS_MODELS.fullList.has(identifier)) return "fullList";
    if (SPELL_ACCESS_MODELS.limited.has(identifier)) return "limited";
    if (SPELL_ACCESS_MODELS.spellbook.has(identifier)) return "spellbook";
    return progression === "none" ? "none" : "limited";
  }

  static async #classSpellPool(identifier, registry) {
    const spellLists = globalThis.dnd5e?.registry?.spellLists;
    if (!spellLists) throw new Error("D&D5e spell-list registry is unavailable.");
    for (let attempt = 0; attempt < 20 && !spellLists.ready; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    const list = spellLists.forType?.("class", identifier);
    if (!list) throw new Error(`No registered class spell list was found for ${identifier}.`);
    const rows = new Map();
    for (const index of list.indexes ?? []) {
      const spellIdentifier = index.system?.identifier;
      if (!spellIdentifier) continue;
      const preferred = registry.preferredOption("spell", spellIdentifier);
      if (!preferred) continue;
      rows.set(spellIdentifier, preferred);
    }
    return [...rows.values()].sort((a, b) => Number(a.system?.level ?? 0) - Number(b.system?.level ?? 0)
      || a.name.localeCompare(b.name, game.i18n.lang));
  }

  static #isNormalClassSpell(spell, cls, actor) {
    if (!spell || spell.type !== "spell") return false;
    const access = spell.getFlag?.(MODULE_ID, "classSpellAccess");
    const classMatches = spell.getFlag?.(MODULE_ID, "classItemId") === cls.id
      || spell.getFlag?.(MODULE_ID, "classIdentifier") === cls.system?.identifier;
    const category = String(spell.getFlag?.(MODULE_ID, "category") ?? "");

    // A single physical Spell can legitimately satisfy both normal class access
    // and a native grant/Always Prepared entitlement. Explicit normal-access
    // metadata wins over auxiliary feature ownership/origin metadata. Feature-
    // additive categories (for example primal-order-magician/thaumaturge) are
    // deliberately excluded so they never consume a base class cantrip slot.
    if (access && classMatches && this.#isNormalClassCategory(category)) return true;
    const reconciliation = spell.getFlag?.(MODULE_ID, "alwaysPreparedReconciliation");
    if (reconciliation?.normalAcquisition?.classIdentifier === cls.system?.identifier) return true;
    const levelUp = spell.getFlag?.(MODULE_ID, "levelUpSpell");
    if (levelUp?.classItemId === cls.id && !levelUp.featureItemId) return true;

    const featureOwners = spell.getFlag?.(MODULE_ID, "featureSpellOwners") ?? [];
    if (featureOwners.length || spell.getFlag?.(MODULE_ID, "featureGrantedSpell")) return false;
    const advancementOrigin = String(spell.getFlag?.("dnd5e", "advancementOrigin") ?? "");
    if (advancementOrigin) return false;
    return String(spell.system?.sourceItem ?? "") === `class:${cls.system?.identifier}`
      && this.#spellClassIdentifier(spell, actor) === cls.system?.identifier;
  }

  static #isNormalClassCategory(category) {
    return ["", "cantrip", "full-list", "limited", "leveled", "spellbook"].includes(String(category ?? ""));
  }

  static #isUnownedSpell(spell) {
    if (!spell || spell.type !== "spell") return false;
    const moduleFlags = spell.flags?.[MODULE_ID] ?? {};
    const dndFlags = spell.flags?.dnd5e ?? {};
    if (moduleFlags.classSpellAccess || moduleFlags.levelUpSpell || moduleFlags.featureGrantedSpell
      || (moduleFlags.featureSpellOwners ?? []).length || moduleFlags.pactOfTheTomeSelection) return false;
    if (dndFlags.advancementOrigin || dndFlags.advancementRoot) return false;
    const sourceItem = String(spell.system?.sourceItem ?? "").trim();
    return !sourceItem;
  }

  static #recordedClassAcquisitionLevel(spell, cls) {
    const levelUp = spell.getFlag?.(MODULE_ID, "levelUpSpell");
    if (levelUp?.classItemId === cls.id && Number(levelUp.acquiredAtClassLevel) > 0) return Number(levelUp.acquiredAtClassLevel);
    if (spell.getFlag?.(MODULE_ID, "classSpellAccess") && (spell.getFlag?.(MODULE_ID, "classItemId") === cls.id
      || spell.getFlag?.(MODULE_ID, "classIdentifier") === cls.system?.identifier)) return 1;
    return null;
  }

  static #spellClassIdentifier(item, actor, seen = new Set()) {
    const explicit = item.getFlag?.(MODULE_ID, "classSpellAccess")?.classIdentifier
      ?? item.getFlag?.(MODULE_ID, "classIdentifier")
      ?? item.getFlag?.(MODULE_ID, "levelUpSpell")?.classIdentifier
      ?? item.system?.classIdentifier;
    if (explicit) return String(explicit);
    const sourceItem = String(item.system?.sourceItem ?? "");
    if (sourceItem.startsWith("class:")) return sourceItem.slice("class:".length);
    if (sourceItem.startsWith("subclass:")) {
      const subclassId = sourceItem.slice("subclass:".length);
      const subclass = actor.items.find(doc => doc.type === "subclass" && doc.system?.identifier === subclassId);
      const parent = subclass?.system?.classIdentifier ?? subclass?.system?.class?.identifier ?? subclass?.system?.class;
      if (parent) return String(parent);
    }
    for (const reference of [item.getFlag?.("dnd5e", "advancementRoot"), item.getFlag?.("dnd5e", "advancementOrigin")].filter(Boolean)) {
      const ownerId = String(reference).split(".")[0];
      const owner = actor.items.get(ownerId);
      if (!owner || seen.has(owner.id)) continue;
      seen.add(owner.id);
      if (owner.type === "class") return owner.system?.identifier ?? null;
      if (owner.type === "subclass") return owner.system?.classIdentifier ?? owner.system?.class?.identifier ?? owner.system?.class ?? null;
      const inherited = this.#spellClassIdentifier(owner, actor, seen);
      if (inherited) return inherited;
    }
    return null;
  }

  static #spellOption(pool, identifier) {
    return pool.find(row => String(row.identifier ?? "") === String(identifier ?? "")) ?? null;
  }

  static #scaleChoiceSlots(sourceClass, classLevel, selector) {
    const advancement = this.#findScaleAdvancement(sourceClass, selector);
    if (!advancement) return [];
    const points = Object.entries(advancement.configuration?.scale ?? {})
      .map(([level, row]) => ({ level: Number(level), value: Number(row?.value ?? 0) }))
      .filter(row => Number.isFinite(row.level) && row.level <= classLevel)
      .sort((a, b) => a.level - b.level);
    const slots = [];
    let previous = 0;
    let index = 0;
    for (const point of points) {
      const delta = Math.max(0, point.value - previous);
      for (let i = 0; i < delta; i++) slots.push({ level: point.level, index: index++ });
      previous = point.value;
    }
    return slots;
  }

  static #wizardSpellbookSlots(level) {
    const slots = [];
    let index = 0;
    for (let i = 0; i < (level >= 1 ? 6 : 0); i++) slots.push({ level: 1, index: index++ });
    for (let current = 2; current <= level; current++) {
      for (let i = 0; i < 2; i++) slots.push({ level: current, index: index++ });
    }
    return slots;
  }

  static #scaleValue(sourceClass, level, selector) {
    const advancement = this.#findScaleAdvancement(sourceClass, selector);
    if (!advancement) return 0;
    const rows = Object.entries(advancement.configuration?.scale ?? {})
      .map(([minimum, row]) => [Number(minimum), Number(row?.value ?? 0)])
      .filter(([minimum]) => Number.isFinite(minimum) && minimum <= level)
      .sort((a, b) => a[0] - b[0]);
    return rows.at(-1)?.[1] ?? 0;
  }

  static #findScaleAdvancement(sourceClass, { identifier = null, title = null } = {}) {
    return this.#advancementEntries(sourceClass).map(([, row]) => row).find(row => {
      if (row?.type !== "ScaleValue") return false;
      if (identifier && row.configuration?.identifier === identifier) return true;
      return title && String(row.title ?? "").toLowerCase().includes(String(title).toLowerCase());
    }) ?? null;
  }

  static #maximumSpellLevel(progression, level) {
    switch (progression) {
      case "full": return Math.min(9, Math.ceil(level / 2));
      case "half": return Math.min(5, Math.max(1, Math.floor((level + 3) / 4)));
      case "third": return Math.min(4, Math.max(1, Math.floor((level + 2) / 3)));
      case "pact": return Math.min(5, Math.ceil(level / 2));
      default: return 0;
    }
  }

  static #firstAccessibleSpellLevel(progression, spellLevel) {
    for (let classLevel = 1; classLevel <= 20; classLevel++) {
      if (this.#maximumSpellLevel(progression, classLevel) >= spellLevel) return classLevel;
    }
    return 20;
  }

  static #spellCategoryLabel(category) {
    if (category === "cantrip") return "Cantrip";
    if (category === "spellbook") return "Spellbook Spell";
    if (category === "full-list") return "Class Spell";
    return "Prepared/Known Spell";
  }

  static #sameSpellIdentity(item, source) {
    const itemSource = item.getFlag?.("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? null;
    if (itemSource && source.uuid && itemSource === source.uuid) return true;
    return Boolean(item.system?.identifier && source.system?.identifier
      && item.system.identifier === source.system.identifier);
  }

  static #expectedGrantSourceItem(owner, actor, advancement = null) {
    const identifier = String(owner.system?.identifier ?? "").trim();
    if (!identifier) return null;

    // A class-owned Fighting Style can grant spell choices (for example the
    // Paladin/Ranger cantrip styles). Those spells count mechanically as spells
    // of the parent class, while featureSpellOwners carries the more specific
    // choice provenance. This mirrors the Character Builder's existing nested
    // feature ownership policy instead of rewriting them as generic feat spells.
    const subtype = String(owner.system?.type?.subtype ?? "");
    if (owner.type === "feat" && subtype === "fightingStyle"
      && advancement?.type === "ItemChoice" && String(advancement.configuration?.type ?? "") === "spell") {
      const classIdentifier = this.#classIdentifier(owner, actor);
      if (classIdentifier) return `class:${classIdentifier}`;
    }
    return `${owner.type}:${identifier}`;
  }

  // -----------------------------------------------------------------------
  // Trait helpers
  // -----------------------------------------------------------------------

  static #traitAdvancementApplies(actor, owner, advancement) {
    if (owner.type !== "class") return true;
    const restriction = String(advancement.classRestriction ?? advancement.configuration?.classRestriction ?? "").trim();
    if (!restriction) return true;
    const classes = actor.items.filter(item => item.type === "class");
    let originalId = String(actor.system?.details?.originalClass ?? "").trim();
    if (originalId.includes(".")) originalId = originalId.split(".").at(-1);
    if (!originalId && classes.length === 1) originalId = classes[0].id;
    if (!originalId && classes.length > 1) return null;
    const primary = owner.id === originalId;
    if (restriction === "primary") return primary;
    if (restriction === "secondary") return !primary;
    return true;
  }

  static #traitPools(advancement) {
    return (advancement.configuration?.choices ?? []).flatMap(choice => this.#collectionValues(choice?.pool)).map(String).filter(Boolean);
  }

  static #traitChoiceCapacity(advancement) {
    return (advancement.configuration?.choices ?? []).reduce((sum, choice) => sum + Math.max(0, Number(choice?.count ?? 0)), 0);
  }

  static #traitTokenMatchesPools(token, pools) {
    if (!pools?.length) return false;
    return pools.some(pool => this.#traitTokenMatchesPool(token, pool));
  }

  static #traitTokenMatchesPool(token, pool) {
    const value = String(token ?? "");
    const pattern = String(pool ?? "");
    if (pattern === value) return true;
    if (!pattern.includes("*")) return false;
    const regex = new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return regex.test(value);
  }

  static #actorTraitTokens(actor) {
    const rows = [];
    for (const [key, skill] of Object.entries(actor.system?.skills ?? {})) if (Number(skill?.value ?? 0) > 0) rows.push(`skills:${key}`);
    for (const [key, ability] of Object.entries(actor.system?.abilities ?? {})) if (Number(ability?.proficient ?? 0) > 0) rows.push(`saves:${key}`);
    for (const language of this.#collectionValues(actor.system?.traits?.languages?.value)) rows.push(`languages:standard:${language}`);
    for (const weapon of this.#collectionValues(actor.system?.traits?.weaponProf?.value)) rows.push(`weapon:${weapon}`);
    for (const armor of this.#collectionValues(actor.system?.traits?.armorProf?.value)) rows.push(`armor:${armor}`);
    for (const family of ["dr", "di", "dv", "ci"]) {
      for (const value of this.#collectionValues(actor.system?.traits?.[family]?.value)) rows.push(`${family}:${value}`);
    }
    for (const [key, tool] of Object.entries(actor.system?.tools ?? {})) {
      if (Number(tool?.value ?? 0) <= 0) continue;
      const type = this.#toolTypeForKey(key);
      rows.push(`tool:${type}:${key}`);
    }
    return [...new Set(rows)];
  }

  static #mechanicalTraitPresent(actor, token, requiredRank = 1) {
    const parts = String(token ?? "").split(":");
    switch (parts[0]) {
      case "skills": return Number(actor.system?.skills?.[parts[1]]?.value ?? 0) >= requiredRank;
      case "saves": return Number(actor.system?.abilities?.[parts[1]]?.proficient ?? 0) >= requiredRank;
      case "languages": return this.#collectionValues(actor.system?.traits?.languages?.value).map(String).includes(parts.at(-1));
      case "weapon": return this.#collectionValues(actor.system?.traits?.weaponProf?.value).map(String).includes(this.#traitStorageValue(parts));
      case "armor": return this.#collectionValues(actor.system?.traits?.armorProf?.value).map(String).includes(this.#traitStorageValue(parts));
      case "tool": return Number(actor.system?.tools?.[parts.at(-1)]?.value ?? 0) >= requiredRank;
      case "dr":
      case "di":
      case "dv":
      case "ci": return this.#collectionValues(actor.system?.traits?.[parts[0]]?.value).map(String).includes(parts.at(-1));
      default: return null;
    }
  }

  static async #writeMechanicalTrait(actor, token, requiredRank = 1) {
    const parts = String(token ?? "").split(":");
    switch (parts[0]) {
      case "skills":
        return actor.update({ [`system.skills.${parts[1]}.value`]: Math.max(requiredRank, Number(actor.system?.skills?.[parts[1]]?.value ?? 0)) }, { characterBuilderValidationRepair: true });
      case "saves":
        return actor.update({ [`system.abilities.${parts[1]}.proficient`]: Math.max(requiredRank, Number(actor.system?.abilities?.[parts[1]]?.proficient ?? 0)) }, { characterBuilderValidationRepair: true });
      case "languages": {
        const values = this.#collectionValues(actor.system?.traits?.languages?.value).map(String);
        const value = parts.at(-1);
        if (!values.includes(value)) values.push(value);
        return actor.update({ "system.traits.languages.value": values }, { characterBuilderValidationRepair: true });
      }
      case "weapon": {
        const values = this.#collectionValues(actor.system?.traits?.weaponProf?.value).map(String);
        const value = this.#traitStorageValue(parts);
        if (!values.includes(value)) values.push(value);
        return actor.update({ "system.traits.weaponProf.value": values }, { characterBuilderValidationRepair: true });
      }
      case "armor": {
        const values = this.#collectionValues(actor.system?.traits?.armorProf?.value).map(String);
        const value = this.#traitStorageValue(parts);
        if (!values.includes(value)) values.push(value);
        return actor.update({ "system.traits.armorProf.value": values }, { characterBuilderValidationRepair: true });
      }
      case "tool": {
        const key = parts.at(-1);
        return actor.update({ [`system.tools.${key}.value`]: Math.max(requiredRank, Number(actor.system?.tools?.[key]?.value ?? 0)) }, { characterBuilderValidationRepair: true });
      }
      case "dr":
      case "di":
      case "dv":
      case "ci": {
        const family = parts[0];
        const values = this.#collectionValues(actor.system?.traits?.[family]?.value).map(String);
        const value = parts.at(-1);
        if (!values.includes(value)) values.push(value);
        return actor.update({ [`system.traits.${family}.value`]: values }, { characterBuilderValidationRepair: true });
      }
      default:
        throw new Error(`Unsupported Trait token family: ${parts[0] || "unknown"}`);
    }
  }

  static #traitStorageValue(parts) {
    if (!Array.isArray(parts) || parts.length < 2) return "";
    // Native D&D5e tokens encode specific weapon families as
    // weapon:mar:handcrossbow. The Actor stores the concrete final key, not
    // the broad `mar` category. Broad grants such as weapon:sim remain `sim`.
    return String(parts.length > 2 ? parts.at(-1) : parts[1]);
  }

  static #traitReservationKey(token, requiredRank = 1) {
    const parts = String(token ?? "").split(":");
    let identity;
    if (parts[0] === "languages") identity = `languages:${parts.at(-1)}`;
    else if (parts[0] === "tool") identity = `tool:${parts.at(-1)}`;
    else if (parts[0] === "weapon" || parts[0] === "armor") identity = `${parts[0]}:${this.#traitStorageValue(parts)}`;
    else identity = `${parts[0]}:${parts.slice(1).join(":")}`;
    return `rank:${Math.max(1, Number(requiredRank ?? 1))}:${identity}`;
  }

  static #badgeChosenTokens(actor, owner, advancementId, pools, requiredRank = 1) {
    if (!advancementId || !pools?.length) return [];
    const badges = [...(actor.items ?? [])].flatMap(item => item.getFlag?.(MODULE_ID, "advancementChoiceBadges") ?? []);
    const matching = badges.filter(badge => String(badge?.sourceItemId ?? "") === String(owner.id)
      && String(badge?.advancementId ?? "") === String(advancementId));
    if (!matching.length) return [];
    const legalMechanical = this.#actorTraitTokens(actor).filter(token => this.#traitTokenMatchesPools(token, pools)
      && this.#mechanicalTraitPresent(actor, token, requiredRank) === true);
    const byLabel = new Map(legalMechanical.map(token => [this.#normalizeLabel(this.#traitTokenLabel(token)), token]));
    const rows = [];
    for (const badge of matching) {
      for (const value of badge?.values ?? []) {
        const token = byLabel.get(this.#normalizeLabel(value));
        if (token) rows.push(token);
      }
    }
    return [...new Set(rows)];
  }

  static #normalizeLabel(value) {
    return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  }

  static #traitTokenLabel(token) {
    const parts = String(token ?? "").split(":");
    const key = parts.at(-1);
    const config = globalThis.CONFIG?.DND5E ?? {};
    const lookup = value => {
      if (typeof value === "string") return game.i18n?.localize?.(value) ?? value;
      return value?.label ? (game.i18n?.localize?.(value.label) ?? value.label) : null;
    };
    if (parts[0] === "skills") return lookup(config.skills?.[key]) ?? this.#title(key);
    if (parts[0] === "saves") return `${lookup(config.abilities?.[key]) ?? this.#title(key)} Saving Throw`;
    if (parts[0] === "languages") return lookup(config.languages?.[key]) ?? this.#title(key);
    if (parts[0] === "weapon") return lookup(config.weaponTypes?.[key]) ?? this.#title(key);
    if (parts[0] === "armor") return lookup(config.armorTypes?.[key]) ?? this.#title(key);
    if (["dr", "di", "dv"].includes(parts[0])) return lookup(config.damageTypes?.[key]) ?? this.#title(key);
    if (parts[0] === "ci") return lookup(config.conditionTypes?.[key] ?? config.conditions?.[key]) ?? this.#title(key);
    if (parts[0] === "tool") {
      const toolConfig = config.tools?.[key];
      const toolDocument = toolConfig?.id ? fromUuidSync?.(toolConfig.id) : null;
      return toolDocument?.name ?? lookup(toolConfig) ?? this.#title(key);
    }
    return this.#title(key);
  }

  static #toolTypeForKey(key) {
    const config = globalThis.CONFIG?.DND5E?.tools?.[key];
    if (config?.type || config?.category) return String(config.type ?? config.category);
    const document = config?.id ? fromUuidSync?.(config.id) : null;
    return String(document?.system?.type?.value ?? document?.system?.type ?? "*") || "*";
  }

  // -----------------------------------------------------------------------
  // Shared helpers
  // -----------------------------------------------------------------------

  static #advancementEntries(document) {
    const raw = document?.toObject?.().system?.advancement ?? document?.system?.advancement ?? {};
    return Object.entries(raw ?? {});
  }

  static #firstAdvancementLevel(advancement) {
    const own = Number(advancement?.level);
    if (Number.isFinite(own)) return own;
    const levels = Object.keys(advancement?.configuration?.choices ?? {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    return levels[0] ?? 0;
  }


  static #mergedGrantReceipt(spell, { ownerId, advancementId, sourceUuid } = {}) {
    const expectedOwner = String(ownerId ?? "");
    const expectedAdvancement = String(advancementId ?? "");
    const expectedSource = String(sourceUuid ?? "");
    if (!expectedOwner || !expectedAdvancement) return null;
    const receipts = spell.getFlag?.(MODULE_ID, "mergedItemGrants") ?? [];
    return receipts.find(receipt => {
      if (String(receipt?.ownerItemId ?? "") !== expectedOwner) return false;
      if (String(receipt?.advancementId ?? "") !== expectedAdvancement) return false;
      if (!expectedSource) return true;
      return [receipt?.configuredUuid, receipt?.sourceUuid].some(uuid => String(uuid ?? "") === expectedSource);
    }) ?? null;
  }

  static #flattenAddedMappings(value, rows = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return rows;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string") rows.push({ itemId: key, uuid: child });
      else if (child && typeof child === "object") this.#flattenAddedMappings(child, rows);
    }
    return rows;
  }

  static #classIdentifier(owner, actor) {
    if (!owner) return null;
    if (owner.type === "class") return owner.system?.identifier ?? null;
    if (owner.type === "subclass") return owner.system?.classIdentifier ?? owner.system?.class?.identifier ?? owner.system?.class ?? null;
    const root = String(owner.getFlag?.("dnd5e", "advancementRoot") ?? owner.getFlag?.("dnd5e", "advancementOrigin") ?? "");
    const rootItem = actor.items.get(root.split(".")[0]);
    return rootItem && rootItem.id !== owner.id ? this.#classIdentifier(rootItem, actor) : null;
  }

  static #classItem(owner, actor) {
    const identifier = this.#classIdentifier(owner, actor);
    return identifier ? actor.items.find(item => item.type === "class" && item.system?.identifier === identifier) : null;
  }

  static #hasFeature(actor, identifier) {
    return actor.items.some(item => item.type === "feat" && String(item.system?.identifier ?? "") === identifier);
  }

  static #collectionValues(value) {
    if (!value) return [];
    if (Array.isArray(value)) return [...value];
    if (value instanceof Set) return [...value];
    if (value?.contents) return [...value.contents];
    if (value?.values) return [...value.values()];
    try { return [...value]; } catch (_error) { return []; }
  }

  static #title(value) {
    return String(value ?? "").replace(/[-_]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
  }

  static #slug(value) {
    return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
}
