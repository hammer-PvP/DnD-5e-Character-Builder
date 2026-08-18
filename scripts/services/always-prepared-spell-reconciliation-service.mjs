import { MODULE_ID, SPELL_ACCESS_MODELS } from "../constants.mjs";
import { DraftManager } from "./draft-manager.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";

/**
 * Reconciles a native Always Prepared feature grant with a normal acquisition
 * of the same class spell. The grant may be preparation-only or may carry the
 * explicit free-cast augmentation declared by its native ItemGrant. This
 * service is deliberately transaction-scoped: it never scans or migrates
 * legacy Actors and it never claims spells originating from Items.
 */
export class AlwaysPreparedSpellReconciliationService {
  static preview(draft, {
    context = "levelUp",
    state = null,
    classItem = null
  } = {}) {
    const resolvedState = state ?? this.#state(draft, context);
    const transactionId = this.#transactionId(draft, resolvedState, context);
    return this.#plans(draft, {
      context,
      state: resolvedState,
      transactionId,
      classItem
    }).map(plan => this.#publicPlan(plan));
  }

  static releasedNormalSelections(draft, options = {}) {
    const plans = this.preview(draft, options);
    const unique = new Map();
    for (const plan of plans) {
      if (!plan.normalSelectionReleased) continue;
      unique.set(plan.canonicalItemId, plan);
    }
    return [...unique.values()];
  }

  static async reconcile(draft, {
    context = "levelUp",
    state = null,
    integrityResult = null,
    classItem = null
  } = {}) {
    const resolvedState = state ?? this.#state(draft, context);
    const transactionId = this.#transactionId(draft, resolvedState, context);
    const plans = this.#plans(draft, {
      context,
      state: resolvedState,
      transactionId,
      classItem
    });
    const items = [];
    const redirects = [];

    for (const plan of plans) {
      const canonical = draft.items.get(plan.canonicalItemId);
      const duplicate = draft.items.get(plan.grantItemId);
      if (!canonical || !duplicate || canonical.id === duplicate.id) continue;

      const merged = await this.#mergePlan(draft, canonical, duplicate, plan, transactionId);
      if (!merged) continue;
      items.push(merged.summary);
      redirects.push({ from: duplicate.id, to: canonical.id });
    }

    const persistedState = this.#state(draft, context);
    const existing = persistedState?.alwaysPreparedSpellReconciliation;
    const existingItems = existing?.transactionId === transactionId
      ? foundry.utils.deepClone(existing.items ?? [])
      : [];
    const combinedItems = this.#mergeSummaries(existingItems, items);
    const reconciledIntegrity = this.#rewriteIntegrityResult(
      integrityResult,
      redirects,
      draft,
      combinedItems
    );
    const result = {
      schema: 1,
      context,
      transactionId,
      reconciledAt: Date.now(),
      mergedCount: combinedItems.length,
      releasedNormalSelectionCount: combinedItems.filter(row => row.normalSelectionReleased).length,
      items: combinedItems
    };

    await this.#storeResult(draft, resolvedState, context, result, reconciledIntegrity);
    return {
      ...result,
      integrityResult: reconciledIntegrity
    };
  }

  static validate(draft, {
    context = "levelUp",
    state = null,
    classItem = null
  } = {}) {
    const resolvedState = state ?? this.#state(draft, context);
    const transactionId = this.#transactionId(draft, resolvedState, context);
    const remaining = this.#plans(draft, {
      context,
      state: resolvedState,
      transactionId,
      classItem
    });
    if (remaining.length) {
      const names = [...new Set(remaining.map(plan => plan.name))].join(", ");
      throw new Error(`Always Prepared spell reconciliation is incomplete: ${names}.`);
    }

    const unresolvedAugmenting = this.#unresolvedNativeAugmentingPairs(draft, {
      transactionId,
      state: resolvedState,
      classItem
    });
    if (unresolvedAugmenting.length) {
      const names = [...new Set(unresolvedAugmenting.map(row => row.name))].join(", ");
      throw new Error(`Native Always Prepared spell augmentation is incomplete: ${names}.`);
    }

    for (const spell of draft.items.filter(item => item.type === "spell")) {
      const receipts = spell.getFlag(MODULE_ID, "mergedItemGrants") ?? [];
      if (!receipts.length) continue;
      if (Number(spell.system?.prepared ?? 0) !== 2) {
        throw new Error(`${spell.name} has a merged Always Prepared grant but is not Always Prepared.`);
      }
      for (const receipt of receipts) {
        const owner = draft.items.get(receipt.ownerItemId);
        const advancement = owner?.toObject().system?.advancement?.[receipt.advancementId];
        const added = advancement?.value?.added ?? {};
        if (added[spell.id] !== receipt.configuredUuid) {
          throw new Error(`${spell.name} lost the ItemGrant receipt from ${owner?.name ?? receipt.ownerItemId}.`);
        }
      }
    }
    return true;
  }

  static #plans(draft, { transactionId, state = null, classItem = null } = {}) {
    const sourceActor = game.actors.get(draft.getFlag(MODULE_ID, "sourceActorId"));
    const sourceItemIds = new Set(sourceActor?.items.map(item => item.id) ?? []);
    const spells = draft.items.filter(item => item.type === "spell" && Number(item.system?.level ?? 0) > 0);
    const grants = spells
      .map(spell => {
        const grant = this.#currentGrant(spell, draft, transactionId, state);
        return { spell, grant, profile: this.#grantProfile(spell, grant) };
      })
      .filter(row => row.grant && row.profile && Number(row.spell.system?.prepared ?? 0) === 2);
    const plans = [];
    const claimedGrantIds = new Set();

    for (const { spell: grantSpell, grant, profile } of grants) {
      if (claimedGrantIds.has(grantSpell.id)) continue;
      if (classItem && grant.classIdentifier && grant.classIdentifier !== classItem.system?.identifier) continue;
      const candidates = spells.filter(candidate =>
        candidate.id !== grantSpell.id
        && this.#sameSpellIdentity(candidate, grantSpell)
        && this.#isNormalClassAcquisition(candidate, draft, grant.classIdentifier)
        && this.#compatibleCasting(candidate, grantSpell, grant.classIdentifier, draft, profile)
      );
      if (!candidates.length) continue;
      const canonical = this.#chooseCanonical(candidates, sourceItemIds);
      const normal = this.#normalAcquisition(canonical, draft, grant.classIdentifier);
      if (!normal) continue;
      const previousSnapshot = this.#previousSpellSnapshot(canonical, draft);
      const previousPrepared = Number(previousSnapshot.prepared ?? canonical.system?.prepared ?? 0);
      plans.push({
        name: canonical.name,
        identifier: canonical.system?.identifier ?? null,
        classIdentifier: grant.classIdentifier,
        canonicalItemId: canonical.id,
        grantItemId: grantSpell.id,
        previousPrepared,
        normalSelectionReleased: this.#usesLimitedSelection(normal, grant.classIdentifier)
          && previousPrepared === 1,
        normal,
        grant,
        profile,
        previousSnapshot
      });
      claimedGrantIds.add(grantSpell.id);
    }
    return plans;
  }

  static #unresolvedNativeAugmentingPairs(draft, { transactionId, state = null, classItem = null } = {}) {
    const spells = draft.items.filter(item => item.type === "spell" && Number(item.system?.level ?? 0) > 0);
    const unresolved = [];

    for (const grantSpell of spells) {
      if (Number(grantSpell.system?.prepared ?? 0) !== 2) continue;
      if (this.#hasItemCreatorOrigin(grantSpell)) continue;
      const grant = this.#currentGrant(grantSpell, draft, transactionId, state);
      if (!grant?.nativeGrant || !grant.spellConfiguration) continue;
      if (classItem && grant.classIdentifier && grant.classIdentifier !== classItem.system?.identifier) continue;

      const configuredUses = grant.spellConfiguration.uses ?? {};
      const maximum = String(configuredUses.max ?? "").trim();
      const period = String(configuredUses.per ?? "").trim();
      if (!maximum || maximum === "0" || !period) continue;

      const candidate = spells.find(normal =>
        normal.id !== grantSpell.id
        && this.#sameSpellIdentity(normal, grantSpell)
        && this.#isNormalClassAcquisition(normal, draft, grant.classIdentifier)
        && this.#classIdentifierForSpell(normal, draft) === grant.classIdentifier
      );
      if (!candidate) continue;

      unresolved.push({
        name: grantSpell.name,
        identifier: grantSpell.system?.identifier ?? null,
        classIdentifier: grant.classIdentifier,
        canonicalItemId: candidate.id,
        grantItemId: grantSpell.id,
        ownerItemId: grant.ownerItemId,
        advancementId: grant.advancementId
      });
    }
    return unresolved;
  }

  static #currentGrant(spell, draft, transactionId, state = null) {
    const grant = spell.getFlag(MODULE_ID, "itemGrantInstance");
    const integrityRow = (state?.itemGrantIntegrity?.items
      ?? state?.itemGrantReconciliation?.items
      ?? []).find(row => row.itemId === spell.id
        || (row.ownerItemId === grant?.ownerItemId && row.advancementId === grant?.advancementId));
    const owners = (spell.getFlag(MODULE_ID, "featureSpellOwners") ?? [])
      .filter(owner => owner?.alwaysPrepared && owner.transactionId === transactionId);
    const levelUpSpell = spell.getFlag(MODULE_ID, "levelUpSpell");
    const managedFeatureGrant = levelUpSpell?.transactionId === transactionId
      && Boolean(levelUpSpell.featureItemId)
      && Number(spell.system?.prepared ?? 0) === 2;
    if (!(grant?.transactionId === transactionId) && !owners.length && !managedFeatureGrant) return null;

    const ownerItemId = grant?.ownerItemId
      ?? owners[0]?.ownerItemId
      ?? owners[0]?.featureItemId
      ?? owners[0]?.subclassItemId
      ?? owners[0]?.classItemId
      ?? levelUpSpell?.featureItemId
      ?? null;
    const owner = ownerItemId ? draft.items.get(ownerItemId) : null;
    const classIdentifier = owners.find(row => row.classIdentifier)?.classIdentifier
      ?? levelUpSpell?.classIdentifier
      ?? this.#classIdentifierForOwner(owner, draft)
      ?? this.#classIdentifierForSpell(spell, draft)
      ?? null;
    if (!classIdentifier) return null;

    const advancementId = grant?.advancementId
      ?? owners[0]?.advancementId
      ?? integrityRow?.advancementId
      ?? null;
    const rawAdvancement = advancementId
      ? owner?.toObject().system?.advancement?.[advancementId]
      : null;
    const configuredUuid = grant?.configuredUuid
      ?? this.#configuredUuidForSpell(rawAdvancement, spell)
      ?? owners[0]?.sourceUuid
      ?? null;
    const nativeGrant = grant?.transactionId === transactionId
      || owners.some(row => Boolean(row?.nativeGrant))
      || Boolean(rawAdvancement?.type === "ItemGrant" && configuredUuid);
    const advancementOrigin = spell.getFlag("dnd5e", "advancementOrigin")
      ?? (ownerItemId && advancementId ? `${ownerItemId}.${advancementId}` : null);
    return {
      nativeGrant,
      managedFeatureGrant,
      transactionId,
      ownerItemId,
      ownerName: integrityRow?.ownerName ?? owner?.name ?? owners[0]?.label ?? "Feature",
      ownerType: integrityRow?.ownerType ?? owner?.type ?? null,
      classIdentifier,
      advancementId,
      advancementOrigin,
      configuredUuid,
      sourceUuid: grant?.sourceUuid
        ?? spell.getFlag("dnd5e", "sourceId")
        ?? spell._stats?.compendiumSource
        ?? null,
      owners: foundry.utils.deepClone(owners),
      featureItemId: owners[0]?.featureItemId ?? levelUpSpell?.featureItemId ?? null,
      spellConfiguration: foundry.utils.deepClone(rawAdvancement?.configuration?.spell ?? null),
      label: owners[0]?.label
        ?? integrityRow?.advancementTitle
        ?? owner?.name
        ?? "Always Prepared Feature"
    };
  }

  static #configuredUuidForSpell(rawAdvancement, spell) {
    if (rawAdvancement?.type !== "ItemGrant") return null;
    const sourceUuid = this.#sourceUuid(spell);
    const identifier = String(spell.system?.identifier ?? "").trim();
    for (const entry of rawAdvancement.configuration?.items ?? []) {
      const uuid = typeof entry === "string" ? entry : entry?.uuid;
      if (!uuid) continue;
      if (uuid === sourceUuid) return uuid;
      try {
        const source = typeof fromUuidSync === "function" ? fromUuidSync(uuid) : null;
        if (identifier && source?.type === "spell" && source.system?.identifier === identifier) return uuid;
      } catch (_error) {
        // A missing configured source is not enough to make a merge unsafe; the
        // caller will fall back to the spell owner's recorded source UUID.
      }
    }
    return null;
  }

  static #grantProfile(spell, grant) {
    if (!grant || !["class", "subclass", "feat"].includes(grant.ownerType)) return null;
    if (this.#hasItemCreatorOrigin(spell)) return null;

    const itemUses = spell.system?.uses ?? {};
    const hasItemUses = this.#meaningfulUsePool(itemUses);
    const activities = this.#activityValues(spell);
    const hasForward = activities.some(activity => String(activity?.type ?? "") === "forward");
    const hasUseConsumption = activities.some(activity =>
      (activity?.consumption?.targets ?? []).some(target =>
        ["itemUses", "activityUses"].includes(String(target?.type ?? ""))
      )
    );

    if (!hasItemUses && !hasForward && !hasUseConsumption) {
      return { kind: "preparation-only", spellConfiguration: grant.spellConfiguration ?? null };
    }

    // Mechanical augmentation is accepted only when the native ItemGrant
    // explicitly declares the use pool that produced it. This keeps the merge
    // generic for Paladin's Smite / Faithful Steed style grants without
    // treating arbitrary spell modifications as safe.
    if (!grant.nativeGrant || !grant.spellConfiguration) return null;
    const configuredUses = grant.spellConfiguration.uses ?? {};
    const maximum = String(configuredUses.max ?? "").trim();
    const period = String(configuredUses.per ?? "").trim();
    if (!maximum || maximum === "0" || !period) return null;
    if (!this.#grantUsePoolMatches(spell, configuredUses)) return null;

    const requireSlot = Boolean(configuredUses.requireSlot);
    if (!this.#authorizedAugmentationShape(spell, { requireSlot })) return null;
    return {
      kind: "augmenting",
      spellConfiguration: foundry.utils.deepClone(grant.spellConfiguration),
      uses: { max: maximum, per: period, requireSlot }
    };
  }

  static #grantUsePoolMatches(spell, configuredUses) {
    const actual = spell.system?.uses ?? {};
    if (String(actual.max ?? "").trim() !== String(configuredUses.max ?? "").trim()) return false;
    const period = String(configuredUses.per ?? "").trim();
    const recovery = Array.isArray(actual.recovery) ? actual.recovery : [];
    return recovery.some(row => String(row?.period ?? "") === period);
  }

  static #authorizedAugmentationShape(spell, { requireSlot }) {
    const activities = this.#activityValues(spell);
    const base = activities.filter(activity => String(activity?.type ?? "") !== "forward");
    const forwards = activities.filter(activity => String(activity?.type ?? "") === "forward");

    if (!requireSlot) {
      const slotActivities = base.filter(activity => Boolean(activity?.consumption?.spellSlot));
      if (!slotActivities.length || forwards.length !== slotActivities.length) return false;
      const baseIds = new Set(slotActivities.map(activity => String(activity?._id ?? activity?.id ?? "")).filter(Boolean));
      for (const activity of forwards) {
        const forwarded = String(activity?.activity?.id ?? "");
        const targets = activity?.consumption?.targets ?? [];
        if (!baseIds.has(forwarded)) return false;
        if (!targets.some(target => String(target?.type ?? "") === "itemUses")) return false;
        if (targets.some(target => String(target?.type ?? "") === "activityUses")) return false;
      }
      return true;
    }

    if (forwards.length) return false;
    const slotActivities = base.filter(activity => Boolean(activity?.consumption?.spellSlot));
    if (!slotActivities.length) return false;
    return slotActivities.every(activity =>
      (activity?.consumption?.targets ?? []).some(target => String(target?.type ?? "") === "itemUses")
    );
  }

  static #activityValues(item) {
    const activities = item?.system?.activities;
    if (!activities) return [];
    if (typeof activities.values === "function") return [...activities.values()];
    if (Array.isArray(activities)) return activities;
    return Object.values(activities);
  }

  static #meaningfulUsePool(uses) {
    const maximum = String(uses?.max ?? "").trim();
    const recovery = Array.isArray(uses?.recovery)
      ? uses.recovery
      : (uses?.recovery ? [uses.recovery] : []);
    return Boolean(maximum && maximum !== "0") || recovery.length > 0;
  }

  static #hasItemCreatorOrigin(item) {
    const flags = item.toObject().flags ?? {};
    if (Object.keys(flags).some(key => /item[-_ ]?creator/i.test(key))) return true;
    const sourceItem = String(item.system?.sourceItem ?? "").trim();
    return /^(?:item:|Item\.|Actor\.[^.]+\.Item\.|Compendium\..+\.Item\.)/i.test(sourceItem);
  }

  static #sameSpellIdentity(left, right) {
    const leftIdentifier = String(left.system?.identifier ?? "").trim();
    const rightIdentifier = String(right.system?.identifier ?? "").trim();
    if (!leftIdentifier || leftIdentifier !== rightIdentifier) return false;
    if (Number(left.system?.level ?? -1) !== Number(right.system?.level ?? -1)) return false;
    const leftSource = this.#sourceUuid(left);
    const rightSource = this.#sourceUuid(right);
    return Boolean(leftSource && rightSource && leftSource === rightSource);
  }

  static #compatibleCasting(normal, grant, classIdentifier, draft, profile) {
    if (this.#classIdentifierForSpell(normal, draft) !== classIdentifier) return false;
    const normalMethod = String(normal.system?.method ?? "spell");
    const grantMethod = String(grant.system?.method ?? "spell");
    if (normalMethod !== grantMethod) return false;
    const normalAbility = String(normal.system?.ability ?? "");
    const grantAbility = String(grant.system?.ability ?? "");
    if (normalAbility && grantAbility && normalAbility !== grantAbility) return false;
    if (this.#activityFingerprint(normal, { stripRecordedAugmentations: true })
      !== this.#activityFingerprint(grant, { profile })) return false;
    return this.#effectFingerprint(normal) === this.#effectFingerprint(grant);
  }

  static #sourceUuid(item) {
    return String(item.getFlag("dnd5e", "sourceId") ?? item._stats?.compendiumSource ?? "").trim();
  }

  static #activityFingerprint(item, { profile = null, stripRecordedAugmentations = false } = {}) {
    const stripAugmentation = profile?.kind === "augmenting";
    const requireSlot = Boolean(profile?.uses?.requireSlot);
    const recordedReceipts = stripRecordedAugmentations
      ? (item.getFlag(MODULE_ID, "mergedItemGrants") ?? []).map(receipt => receipt?.augmentation).filter(Boolean)
      : [];
    const recordedAddedIds = new Set(recordedReceipts.flatMap(receipt => receipt?.addedActivityIds ?? []));
    const activities = Object.entries(item.toObject().system?.activities ?? {}).map(([activityId, activity]) => {
      if (recordedAddedIds.has(activityId)) return null;
      if (stripAugmentation && !requireSlot && String(activity?.type ?? "") === "forward") return null;
      const row = foundry.utils.deepClone(activity ?? {});
      delete row._id;
      delete row.id;
      delete row.name;
      delete row.img;
      delete row.sort;
      delete row.description;
      delete row._stats;
      const uses = row.uses ?? {};
      if (!this.#meaningfulUsePool(uses)) delete row.uses;
      if (row.consumption && Array.isArray(row.consumption.targets)) {
        if (stripRecordedAugmentations) {
          for (const receipt of recordedReceipts) {
            const previous = receipt?.activityConsumptionPrevious?.[activityId];
            if (Array.isArray(previous)) row.consumption.targets = foundry.utils.deepClone(previous);
          }
        }
        if (stripAugmentation && requireSlot) {
          row.consumption.targets = row.consumption.targets.filter(target =>
            String(target?.type ?? "") !== "itemUses"
          );
        }
        if (!row.consumption.targets.length) delete row.consumption.targets;
      }
      return row;
    }).filter(Boolean);
    return this.#stableStringify(activities.sort((a, b) =>
      this.#stableStringify(a).localeCompare(this.#stableStringify(b))
    ));
  }

  static #effectFingerprint(item) {
    const effects = Object.values(item.toObject().effects ?? {}).map(effect => {
      const row = foundry.utils.deepClone(effect ?? {});
      delete row._id;
      delete row.id;
      delete row.name;
      delete row.img;
      delete row.origin;
      delete row.sort;
      delete row._stats;
      delete row.start;
      delete row.folder;
      if (row.duration && Object.prototype.hasOwnProperty.call(row.duration, "expired")) {
        delete row.duration.expired;
      }
      return row;
    });
    return this.#stableStringify(effects.sort((a, b) =>
      this.#stableStringify(a).localeCompare(this.#stableStringify(b))
    ));
  }

  static #stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(row => this.#stableStringify(row)).join(",")}]`;
    if (value && value.constructor === Object) {
      return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${this.#stableStringify(value[key])}`
      ).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  static #isNormalClassAcquisition(item, draft, classIdentifier) {
    return Boolean(this.#normalAcquisition(item, draft, classIdentifier));
  }

  static #normalAcquisition(item, draft, classIdentifier) {
    if (!item || item.type !== "spell" || this.#hasItemCreatorOrigin(item)) return null;
    const reconciliation = item.getFlag(MODULE_ID, "alwaysPreparedReconciliation");
    if (reconciliation?.normalAcquisition?.classIdentifier === classIdentifier) {
      return foundry.utils.deepClone(reconciliation.normalAcquisition);
    }

    const classItemId = item.getFlag(MODULE_ID, "classItemId");
    const flaggedClassIdentifier = item.getFlag(MODULE_ID, "classIdentifier");
    const classSpellAccess = item.getFlag(MODULE_ID, "classSpellAccess");
    if (classSpellAccess && (flaggedClassIdentifier === classIdentifier
      || draft.items.get(classItemId)?.system?.identifier === classIdentifier)) {
      return {
        type: "class-spell-access",
        classIdentifier,
        classItemId: classItemId ?? null,
        accessModel: item.getFlag(MODULE_ID, "accessModel") ?? null,
        category: item.getFlag(MODULE_ID, "category") ?? null
      };
    }

    const levelUp = item.getFlag(MODULE_ID, "levelUpSpell");
    if (levelUp?.classIdentifier === classIdentifier && !levelUp.featureItemId) {
      return {
        type: "level-up-spell",
        classIdentifier,
        classItemId: levelUp.classItemId ?? null,
        accessModel: levelUp.accessModel ?? null,
        category: levelUp.category ?? null,
        transactionId: levelUp.transactionId ?? null
      };
    }

    const sourceItem = String(item.system?.sourceItem ?? "");
    if (sourceItem === `class:${classIdentifier}`
      && !(item.getFlag(MODULE_ID, "itemGrantInstance"))
      && !(item.getFlag(MODULE_ID, "featureSpellOwners") ?? []).length) {
      return {
        type: "native-class-spell",
        classIdentifier,
        classItemId: draft.items.find(row => row.type === "class"
          && row.system?.identifier === classIdentifier)?.id ?? null,
        accessModel: null,
        category: null
      };
    }
    return null;
  }

  static #usesLimitedSelection(normal, classIdentifier) {
    const accessModel = String(normal?.accessModel ?? "");
    if (accessModel === "fullList" || accessModel === "spellbook") return false;
    if (accessModel === "limited") return true;
    if (SPELL_ACCESS_MODELS.limited.has(classIdentifier)) return true;
    // Third-caster subclass access is stored under its subclass identifier
    // rather than the literal "limited" model.
    if (accessModel) return true;
    return ["limited", "replacement"].includes(String(normal?.category ?? ""));
  }

  static #chooseCanonical(candidates, sourceItemIds) {
    return [...candidates].sort((left, right) => {
      const score = item => {
        let value = 0;
        if (sourceItemIds.has(item.id)) value += 100;
        if (item.getFlag(MODULE_ID, "classSpellAccess")) value += 40;
        const levelUp = item.getFlag(MODULE_ID, "levelUpSpell");
        if (levelUp && !levelUp.featureItemId) value += 30;
        if (Number(item.system?.prepared ?? 0) === 1) value += 10;
        return value;
      };
      return score(right) - score(left) || String(left.id).localeCompare(String(right.id));
    })[0];
  }

  static #previousSpellSnapshot(canonical, draft) {
    const sourceActor = game.actors.get(draft.getFlag(MODULE_ID, "sourceActorId"));
    const live = sourceActor?.items.get(canonical.id);
    const source = live && this.#sameSpellIdentity(live, canonical) ? live : canonical;
    return {
      source: live ? "source-actor" : "draft",
      prepared: Number(source.system?.prepared ?? 0),
      ability: source.system?.ability ?? null,
      method: source.system?.method ?? null,
      uses: foundry.utils.deepClone(source.system?.uses ?? {}),
      activities: foundry.utils.deepClone(source.toObject().system?.activities ?? {})
    };
  }

  static async #mergePlan(draft, canonical, duplicate, plan, transactionId) {
    const existingReconciliation = foundry.utils.deepClone(
      canonical.getFlag(MODULE_ID, "alwaysPreparedReconciliation") ?? {}
    );
    const existingOwners = foundry.utils.deepClone(canonical.getFlag(MODULE_ID, "featureSpellOwners") ?? []);
    const duplicateOwners = foundry.utils.deepClone(duplicate.getFlag(MODULE_ID, "featureSpellOwners") ?? plan.grant.owners ?? []);
    const restorablePrepared = Number.isFinite(Number(existingReconciliation.normalAcquisition?.previousPrepared))
      ? Number(existingReconciliation.normalAcquisition.previousPrepared)
      : plan.previousPrepared;
    const augmentation = this.#augmentationDelta(canonical, duplicate, plan);
    if (plan.profile?.kind === "augmenting" && !augmentation) return null;
    const owners = [...existingOwners];
    for (const sourceOwner of duplicateOwners) {
      const owner = foundry.utils.deepClone(sourceOwner);
      if (owner.alwaysPrepared && !Number.isFinite(Number(owner.previousPrepared))) {
        owner.previousPrepared = restorablePrepared;
      }
      const key = this.#ownerKey(owner);
      const index = owners.findIndex(row => this.#ownerKey(row) === key);
      if (index >= 0) owners[index] = owner;
      else owners.push(owner);
    }

    if (!duplicateOwners.length) {
      owners.push({
        category: this.#slug(plan.grant.label),
        label: plan.grant.label,
        classIdentifier: plan.classIdentifier,
        classItemId: plan.normal.classItemId ?? null,
        subclassItemId: plan.grant.ownerType === "subclass" ? plan.grant.ownerItemId : null,
        featureItemId: plan.grant.featureItemId,
        ownerItemId: plan.grant.ownerItemId,
        advancementId: plan.grant.advancementId,
        transactionId,
        sourceUuid: plan.grant.sourceUuid,
        alwaysPrepared: true,
        nativeGrant: Boolean(plan.grant.nativeGrant),
        previousPrepared: restorablePrepared
      });
    }

    const existingReceipts = foundry.utils.deepClone(canonical.getFlag(MODULE_ID, "mergedItemGrants") ?? []);
    const receipt = plan.grant.nativeGrant ? {
      ownerItemId: plan.grant.ownerItemId,
      advancementId: plan.grant.advancementId,
      advancementOrigin: plan.grant.advancementOrigin,
      configuredUuid: plan.grant.configuredUuid,
      sourceUuid: plan.grant.sourceUuid,
      transactionId,
      mergedFromItemId: duplicate.id,
      augmentation: augmentation ? foundry.utils.deepClone(augmentation.receipt) : null
    } : null;
    const receipts = receipt ? this.#mergeReceipt(existingReceipts, receipt) : existingReceipts;

    const grants = Array.isArray(existingReconciliation.grants)
      ? existingReconciliation.grants
      : [];
    const grantRecord = {
      ownerItemId: plan.grant.ownerItemId,
      ownerName: plan.grant.ownerName,
      ownerType: plan.grant.ownerType,
      featureItemId: plan.grant.featureItemId,
      advancementId: plan.grant.advancementId,
      configuredUuid: plan.grant.configuredUuid,
      sourceUuid: plan.grant.sourceUuid,
      transactionId,
      mergedFromItemId: duplicate.id,
      label: plan.grant.label,
      grantKind: plan.profile?.kind ?? "preparation-only",
      augmentation: augmentation ? foundry.utils.deepClone(augmentation.receipt) : null
    };
    const grantKey = this.#grantKey(grantRecord);
    const mergedGrants = grants.filter(row => this.#grantKey(row) !== grantKey);
    mergedGrants.push(grantRecord);

    const update = {
      "system.prepared": 2,
      ...(augmentation?.updates ?? {}),
      ...(!String(canonical.system?.ability ?? "").trim() && String(duplicate.system?.ability ?? "").trim()
        ? { "system.ability": duplicate.system.ability }
        : {}),
      ...(!String(canonical.system?.method ?? "").trim() && String(duplicate.system?.method ?? "").trim()
        ? { "system.method": duplicate.system.method }
        : {}),
      [`flags.${MODULE_ID}.featureGrantedSpell`]: true,
      [`flags.${MODULE_ID}.featureSpellOwners`]: owners,
      [`flags.${MODULE_ID}.mergedItemGrants`]: receipts,
      [`flags.${MODULE_ID}.alwaysPreparedReconciliation`]: {
        schema: 2,
        normalAcquisition: {
          ...foundry.utils.deepClone(plan.normal),
          previousPrepared: restorablePrepared,
          previousSnapshot: foundry.utils.deepClone(plan.previousSnapshot)
        },
        grants: mergedGrants,
        lastTransactionId: transactionId,
        alwaysPrepared: true
      }
    };
    await canonical.update(update, {
      characterBuilderAlwaysPreparedReconciliation: true
    });

    if (receipt) await this.#redirectNativeGrant(draft, receipt, duplicate.id, canonical.id);
    await draft.deleteEmbeddedDocuments("Item", [duplicate.id], {
      deleteContents: true,
      characterBuilderAlwaysPreparedReconciliation: true
    });

    return {
      summary: {
        spellItemId: canonical.id,
        name: canonical.name,
        img: canonical.img,
        identifier: canonical.system?.identifier ?? null,
        classIdentifier: plan.classIdentifier,
        source: plan.grant.label,
        ownerItemId: plan.grant.ownerItemId,
        ownerName: plan.grant.ownerName,
        previousPrepared: restorablePrepared,
        alwaysPrepared: true,
        grantKind: plan.profile?.kind ?? "preparation-only",
        augmented: Boolean(augmentation),
        addedActivityIds: augmentation?.receipt?.addedActivityIds ?? [],
        normalSelectionReleased: plan.normalSelectionReleased,
        removedDuplicateItemId: duplicate.id
      }
    };
  }

  static #augmentationDelta(canonical, duplicate, plan) {
    if (plan.profile?.kind !== "augmenting") return null;
    // A pre-existing Item use pool may belong to another acquisition and cannot
    // safely be repurposed for a second native free-cast grant.
    if (this.#meaningfulUsePool(canonical.system?.uses ?? {})) return null;
    const requireSlot = Boolean(plan.profile?.uses?.requireSlot);
    const canonicalActivities = foundry.utils.deepClone(canonical.toObject().system?.activities ?? {});
    const duplicateActivities = foundry.utils.deepClone(duplicate.toObject().system?.activities ?? {});
    const updates = {
      "system.uses": foundry.utils.deepClone(duplicate.system?.uses ?? {})
    };
    const addedActivityIds = [];
    const activityConsumptionPrevious = {};

    if (!requireSlot) {
      for (const [id, activity] of Object.entries(duplicateActivities)) {
        if (String(activity?.type ?? "") !== "forward") continue;
        const forwardedId = String(activity?.activity?.id ?? "");
        if (!canonicalActivities[forwardedId]) return null;
        if (canonicalActivities[id]) {
          if (this.#stableStringify(canonicalActivities[id]) !== this.#stableStringify(activity)) return null;
          continue;
        }
        updates[`system.activities.${id}`] = foundry.utils.deepClone(activity);
        addedActivityIds.push(id);
      }
      if (!addedActivityIds.length) return null;
    } else {
      for (const [id, duplicateActivity] of Object.entries(duplicateActivities)) {
        if (String(duplicateActivity?.type ?? "") === "forward") continue;
        const canonicalActivity = canonicalActivities[id];
        if (!canonicalActivity || !duplicateActivity?.consumption?.spellSlot) continue;
        const grantedTargets = (duplicateActivity.consumption?.targets ?? [])
          .filter(target => String(target?.type ?? "") === "itemUses");
        if (!grantedTargets.length) continue;
        activityConsumptionPrevious[id] = foundry.utils.deepClone(canonicalActivity.consumption?.targets ?? []);
        const targets = foundry.utils.deepClone(canonicalActivity.consumption?.targets ?? []);
        for (const target of grantedTargets) {
          const key = this.#stableStringify(target);
          if (!targets.some(row => this.#stableStringify(row) === key)) targets.push(foundry.utils.deepClone(target));
        }
        updates[`system.activities.${id}.consumption.targets`] = targets;
      }
      if (!Object.keys(activityConsumptionPrevious).length) return null;
    }

    return {
      updates,
      receipt: {
        kind: "native-item-grant",
        requireSlot,
        previousUses: foundry.utils.deepClone(plan.previousSnapshot?.uses ?? canonical.system?.uses ?? {}),
        appliedUses: foundry.utils.deepClone(duplicate.system?.uses ?? {}),
        addedActivityIds,
        activityConsumptionPrevious,
        configuredUses: foundry.utils.deepClone(plan.profile?.uses ?? {})
      }
    };
  }

  static async #redirectNativeGrant(draft, receipt, duplicateId, canonicalId) {
    const owner = draft.items.get(receipt.ownerItemId);
    if (!owner || !receipt.advancementId || !receipt.configuredUuid) {
      throw new Error("A native Always Prepared grant could not be redirected to its canonical spell.");
    }
    const raw = owner.toObject().system?.advancement?.[receipt.advancementId];
    if (!raw) throw new Error(`The ItemGrant Advancement ${receipt.advancementId} no longer exists on ${owner.name}.`);

    // Foundry document updates recursively merge nested objects. Replacing a
    // cloned `value` object with the duplicate key omitted therefore does not
    // reliably delete the old ItemGrant mapping. Use Foundry's explicit nested
    // deletion operator and write the surviving canonical mapping atomically.
    const addedPath = `system.advancement.${receipt.advancementId}.value.added`;
    await owner.update({
      [`${addedPath}.-=${duplicateId}`]: null,
      [`${addedPath}.${canonicalId}`]: receipt.configuredUuid
    }, {
      characterBuilderAlwaysPreparedReconciliation: true
    });

    const persisted = owner.toObject().system?.advancement?.[receipt.advancementId]?.value?.added ?? {};
    if (Object.hasOwn(persisted, duplicateId) || persisted[canonicalId] !== receipt.configuredUuid) {
      throw new Error(`The ItemGrant Advancement ${receipt.advancementId} on ${owner.name} could not be redirected cleanly to ${canonicalId}.`);
    }
  }

  static #rewriteIntegrityResult(result, redirects, draft, reconciledItems) {
    if (!result) return null;
    const redirectMap = new Map(redirects.map(row => [row.from, row.to]));
    const clone = foundry.utils.deepClone(result);
    clone.items = (clone.items ?? []).map(row => {
      const targetId = redirectMap.get(row.itemId);
      if (!targetId) return row;
      const item = draft.items.get(targetId);
      return {
        ...row,
        itemId: targetId,
        uuid: item?.uuid ?? row.uuid,
        name: item?.name ?? row.name,
        img: item?.img ?? row.img,
        alwaysPrepared: true,
        reconciledToCanonicalSpell: true
      };
    });
    const unique = new Map();
    for (const row of clone.items ?? []) {
      unique.set(`${row.itemId}:${row.advancementOrigin}`, row);
    }
    clone.items = [...unique.values()];
    clone.removedDuplicateItemIds = [...new Set([
      ...(clone.removedDuplicateItemIds ?? []),
      ...redirects.map(row => row.from)
    ])];
    clone.mergedSpellGrantItemIds = [...new Set([
      ...(clone.mergedSpellGrantItemIds ?? []),
      ...redirects.map(row => row.to)
    ])];
    clone.alwaysPreparedReconciliations = foundry.utils.deepClone(reconciledItems);
    return clone;
  }

  static async #storeResult(draft, state, context, result, integrityResult) {
    if (context === "creation") {
      await DraftManager.setBuildState(draft, {
        alwaysPreparedSpellReconciliation: result,
        ...(integrityResult ? { itemGrantIntegrity: integrityResult } : {})
      });
      return;
    }
    await LevelUpDraftManager.setState(draft, {
      alwaysPreparedSpellReconciliation: result,
      ...(integrityResult ? {
        itemGrantIntegrity: integrityResult,
        itemGrantReconciliation: integrityResult
      } : {})
    });
  }


  static #mergeSummaries(existing, additions) {
    const rows = new Map();
    for (const row of [...existing, ...additions]) {
      const key = [
        row.spellItemId,
        row.ownerItemId,
        row.removedDuplicateItemId,
        row.identifier
      ].join(":");
      rows.set(key, foundry.utils.deepClone(row));
    }
    return [...rows.values()];
  }

  static #mergeReceipt(existing, receipt) {
    const key = this.#receiptKey(receipt);
    const rows = existing.filter(row => this.#receiptKey(row) !== key);
    rows.push(receipt);
    return rows;
  }

  static #receiptKey(receipt) {
    return [receipt.ownerItemId, receipt.advancementId, receipt.configuredUuid].join(":");
  }

  static #ownerKey(owner) {
    return [owner.category, owner.featureItemId, owner.ownerItemId, owner.advancementId].join(":");
  }

  static #grantKey(grant) {
    return [grant.ownerItemId, grant.featureItemId, grant.advancementId, grant.configuredUuid].join(":");
  }

  static #classIdentifierForSpell(spell, draft) {
    const reconciliation = spell.getFlag(MODULE_ID, "alwaysPreparedReconciliation");
    if (reconciliation?.normalAcquisition?.classIdentifier) {
      return reconciliation.normalAcquisition.classIdentifier;
    }
    const levelUp = spell.getFlag(MODULE_ID, "levelUpSpell");
    if (levelUp?.classIdentifier) return levelUp.classIdentifier;
    const flagged = spell.getFlag(MODULE_ID, "classIdentifier");
    if (flagged) return flagged;
    const classItemId = spell.getFlag(MODULE_ID, "classItemId");
    const classItem = classItemId ? draft.items.get(classItemId) : null;
    if (classItem?.system?.identifier) return classItem.system.identifier;
    const owners = spell.getFlag(MODULE_ID, "featureSpellOwners") ?? [];
    const owned = owners.find(owner => owner.classIdentifier)?.classIdentifier;
    if (owned) return owned;
    const sourceItem = String(spell.system?.sourceItem ?? "");
    const match = /^class:([^:]+)$/i.exec(sourceItem);
    return match?.[1] ?? null;
  }

  static #classIdentifierForOwner(owner, draft) {
    if (!owner) return null;
    if (owner.type === "class") return owner.system?.identifier ?? null;
    if (owner.type === "subclass") {
      return owner.system?.classIdentifier ?? owner.system?.class?.identifier ?? owner.system?.class ?? null;
    }
    const grantOwnerId = owner.getFlag(MODULE_ID, "itemGrantInstance")?.ownerItemId;
    const root = owner.getFlag("dnd5e", "advancementRoot")
      ?? owner.getFlag("dnd5e", "advancementOrigin");
    const [rootId] = String(root ?? "").split(".");
    const next = draft.items.get(grantOwnerId || rootId);
    if (next && next.id !== owner.id) return this.#classIdentifierForOwner(next, draft);
    return null;
  }

  static #publicPlan(plan) {
    return {
      name: plan.name,
      identifier: plan.identifier,
      classIdentifier: plan.classIdentifier,
      canonicalItemId: plan.canonicalItemId,
      grantItemId: plan.grantItemId,
      previousPrepared: plan.previousPrepared,
      grantKind: plan.profile?.kind ?? "preparation-only",
      normalSelectionReleased: plan.normalSelectionReleased,
      source: plan.grant.label,
      ownerItemId: plan.grant.ownerItemId,
      ownerName: plan.grant.ownerName
    };
  }

  static #state(draft, context) {
    return context === "creation"
      ? DraftManager.getBuildState(draft)
      : LevelUpDraftManager.getState(draft);
  }

  static #transactionId(draft, state, context) {
    return state?.transactionId
      ?? (context === "creation" ? `creation:${draft.id}` : `level-up:${draft.id}`);
  }

  static #slug(value) {
    return String(value ?? "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
}
