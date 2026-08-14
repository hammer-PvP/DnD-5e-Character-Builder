import { MODULE_ID } from "../constants.mjs";
import { NativeAdvancementModalGuard } from "./native-advancement-modal-guard.mjs";
import { SpellPreparationPolicyService } from "./spell-preparation-policy-service.mjs";
import { FeatureSpellOwnershipService } from "./feature-spell-ownership-service.mjs";
import { AdvancementChoiceAnnotationService } from "./advancement-choice-annotation-service.mjs";
import { CharacterValidationBuildProjectionService } from "./character-validation-build-projection-service.mjs";

const PHYSICAL_ITEM_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "container", "loot"]);
const CANONICAL_OWNER_TYPES = new Set(["class", "subclass", "race", "background", "feat"]);
const BLOCKING_ADVANCEMENT_COMPLETION_KINDS = new Set([
  "advancement-choice-incomplete",
  "subclass-entitlement-incomplete",
  "weapon-mastery-incomplete",
  "fighting-style-incomplete",
  "trait-grant-missing",
  "trait-choice-mechanical-missing",
  "trait-choice-incomplete"
]);
const BLOCKING_TRAIT_COMPLETION_KINDS = new Set([
  "trait-grant-missing",
  "trait-choice-mechanical-missing",
  "trait-choice-incomplete"
]);

/**
 * Rule-oriented progression audit used by Character Validation.
 *
 * This service deliberately treats the enabled D&D5e/PHB source documents as a
 * rules projection, not as a reason to replace the Actor wholesale. It compares
 * demonstrable entitlements against the live revised Actor and only offers a
 * repair when the missing state can be reconstructed without inventing a past
 * choice. Human choices are delegated back to D&D5e's native Advancement flow.
 */
