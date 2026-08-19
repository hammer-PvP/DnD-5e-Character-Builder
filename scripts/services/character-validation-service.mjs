import { MODULE_ID, MODULE_VERSION } from "../constants.mjs";
import { SourceRegistry } from "./source-registry.mjs";
import { CharacterValidationProgressionService } from "./character-validation-progression-service.mjs";
import { NativeSpellGrantProjectionService } from "./native-spell-grant-projection-service.mjs";
import { FeatureSpellOwnershipService } from "./feature-spell-ownership-service.mjs";

const VALIDATION_FLAG = "characterValidation";
const SCHEMA_VERSION = 1;
const TRANSIENT_FLAGS = new Set([
  "isDraft",
  "isLevelUpDraft",
  "draftActorId",
  "levelUpDraftId",
  "draftCreationLock",
  "creationTransaction",
  "commitSafetyLock",
  "commitSafetyBackup",
  "levelUpGrant",
  "levelUpHitPointRoll",
  "restManagementSession",
  "runtimeManagementCommitLock",
  "runtimeManagementSafetyLock"
]);

export class CharacterValidationService {
  static get flag() {
    return VALIDATION_FLAG;
  }

  static async createRevision(sourceActor) {
    if (!game.user?.isGM) throw new Error("Character Validation is GM-only.");
    if (!sourceActor || sourceActor.type !== "character") {
      throw new Error("Character Validation can only review Player Character Actors.");
    }
    if (sourceActor.getFlag(MODULE_ID, "isDraft") || sourceActor.getFlag(MODULE_ID, "isLevelUpDraft")) {
      throw new Error("Character Builder drafts cannot be validated as live characters.");
    }

    const parentValidation = foundry.utils.deepClone(sourceActor.getFlag(MODULE_ID, VALIDATION_FLAG) ?? null);
    const rootActorUuid = parentValidation?.rootActorUuid ?? sourceActor.uuid;
    const rootActor = await fromUuid(rootActorUuid).catch(() => null) ?? sourceActor;
    const rootName = String(rootActor?.name ?? sourceActor.name ?? "Character").trim();
    const revision = this.#nextRevision(rootActorUuid);
    const reviewName = this.#reviewName(rootName, revision);

    const data = foundry.utils.deepClone(sourceActor.toObject());
    const revisedActorId = foundry.utils.randomID();
    data._id = revisedActorId;
    this.#rebindCopiedActorReferences(data, sourceActor.id, revisedActorId);
    data.name = reviewName;
    data.prototypeToken ??= {};
    data.prototypeToken.name = reviewName;
    data.flags ??= {};
    data.flags[MODULE_ID] ??= {};
    for (const key of TRANSIENT_FLAGS) delete data.flags[MODULE_ID][key];
    data.flags[MODULE_ID][VALIDATION_FLAG] = {
      schemaVersion: SCHEMA_VERSION,
      moduleVersion: MODULE_VERSION,
      status: "in-progress",
      rootActorUuid,
      sourceActorUuid: sourceActor.uuid,
      previousRevisionUuid: parentValidation ? sourceActor.uuid : null,
      revision,
      startedAt: Date.now(),
      startedBy: game.user.id,
      completedAt: null,
      completedBy: null,
      report: null
    };

    const created = await Actor.implementation.create(data, {
      keepId: true,
      keepEmbeddedIds: true,
      renderSheet: false,
      characterBuilderValidationCopy: true
    });
    if (!created) throw new Error("Foundry did not create the revised Actor copy.");
    return created;
  }

