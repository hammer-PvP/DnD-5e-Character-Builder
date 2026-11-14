import { ManagedAdvancementRegistry } from "./managed-advancement-registry.mjs";

/**
 * Reconciles a CB-handled ItemChoice with *real* Items already created by CB.
 * The native AdvancementManager must never run these dependent choices again;
 * its original advancement definitions and ledger are retained for D&D5e
 * provenance and Character Validation. No content UUID or choice title is
 * hardcoded here; the caller supplies the validated acquisition groups.
 */
export class ManagedItemChoiceLedgerService {
  static plan(owner, acquisitions, { classIdentifier = "", workflow = "creation" } = {}) {
    const source = owner?.toObject?.().system?.advancement ?? {};
    const next = foundry.utils.deepClone(source);
    // Legacy/converted content without a native CB-managed ItemChoice keeps
    // its existing CB selection workflow. Do not invent PHB-specific ledgers.
    const managed = Object.entries(next).filter(([, advancement]) =>
      advancement?.type === "ItemChoice"
      && String(advancement.configuration?.type ?? "") === "spell"
      && ManagedAdvancementRegistry.isManaged(advancement, { owner, classIdentifier, workflow })
    );
    if (!managed.length) return { advancement: next, mapped: [], skipped: true };
    const mapped = [];
    const usedAdvancementIds = new Set();
    for (const acquisition of acquisitions) {
      const spellLevel = Number(acquisition.spellLevel);
      const items = acquisition.items ?? [];
      if (!Number.isInteger(spellLevel) || !items.length) {
        throw new Error("Managed spell Advancement cannot be reconciled without a nonempty, leveled Item selection.");
      }
      const matches = Object.entries(next).filter(([, advancement]) => {
        if (advancement?.type !== "ItemChoice" || String(advancement.configuration?.type ?? "") !== "spell") return false;
        if (!ManagedAdvancementRegistry.isManaged(advancement, { owner, classIdentifier, workflow })) return false;
        return Number(advancement.configuration?.restriction?.level) === spellLevel
          && advancement.configuration?.restriction?.level !== undefined;
      });
      if (matches.length !== 1) {
        throw new Error(`Expected exactly one CB-managed native ItemChoice for level ${spellLevel} on ${owner?.name ?? "Feature"}; found ${matches.length}.`);
      }
      const [advancementId, advancement] = matches[0];
      if (usedAdvancementIds.has(advancementId)) throw new Error(`Advancement ${advancementId} was assigned more than once.`);
      usedAdvancementIds.add(advancementId);
      const choiceRows = Object.entries(advancement.configuration?.choices ?? {}).filter(([, choice]) =>
        Number.isInteger(Number(choice?.count)) && Number(choice.count) > 0 && !choice.replacement
      );
      if (choiceRows.length !== 1 || Number(choiceRows[0][1].count) !== items.length) {
        throw new Error(`The native ItemChoice ${advancementId} requires a different number or arrangement of spells.`);
      }
      const levelKey = String(choiceRows[0][0]);
      const added = {};
      for (const item of items) {
        const uuid = String(item?.getFlag?.("dnd5e", "sourceId") ?? item?._stats?.compendiumSource ?? "");
        if (item?.type !== "spell" || Number(item.system?.level) !== spellLevel || !item.id || !uuid) {
          throw new Error(`The native ItemChoice ${advancementId} has an invalid or untraceable spell acquisition.`);
        }
        if (Object.hasOwn(added, item.id)) throw new Error("Duplicate Item ID while reconciling a native spell choice.");
        added[item.id] = uuid;
        mapped.push({ itemId: item.id, advancementId });
      }
      advancement.value = {
        ...(advancement.value ?? {}),
        added: { [levelKey]: added },
        replaced: advancement.value?.replaced ?? {},
        ...(advancement.configuration?.spell?.ability?.length === 1
          ? { ability: advancement.configuration.spell.ability[0] } : {})
      };
    }
    return { advancement: next, mapped };
  }

  static async reconcile(actor, owner, acquisitions, options = {}) {
    const plan = this.plan(owner, acquisitions, options);
    if (plan.skipped) return { reconciled: 0, advancementIds: [], legacyFallback: true };
    const ForcedReplacement = foundry.data?.operators?.ForcedReplacement;
    if (typeof ForcedReplacement?.create !== "function") {
      throw new Error("Cannot record managed Advancement choices: Foundry ForcedReplacement is unavailable.");
    }
    const root = String(owner.getFlag?.("dnd5e", "advancementRoot") ?? "");
    const updates = plan.mapped.map(({ itemId, advancementId }) => ({
      _id: itemId,
      "flags.dnd5e.advancementOrigin": `${owner.id}.${advancementId}`,
      ...(root ? { "flags.dnd5e.advancementRoot": root } : {})
    }));
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, {
      characterBuilderManagedAdvancementReconcile: true
    });
    await owner.update({ "system.advancement": ForcedReplacement.create(plan.advancement) }, {
      characterBuilderManagedAdvancementReconcile: true
    });
    const actual = owner.toObject().system?.advancement ?? {};
    const canonicalAdded = added => JSON.stringify(Object.entries(added ?? {})
      .map(([level, entries]) => [String(level), Object.entries(entries ?? {}).sort(([a], [b]) => a.localeCompare(b))])
      .sort(([a], [b]) => a.localeCompare(b)));
    for (const { advancementId } of plan.mapped) {
      const expected = plan.advancement[advancementId]?.value?.added ?? {};
      if (canonicalAdded(actual[advancementId]?.value?.added) !== canonicalAdded(expected)) {
        throw new Error(`The native Advancement ledger did not retain the CB selection for ${owner.name}.`);
      }
    }
    for (const { itemId, advancementId } of plan.mapped) {
      if (String(actor.items.get(itemId)?.getFlag("dnd5e", "advancementOrigin") ?? "") !== `${owner.id}.${advancementId}`) {
        throw new Error(`The selected spell ${itemId} lost its native Advancement origin.`);
      }
    }
    return { reconciled: plan.mapped.length, advancementIds: [...new Set(plan.mapped.map(row => row.advancementId))] };
  }
}
