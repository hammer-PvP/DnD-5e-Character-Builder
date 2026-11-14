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
 */
export class ManagedFeatureAdvancementBridge {
  static #active = new Set();

  static begin(manager, { classIdentifier = "", workflow = "levelUp" } = {}) {
    const session = {
      manager,
      classIdentifier: String(classIdentifier ?? "").toLowerCase(),
      workflow,
      removed: new Map(),
      hook: null
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
    this.#active.add(session);
    return session;
  }

  static end(session) {
    if (!session || !this.#active.delete(session)) return;
    if (session.hook !== null) Hooks.off("dnd5e.advancementCreateItemData", session.hook);
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
    if (Object.keys(removed).length) item.updateSource({ "system.advancement": retained });
    return { removed };
  }

  static suppressData(data, context = {}) {
    const item = {
      type: data?.type,
      system: data?.system ?? {},
      toObject: () => data,
      updateSource: changes => { data.system.advancement = changes["system.advancement"]; }
    };
    return this.suppress(item, context);
  }

  static async restore(draft, session) {
    if (!session?.removed.size) return;
    for (const [id, removed] of session.removed) {
      const item = draft.items.get(id);
      // Native Previous/Restart can legitimately remove a transient granted
      // Feature before Complete. Only restore those that survived the native
      // transaction, not abandoned choices from a previous step.
      if (!item) continue;
      const current = item.toObject().system?.advancement ?? {};
      const merged = { ...current, ...removed };
      await item.update({ "system.advancement": merged }, { characterBuilderManagedAdvancementRestore: true });
    }
    session.removed.clear();
  }

  static async restoreItem(item, removed) {
    if (!item || !Object.keys(removed ?? {}).length) return;
    const current = item.toObject().system?.advancement ?? {};
    await item.update({ "system.advancement": { ...current, ...removed } }, {
      characterBuilderManagedAdvancementRestore: true
    });
  }
}