  static async scan(actor) {
    if (!game.user?.isGM) throw new Error("Character Validation is GM-only.");
    const registry = new SourceRegistry();
    await registry.load();

    const issues = [];
    issues.push(...await this.#scanBrokenActivityEffects(actor, registry));
    issues.push(...await this.#scanMissingAdvancementItems(actor, registry));
    issues.push(...this.#scanForeignSelfReferences(actor));
    const progression = await CharacterValidationProgressionService.scan(actor, registry);
    issues.push(...progression.issues);

    issues.sort((a, b) => {
      const severityRank = { error: 0, warning: 1, info: 2 };
      const left = severityRank[a.severity] ?? 9;
      const right = severityRank[b.severity] ?? 9;
      return left - right || a.title.localeCompare(b.title, game.i18n.lang);
    });

    return {
      scannedAt: Date.now(),
      issueCount: issues.length,
      repairableCount: issues.filter(issue => issue.repairable).length,
      safeCount: issues.filter(issue => issue.repairable && issue.repairMode !== "guided").length,
      warningCount: issues.filter(issue => issue.severity === "warning").length,
      guidedCount: issues.filter(issue => issue.repairMode === "guided").length,
      coverage: [
        { id: "structural-links", label: "Structural Links", status: "checked" },
        { id: "advancement-records", label: "Advancement Records", status: "checked" },
        { id: "actor-references", label: "Actor Self-References", status: "checked" },
        ...(progression.coverage ?? [])
      ],
      issues
    };
  }

  static async applyRepair(actor, issue) {
    if (!game.user?.isGM) throw new Error("Character Validation is GM-only.");
    if (!issue?.repairable) throw new Error("This validation issue has no safe automatic repair.");

    switch (issue.kind) {
      case "broken-activity-effects":
        return this.#repairBrokenActivityEffects(actor, issue);
      case "missing-advancement-item":
        return this.#repairMissingAdvancementItem(actor, issue);
      case "foreign-self-reference":
        return this.#repairForeignSelfReferences(actor, issue);
      default: {
        const progressionResult = await CharacterValidationProgressionService.applyRepair(actor, issue);
        if (progressionResult) return progressionResult;
        throw new Error(`Unsupported validation repair: ${issue.kind}.`);
      }
    }
  }

  static async finalize(actor, { sourceActor = null, results = [], unresolved = [] } = {}) {
    if (!game.user?.isGM) throw new Error("Character Validation is GM-only.");
    const current = foundry.utils.deepClone(actor.getFlag(MODULE_ID, VALIDATION_FLAG) ?? {});
    const report = {
      finalizedAt: Date.now(),
      repaired: results.filter(row => row.status === "repaired"),
      skipped: results.filter(row => row.status === "skipped"),
      unresolved: unresolved.map(issue => ({
        id: issue.id,
        kind: issue.kind,
        title: issue.title,
        summary: issue.summary,
        severity: issue.severity
      }))
    };
    await actor.setFlag(MODULE_ID, VALIDATION_FLAG, {
      ...current,
      status: unresolved.length ? "complete-with-review" : "complete",
      completedAt: Date.now(),
      completedBy: game.user.id,
      report
    });
    await this.#postChatSummary(actor, sourceActor, report);
    return report;
  }

  static #rebindCopiedActorReferences(data, sourceActorId, revisedActorId) {
    const sourcePrefix = `Actor.${sourceActorId}`;
    const revisedPrefix = `Actor.${revisedActorId}`;
    const visit = value => {
      if (typeof value === "string") return value.includes(sourcePrefix) ? value.split(sourcePrefix).join(revisedPrefix) : value;
      if (Array.isArray(value)) return value.map(visit);
      if (!value || typeof value !== "object") return value;
      for (const [key, child] of Object.entries(value)) value[key] = visit(child);
      return value;
    };
    visit(data);
    return data;
  }

  static #scanForeignSelfReferences(actor) {
    const issues = [];
    const collect = (value, path = "", rows = []) => {
      if (typeof value === "string") {
        const regex = /Actor\.([A-Za-z0-9]{16})\.Item\.([A-Za-z0-9]{16})(?:\.Activity\.([A-Za-z0-9]{16}))?/g;
        let match;
        while ((match = regex.exec(value))) {
          const [, actorId, itemId, activityId] = match;
          if (actorId === actor.id) continue;
          const localItem = actor.items.get(itemId);
          if (!localItem) continue;
          if (activityId && !localItem.system?.activities?.get?.(activityId)
            && !localItem.toObject().system?.activities?.[activityId]) continue;
          rows.push({ path, value, actorId, itemId, activityId: activityId ?? null });
        }
        return rows;
      }
      if (Array.isArray(value)) {
        value.forEach((child, index) => collect(child, path ? `${path}.${index}` : String(index), rows));
        return rows;
      }
      if (!value || typeof value !== "object") return rows;
      for (const [key, child] of Object.entries(value)) collect(child, path ? `${path}.${key}` : key, rows);
      return rows;
    };

    const documentRows = [];
    const actorRaw = actor.toObject();
    const actorScope = { system: actorRaw.system ?? {}, flags: actorRaw.flags ?? {}, prototypeToken: actorRaw.prototypeToken ?? {} };
    const actorRefs = collect(actorScope).filter(row => !row.path.startsWith(`flags.${MODULE_ID}.${VALIDATION_FLAG}`));
    if (actorRefs.length) documentRows.push({ documentType: "Actor", documentId: actor.id, name: actor.name, refs: actorRefs });

    for (const item of actor.items ?? []) {
      const raw = item.toObject();
      const refs = collect({ system: raw.system ?? {}, flags: raw.flags ?? {} });
      if (refs.length) documentRows.push({ documentType: "Item", documentId: item.id, name: item.name, refs });
      for (const effect of item.effects ?? []) {
        const effectRaw = effect.toObject();
        const effectRefs = collect({ origin: effectRaw.origin, description: effectRaw.description, flags: effectRaw.flags ?? {} });
        if (effectRefs.length) documentRows.push({ documentType: "ItemActiveEffect", documentId: effect.id, parentId: item.id, name: effect.name, refs: effectRefs });
      }
    }
    for (const effect of actor.effects ?? []) {
      const effectRaw = effect.toObject();
      const refs = collect({ origin: effectRaw.origin, description: effectRaw.description, flags: effectRaw.flags ?? {} });
      if (refs.length) documentRows.push({ documentType: "ActorActiveEffect", documentId: effect.id, name: effect.name, refs });
    }

    for (const row of documentRows) {
      issues.push({
        id: `foreign-self-reference:${row.documentType}:${row.parentId ?? actor.id}:${row.documentId}`,
        kind: "foreign-self-reference",
        severity: "error",
        repairable: true,
        repairMode: "safe",
        repairLabel: "Rebind to Revised Actor",
        title: `${row.name} — Stale Actor Reference`,
        summary: `${row.refs.length} internal reference${row.refs.length === 1 ? " still points" : "s still point"} to another Actor ID even though the referenced embedded document exists on this revised Actor.`,
        details: "The Validator can replace only the Actor UUID prefix and preserve the embedded Item/Activity IDs.",
        data: row
      });
    }
    return issues;
  }

  static async #repairForeignSelfReferences(actor, issue) {
    const row = issue.data ?? {};
    const provenPrefixes = [...new Map((row.refs ?? []).map(ref => {
      const actorId = String(ref?.actorId ?? "");
      const itemId = String(ref?.itemId ?? "");
      if (!actorId || !itemId || actorId === actor.id || !actor.items.get(itemId)) return null;
      return [`Actor.${actorId}.Item.${itemId}`, `Actor.${actor.id}.Item.${itemId}`];
    }).filter(Boolean)).entries()];
    if (!provenPrefixes.length) throw new Error("No provable stale self-reference remains to repair.");

    const replace = value => {
      if (typeof value !== "string") return value;
      let result = value;
      for (const [from, to] of provenPrefixes) result = result.split(from).join(to);
      return result;
    };
    const patchObject = value => {
      if (typeof value === "string") return replace(value);
      if (Array.isArray(value)) return value.map(patchObject);
      if (!value || typeof value !== "object") return value;
      const result = {};
      for (const [key, child] of Object.entries(value)) result[key] = patchObject(child);
      return result;
    };

    if (row.documentType === "Actor") {
      const raw = actor.toObject();
      await actor.update({
        system: patchObject(raw.system ?? {}),
        flags: patchObject(raw.flags ?? {}),
        prototypeToken: patchObject(raw.prototypeToken ?? {})
      }, { characterBuilderValidationRepair: true });
    } else if (row.documentType === "Item") {
      const item = actor.items.get(row.documentId);
      if (!item) throw new Error("The Item with the stale self-reference no longer exists.");
      const raw = item.toObject();
      await item.update({ system: patchObject(raw.system ?? {}), flags: patchObject(raw.flags ?? {}) }, {
        characterBuilderValidationRepair: true
      });
    } else if (row.documentType === "ItemActiveEffect") {
      const effect = actor.items.get(row.parentId)?.effects?.get?.(row.documentId);
      if (!effect) throw new Error("The embedded Active Effect with the stale self-reference no longer exists.");
      const raw = effect.toObject();
      await effect.update({
        origin: replace(raw.origin),
        description: patchObject(raw.description),
        flags: patchObject(raw.flags ?? {})
      }, { characterBuilderValidationRepair: true });
    } else if (row.documentType === "ActorActiveEffect") {
      const effect = actor.effects.get?.(row.documentId);
      if (!effect) throw new Error("The Actor Active Effect with the stale self-reference no longer exists.");
      const raw = effect.toObject();
      await effect.update({
        origin: replace(raw.origin),
        description: patchObject(raw.description),
        flags: patchObject(raw.flags ?? {})
      }, { characterBuilderValidationRepair: true });
    }
    return {
      status: "repaired",
      issueId: issue.id,
      title: issue.title,
      message: `Rebound ${row.refs?.length ?? 0} stale internal Actor reference${row.refs?.length === 1 ? "" : "s"} on ${row.name}.`
    };
  }

