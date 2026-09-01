import { MODULE_ID } from "../constants.mjs";
import { AdvancementChoiceAnnotationService } from "./advancement-choice-annotation-service.mjs";

/**
 * Reconciles only Character Builder-owned presentation/ownership metadata after
 * native D&D5e rollback. Native Items, levels, Advancements, and mechanics are
 * never recreated or deleted here.
 */
export class MetadataReconciliationService {
  static async reconcile(actor) {
    if (!actor?.items || actor.getFlag(MODULE_ID, "isDraft") || actor.getFlag(MODULE_ID, "isLevelUpDraft")) {
      return { changedItems: 0, removedBadges: 0, removedAugments: 0, removedOwners: 0 };
    }

    const itemIds = new Set(actor.items.map(item => item.id));
    const updates = [];
    let removedBadges = 0;
    let removedAugments = 0;
    let removedOwners = 0;

    for (const item of actor.items) {
      const update = { _id: item.id };
      let changed = false;

      const badges = AdvancementChoiceAnnotationService.getBadges(item);
      const validBadges = badges.filter(badge => {
        const targetValid = !badge?.targetItemId || badge.targetItemId === item.id;
        const sourceValid = !badge?.sourceItemId || itemIds.has(badge.sourceItemId) || badge.sourceItemId === item.id;
        return targetValid && sourceValid;
      });
      if (validBadges.length !== badges.length) {
        update[`flags.${MODULE_ID}.${AdvancementChoiceAnnotationService.FLAG}`] = validBadges;
        removedBadges += badges.length - validBadges.length;
        changed = true;
      }

      const augments = item.getFlag(MODULE_ID, "eldritchInvocationAugments");
      if (Array.isArray(augments)) {
        const valid = augments.filter(row => !row?.invocationItemId || itemIds.has(row.invocationItemId));
        if (valid.length !== augments.length) {
          update[`flags.${MODULE_ID}.eldritchInvocationAugments`] = valid;
          removedAugments += augments.length - valid.length;
          changed = true;
        }
      }

      const owners = item.getFlag(MODULE_ID, "featureSpellOwners");
      if (Array.isArray(owners)) {
        const valid = owners.filter(owner => {
          if (owner?.classItemId && !itemIds.has(owner.classItemId)) return false;
          if (owner?.subclassItemId && !itemIds.has(owner.subclassItemId)) return false;
          if (owner?.featureItemId && !itemIds.has(owner.featureItemId)) return false;
          return true;
        });
        if (valid.length !== owners.length) {
          update[`flags.${MODULE_ID}.featureSpellOwners`] = valid;
          removedOwners += owners.length - valid.length;
          changed = true;
        }
      }

      if (changed) updates.push(update);
    }

    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, {
        characterBuilderMetadataReconciliation: true
      });
    }

    const result = {
      reconciledAt: Date.now(),
      changedItems: updates.length,
      removedBadges,
      removedAugments,
      removedOwners
    };
    if (updates.length) {
      await actor.setFlag(MODULE_ID, "metadataReconciliation", result);
      // Rebuild authoritative badges after stale active references have been
      // removed. History itself remains untouched and auditable.
      await AdvancementChoiceAnnotationService.refresh(actor, { rebuild: true });
    }
    return result;
  }
}