export class CharacterValidationProgressionService {
  static async scan(actor, registry) {
    const issues = [];
    const graph = await this.#buildEntitlementGraph(actor, registry);
    const sourceOwners = graph.owners;

    // Global completion comes first: a parent Item being present is not enough
    // when one of its own Advancements still has unresolved dependent choices.
    issues.push(...await this.#scanAdvancementCompletion(actor, registry, graph));
    issues.push(...await this.#scanWeaponMastery(actor, registry, sourceOwners));
    issues.push(...await this.#scanFightingStyles(actor, registry, sourceOwners));
    issues.push(...await this.#scanCanonicalItemGrants(actor, registry, sourceOwners));
    issues.push(...this.#scanChoiceStateReconciliation(actor, graph));
    issues.push(...await this.#scanLegacyOriginFeatMismatch(actor, registry, graph));
    issues.push(...this.#scanSameOriginSpellDuplicates(actor));
    issues.push(...this.#scanWarlockInvocationCount(actor, sourceOwners));
    const buildProjection = await CharacterValidationBuildProjectionService.scan(actor, registry, graph);
    issues.push(...buildProjection.issues);

    return {
      issues,
      coverage: [
        ...(buildProjection.coverage ?? []),
        { id: "entitlement-graph", label: "Entitlement / Advancement Graph", status: "checked" },
        { id: "advancement-completion", label: "Dependent Advancement Completion", status: "checked" },
        { id: "choice-state", label: "Choice State / CB Metadata", status: "checked" },
        { id: "progression-grants", label: "Class / Subclass Grants", status: "checked" },
        { id: "weapon-mastery", label: "Weapon Mastery", status: "checked" },
        { id: "fighting-style", label: "Fighting Style", status: "checked" },
        { id: "origin-feat-migration", label: "Origin Feat Migration", status: "audit" },
        { id: "spell-grants", label: "Granted / Always Prepared Spells", status: "checked" },
        { id: "spell-duplicates", label: "Same-Origin Spell Duplicates", status: "checked" },
        { id: "invocations", label: "Eldritch Invocation Count", status: "audit" },
        { id: "asi-feat", label: "ASI / Feat Replay", status: "planned" }
      ]
    };
  }

  static async scanBlockingAdvancementCompletion(actor, registry) {
    const graph = await this.#buildEntitlementGraph(actor, registry);
    const sourceOwners = graph.owners;
    const issues = [];

    issues.push(...await this.#scanAdvancementCompletion(actor, registry, graph));
    issues.push(...await this.#scanWeaponMastery(actor, registry, sourceOwners));
    issues.push(...await this.#scanFightingStyles(actor, registry, sourceOwners));
    issues.push(...this.#scanWarlockInvocationCount(actor, sourceOwners));

    const traitIssues = await CharacterValidationBuildProjectionService.scanTraitCompletion(actor, graph);
    issues.push(...traitIssues.filter(issue => BLOCKING_TRAIT_COMPLETION_KINDS.has(issue.kind)));

    return issues.filter(issue => {
      if (issue.kind === "warlock-invocation-entitlement") {
        return Number(issue.data?.actual ?? 0) < Number(issue.data?.expected ?? 0);
      }
      return BLOCKING_ADVANCEMENT_COMPLETION_KINDS.has(issue.kind);
    });
  }

  static async applyRepair(actor, issue) {
    switch (issue?.kind) {
      case "weapon-mastery-incomplete":
      case "fighting-style-incomplete":
      case "advancement-choice-incomplete":
      case "advancement-trait-incomplete":
      case "subclass-entitlement-incomplete":
        return this.#runGuidedAdvancementRepair(actor, issue);
      case "advancement-ledger-incomplete":
        return this.#repairAdvancementLedger(actor, issue);
      case "choice-metadata-incomplete":
        return this.#repairChoiceMetadata(actor, issue);
      case "missing-canonical-grant":
        return this.#repairMissingCanonicalGrant(actor, issue);
      case "always-prepared-state":
        return this.#repairAlwaysPrepared(actor, issue);
      case "duplicate-same-origin-spell":
        return this.#repairDuplicateSameOriginSpell(actor, issue);
      default:
        return CharacterValidationBuildProjectionService.applyRepair(actor, issue);
    }
  }

  static canRepair(kind) {
    return new Set([
      "weapon-mastery-incomplete",
      "fighting-style-incomplete",
      "advancement-choice-incomplete",
      "advancement-trait-incomplete",
      "subclass-entitlement-incomplete",
      "advancement-ledger-incomplete",
      "choice-metadata-incomplete",
      "missing-canonical-grant",
      "always-prepared-state",
      "duplicate-same-origin-spell"
    ]).has(kind) || CharacterValidationBuildProjectionService.canRepair(kind);
  }

  static async #buildEntitlementGraph(actor, registry) {
    const owners = [];
    const nodes = [];
    for (const owner of actor.items ?? []) {
      if (!CANONICAL_OWNER_TYPES.has(owner.type)) continue;
      if (!this.#isModernOwner(owner)) continue;
      const source = await this.#resolveSource(owner, registry);
      if (!source?.document) continue;
      const ownerLevel = this.#ownerLevel(owner, actor);
      const record = { owner, source, ownerLevel };
      owners.push(record);
      for (const [sourceAdvancementId, sourceAdvancement] of this.#advancementEntries(source.document)) {
        if (!this.#advancementActive(sourceAdvancement, ownerLevel)) continue;
        const local = this.#findEquivalentAdvancement(owner, sourceAdvancementId, sourceAdvancement);
        nodes.push({
          owner,
          source,
          ownerLevel,
          sourceAdvancementId,
          sourceAdvancement,
          local
        });
      }
    }
    return { owners, nodes };
  }

  static async #scanAdvancementCompletion(actor, registry, graph) {
    const issues = [];
    for (const node of graph.nodes) {
      const { owner, source, ownerLevel, sourceAdvancementId, sourceAdvancement, local } = node;
      const type = String(sourceAdvancement?.type ?? "");

      if (type === "ItemChoice") {
        if (this.#isFightingStyleAdvancement(sourceAdvancement) || this.#isInvocationChoice(sourceAdvancement)) continue;
        const choiceType = String(sourceAdvancement.configuration?.type ?? "");
        if (PHYSICAL_ITEM_TYPES.has(choiceType)) continue;

        const expected = this.#itemChoiceExpected(sourceAdvancement, ownerLevel);
        if (!expected) continue;
        const actualLedger = local ? this.#itemChoiceActual(local.advancement, ownerLevel) : 0;
        const linked = this.#linkedAdvancementItems(actor, owner.id, local?.id ?? sourceAdvancementId);
        const actualLinked = linked.length;
        const actual = Math.max(actualLedger, actualLinked);
        if (actual >= expected) {
          if (local && actualLinked >= expected && actualLedger < expected) {
            const activeLevels = this.#activeItemChoiceLevels(sourceAdvancement, ownerLevel);
            if (activeLevels.length === 1) {
              issues.push({
                id: `advancement-ledger:${owner.id}:${local.id}`,
                kind: "advancement-ledger-incomplete",
                severity: "error",
                repairable: true,
                repairMode: "safe",
                repairLabel: "Reconcile Choice Record",
                title: `${owner.name} — Advancement Choice Record Incomplete`,
                summary: `${expected} required choice${expected === 1 ? " is" : "s are"} present and linked to ${owner.name}, but the Advancement ledger records only ${actualLedger}.`,
                details: "The mechanical Items are already present. The Validator can reconnect those existing Items to the Advancement without changing the choices.",
                data: {
                  ownerId: owner.id,
                  localAdvancementId: local.id,
                  sourceAdvancementId,
                  level: activeLevels[0],
                  linkedItems: linked.map(item => ({
                    id: item.id,
                    uuid: item.getFlag?.("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? null
                  }))
                }
              });
            }
          }
          continue;
        }

        issues.push({
          id: `advancement-choice:${owner.id}:${sourceAdvancementId}`,
          kind: "advancement-choice-incomplete",
          severity: "error",
          repairable: true,
          repairMode: "guided",
          repairLabel: "Resolve Missing Choice",
          title: `${owner.name} — ${sourceAdvancement.title || "Advancement Choice"} Incomplete`,
          summary: `${owner.name} requires ${expected} resolved choice${expected === 1 ? "" : "s"} from ${sourceAdvancement.title || "this Advancement"}, but only ${actual} could be proven.`,
          details: "The parent feature is present, but its dependent Advancement is incomplete. The Validator reopens the same native D&D5e Advancement flow instead of inventing the missing choice.",
          data: {
            ownerId: owner.id,
            sourceUuid: source.uuid,
            sourceAdvancementId,
            localAdvancementId: local?.id ?? null,
            level: this.#firstItemChoiceDeficitLevel(sourceAdvancement, local?.advancement, ownerLevel),
            expected,
            actual,
            mode: local ? "modify" : "add"
          }
        });
        continue;
      }

      // Trait Advancements for class/subclass/species/background/feat owners are
      // projected globally by CharacterValidationBuildProjectionService so
      // mechanical proficiencies cannot be double-counted between sources.
      if (type === "Trait" && sourceAdvancement.configuration?.mode !== "mastery") continue;

      if (type === "Subclass" && owner.type === "class") {
        const level = this.#firstAdvancementLevel(sourceAdvancement);
        if (ownerLevel < level) continue;
        const classIdentifier = String(owner.system?.identifier ?? "");
        const subclass = actor.items.find(item => item.type === "subclass"
          && String(item.system?.classIdentifier ?? item.system?.class?.identifier ?? item.system?.class ?? "") === classIdentifier);
        if (subclass) continue;
        issues.push({
          id: `subclass-entitlement:${owner.id}:${sourceAdvancementId}`,
          kind: "subclass-entitlement-incomplete",
          severity: "error",
          repairable: true,
          repairMode: "guided",
          repairLabel: "Resolve Subclass",
          title: `${owner.name} — Subclass Selection Missing`,
          summary: `${owner.name} level ${ownerLevel} is entitled to a subclass from level ${level}, but no matching subclass Item is present.`,
          details: "The Validator opens the native subclass Advancement at the entitlement level. It does not choose a subclass automatically.",
          data: {
            ownerId: owner.id,
            sourceUuid: source.uuid,
            sourceAdvancementId,
            localAdvancementId: local?.id ?? null,
            level,
            expected: 1,
            actual: 0,
            mode: local ? "modify" : "add"
          }
        });
      }
    }
    return issues;
  }

  static #scanChoiceStateReconciliation(actor, graph) {
    const issues = [];
    const emitted = new Set();
    for (const node of graph.nodes) {
      const { owner, ownerLevel, sourceAdvancementId, sourceAdvancement, local } = node;
      if (!local) continue;
      // Blue choice badges are presentation metadata, not universal mechanics.
      // Only audit them where Character Builder has an established maintenance
      // contract today. Weapon Mastery is the first such contract; broad badge
      // normalization would create cosmetic false positives on legacy Actors.
      if (!(sourceAdvancement?.type === "Trait" && sourceAdvancement.configuration?.mode === "mastery")) continue;
      const expected = AdvancementChoiceAnnotationService.expectedAdvancementBadge(actor, {
        sourceItemId: owner.id,
        advancementId: local.id,
        characterLevel: this.#actorLevel(actor),
        classIdentifier: this.#classIdentifier(owner, actor),
        classLevel: this.#classItem(owner, actor)?.system?.levels ?? ownerLevel
      });
      if (!expected) continue;
      const key = `${expected.targetItemId}:${local.id}:${owner.id}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      const target = actor.items.get(expected.targetItemId);
      if (!target) continue;
      const badges = AdvancementChoiceAnnotationService.getBadges(target);
      const current = badges.find(badge =>
        String(badge?.sourceItemId ?? "") === String(owner.id)
        && String(badge?.advancementId ?? "") === String(local.id)
        && String(badge?.targetItemId ?? target.id) === String(target.id)
      );
      if (current && this.#badgeEquivalent(current, expected.badge)) continue;
      if (sourceAdvancement.configuration?.mode === "mastery"
        && this.#equivalentWeaponMasteryBadgeExists(badges, expected.badge, target.id)) continue;
      issues.push({
        id: `choice-metadata:${owner.id}:${local.id}:${target.id}`,
        kind: "choice-metadata-incomplete",
        severity: "error",
        repairable: true,
        repairMode: "safe",
        repairLabel: "Reconcile Choice Metadata",
        title: `${target.name} — Choice Metadata Incomplete`,
        summary: `${expected.badge.label} is mechanically resolved, but the Character Builder maintenance badge is missing or stale.`,
        details: "This repair changes only Character Builder-owned presentation/maintenance metadata. It does not change the native choice, Item, or Actor mechanics.",
        data: {
          ownerId: owner.id,
          advancementId: local.id,
          sourceAdvancementId,
          targetItemId: target.id,
          characterLevel: this.#actorLevel(actor),
          classIdentifier: this.#classIdentifier(owner, actor),
          classLevel: Number(this.#classItem(owner, actor)?.system?.levels ?? ownerLevel)
        }
      });
    }
    return issues;
  }

  static async #scanLegacyOriginFeatMismatch(actor, registry, graph) {
    const issues = [];
    for (const { owner, source } of graph.owners.filter(row => row.owner.type === "background")) {
      const expected = [];
      for (const [sourceAdvancementId, advancement] of this.#advancementEntries(source.document)) {
        if (advancement?.type !== "ItemGrant") continue;
        for (const entry of advancement.configuration?.items ?? []) {
          if (entry?.optional || !entry?.uuid) continue;
          const resolved = await this.#resolveGrantDocument(String(entry.uuid), registry);
          if (!resolved?.document || !this.#isOriginFeatDocument(resolved.document)) continue;
          expected.push({ sourceAdvancementId, configuredUuid: String(entry.uuid), ...resolved });
        }
      }
      if (!expected.length) continue;
      const expectedPresent = expected.some(row => actor.items.some(item => this.#sameItemIdentity(item, row.document, row.configuredUuid)));
      if (expectedPresent) continue;
      const alternatives = actor.items.filter(item => this.#isOriginFeatDocument(item)
        && !expected.some(row => this.#sameItemIdentity(item, row.document, row.configuredUuid)))
        .filter(item => this.#isPlausibleLegacyBackgroundFeat(item, owner, actor));
      if (!alternatives.length) continue;
      issues.push({
        id: `legacy-origin-feat:${owner.id}:${expected.map(row => row.document.system?.identifier ?? row.document.name).join(":")}`,
        kind: "legacy-custom-origin-feat",
        severity: "warning",
        repairable: false,
        repairMode: "review",
        title: `${owner.name} — Origin Feat Mismatch / Legacy Custom Origin`,
        summary: `${owner.name} normally grants ${expected.map(row => row.document.name).join(" / ")}, but ${alternatives.map(item => item.name).join(" / ")} is present instead.`,
        details: "This pattern can represent an intentional custom origin from a legacy builder or manual migration. The Validator will not restore the default feat over it. Formal conversion to Character Builder Custom Background remains a guided migration step rather than an automatic repair.",
        data: {
          backgroundId: owner.id,
          sourceBackgroundUuid: source.uuid,
          expected: expected.map(row => ({ uuid: row.uuid, name: row.document.name })),
          alternatives: alternatives.map(item => ({ id: item.id, name: item.name }))
        }
      });
    }
    return issues;
  }

  static async #scanWeaponMastery(actor, registry, sourceOwners) {
    const rows = [];
    const masteryClasses = sourceOwners.filter(({ owner }) => owner.type === "class")
      .map(({ owner, source }) => {
        const advancements = this.#advancementEntries(source.document)
          .filter(([, advancement]) => advancement?.type === "Trait"
            && advancement.configuration?.mode === "mastery"
            && this.#advancementActive(advancement, this.#ownerLevel(owner, actor)));
        if (!advancements.length) return null;
        return { owner, source, advancements };
      }).filter(Boolean);

    const globalValues = this.#collectionValues(actor.system?.traits?.weaponProf?.mastery?.value)
      .map(value => String(value ?? "").trim()).filter(Boolean);

    for (const { owner, source, advancements } of masteryClasses) {
      for (const [sourceAdvancementId, sourceAdvancement] of advancements) {
        const expected = this.#traitChoiceCapacity(sourceAdvancement);
        if (!expected) continue;
        const local = this.#findEquivalentAdvancement(owner, sourceAdvancementId, sourceAdvancement);
        const localChosen = this.#collectionValues(local?.advancement?.value?.chosen);

        let actual = localChosen.length;
        let ambiguous = false;
        if (!local && masteryClasses.length === 1) actual = Math.min(expected, globalValues.length);
        else if (!local && globalValues.length) ambiguous = true;

        if (actual >= expected) continue;
        if (ambiguous) {
          rows.push({
            id: `weapon-mastery-ambiguous:${owner.id}:${sourceAdvancementId}`,
            kind: "weapon-mastery-ambiguous",
            severity: "warning",
            repairable: false,
            repairMode: "review",
            title: `${owner.name} — Weapon Mastery Ownership Needs Review`,
            summary: `${owner.name} grants ${expected} Weapon Mastery choices, but the Actor has mastery values with no reliable class ownership record.`,
            details: "The Validator will not reassign multiclass Weapon Mastery choices without proof of which class owns each selection.",
            data: { ownerId: owner.id, expected, actual, sourceAdvancementId }
          });
          continue;
        }

        rows.push({
          id: `weapon-mastery:${owner.id}:${sourceAdvancementId}`,
          kind: "weapon-mastery-incomplete",
          severity: "error",
          repairable: true,
          repairMode: "guided",
          repairLabel: "Resolve Weapon Mastery",
          title: `${owner.name} — Weapon Mastery Incomplete`,
          summary: `${owner.name} level ${Number(owner.system?.levels ?? 0)} grants ${expected} Weapon Mastery choice${expected === 1 ? "" : "s"}, but ${actual} ${actual === 1 ? "is" : "are"} recorded for this class.`,
          details: `The Validator can reopen the native Advancement choice at level ${this.#firstAdvancementLevel(sourceAdvancement)}. You choose only the missing legal mastery selections; the original Actor remains untouched.`,
          data: {
            ownerId: owner.id,
            sourceUuid: source.uuid,
            sourceAdvancementId,
            localAdvancementId: local?.id ?? null,
            level: this.#firstAdvancementLevel(sourceAdvancement),
            expected,
            actual,
            mode: local ? "modify" : "add"
          }
        });
      }
    }
    return rows;
  }

  static async #scanFightingStyles(actor, registry, sourceOwners) {
    const rows = [];
    for (const { owner, source } of sourceOwners.filter(({ owner }) => owner.type === "class")) {
      const classLevel = this.#ownerLevel(owner, actor);
      for (const [sourceAdvancementId, sourceAdvancement] of this.#advancementEntries(source.document)) {
        if (!this.#isFightingStyleAdvancement(sourceAdvancement)) continue;
        const expected = this.#itemChoiceExpected(sourceAdvancement, classLevel);
        if (!expected) continue;
        const local = this.#findEquivalentAdvancement(owner, sourceAdvancementId, sourceAdvancement);
        const localActual = local ? this.#itemChoiceActual(local.advancement, classLevel) : 0;
        const pool = await this.#poolIdentity(sourceAdvancement, registry);
        const actualItems = actor.items.filter(item => item.type === "feat"
          && (String(item.system?.type?.subtype ?? "") === "fightingStyle" || pool.identifiers.has(String(item.system?.identifier ?? ""))));
        const actual = Math.max(localActual, Math.min(expected, actualItems.length));
        if (actual >= expected) continue;

        rows.push({
          id: `fighting-style:${owner.id}:${sourceAdvancementId}`,
          kind: "fighting-style-incomplete",
          severity: "error",
          repairable: true,
          repairMode: "guided",
          repairLabel: "Resolve Fighting Style",
          title: `${owner.name} — Fighting Style Incomplete`,
          summary: `${owner.name} progression expects ${expected} Fighting Style choice${expected === 1 ? "" : "s"} by level ${classLevel}, but only ${actual} could be identified.`,
          details: "The Validator can reopen the source-native Fighting Style Advancement so the GM can make the missing legal choice.",
          data: {
            ownerId: owner.id,
            sourceUuid: source.uuid,
            sourceAdvancementId,
            localAdvancementId: local?.id ?? null,
            level: this.#firstItemChoiceDeficitLevel(sourceAdvancement, local?.advancement, classLevel),
            expected,
            actual,
            mode: local ? "modify" : "add"
          }
        });
      }
    }
    return rows;
  }

  static async #scanCanonicalItemGrants(actor, registry, sourceOwners) {
    const rows = [];
    const seen = new Set();
    for (const { owner, source } of sourceOwners) {
      const ownerLevel = this.#ownerLevel(owner, actor);
      for (const [sourceAdvancementId, sourceAdvancement] of this.#advancementEntries(source.document)) {
        if (sourceAdvancement?.type !== "ItemGrant" || !this.#advancementActive(sourceAdvancement, ownerLevel)) continue;
        const configured = (sourceAdvancement.configuration?.items ?? []).filter(entry => !entry?.optional && entry?.uuid);
        if (!configured.length) continue;
        const local = this.#findEquivalentAdvancement(owner, sourceAdvancementId, sourceAdvancement);

        for (const entry of configured) {
          const configuredUuid = String(entry.uuid ?? "");
          if (!configuredUuid || seen.has(`${owner.id}:${sourceAdvancementId}:${configuredUuid}`)) continue;
          seen.add(`${owner.id}:${sourceAdvancementId}:${configuredUuid}`);
          const sourceItem = await this.#resolveGrantDocument(configuredUuid, registry);
          if (!sourceItem?.document || PHYSICAL_ITEM_TYPES.has(sourceItem.document.type)) continue;

          const mappedIds = this.#flattenAddedMappings(local?.advancement?.value?.added ?? {})
            .filter(mapping => this.#sameConfiguredSource(mapping.uuid, configuredUuid, sourceItem.document))
            .map(mapping => mapping.itemId);
          let matches = mappedIds.map(id => actor.items.get(id)).filter(Boolean);
          // A missing Item that is still explicitly recorded in value.added is
          // already covered by the structural Advancement-record rule. Avoid
          // presenting the same defect twice as both structural and progression.
          if (mappedIds.length && !matches.length) continue;
          if (!matches.length) {
            const identityMatches = actor.items.filter(item => this.#sameItemIdentity(item, sourceItem.document, configuredUuid));
            matches = sourceItem.document.type === "spell"
              ? identityMatches.filter(item => !this.#hasExplicitDifferentSpellOrigin(item, owner, local?.id ?? sourceAdvancementId))
              : identityMatches;
          }

          if (!matches.length) {
            // A legacy/custom Background can intentionally replace its normal
            // Origin Feat. Do not silently restore the canonical feat over a
            // different plausible Origin Feat; the dedicated migration audit
            // reports that as GM review instead.
            if (owner.type === "background" && this.#isOriginFeatDocument(sourceItem.document)) {
              const alternatives = actor.items.filter(item => this.#isOriginFeatDocument(item)
                && !this.#sameItemIdentity(item, sourceItem.document, configuredUuid)
                && this.#isPlausibleLegacyBackgroundFeat(item, owner, actor));
              if (alternatives.length) continue;
            }
            rows.push({
              id: `canonical-grant:${owner.id}:${sourceAdvancementId}:${this.#slug(sourceItem.document.system?.identifier || sourceItem.document.name)}`,
              kind: "missing-canonical-grant",
              severity: "error",
              repairable: true,
              repairMode: "safe",
              repairLabel: "Restore Required Feature",
              title: `${owner.name} — Missing Required ${sourceItem.document.type === "spell" ? "Spell" : "Feature"}`,
              summary: `${sourceItem.document.name} is a mandatory grant from ${sourceAdvancement.title || owner.name} and is not present on the Actor.`,
              details: `The enabled source ${sourceItem.label} can restore the exact granted document and reconnect it to the revised Actor's progression record.`,
              data: {
                ownerId: owner.id,
                ownerLevel,
                sourceOwnerUuid: source.uuid,
                sourceAdvancementId,
                localAdvancementId: local?.id ?? null,
                configuredUuid,
                resolvedUuid: sourceItem.uuid,
                sourceName: sourceItem.document.name
              }
            });
            continue;
          }

          if (sourceItem.document.type !== "spell") continue;
          const requiredPrepared = this.#grantPreparedState(sourceAdvancement, sourceItem.document);
          if (requiredPrepared !== SpellPreparationPolicyService.ALWAYS_PREPARED) continue;
          const spell = this.#preferredGrantedSpell(matches, owner, local?.id ?? sourceAdvancementId);
          if (!spell || Number(spell.system?.prepared ?? -1) === SpellPreparationPolicyService.ALWAYS_PREPARED) continue;

          rows.push({
            id: `always-prepared:${owner.id}:${sourceAdvancementId}:${spell.id}`,
            kind: "always-prepared-state",
            severity: "error",
            repairable: true,
            repairMode: "safe",
            repairLabel: "Restore Always Prepared",
            title: `${spell.name} — Always Prepared State Missing`,
            summary: `${spell.name} is granted by ${sourceAdvancement.title || owner.name} as Always Prepared, but the Actor currently stores it as a normal prepared/unprepared spell.`,
            details: "The spell itself is preserved. The Validator only restores the required preparation state and acquisition ownership for this grant.",
            data: {
              spellId: spell.id,
              ownerId: owner.id,
              ownerName: owner.name,
              advancementId: local?.id ?? sourceAdvancementId,
              sourceAdvancementId,
              sourceOwnerUuid: source.uuid,
              configuredUuid,
              resolvedUuid: sourceItem.uuid,
              sourceName: sourceItem.document.name
            }
          });
        }
      }
    }
    return rows;
  }

  static #scanSameOriginSpellDuplicates(actor) {
    const groups = new Map();
    for (const spell of actor.items.filter(item => item.type === "spell")) {
      const identifier = String(spell.system?.identifier ?? "").trim();
      if (!identifier) continue;
      const origins = this.#spellOriginKeys(spell);
      for (const origin of origins) {
        const key = `${identifier}::${origin}`;
        const rows = groups.get(key) ?? [];
        rows.push(spell);
        groups.set(key, rows);
      }
    }

    const issues = [];
    const emitted = new Set();
    for (const [key, spells] of groups) {
      const unique = [...new Map(spells.map(spell => [spell.id, spell])).values()];
      if (unique.length < 2) continue;
      const signature = unique.map(spell => spell.id).sort().join(":");
      if (emitted.has(signature)) continue;
      emitted.add(signature);
      const keep = this.#chooseDuplicateKeeper(actor, unique, key.split("::")[1]);
      const remove = unique.filter(spell => spell.id !== keep.id);
      issues.push({
        id: `duplicate-spell:${signature}`,
        kind: "duplicate-same-origin-spell",
        severity: "error",
        repairable: true,
        repairMode: "safe",
        repairLabel: "Remove Redundant Copy",
        title: `${keep.name} — Redundant Spell Copy`,
        summary: `${unique.length} copies of ${keep.name} are tied to the same acquisition origin.`,
        details: "Duplicates from different classes, species, feats, or other origins are preserved. This repair removes only redundant copies that claim the same entitlement.",
        data: {
          keepId: keep.id,
          deleteIds: remove.map(spell => spell.id),
          originKey: key.split("::")[1]
        }
      });
    }
    return issues;
  }

  static #scanWarlockInvocationCount(actor, sourceOwners) {
    const issues = [];
    for (const { owner, source } of sourceOwners.filter(({ owner }) => owner.type === "class" && owner.system?.identifier === "warlock")) {
      const level = Number(owner.system?.levels ?? 0);
      const sourceAdvancements = this.#advancementEntries(source.document);
      const scale = sourceAdvancements.find(([, advancement]) => advancement?.type === "ScaleValue"
        && advancement.configuration?.identifier === "invocations-known")?.[1]?.configuration?.scale ?? {};
      let expected = 0;
      for (const [minimum, row] of Object.entries(scale)) if (Number(minimum) <= level) expected = Number(row?.value ?? expected);
      if (!expected) continue;

      const sourceChoice = sourceAdvancements.find(([, advancement]) => advancement?.type === "ItemChoice"
        && advancement.configuration?.restriction?.subtype === "eldritchInvocation");
      const poolUuids = new Set((sourceChoice?.[1]?.configuration?.pool ?? []).map(row => row?.uuid).filter(Boolean));
      const poolIdentifiers = new Set();
      for (const uuid of poolUuids) {
        const doc = fromUuidSync?.(uuid);
        if (doc?.system?.identifier) poolIdentifiers.add(String(doc.system.identifier));
      }
      const actual = actor.items.filter(item => item.type === "feat" && (
        String(item.system?.type?.subtype ?? "") === "eldritchInvocation"
        || poolIdentifiers.has(String(item.system?.identifier ?? ""))
        || Boolean(item.getFlag?.(MODULE_ID, "invocationInstance"))
      )).length;
      if (actual === expected) continue;
      issues.push({
        id: `warlock-invocation-count:${owner.id}`,
        kind: "warlock-invocation-entitlement",
        severity: "warning",
        repairable: false,
        repairMode: "review",
        title: "Warlock — Eldritch Invocation Progression",
        summary: actual < expected
          ? `Warlock level ${level} expects ${expected} Eldritch Invocations, but ${actual} were identified (${expected - actual} missing).`
          : `Warlock level ${level} expects ${expected} Eldritch Invocations, but ${actual} were identified (${actual - expected} above the expected count).`,
        details: "This build audits the count against the enabled source but does not invent or delete Invocation choices yet. Guided prerequisite-aware Invocation replay remains a GM review item.",
        data: { classItemId: owner.id, sourceUuid: source.uuid, level, expected, actual }
      });
    }
    return issues;
  }

  static async #runGuidedAdvancementRepair(actor, issue) {
    const owner = actor.items.get(issue.data?.ownerId);
    if (!owner) throw new Error("The progression owner no longer exists on the revised Actor.");
    const Manager = globalThis.dnd5e?.applications?.advancement?.AdvancementManager;
    if (!Manager) throw new Error("D&D5e AdvancementManager is unavailable.");

    let manager;
    if (issue.data?.mode === "add") {
      const sourceDocument = await fromUuid(issue.data?.sourceUuid);
      const advancement = sourceDocument?.advancement?.byId?.[issue.data?.sourceAdvancementId]
        ?? this.#collectionValues(sourceDocument?.advancement).find(row => (row.id ?? row._id) === issue.data?.sourceAdvancementId);
      if (!advancement) throw new Error("The source Advancement used for this repair is unavailable.");
      manager = Manager.forNewAdvancement(actor, owner.id, [advancement], {
        automaticApplication: true,
        showVisualizer: false,
        characterBuilderValidationRepair: true
      });
    } else {
      const level = Number(issue.data?.level ?? 0);
      manager = Manager.forModifyChoices(actor, owner.id, level, {
        automaticApplication: true,
        showVisualizer: false,
        characterBuilderValidationRepair: true
      });
      const targetId = String(issue.data?.localAdvancementId ?? "");
      if (targetId) {
        manager.steps = manager.steps.filter(step => {
          const advancementId = step?.flow?.advancement?.id ?? step?.flow?.advancement?._id ?? null;
          return advancementId === targetId;
        });
      }
    }

    if (!manager?.steps?.length) throw new Error("No native Advancement step could be created for this repair.");
    const result = await NativeAdvancementModalGuard.run(manager);
    if (!result.completed) {
      return {
        status: "skipped",
        issueId: issue.id,
        title: issue.title,
        message: `${issue.title} was left unresolved because the Advancement window was cancelled.`
      };
    }

    await this.#markValidationAdvancementRepair(owner, issue);
    return {
      status: "repaired",
      issueId: issue.id,
      title: issue.title,
      message: `${issue.title} was resolved through the native Advancement choice workflow.`,
      guided: true
    };
  }

  static async #repairAdvancementLedger(actor, issue) {
    const owner = actor.items.get(issue.data?.ownerId);
    if (!owner) throw new Error("The progression owner no longer exists on the revised Actor.");
    const advancementId = String(issue.data?.localAdvancementId ?? "");
    const raw = owner.toObject().system?.advancement?.[advancementId];
    if (!raw) throw new Error("The Advancement record no longer exists on the revised Actor.");
    const level = String(issue.data?.level ?? "0");
    const added = foundry.utils.deepClone(raw.value?.added ?? {});
    const row = foundry.utils.deepClone(added[level] ?? {});
    for (const linked of issue.data?.linkedItems ?? []) {
      if (!linked?.id || !actor.items.get(linked.id)) continue;
      const item = actor.items.get(linked.id);
      const uuid = linked.uuid ?? item.getFlag?.("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? null;
      if (!uuid) continue;
      row[linked.id] = uuid;
    }
    added[level] = row;
    await owner.update({ [`system.advancement.${advancementId}.value.added`]: added }, {
      characterBuilderValidationRepair: true,
      characterBuilderValidationProgressionProjection: true
    });
    return {
      status: "repaired",
      issueId: issue.id,
      title: issue.title,
      message: `${owner.name} choice ledger was reconciled to the already-present linked Items.`
    };
  }

  static async #repairChoiceMetadata(actor, issue) {
    const result = await AdvancementChoiceAnnotationService.reconcileAdvancementBadge(actor, {
      sourceItemId: issue.data?.ownerId,
      advancementId: issue.data?.advancementId,
      context: "validation",
      transactionId: `validation:${issue.data?.ownerId}:${issue.data?.advancementId}`,
      characterLevel: issue.data?.characterLevel,
      classIdentifier: issue.data?.classIdentifier,
      classLevel: issue.data?.classLevel
    });
    if (!result?.targetItemId) throw new Error("The resolved choice no longer has a valid Character Builder presentation target.");
    return {
      status: "repaired",
      issueId: issue.id,
      title: issue.title,
      message: `${actor.items.get(result.targetItemId)?.name ?? issue.title} choice metadata was reconciled without changing the native choice.`
    };
  }

  static async #repairMissingCanonicalGrant(actor, issue) {
    const owner = actor.items.get(issue.data?.ownerId);
    if (!owner) throw new Error("The progression owner no longer exists on the revised Actor.");
    const sourceOwner = await fromUuid(issue.data?.sourceOwnerUuid);
    const sourceAdvancement = sourceOwner?.advancement?.byId?.[issue.data?.sourceAdvancementId] ?? null;
    const sourceItem = await fromUuid(issue.data?.resolvedUuid ?? issue.data?.configuredUuid);
    if (!sourceItem) throw new Error("The required source Item is unavailable.");

    let localAdvancementId = issue.data?.localAdvancementId;
    const ownerRaw = owner.toObject();
    if (!localAdvancementId) {
      const raw = sourceOwner?.toObject?.().system?.advancement?.[issue.data?.sourceAdvancementId];
      if (!raw) throw new Error("The required source Advancement is unavailable.");
      localAdvancementId = issue.data.sourceAdvancementId;
      const advancementData = foundry.utils.deepClone(raw);
      advancementData.value = foundry.utils.deepClone(advancementData.value ?? {});
      advancementData.value.added = {};
      await owner.update({ [`system.advancement.${localAdvancementId}`]: advancementData }, {
        characterBuilderValidationRepair: true,
        characterBuilderValidationProgressionProjection: true
      });
    }

    const itemId = foundry.utils.randomID();
    let data = sourceAdvancement?.createItemData
      ? await sourceAdvancement.createItemData(issue.data?.resolvedUuid ?? issue.data?.configuredUuid, itemId)
      : null;
    if (!data) data = foundry.utils.deepClone(sourceItem.toObject());
    data._id = itemId;
    data.flags ??= {};
    data.flags.dnd5e ??= {};
    data.flags.dnd5e.sourceId = issue.data?.resolvedUuid ?? issue.data?.configuredUuid;
    data.flags.dnd5e.advancementOrigin = `${owner.id}.${localAdvancementId}`;
    data.flags.dnd5e.advancementRoot ??= owner.getFlag?.("dnd5e", "advancementRoot") ?? `${owner.id}.${localAdvancementId}`;
    data.flags[MODULE_ID] ??= {};
    data.flags[MODULE_ID].validationRestore = {
      restoredAt: Date.now(),
      restoredBy: game.user.id,
      sourceUuid: issue.data?.resolvedUuid ?? issue.data?.configuredUuid,
      ownerId: owner.id,
      advancementId: localAdvancementId,
      canonicalProjection: true
    };

    this.#applyGrantSpellConfiguration(data, sourceOwner, sourceAdvancement, issue.data?.sourceAdvancementId, owner);
    const [created] = await actor.createEmbeddedDocuments("Item", [data], {
      keepId: true,
      characterBuilderValidationRepair: true
    });
    if (!created) throw new Error(`D&D5e did not restore ${sourceItem.name}.`);

    const currentAdvancement = owner.toObject().system?.advancement?.[localAdvancementId] ?? ownerRaw.system?.advancement?.[localAdvancementId] ?? {};
    const added = foundry.utils.deepClone(currentAdvancement.value?.added ?? {});
    added[created.id] = issue.data?.configuredUuid ?? issue.data?.resolvedUuid;
    await owner.update({ [`system.advancement.${localAdvancementId}.value.added`]: added }, {
      characterBuilderValidationRepair: true,
      characterBuilderValidationProgressionProjection: true
    });

    // A restored spell must come back as the same entitlement, not merely as a
    // mechanically similar class spell. Record the proven ItemGrant owner now
    // so the next maintenance pass sees the class/subclass/feature link.
    if (created.type === "spell") {
      const classIdentifier = this.#classIdentifier(owner, actor);
      const classItem = this.#classItem(owner, actor);
      const prepared = Number(created.system?.prepared ?? 0);
      await FeatureSpellOwnershipService.addOwner(created, {
        category: this.#slug(owner.name || "validation-grant"),
        label: owner.name,
        classIdentifier,
        classItemId: classItem?.id ?? null,
        subclassItemId: owner.type === "subclass" ? owner.id : null,
        featureItemId: owner.type === "feat" ? owner.id : null,
        ownerItemId: owner.id,
        advancementId: localAdvancementId,
        transactionId: null,
        acquiredAtCharacterLevel: null,
        acquiredAtClassLevel: Number(sourceAdvancement?.level ?? issue.data?.ownerLevel ?? 0),
        sourceUuid: issue.data?.resolvedUuid ?? issue.data?.configuredUuid ?? null,
        spellLevel: Number(created.system?.level ?? 0),
        alwaysPrepared: prepared === SpellPreparationPolicyService.ALWAYS_PREPARED,
        nativeGrant: true,
        validationReconciled: true
      }, { prepared: prepared === SpellPreparationPolicyService.ALWAYS_PREPARED ? prepared : null });
      if (owner.system?.identifier) {
        await created.update({ "system.sourceItem": `${owner.type}:${owner.system.identifier}` }, {
          characterBuilderValidationRepair: true,
          characterBuilderValidationProgressionProjection: true
        });
      }
    }

    return {
      status: "repaired",
      issueId: issue.id,
      title: issue.title,
      message: `Restored ${created.name} from the enabled canonical progression source.`,
      restoredItemId: created.id
    };
  }

  static async #repairAlwaysPrepared(actor, issue) {
    const spell = actor.items.get(issue.data?.spellId);
    const owner = actor.items.get(issue.data?.ownerId);
    if (!spell || !owner) throw new Error("The granted spell or its owning feature no longer exists.");
    const previousPrepared = Number(spell.system?.prepared ?? SpellPreparationPolicyService.PREPARED);
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
      acquiredAtCharacterLevel: this.#actorLevel(actor),
      acquiredAtClassLevel: this.#ownerLevel(owner, actor),
      sourceUuid: issue.data?.resolvedUuid ?? issue.data?.configuredUuid ?? null,
      alwaysPrepared: true,
      nativeGrant: true,
      validationReconciled: true,
      previousPrepared
    };
    await FeatureSpellOwnershipService.addOwner(spell, ownerRecord, {
      prepared: SpellPreparationPolicyService.ALWAYS_PREPARED
    });
    return {
      status: "repaired",
      issueId: issue.id,
      title: issue.title,
      message: `Restored ${spell.name} as Always Prepared for ${owner.name}.`
    };
  }

  static async #repairDuplicateSameOriginSpell(actor, issue) {
    const keep = actor.items.get(issue.data?.keepId);
    if (!keep) throw new Error("The spell selected to keep no longer exists.");
    const deleteIds = (issue.data?.deleteIds ?? []).filter(id => actor.items.get(id));
    if (!deleteIds.length) {
      return { status: "repaired", issueId: issue.id, title: issue.title, message: `${keep.name} no longer has a redundant same-origin copy.` };
    }

    const origin = String(issue.data?.originKey ?? "");
    if (origin.startsWith("adv:")) {
      const [, ownerId, advancementId] = origin.split(":");
      const owner = actor.items.get(ownerId);
      if (owner) {
        const raw = owner.toObject().system?.advancement?.[advancementId];
        if (raw) {
          const added = foundry.utils.deepClone(raw.value?.added ?? {});
          let keepUuid = keep.getFlag?.("dnd5e", "sourceId") ?? keep._stats?.compendiumSource ?? null;
          this.#removeAddedIds(added, new Set(deleteIds));
          if (keepUuid && !this.#flattenAddedMappings(added).some(row => row.itemId === keep.id)) added[keep.id] = keepUuid;
          await owner.update({ [`system.advancement.${advancementId}.value.added`]: added }, {
            characterBuilderValidationRepair: true
          });
        }
      }
    }

    await actor.deleteEmbeddedDocuments("Item", deleteIds, {
      deleteContents: true,
      characterBuilderValidationRepair: true
    });
    return {
      status: "repaired",
      issueId: issue.id,
      title: issue.title,
      message: `Removed ${deleteIds.length} redundant same-origin cop${deleteIds.length === 1 ? "y" : "ies"} of ${keep.name}.`,
      deletedItemIds: deleteIds
    };
  }

  static async #markValidationAdvancementRepair(owner, issue) {
    const current = foundry.utils.deepClone(owner.getFlag?.(MODULE_ID, "validationAdvancementRepairs") ?? []);
    const key = `${issue.kind}:${issue.data?.sourceAdvancementId ?? issue.data?.localAdvancementId ?? "advancement"}`;
    const rows = current.filter(row => row?.key !== key);
    rows.push({
      key,
      kind: issue.kind,
      repairedAt: Date.now(),
      repairedBy: game.user.id,
      sourceUuid: issue.data?.sourceUuid ?? null,
      sourceAdvancementId: issue.data?.sourceAdvancementId ?? null,
      localAdvancementId: issue.data?.localAdvancementId ?? issue.data?.sourceAdvancementId ?? null,
      level: Number(issue.data?.level ?? 0)
    });
    await owner.setFlag(MODULE_ID, "validationAdvancementRepairs", rows);
  }

  static #isModernOwner(owner) {
    const rules = String(owner.system?.source?.rules ?? "").trim();
    if (rules === "2024") return true;
    const book = String(owner.system?.source?.book ?? "").toLowerCase();
    return /2024|xphb/.test(book);
  }

  static async #resolveSource(owner, registry) {
    const candidates = [owner.getFlag?.("dnd5e", "sourceId"), owner._stats?.compendiumSource]
      .filter(uuid => String(uuid ?? "").startsWith("Compendium."));
    for (const uuid of candidates) {
      if (!registry.isUuidAllowed(uuid)) continue;
      try {
        const document = await fromUuid(uuid);
        if (document && this.#isModernOwner(document)) {
          return { uuid, document, label: registry.findOption(uuid)?.sourceLabel ?? "enabled source" };
        }
      } catch (_error) { /* Try identifier resolution. */ }
    }
    const identifier = String(owner.system?.identifier ?? "");
    if (!identifier) return null;
    for (const option of registry.optionsForKey(owner.type, identifier)) {
      try {
        const document = await fromUuid(option.uuid);
        if (!document || !this.#isModernOwner(document)) continue;
        return { uuid: option.uuid, document, label: option.sourceLabel };
      } catch (_error) { /* Continue. */ }
    }
    return null;
  }

  static #advancementEntries(document) {
    const raw = document?.toObject?.().system?.advancement ?? document?.system?.advancement ?? {};
    return Object.entries(raw);
  }

  static #findEquivalentAdvancement(owner, sourceId, sourceAdvancement) {
    const local = owner.toObject().system?.advancement ?? {};
    if (local[sourceId]) return { id: sourceId, advancement: local[sourceId] };
    const signature = this.#advancementSignature(sourceAdvancement);
    for (const [id, advancement] of Object.entries(local)) {
      if (this.#advancementSignature(advancement) === signature) return { id, advancement };
    }
    return null;
  }

  static #advancementSignature(advancement) {
    const type = String(advancement?.type ?? "");
    const level = this.#firstAdvancementLevel(advancement);
    if (type === "Trait") return [type, level, String(advancement.configuration?.mode ?? "default"), this.#normalize(advancement.title)].join("|");
    if (type === "ItemChoice") return [type, String(advancement.configuration?.restriction?.type ?? ""), String(advancement.configuration?.restriction?.subtype ?? ""), this.#normalize(advancement.title)].join("|");
    if (type === "ItemGrant") {
      const ids = (advancement.configuration?.items ?? []).map(row => String(row?.uuid ?? "").split(".").at(-1)).filter(Boolean).sort().join(",");
      return [type, level, ids].join("|");
    }
    if (type === "ScaleValue") return [type, String(advancement.configuration?.identifier ?? ""), this.#normalize(advancement.title)].join("|");
    return [type, level, this.#normalize(advancement.title)].join("|");
  }

  static #advancementActive(advancement, level) {
    const levels = this.#advancementLevels(advancement);
    if (!levels.length) return true;
    return levels.some(value => value <= Number(level ?? 0));
  }

  static #advancementLevels(advancement) {
    const values = [];
    if (Number.isFinite(Number(advancement?.level))) values.push(Number(advancement.level));
    for (const level of advancement?.levels ?? []) if (Number.isFinite(Number(level))) values.push(Number(level));
    if (advancement?.type === "ItemChoice") {
      for (const level of Object.keys(advancement.configuration?.choices ?? {})) if (Number.isFinite(Number(level))) values.push(Number(level));
    }
    return [...new Set(values)].sort((a, b) => a - b);
  }

  static #firstAdvancementLevel(advancement) {
    return this.#advancementLevels(advancement)[0] ?? 0;
  }

  static #traitChoiceCapacity(advancement) {
    return (advancement.configuration?.choices ?? []).reduce((sum, choice) => sum + Math.max(0, Number(choice?.count ?? 0)), 0);
  }

  static #isFightingStyleAdvancement(advancement) {
    return advancement?.type === "ItemChoice"
      && String(advancement.configuration?.restriction?.subtype ?? "") === "fightingStyle";
  }

  static #itemChoiceExpected(advancement, currentLevel) {
    let expected = 0;
    for (const [level, choice] of Object.entries(advancement.configuration?.choices ?? {})) {
      if (Number(level) <= Number(currentLevel ?? 0)) expected += Math.max(0, Number(choice?.count ?? 0));
    }
    return expected;
  }

  static #itemChoiceActual(advancement, currentLevel) {
    const added = advancement?.value?.added ?? {};
    let total = 0;
    for (const [level, choices] of Object.entries(added)) {
      if (/^\d+$/.test(String(level)) && Number(level) > Number(currentLevel ?? 0)) continue;
      if (choices && typeof choices === "object" && !Array.isArray(choices)) {
        total += Object.values(choices).filter(value => typeof value === "string").length;
      } else if (typeof choices === "string") total += 1;
    }
    return total || this.#flattenAddedMappings(added).length;
  }

  static #firstItemChoiceDeficitLevel(sourceAdvancement, localAdvancement, currentLevel) {
    let cumulativeExpected = 0;
    let cumulativeActual = 0;
    const levels = Object.keys(sourceAdvancement.configuration?.choices ?? {}).map(Number)
      .filter(level => Number.isFinite(level) && level <= Number(currentLevel ?? 0)).sort((a, b) => a - b);
    const localAdded = localAdvancement?.value?.added ?? {};
    for (const level of levels) {
      cumulativeExpected += Math.max(0, Number(sourceAdvancement.configuration.choices?.[level]?.count ?? 0));
      const row = localAdded?.[level] ?? localAdded?.[String(level)] ?? {};
      cumulativeActual += row && typeof row === "object" ? Object.values(row).filter(value => typeof value === "string").length : 0;
      if (cumulativeActual < cumulativeExpected) return level;
    }
    return levels[0] ?? this.#firstAdvancementLevel(sourceAdvancement);
  }

