/**
 * Pure helpers for the narrowly-scoped Warlock projected cantrip flow.
 *
 * This service deliberately models only acquisitions that can disappear from
 * the same Level Up because either the exact cantrip Item is replaced or its
 * owning Eldritch Invocation is replaced. It is not a global projected-state
 * engine for every spell acquisition in the module.
 */
export class WarlockProjectedCantripService {
  static serializeAcquisitions(acquisitions = []) {
    return (acquisitions ?? [])
      .map(acquisition => {
        const itemId = String(acquisition?.itemId ?? "").trim();
        const providerIds = [...new Set((acquisition?.providerItemIds ?? []).map(String).filter(Boolean))];
        if (!itemId && !providerIds.length) return "";
        return `${itemId}:${providerIds.join(",")}`;
      })
      .filter(Boolean)
      .join("|");
  }

  static parseAcquisitions(serialized = "") {
    return String(serialized ?? "")
      .split("|")
      .filter(Boolean)
      .map(binding => {
        const separator = binding.indexOf(":");
        const itemId = separator >= 0 ? binding.slice(0, separator) : binding;
        const providerIds = separator >= 0 ? binding.slice(separator + 1) : "";
        return {
          itemId,
          providerItemIds: providerIds.split(",").filter(Boolean)
        };
      });
  }

  static acquisitionSurvives(acquisition, {
    removeInvocationId = "",
    removeCantripId = ""
  } = {}) {
    const itemId = String(acquisition?.itemId ?? "");
    if (removeCantripId && itemId === String(removeCantripId)) return false;
    const providers = new Set((acquisition?.providerItemIds ?? []).map(String).filter(Boolean));
    return !removeInvocationId || !providers.has(String(removeInvocationId));
  }

  static hasSurvivingAcquisition(acquisitions = [], removals = {}) {
    return (acquisitions ?? []).some(acquisition => this.acquisitionSurvives(acquisition, removals));
  }

  static replacementAvailable({ acquisitions = [], staticDisabled = false } = {}, removals = {}) {
    if (staticDisabled) return false;
    if (!(acquisitions ?? []).length) return true;
    return !this.hasSurvivingAcquisition(acquisitions, removals);
  }

  static targetSurvives({ acquisitions = [], pendingSelected = false } = {}, removals = {}) {
    return Boolean(pendingSelected) || this.hasSurvivingAcquisition(acquisitions, removals);
  }

  /**
   * Select the surviving embedded cantrip that should receive a newly-created
   * Invocation binding after all same-transaction removals have completed.
   *
   * A cantrip created by the current spell-selection transaction is preferred
   * over any older acquisition with the same identifier. This keeps new
   * Invocation selections and Invocation replacements aligned with the same
   * projected Pact Magic acquisition.
   */
  static selectTargetCandidate(candidates = [], {
    preferredItemIds = [],
    transactionId = ""
  } = {}) {
    const rows = (candidates ?? []).filter(Boolean);
    if (!rows.length) return null;
    const preferred = new Set((preferredItemIds ?? []).map(String).filter(Boolean));
    return rows.find(row => preferred.has(String(row?.itemId ?? "")))
      ?? rows.find(row => transactionId && String(row?.transactionId ?? "") === String(transactionId))
      ?? rows[0];
  }
}
