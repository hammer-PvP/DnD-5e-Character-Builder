import { MODULE_ID } from "../constants.mjs";

const RECOVERY_MUTATIONS = Object.freeze([
  Object.freeze({
    triggerIdentifier: "font-of-inspiration",
    targetIdentifier: "bardic-inspiration",
    label: "Font of Inspiration → Bardic Inspiration"
  }),
  Object.freeze({
    triggerIdentifier: "improved-warding-flare",
    targetIdentifier: "warding-flare",
    label: "Improved Warding Flare → Warding Flare"
  })
]);

/**
 * Restores small native PHB feature mutations that are normally performed by
 * the D&D5e advancement workflow but can be skipped when progression is staged
 * through Character Builder. The source feature remains authoritative; this
 * service only reconciles the dependent Item field to the same runtime shape
 * used by D&D5e 5.3.3.
 */
export class NativeFeatureCompatibilityService {
  static async ready() {
    if (!game.user?.isGM) return;
    const activeGM = game.users?.activeGM;
    if (activeGM && activeGM.id !== game.user.id) return;

    for (const actor of game.actors?.filter?.(candidate => candidate.type === "character"
      && !candidate.getFlag?.(MODULE_ID, "isDraft")
      && !candidate.getFlag?.(MODULE_ID, "isLevelUpDraft")
      && !candidate.getFlag?.(MODULE_ID, "commitSafetyBackup")
      && !candidate.getFlag?.(MODULE_ID, "commitSafetyLock")
      && !candidate.getFlag?.(MODULE_ID, "runtimeManagementSafetyLock")
      && !candidate.getFlag?.(MODULE_ID, "runtimeManagementCommitLock")) ?? []) {
      try {
        await this.reconcileActor(actor, { reason: "ready" });
      } catch (error) {
        console.warn(`${MODULE_ID} | Native feature compatibility reconciliation failed for ${actor.name}.`, error);
      }
    }
  }

  static async reconcileActor(actor, { reason = "manual" } = {}) {
    if (!actor || actor.type !== "character") {
      return { checked: 0, updated: 0, reason };
    }

    const summary = { checked: 0, updated: 0, mutations: [], reason };
    for (const rule of RECOVERY_MUTATIONS) {
      const trigger = this.#features(actor, rule.triggerIdentifier)[0] ?? null;
      if (!trigger) continue;

      const targets = this.#features(actor, rule.targetIdentifier);
      for (const target of targets) {
        summary.checked += 1;
        const current = this.#plainRecovery(target.system?.uses?.recovery);
        const desired = this.#shortRestRecoverAll(current);
        if (this.#sameRecovery(current, desired)) continue;

        await target.update({ "system.uses.recovery": desired }, {
          characterBuilderNativeFeatureCompatibility: true,
          characterBuilderNativeFeatureCompatibilityReason: reason
        });
        summary.updated += 1;
        summary.mutations.push({
          label: rule.label,
          triggerItemId: trigger.id,
          targetItemId: target.id,
          previousRecovery: current,
          recovery: desired
        });
      }
    }
    return summary;
  }

  static #features(actor, identifier) {
    return (actor.items?.filter?.(item => item.type === "feat"
      && String(item.system?.identifier ?? "").trim().toLowerCase() === identifier) ?? []);
  }

  static #plainRecovery(recovery) {
    if (!recovery) return [];
    const rows = Array.isArray(recovery)
      ? recovery
      : (Array.isArray(recovery.contents) ? recovery.contents : [...recovery]);
    return rows.map(row => foundry.utils.deepClone(row?.toObject?.() ?? row ?? {}));
  }

  static #shortRestRecoverAll(current) {
    const unrelated = current.filter(row => !["sr", "short", "lr", "long"]
      .includes(String(row?.period ?? "").trim().toLowerCase()));
    return [{ period: "sr", type: "recoverAll" }, ...unrelated];
  }

  static #sameRecovery(a, b) {
    return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  }
}
