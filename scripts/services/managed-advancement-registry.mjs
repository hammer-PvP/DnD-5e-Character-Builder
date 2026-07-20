/**
 * Central registry for source-native Advancements whose final choice values are
 * completed by Character Builder after the visible native Advancement flow.
 *
 * The native manager remains authoritative for every non-managed step. Managed
 * steps are removed from the native queue only when Character Builder has an
 * explicit handler and exact post-apply validation for that Advancement.
 */
export class ManagedAdvancementRegistry {
  static #rules = Object.freeze([
    {
      classIdentifier: "warlock",
      type: "ItemChoice",
      title: "eldritch invocations",
      handler: "warlock-invocations"
    }
  ]);

  static descriptor(advancement, { classIdentifier = "" } = {}) {
    const source = advancement?._source ?? advancement ?? {};
    const type = String(
      advancement?.constructor?.typeName
      ?? advancement?.constructor?.metadata?.type
      ?? source.type
      ?? ""
    ).trim().toLowerCase();
    const title = String(advancement?.title ?? source.title ?? "").trim().toLowerCase();
    return this.#rules.find(rule =>
      (!rule.classIdentifier || rule.classIdentifier === classIdentifier)
      && type.includes(String(rule.type).toLowerCase())
      && title === rule.title
    ) ?? null;
  }

  static isManaged(advancement, context = {}) {
    return Boolean(this.descriptor(advancement, context));
  }

  static isManagedRaw(owner, advancement, { classIdentifier = "" } = {}) {
    const ownerIdentifier = String(owner?.system?.identifier ?? "");
    return this.isManaged(advancement, {
      classIdentifier: classIdentifier || (owner?.type === "class" ? ownerIdentifier : "")
    });
  }
}
