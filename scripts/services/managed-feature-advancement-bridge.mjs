import { readAdvancementRecords, writeAdvancementRecords } from "../utils/advancement-utils.mjs";
import { ManagedAdvancementRegistry } from "./managed-advancement-registry.mjs";

/**
 * The D&D5e 6.1 manager adds synthetic steps when ItemGrant/ItemChoice creates
 * a Feature during its own transaction. The manager's initial steps list cannot
 * contain those future steps, so filtering it alone cannot prevent duplicate UI.
 *
 * This bridge uses the system's public dnd5e.advancementCreateItemData hook,
 * scoped strictly to the manager.clone owned by the current CB transaction.
 * It temporarily omits only CB-owned ItemChoice data from newly granted
 * Features. The original source Advancement data is reattached after the
 * manager has committed its clone onto the Draft, so native provenance and
 * future levels are retained; other native Advancements are never stripped.
 *
 * D&D5e 6.1's system.advancement is a keyed collection DataField. Standard
 * updateSource({"system.advancement": filtered}) MERGES, retaining keys not
 * listed in the filtered object. It MUST use Foundry's ForcedReplacement or
 * the native manager still synthesizes and executes the removed ItemChoices.
 */
export class ManagedFeatureAdvancementBridge {
  static #active = new Set();

  static begin(manager, { classIdentifier = "", workflow = "levelUp" } = {}) {
    const session = {
      manager,
      classIdentifier: String(classIdentifier ?? "").toLowerCase(),
      workflow,
      removed: new Map(),
      hook: null,
      completionGuard: null
    };
    session.hook = Hooks.on("dnd5e.advancementCreateItemData", (advancement, item) => {
      // Never intercept outside this particular Character Builder manager.
      if (advancement?.item?.actor !== manager.clone) return;
      const { removed } = this.suppress(item, session);
      if (Object.keys(removed).length) {
        const prior = session.removed.get(item.id) ?? {};
        session.removed.set(item.id, { ...prior, ...removed });
      }
    });
    // Defense in depth: if a future D&D5e release bypasses the create-data
    // hook, never commit duplicate choices. This native hook is synchronous
    // and fires before any changes are persisted onto the Draft Actor.
    session.completionGuard = Hooks.on("dnd5e.preAdvancementManagerComplete", (completedManager, updates, toCreate) => {
      if (completedManager !== manager) return;
      const conflict = this.nativeChoiceConflict(toCreate, session);
      if (!conflict) return;
      console.error("dnd5e-character-builder | Managed native Advancement would duplicate a Character Builder choice.", conflict);
      ui.notifications.error(`Cannot complete native Advancements: ${conflict.owner} still contains a native choice managed by Character Builder. No changes were applied.`);
      return false;
    });
    this.#active.add(session);
    return session;
  }

  static end(session) {
    if (!session || !this.#active.delete(session)) return;
    if (session.hook !== null) Hooks.off("dnd5e.advancementCreateItemData", session.hook);
    if (session.completionGuard !== null) Hooks.off("dnd5e.preAdvancementManagerComplete", session.completionGuard);
  }

  static nativeChoiceConflict(itemData, { classIdentifier = "", workflow = "levelUp" } = {}) {
    for (const data of itemData ?? []) {
      const owner = { type: data.type, system: data.system ?? {} };
      for (const advancement of Object.values(data.system?.advancement ?? {})) {
        if (!ManagedAdvancementRegistry.isManaged(advancement, { owner, classIdentifier, workflow })) continue;
        const hasNativeSelection = Object.values(advancement.value?.added ?? {})
          .some(row => row && Object.keys(row).length > 0);
        if (hasNativeSelection) return {
          owner: data.name ?? data.system?.identifier ?? "Item",
          advancement: advancement.name ?? advancement._id,
          classIdentifier,
          workflow
        };
      }
    }
    return null;
  }

  static suppress(item, { classIdentifier = "", workflow = "levelUp" } = {}) {
    const original = item?.toObject?.().system?.advancement
      ?? item?.system?.advancement ?? {};
    const entries = Array.isArray(original)
      ? original.map(row => [row._id, row])
      : Object.entries(original);
    const retained = {};
    const removed = {};
    for (const [id, advancement] of entries) {
      if (!id) continue;
      if (ManagedAdvancementRegistry.isManaged(advancement, { owner: item, classIdentifier, workflow })) {
        removed[id] = foundry.utils.deepClone(advancement);
      } else retained[id] = foundry.utils.deepClone(advancement);
    }
    if (Object.keys(removed).length) {
      const ForcedReplacement = foundry.data?.operators?.ForcedReplacement;
      if (typeof ForcedReplacement?.create !== "function") {
        throw new Error("Cannot safely intercept managed Advancements: Foundry ForcedReplacement is unavailable.");
      }
      // Replace the whole keyed collection, rather than merging its keys.
      // This is transient and scoped to the new Item being granted on the
      // AdvancementManager's clone; source compendium Items are never changed.
      item.updateSource({
        "system.advancement": ForcedReplacement.create(retained)
      });
      // A missing ItemChoice would otherwise be offered and granted twice.
      // Never silently continue the native workflow if deletion was ignored.
      const actual = item.toObject().system?.advancement ?? {};
      const remaining = Object.keys(removed).filter(id => Object.hasOwn(actual, id));
      if (remaining.length) {
        throw new Error(`Managed Advancement interception did not remove ${remaining.length} native choice(s) from ${item.name ?? item.system?.identifier ?? "Item"}.`);
      }
    }
    return { removed };
  }

  static suppressData(data, { classIdentifier = "", workflow = "levelUp" } = {}) {
    // Pure raw-data adapter for pre-materialization callers and fixture tests.
    // No Foundry DataModel exists yet, so replacing this plain object is safe.
    const item = { type: data?.type, system: data?.system ?? {} };
    const original = data?.system?.advancement ?? {};
    const entries = Array.isArray(original)
      ? original.map(row => [row._id, row]) : Object.entries(original);
    const retained = {};
    const removed = {};
    for (const [id, advancement] of entries) {
      if (!id) continue;
      if (ManagedAdvancementRegistry.isManaged(advancement, { owner: item, classIdentifier, workflow })) {
        removed[id] = foundry.utils.deepClone(advancement);
      } else retained[id] = foundry.utils.deepClone(advancement);
    }
    if (Object.keys(removed).length) data.system.advancement = retained;
    return { removed };
  }

  static async restore(draft, session) {
    if (!session?.removed.size) return;
    for (const [id, removed] of session.removed) {
      const item = draft.items.get(id);
      // Native Previous/Restart can legitimately remove a transient granted
      // Feature before Complete. Only restore those that survived the native
      // transaction, not abandoned choices from a previous step.
      if (!item) continue;
      const current = readAdvancementRecords(item);
      const merged = { ...current, ...removed };
      await writeAdvancementRecords(item, merged, { characterBuilderManagedAdvancementRestore: true });
    }
    session.removed.clear();
  }

  static async restoreItem(item, removed) {
    if (!item || !Object.keys(removed ?? {}).length) return;
    const current = readAdvancementRecords(item);
    await writeAdvancementRecords(item, { ...current, ...removed }, {
      characterBuilderManagedAdvancementRestore: true
    });
  }
}