  static #nextRevision(rootActorUuid) {
    let max = 0;
    for (const actor of game.actors ?? []) {
      const validation = actor.getFlag?.(MODULE_ID, VALIDATION_FLAG);
      if (!validation || validation.rootActorUuid !== rootActorUuid) continue;
      max = Math.max(max, Number(validation.revision ?? 0));
    }
    return max + 1;
  }

  static #reviewName(rootName, revision) {
    return revision <= 1 ? `${rootName} - Revisado` : `${rootName} - Revisado ${revision}`;
  }

  static async #scanBrokenActivityEffects(actor, registry) {
    const issues = [];
    for (const item of actor.items ?? []) {
      const raw = item.toObject();
      const activities = raw.system?.activities ?? {};
      if (!Object.keys(activities).length) continue;
      const liveEffectIds = new Set((raw.effects ?? []).map(effect => effect._id).filter(Boolean));

      for (const [activityId, activity] of Object.entries(activities)) {
        const refs = Array.isArray(activity?.effects) ? activity.effects : [];
        const missingIds = refs.map(ref => ref?._id).filter(id => id && !liveEffectIds.has(id));
        if (!missingIds.length) continue;

        const source = await this.#resolveSourceItem(item, registry);
        const sourceActivity = source?.document ? this.#findSourceActivity(source.document, activityId, activity) : null;
        const sourceEffects = new Map((source?.document?.toObject?.().effects ?? []).map(effect => [effect._id, effect]));
        const missing = missingIds.map(id => {
          const sourceRef = (sourceActivity?.effects ?? []).find(ref => ref?._id === id) ?? null;
          const sourceEffect = sourceEffects.get(sourceRef?._id ?? id) ?? null;
          return {
            id,
            name: sourceEffect?.name ?? id,
            canResolve: Boolean(sourceEffect)
          };
        });
        const repairable = Boolean(source?.document) && missing.every(row => row.canResolve);
        const activityName = activity?.name || sourceActivity?.name || "Activity";
        issues.push({
          id: `activity-effects:${item.id}:${activityId}`,
          kind: "broken-activity-effects",
          severity: "error",
          repairable,
          repairLabel: "Repair References",
          title: `${item.name} — Broken Effect Links`,
          summary: `${activityName} references ${missing.length} Active Effect${missing.length === 1 ? "" : "s"} that no longer exist by those IDs.`,
          details: repairable
            ? `The enabled source ${source.label} can be used to reconnect the Activity to the matching native effect data without replacing the whole Item.`
            : "The source effect data could not be resolved safely. This needs GM review.",
          data: {
            itemId: item.id,
            activityId,
            sourceUuid: source?.uuid ?? null,
            missing
          }
        });
      }
    }
    return issues;
  }

  static async #scanMissingAdvancementItems(actor, registry) {
    const issues = [];
    for (const owner of actor.items ?? []) {
      const advancements = owner.toObject().system?.advancement ?? {};
      for (const [advancementId, advancement] of Object.entries(advancements)) {
        const mappings = this.#flattenAddedMappings(advancement?.value?.added ?? {});
        for (const mapping of mappings) {
          if (actor.items.get(mapping.itemId)) continue;
          const sourceUuid = String(mapping.uuid ?? "");

          // A missing embedded ID can be intentional when a native ItemGrant
          // spell was consolidated into an already-present canonical spell.
          // The surviving spell carries a Character Builder merge receipt that
          // proves exactly which owner/Advancement/source/old ID was redirected.
          // Do not resurrect that intentionally removed duplicate.
          if (this.#mergedGrantSurvivor(actor, {
            ownerId: owner.id,
            advancementId,
            mergedFromItemId: mapping.itemId,
            sourceUuid
          })) continue;
          const sourceAllowed = !sourceUuid.startsWith("Compendium.") || registry.isUuidAllowed(sourceUuid);
          let sourceDocument = null;
          if (sourceUuid) {
            try { sourceDocument = await fromUuid(sourceUuid); } catch (_error) { sourceDocument = null; }
          }
          const repairable = Boolean(sourceDocument) && sourceAllowed;
          issues.push({
            id: `advancement-item:${owner.id}:${advancementId}:${mapping.itemId}`,
            kind: "missing-advancement-item",
            severity: "error",
            repairable,
            repairLabel: "Restore Item",
            title: `${owner.name} — Missing Advancement Item`,
            summary: `${advancement?.title || advancement?.type || "Advancement"} still records a granted or selected Item that is missing from the Actor.`,
            details: repairable
              ? `The recorded source ${sourceDocument.name} can be restored with its original embedded Item ID, preserving the Advancement link.`
              : sourceAllowed
                ? "The recorded source document is unavailable. This needs GM review."
                : "The recorded source belongs to a disabled content source, so the Validator will not restore it automatically.",
            data: {
              ownerId: owner.id,
              advancementId,
              itemId: mapping.itemId,
              sourceUuid,
              sourceName: sourceDocument?.name ?? null
            }
          });
        }
      }
    }
    return issues;
  }


  static async #repairBrokenActivityEffects(actor, issue) {
    const item = actor.items.get(issue.data?.itemId);
    if (!item) throw new Error("The Item being repaired no longer exists on the revised Actor.");
    const registry = new SourceRegistry();
    await registry.load();
    const source = await this.#resolveSourceItem(item, registry, issue.data?.sourceUuid);
    if (!source?.document) throw new Error("The native source Item is no longer available.");

    const raw = item.toObject();
    const activity = raw.system?.activities?.[issue.data.activityId];
    if (!activity) throw new Error("The affected Activity no longer exists on the revised Actor.");
    const sourceActivity = this.#findSourceActivity(source.document, issue.data.activityId, activity);
    if (!sourceActivity) throw new Error("The matching source Activity could not be identified.");

    const sourceRaw = source.document.toObject();
    const sourceEffects = new Map((sourceRaw.effects ?? []).map(effect => [effect._id, effect]));
    const localEffects = item.effects ?? [];
    const refs = foundry.utils.deepClone(activity.effects ?? []);
    const repaired = [];

    for (const ref of refs) {
      if (!ref?._id || item.effects.get?.(ref._id) || localEffects.some(effect => effect.id === ref._id)) continue;
      const sourceRef = (sourceActivity.effects ?? []).find(candidate => candidate?._id === ref._id);
      const sourceEffect = sourceEffects.get(sourceRef?._id ?? ref._id);
      if (!sourceEffect) throw new Error(`Source Active Effect ${ref._id} could not be resolved.`);

      let local = localEffects.find(effect => this.#sameEffectIdentity(effect.toObject?.() ?? effect, sourceEffect));
      if (!local) {
        const effectData = foundry.utils.deepClone(sourceEffect);
        const existingId = item.effects.get?.(effectData._id) ?? localEffects.find(effect => effect.id === effectData._id);
        if (existingId) local = existingId;
        else {
          const [created] = await item.createEmbeddedDocuments("ActiveEffect", [effectData], {
            keepId: true,
            characterBuilderValidationRepair: true
          });
          local = created;
        }
      }
      if (!local) throw new Error(`Could not restore ${sourceEffect.name ?? ref._id}.`);
      const prior = ref._id;
      ref._id = local.id;
      repaired.push({ from: prior, to: local.id, name: local.name ?? sourceEffect.name });
    }

    await item.update({ [`system.activities.${issue.data.activityId}.effects`]: refs }, {
      characterBuilderValidationRepair: true
    });
    return {
      status: "repaired",
      issueId: issue.id,
      title: issue.title,
      message: `Reconnected ${repaired.length} effect link${repaired.length === 1 ? "" : "s"} on ${item.name}.`,
      repaired
    };
  }

  static async #repairMissingAdvancementItem(actor, issue) {
    const owner = actor.items.get(issue.data?.ownerId);
    if (!owner) throw new Error("The Advancement owner no longer exists on the revised Actor.");
    const sourceUuid = issue.data?.sourceUuid;
    if (!sourceUuid) throw new Error("The recorded Advancement source UUID is missing.");
    const source = await fromUuid(sourceUuid);
    if (!source) throw new Error("The recorded Advancement source document is unavailable.");
    if (actor.items.get(issue.data.itemId)) {
      return {
        status: "repaired",
        issueId: issue.id,
        title: issue.title,
        message: `${source.name} was already restored before this step.`
      };
    }

    const localAdvancement = owner.toObject().system?.advancement?.[issue.data.advancementId] ?? null;
    const sourceGrant = source.type === "spell"
      ? await this.#resolveNativeSourceAdvancement(owner, issue.data.advancementId, sourceUuid)
      : null;
    let data = sourceGrant?.advancement
      ? await NativeSpellGrantProjectionService.materialize({
          sourceAdvancement: sourceGrant.advancement,
          sourceUuid,
          sourceItem: source,
          itemId: issue.data.itemId,
          owner,
          localAdvancement
        })
      : null;
    if (!data) data = foundry.utils.deepClone(source.toObject());
    data._id = issue.data.itemId;
    data.flags ??= {};
    data.flags.dnd5e ??= {};
    data.flags.dnd5e.sourceId = sourceUuid;
    data.flags.dnd5e.advancementOrigin = `${owner.id}.${issue.data.advancementId}`;
    data.flags.dnd5e.advancementRoot = owner.getFlag?.("dnd5e", "advancementRoot") ?? `${owner.id}.${issue.data.advancementId}`;
    data.flags[MODULE_ID] ??= {};
    data.flags[MODULE_ID].validationRestore = {
      restoredAt: Date.now(),
      restoredBy: game.user.id,
      sourceUuid,
      ownerId: owner.id,
      advancementId: issue.data.advancementId,
      nativeSpellProjection: Boolean(sourceGrant?.advancement)
    };

    const [created] = await actor.createEmbeddedDocuments("Item", [data], {
      keepId: true,
      characterBuilderValidationRepair: true
    });
    if (!created) throw new Error(`D&D5e did not restore ${source.name}.`);

    // When the missing ledger entry is a native spell grant, preserve the same
    // feature ownership metadata used by the normal progression reconciler.
    // D&D5e remains authoritative for the spell mechanics themselves.
    if (created.type === "spell" && sourceGrant?.advancement) {
      const classIdentifier = this.#classIdentifier(owner, actor);
      const classItem = classIdentifier
        ? actor.items.find(item => item.type === "class" && item.system?.identifier === classIdentifier)
        : null;
      await FeatureSpellOwnershipService.addOwner(created, {
        category: this.#slug(owner.name || "validation-grant"),
        label: sourceGrant.advancement.title || owner.name || "Native Spell Grant",
        classIdentifier,
        classItemId: classItem?.id ?? null,
        subclassItemId: owner.type === "subclass" ? owner.id : null,
        featureItemId: owner.type === "feat" ? owner.id : null,
        ownerItemId: owner.id,
        advancementId: issue.data.advancementId,
        transactionId: null,
        acquiredAtCharacterLevel: null,
        acquiredAtClassLevel: Number(sourceGrant.advancement.level ?? 0),
        sourceUuid,
        spellLevel: Number(created.system?.level ?? 0),
        alwaysPrepared: Number(created.system?.prepared ?? 0) === 2,
        nativeGrant: true,
        validationReconciled: true
      });
    }
    return {
      status: "repaired",
      issueId: issue.id,
      title: issue.title,
      message: `Restored ${created.name} from its recorded Advancement source.`,
      restoredItemId: created.id,
      sourceUuid
    };
  }

  static #classIdentifier(owner, actor) {
    if (!owner) return null;
    if (owner.type === "class") return owner.system?.identifier ?? null;
    if (owner.type === "subclass") {
      return owner.system?.classIdentifier ?? owner.system?.class?.identifier ?? owner.system?.class ?? null;
    }
    const root = String(owner.getFlag?.("dnd5e", "advancementRoot")
      ?? owner.getFlag?.("dnd5e", "advancementOrigin") ?? "");
    const rootItem = actor.items.get(root.split(".")[0]);
    return rootItem && rootItem.id !== owner.id ? this.#classIdentifier(rootItem, actor) : null;
  }

  static #slug(value) {
    return String(value ?? "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  static async #resolveNativeSourceAdvancement(owner, advancementId, sourceUuid = null) {
    const candidates = [
      owner.getFlag?.("dnd5e", "sourceId"),
      owner._stats?.compendiumSource,
      owner.getFlag?.(MODULE_ID, "sourceSnapshot")?.uuid
    ].filter(uuid => String(uuid ?? "").startsWith("Compendium."));
    const local = owner.toObject().system?.advancement?.[advancementId] ?? null;

    for (const uuid of candidates) {
      try {
        const sourceOwner = await fromUuid(uuid);
        const direct = sourceOwner?.advancement?.byId?.[advancementId] ?? null;
        if (direct?.configuration?.spell) return { uuid, owner: sourceOwner, advancement: direct };

        // Embedded Advancement IDs are normally preserved from the canonical
        // source. If an older/custom copy changed the ID, only fall back when
        // the Advancement type and recorded granted spell UUID prove the same
        // source relationship. This avoids guessing by title alone.
        for (const advancement of Object.values(sourceOwner?.advancement?.byId ?? {})) {
          if (!advancement?.configuration?.spell) continue;
          const raw = advancement.toObject?.() ?? advancement;
          if (local?.type && String(raw?.type ?? "") !== String(local.type)) continue;
          const configured = [
            ...(raw?.configuration?.items ?? []).map(row => typeof row === "string" ? row : row?.uuid),
            ...(raw?.configuration?.pool ?? []).map(row => typeof row === "string" ? row : row?.uuid)
          ].filter(Boolean);
          if (sourceUuid && configured.includes(sourceUuid)) {
            return { uuid, owner: sourceOwner, advancement };
          }
        }
      } catch (_error) {
        // Continue to the next recorded canonical source.
      }
    }
    return null;
  }

  static async #resolveSourceItem(item, registry, explicitUuid = null) {
    const candidates = [
      explicitUuid,
      item.getFlag?.("dnd5e", "sourceId"),
      item._stats?.compendiumSource
    ].filter(uuid => String(uuid ?? "").startsWith("Compendium."));

    for (const uuid of candidates) {
      if (!registry.isUuidAllowed(uuid)) continue;
      try {
        const document = await fromUuid(uuid);
        if (document) return { uuid, document, label: registry.findOption(uuid)?.sourceLabel ?? "configured content source" };
      } catch (_error) {
        // Continue to identifier-based resolution.
      }
    }

    const identifier = item.system?.identifier;
    if (!identifier) return null;
    const preferred = registry.preferredOption(item.type, identifier);
    if (!preferred) return null;
    try {
      const document = await fromUuid(preferred.uuid);
      if (!document) return null;
      return { uuid: preferred.uuid, document, label: preferred.sourceLabel };
    } catch (_error) {
      return null;
    }
  }

  static #findSourceActivity(sourceDocument, activityId, localActivity) {
    const activities = sourceDocument.toObject().system?.activities ?? {};
    if (activities[activityId]) return activities[activityId];
    const localName = String(localActivity?.name ?? "").trim().toLowerCase();
    const localType = localActivity?.type ?? null;
    return Object.values(activities).find(activity => {
      const nameMatch = localName && String(activity?.name ?? "").trim().toLowerCase() === localName;
      const typeMatch = !localType || activity?.type === localType;
      return nameMatch && typeMatch;
    }) ?? null;
  }

  static #sameEffectIdentity(local, source) {
    const localName = String(local?.name ?? "").trim().toLowerCase();
    const sourceName = String(source?.name ?? "").trim().toLowerCase();
    if (!localName || localName !== sourceName) return false;
    const localStatuses = [...(local?.statuses ?? [])].map(String).sort().join("|");
    const sourceStatuses = [...(source?.statuses ?? [])].map(String).sort().join("|");
    return !sourceStatuses || localStatuses === sourceStatuses;
  }


  static #mergedGrantSurvivor(actor, { ownerId, advancementId, mergedFromItemId, sourceUuid } = {}) {
    const expectedOwner = String(ownerId ?? "");
    const expectedAdvancement = String(advancementId ?? "");
    const expectedMissingId = String(mergedFromItemId ?? "");
    const expectedSource = String(sourceUuid ?? "");
    if (!expectedOwner || !expectedAdvancement || !expectedMissingId) return null;

    for (const item of actor.items ?? []) {
      const receipts = item.getFlag?.(MODULE_ID, "mergedItemGrants") ?? [];
      const match = receipts.find(receipt => {
        if (String(receipt?.ownerItemId ?? "") !== expectedOwner) return false;
        if (String(receipt?.advancementId ?? "") !== expectedAdvancement) return false;
        if (String(receipt?.mergedFromItemId ?? "") !== expectedMissingId) return false;
        if (!expectedSource) return true;
        return [receipt?.configuredUuid, receipt?.sourceUuid].some(uuid => String(uuid ?? "") === expectedSource);
      });
      if (match) return item;
    }
    return null;
  }

  static #flattenAddedMappings(value, rows = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return rows;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string") {
        rows.push({ itemId: key, uuid: child });
        continue;
      }
      if (child && typeof child === "object") this.#flattenAddedMappings(child, rows);
    }
    return rows;
  }

  static async #postChatSummary(actor, sourceActor, report) {
    const repaired = report.repaired ?? [];
    const skipped = report.skipped ?? [];
    const unresolved = report.unresolved ?? [];
    const rows = repaired.map(row => `<li><i class="fa-solid fa-wrench"></i> ${foundry.utils.escapeHTML(row.message ?? row.title ?? "Repair applied")}</li>`);
    if (!rows.length) rows.push("<li>No automatic repairs were applied.</li>");
    if (skipped.length) rows.push(`<li>${skipped.length} validation issue${skipped.length === 1 ? " was" : "s were"} skipped by the GM.</li>`);
    if (unresolved.length) rows.push(`<li>${unresolved.length} issue${unresolved.length === 1 ? " still requires" : "s still require"} GM review.</li>`);
    const content = `
      <section class="dnd5e-character-builder cb-validation-chat-card">
        <h3>Character Validation Complete</h3>
        <p><strong>${foundry.utils.escapeHTML(actor.name)}</strong> was reviewed as a copy of <strong>${foundry.utils.escapeHTML(sourceActor?.name ?? "the source Actor")}</strong>.</p>
        <ul>${rows.join("")}</ul>
        <p class="notes">The original Actor was not modified.</p>
      </section>`;
    await ChatMessage.implementation.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content
    });
  }
}
