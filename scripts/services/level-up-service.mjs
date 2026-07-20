import { MODULE_ID, MULTICLASS_PRIMARY_ABILITIES, defaultSettings } from "../constants.mjs";

export class LevelUpService {
  static settings() {
    return foundry.utils.mergeObject(defaultSettings(), game.settings.get(MODULE_ID, "settings") ?? {}, {
      inplace: false
    });
  }

  static actorLevel(actor) {
    const prepared = Number(actor?.system?.details?.level);
    if (Number.isFinite(prepared)) return prepared;
    return actor?.items
      ?.filter(item => item.type === "class")
      .reduce((sum, item) => sum + Number(item.system?.levels ?? 0), 0) ?? 0;
  }

  static classItems(actor) {
    const originalClassId = actor?.system?.details?.originalClass?.id
      ?? actor?.system?.details?.originalClass
      ?? null;
    return actor.items
      .filter(item => item.type === "class")
      .sort((a, b) => {
        if (a.id === originalClassId) return -1;
        if (b.id === originalClassId) return 1;
        return a.sort - b.sort || a.name.localeCompare(b.name, game.i18n.lang);
      });
  }

  static originalClass(actor) {
    const original = actor?.system?.details?.originalClass;
    if (original?.type === "class") return original;
    const id = original?.id ?? original;
    return id ? actor.items.get(id) : this.classItems(actor)[0] ?? null;
  }

  static eligibility(actor) {
    const settings = this.settings();
    const level = this.actorLevel(actor);
    const draftId = actor?.getFlag?.(MODULE_ID, "levelUpDraftId");
    const hasDraft = Boolean(draftId && game.actors.get(draftId));
    const result = {
      mode: settings.levelUpMode,
      level,
      targetLevel: Math.min(20, level + 1),
      ready: false,
      hasDraft,
      reason: "",
      xpValue: Number(actor?.system?.details?.xp?.value ?? 0),
      xpRequired: Number(actor?.system?.details?.xp?.max ?? Infinity),
      grant: actor?.getFlag?.(MODULE_ID, "levelUpGrant") ?? null
    };

    if (!actor || actor.type !== "character") {
      result.reason = "Level Up is available only for Player Character Actors.";
      return result;
    }
    if (actor.getFlag?.(MODULE_ID, "commitSafetyLock")) {
      result.reason = "Character Builder is locked for this Actor because a previous Level Up rollback could not be verified. A GM must restore or inspect the Actor before continuing.";
      return result;
    }
    if (!actor.isOwner) {
      result.reason = "You do not own this Actor.";
      return result;
    }
    if (!actor.items.some(item => item.type === "class")) {
      result.reason = "Complete level 1 character creation before using Level Up.";
      return result;
    }
    if (level >= 20) {
      result.reason = "This character is already level 20.";
      return result;
    }
    if (hasDraft) {
      result.ready = true;
      result.reason = "Resume the pending Level Up.";
      return result;
    }

    if (settings.levelUpMode === "xp") {
      result.ready = Number.isFinite(result.xpRequired) && result.xpValue >= result.xpRequired;
      result.reason = result.ready
        ? `The Actor has reached the level ${level + 1} XP threshold.`
        : `${result.xpValue.toLocaleString()} / ${Number.isFinite(result.xpRequired) ? result.xpRequired.toLocaleString() : "—"} XP.`;
      return result;
    }

    result.ready = Boolean(result.grant?.available);
    result.reason = result.ready
      ? `Level Up was granted by the GM for character level ${level + 1}.`
      : "The GM has not granted this Actor a Milestone Level Up.";
    return result;
  }

  static async grant(actor, metadata = {}) {
    if (!game.user.isGM) throw new Error("Only the GM can grant a Milestone Level Up.");
    const level = this.actorLevel(actor);
    if (level >= 20) throw new Error("This character is already level 20.");
    await actor.setFlag(MODULE_ID, "levelUpGrant", {
      available: true,
      grantedAt: Date.now(),
      grantedBy: game.user.id,
      sourceCharacterLevel: level,
      targetCharacterLevel: level + 1,
      ...(metadata.batchId ? { batchId: metadata.batchId } : {}),
      ...(metadata.idempotencyToken ? { idempotencyToken: metadata.idempotencyToken } : {})
    });
    return actor.getFlag(MODULE_ID, "levelUpGrant");
  }

  static async revoke(actor) {
    if (!game.user.isGM) throw new Error("Only the GM can revoke a Milestone Level Up.");
    await actor.unsetFlag(MODULE_ID, "levelUpGrant");
  }

  static classSourceUuid(item) {
    return item?.getFlag?.("dnd5e", "sourceId")
      ?? item?._stats?.compendiumSource
      ?? item?.getFlag?.(MODULE_ID, "sourceSnapshot")?.uuid
      ?? null;
  }

  static multiclassPrerequisite(actor, newClassIdentifier) {
    const settings = this.settings();
    if (!settings.enforceMulticlassRequirements) {
      return {
        qualified: true,
        checks: [],
        enforced: false,
        message: "Multiclass prerequisites are disabled by the GM."
      };
    }
    const checks = [];
    const originalClass = this.originalClass(actor);
    const identifiers = [originalClass?.system?.identifier, newClassIdentifier].filter(Boolean);
    for (const identifier of [...new Set(identifiers)]) {
      const alternatives = MULTICLASS_PRIMARY_ABILITIES[identifier] ?? [];
      if (!alternatives.length) continue;
      const qualified = alternatives.some(group => group.every(ability =>
        Number(actor.system?.abilities?.[ability]?.value ?? 0) >= 13
      ));
      checks.push({
        identifier,
        qualified,
        requirements: alternatives.map(group => group.map(ability => ability.toUpperCase()).join(" and ")).join(" or ")
      });
    }
    const failed = checks.filter(check => !check.qualified);
    return {
      qualified: failed.length === 0,
      checks,
      enforced: true,
      message: failed.length
        ? `Multiclass prerequisites are not met: ${failed.map(check => `${check.identifier} requires ${check.requirements} 13`).join("; ")}.`
        : "Multiclass prerequisites are met."
    };
  }
}