  static async #poolIdentity(advancement, registry) {
    const identifiers = new Set();
    for (const row of advancement.configuration?.pool ?? []) {
      const uuid = row?.uuid;
      if (!uuid) continue;
      const option = registry.findOption(uuid);
      if (option?.identifier) identifiers.add(String(option.identifier));
      else {
        try {
          const document = await fromUuid(uuid);
          if (document?.system?.identifier) identifiers.add(String(document.system.identifier));
        } catch (_error) { /* Ignore unavailable pool row. */ }
      }
    }
    return { identifiers };
  }

  static async #resolveGrantDocument(configuredUuid, registry) {
    let document = null;
    try { document = await fromUuid(configuredUuid); } catch (_error) { document = null; }
    if (document && registry.isUuidAllowed(configuredUuid)) {
      return { uuid: configuredUuid, document, label: registry.findOption(configuredUuid)?.sourceLabel ?? "enabled source" };
    }
    const identifier = document?.system?.identifier;
    const preferred = identifier ? registry.preferredOption(document.type, identifier) : null;
    if (!preferred) return null;
    try {
      const resolved = await fromUuid(preferred.uuid);
      return resolved ? { uuid: preferred.uuid, document: resolved, label: preferred.sourceLabel } : null;
    } catch (_error) { return null; }
  }

  static #sameConfiguredSource(actualUuid, configuredUuid, configuredDocument) {
    if (String(actualUuid ?? "") === String(configuredUuid ?? "")) return true;
    const actual = fromUuidSync?.(actualUuid);
    return Boolean(actual && configuredDocument && actual.type === configuredDocument.type
      && actual.system?.identifier && actual.system.identifier === configuredDocument.system?.identifier);
  }

  static #sameItemIdentity(item, sourceDocument, sourceUuid) {
    const itemSource = item.getFlag?.("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? null;
    if (itemSource === sourceUuid || itemSource === sourceDocument.uuid) return true;
    const sourceIdentifier = String(sourceDocument.system?.identifier ?? "");
    const localIdentifier = String(item.system?.identifier ?? "");
    return Boolean(sourceIdentifier && localIdentifier && sourceIdentifier === localIdentifier && item.type === sourceDocument.type);
  }

  static #grantPreparedState(advancement, spellDocument) {
    const configured = advancement.configuration?.spell?.prepared;
    return SpellPreparationPolicyService.resolve({
      level: spellDocument.system?.level,
      explicitPrepared: configured,
      alwaysPrepared: Number(configured) === SpellPreparationPolicyService.ALWAYS_PREPARED,
      category: "native-item-grant"
    });
  }

  static #hasExplicitDifferentSpellOrigin(spell, owner, advancementId) {
    const expectedAdvancementOrigin = `${owner.id}.${advancementId}`;
    const advancementOrigin = String(spell.getFlag?.("dnd5e", "advancementOrigin") ?? "");
    if (advancementOrigin && advancementOrigin !== expectedAdvancementOrigin) return true;

    const featureOwners = spell.getFlag?.(MODULE_ID, "featureSpellOwners") ?? [];
    if (featureOwners.length) {
      const ownsExpected = featureOwners.some(row => row.ownerItemId === owner.id
        && String(row.advancementId ?? "") === String(advancementId ?? ""));
      if (!ownsExpected) return true;
    }

    // A level-up spell record is positive evidence that this copy consumed a
    // normal class repertoire choice. Do not silently repurpose it to satisfy
    // an unrelated Always Prepared / granted-spell entitlement.
    const levelUp = spell.getFlag?.(MODULE_ID, "levelUpSpell");
    if (levelUp?.classIdentifier || levelUp?.transactionId) return true;
    return false;
  }

  static #preferredGrantedSpell(matches, owner, advancementId) {
    const exactOrigin = `${owner.id}.${advancementId}`;
    return matches.find(item => item.getFlag?.("dnd5e", "advancementOrigin") === exactOrigin)
      ?? matches.find(item => (item.getFlag?.(MODULE_ID, "featureSpellOwners") ?? []).some(row => row.ownerItemId === owner.id && String(row.advancementId ?? "") === String(advancementId ?? "")))
      ?? matches[0]
      ?? null;
  }

  static #spellOriginKeys(spell) {
    const keys = [];
    const advancementOrigin = String(spell.getFlag?.("dnd5e", "advancementOrigin") ?? "");
    if (advancementOrigin) keys.push(`adv:${advancementOrigin.replace(".", ":")}`);
    const owners = spell.getFlag?.(MODULE_ID, "featureSpellOwners") ?? [];
    for (const owner of owners) {
      const ownerKey = [owner.ownerItemId, owner.featureItemId, owner.advancementId, owner.classItemId, owner.subclassItemId]
        .map(value => String(value ?? "")).join(":");
      if (ownerKey.replaceAll(":", "")) keys.push(`feature:${ownerKey}`);
    }
    const levelUp = spell.getFlag?.(MODULE_ID, "levelUpSpell");
    if (levelUp?.transactionId && levelUp?.classIdentifier) keys.push(`levelup:${levelUp.transactionId}:${levelUp.classIdentifier}`);
    return [...new Set(keys)];
  }

  static #chooseDuplicateKeeper(actor, spells, originKey) {
    if (originKey.startsWith("adv:")) {
      const [, ownerId, advancementId] = originKey.split(":");
      const owner = actor.items.get(ownerId);
      const tracked = new Set(this.#flattenAddedMappings(owner?.toObject?.().system?.advancement?.[advancementId]?.value?.added ?? {}).map(row => row.itemId));
      const exact = spells.find(spell => tracked.has(spell.id));
      if (exact) return exact;
    }
    return [...spells].sort((a, b) => {
      const prep = Number(b.system?.prepared ?? 0) - Number(a.system?.prepared ?? 0);
      if (prep) return prep;
      return String(a.id).localeCompare(String(b.id));
    })[0];
  }

  static #applyGrantSpellConfiguration(data, sourceOwner, sourceAdvancement, sourceAdvancementId, owner = null) {
    if (data?.type !== "spell") return;
    const raw = sourceOwner?.toObject?.().system?.advancement?.[sourceAdvancementId];
    const spellConfig = raw?.configuration?.spell ?? {};
    const abilities = Array.isArray(spellConfig.ability) ? spellConfig.ability : this.#collectionValues(spellConfig.ability);
    if (abilities[0]) data.system.ability = abilities[0];
    if (spellConfig.method) data.system.method = spellConfig.method;
    if (owner?.system?.identifier) data.system.sourceItem = `${owner.type}:${owner.system.identifier}`;
    data.system.prepared = SpellPreparationPolicyService.resolve({
      level: data.system?.level,
      explicitPrepared: spellConfig.prepared,
      alwaysPrepared: Number(spellConfig.prepared) === SpellPreparationPolicyService.ALWAYS_PREPARED,
      category: "native-item-grant"
    });
  }

  static #classIdentifier(owner, actor) {
    if (!owner) return null;
    if (owner.type === "class") return owner.system?.identifier ?? null;
    if (owner.type === "subclass") return owner.system?.classIdentifier ?? owner.system?.class?.identifier ?? owner.system?.class ?? null;
    const root = String(owner.getFlag?.("dnd5e", "advancementRoot") ?? owner.getFlag?.("dnd5e", "advancementOrigin") ?? "");
    const rootItem = actor.items.get(root.split(".")[0]);
    if (rootItem && rootItem.id !== owner.id) return this.#classIdentifier(rootItem, actor);
    return null;
  }

  static #classItem(owner, actor) {
    const identifier = this.#classIdentifier(owner, actor);
    return identifier ? actor.items.find(item => item.type === "class" && item.system?.identifier === identifier) : null;
  }

  static #ownerLevel(owner, actor) {
    if (owner.type === "class") return Number(owner.system?.levels ?? 0);
    if (owner.type === "subclass") return Number(this.#classItem(owner, actor)?.system?.levels ?? 0);
    const root = String(owner.getFlag?.("dnd5e", "advancementRoot") ?? owner.getFlag?.("dnd5e", "advancementOrigin") ?? "");
    const rootItem = actor.items.get(root.split(".")[0]);
    if (rootItem && rootItem.id !== owner.id) return this.#ownerLevel(rootItem, actor);
    return this.#actorLevel(actor);
  }

  static #actorLevel(actor) {
    return actor.items.filter(item => item.type === "class").reduce((sum, item) => sum + Number(item.system?.levels ?? 0), 0);
  }

  static #flattenAddedMappings(value, rows = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return rows;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string") rows.push({ itemId: key, uuid: child });
      else if (child && typeof child === "object") this.#flattenAddedMappings(child, rows);
    }
    return rows;
  }

  static #removeAddedIds(value, ids) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (ids.has(key)) delete value[key];
      else if (child && typeof child === "object") this.#removeAddedIds(child, ids);
    }
  }

  static #isInvocationChoice(advancement) {
    return advancement?.type === "ItemChoice"
      && String(advancement.configuration?.restriction?.subtype ?? "") === "eldritchInvocation";
  }

  static #activeItemChoiceLevels(advancement, currentLevel) {
    return Object.entries(advancement.configuration?.choices ?? {})
      .filter(([level, choice]) => Number(level) <= Number(currentLevel ?? 0) && Number(choice?.count ?? 0) > 0)
      .map(([level]) => Number(level))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  }

  static #linkedAdvancementItems(actor, ownerId, advancementId) {
    const origin = `${ownerId}.${advancementId}`;
    return actor.items.filter(item => {
      const advancementOrigin = String(item.getFlag?.("dnd5e", "advancementOrigin") ?? "");
      const advancementRoot = String(item.getFlag?.("dnd5e", "advancementRoot") ?? "");
      return advancementOrigin === origin || advancementRoot === origin;
    });
  }

  static #traitSelectedCount(advancement) {
    const chosen = this.#collectionValues(advancement?.value?.chosen).map(String).filter(Boolean);
    const grants = new Set(this.#collectionValues(advancement?.configuration?.grants).map(String));
    return chosen.filter(value => !grants.has(value)).length;
  }

  static #equivalentWeaponMasteryBadgeExists(badges, expected, targetItemId) {
    const normalizeValues = values => [...new Set((values ?? [])
      .map(value => String(value ?? "").split(" — ")[0].trim())
      .filter(Boolean))].sort();
    const expectedValues = normalizeValues(expected?.values ?? []);
    if (!expectedValues.length) return false;
    return (badges ?? []).some(badge => {
      if (String(badge?.sourceItemId ?? "") !== String(expected?.sourceItemId ?? "")) return false;
      if (String(badge?.targetItemId ?? targetItemId) !== String(targetItemId)) return false;
      if (String(badge?.category ?? "").toLowerCase() !== "weapon mastery") return false;
      return JSON.stringify(normalizeValues(badge?.values ?? [])) === JSON.stringify(expectedValues);
    });
  }

  static #badgeEquivalent(current, expected) {
    const normalize = badge => ({
      advancementId: String(badge?.advancementId ?? ""),
      sourceItemId: String(badge?.sourceItemId ?? ""),
      targetItemId: String(badge?.targetItemId ?? ""),
      kind: String(badge?.kind ?? ""),
      category: String(badge?.category ?? ""),
      values: [...(badge?.values ?? [])].map(String).sort(),
      label: String(badge?.label ?? "")
    });
    return JSON.stringify(normalize(current)) === JSON.stringify(normalize(expected));
  }

  static #isOriginFeatDocument(document) {
    return document?.type === "feat" && String(document.system?.type?.subtype ?? "") === "origin";
  }

  static #isPlausibleLegacyBackgroundFeat(item, background, actor) {
    const advancementOrigin = String(item.getFlag?.("dnd5e", "advancementOrigin") ?? "");
    const advancementRoot = String(item.getFlag?.("dnd5e", "advancementRoot") ?? "");
    if (!advancementOrigin && !advancementRoot) return true;
    const rootId = (advancementRoot || advancementOrigin).split(".")[0];
    if (rootId === background.id) return true;
    // If the root still exists and is a different build source, respect that
    // provenance and do not reinterpret the feat as a Background substitute.
    return !actor.items.get(rootId);
  }

  static #collectionValues(value) {
    if (!value) return [];
    if (Array.isArray(value)) return [...value];
    if (value instanceof Set) return [...value];
    if (value?.contents) return [...value.contents];
    if (value?.values) return [...value.values()];
    try { return [...value]; } catch (_error) { return []; }
  }

  static #normalize(value) {
    return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  static #slug(value) {
    return this.#normalize(value).replace(/\s+/g, "-");
  }
}
