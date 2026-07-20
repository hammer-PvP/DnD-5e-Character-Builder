import { MODULE_ID } from "../constants.mjs";

/**
 * Conservative guard around the native D&D5e Ability Score Improvement feat
 * browser. The native browser remains authoritative; this service only removes
 * choices that are deterministically invalid and validates the selected UUID
 * before the native Advancement applies it to its clone.
 *
 * This intentionally does not rebuild the feat catalog or interpret free-form
 * prerequisite text. Ambiguous metadata remains visible and is left to D&D5e.
 */
export class NativeFeatChoiceGuard {
  static #active = null;

  /**
   * Run a native AdvancementManager while guarding ASI feat browser calls.
   *
   * @param {object} manager  D&D5e AdvancementManager.
   * @param {object} options
   * @param {object} options.state  Character Builder Level Up state.
   * @param {Function} callback  Function that renders and awaits the manager.
   * @returns {Promise<*>}
   */
  static async run(manager, { state } = {}, callback) {
    const Browser = globalThis.dnd5e?.applications?.CompendiumBrowser;
    if (!Browser || typeof Browser.selectOne !== "function") return callback();
    if (this.#active) return callback();

    const originalSelectOne = Browser.selectOne;
    const context = {
      manager,
      state,
      projectedCharacterLevel: this.projectedCharacterLevel(manager, state),
      originalSelectOne
    };

    this.#active = context;
    const guardedSelectOne = async function(options = {}, renderOptions = {}) {
      if (!NativeFeatChoiceGuard.isAbilityScoreFeatBrowser(options)
        || NativeFeatChoiceGuard.#active !== context) {
        return originalSelectOne.call(this, options, renderOptions);
      }

      // The ASI flow remains open while this loop runs. An invalid result is
      // never returned to D&D5e, so the selected feat is not applied and the
      // player can choose again without restarting Class Progression or losing
      // the locked Hit Die result.
      while (NativeFeatChoiceGuard.#active === context) {
        const guardedOptions = NativeFeatChoiceGuard.buildBrowserOptions(options, {
          actor: manager.clone,
          projectedCharacterLevel: context.projectedCharacterLevel
        });
        const result = await originalSelectOne.call(this, guardedOptions, renderOptions);
        if (!result) return null;

        const candidate = await fromUuid(result);
        const invalid = NativeFeatChoiceGuard.invalidCandidateReason(candidate, {
          actor: manager.clone,
          projectedCharacterLevel: context.projectedCharacterLevel
        });
        if (!invalid) return result;

        await NativeFeatChoiceGuard.#showInvalidChoice(candidate, invalid);
      }

      return null;
    };
    Browser.selectOne = guardedSelectOne;

    try {
      return await callback();
    } finally {
      if (Browser.selectOne === guardedSelectOne && this.#active === context) {
        Browser.selectOne = originalSelectOne;
      }
      if (this.#active === context) this.#active = null;
    }
  }

  /**
   * Identify the browser invocation used by AbilityScoreImprovementFlow.
   * ItemChoice feat browsers use CompendiumBrowser.select and are intentionally
   * outside this patch.
   */
  static isAbilityScoreFeatBrowser(options = {}) {
    const locked = options?.filters?.locked ?? {};
    return options?.tab === "feats"
      && locked?.additional?.category?.feat === 1
      && (!locked.types || locked.types.has?.("feat"));
  }

  /**
   * Build a filtered copy of the native browser options.
   *
   * Filters are exclusions only:
   * - Epic Boons below projected character level 19.
   * - Exact non-repeatable feats already owned by source UUID.
   * - Identifier + subtype equivalents, covering PHB/SRD mirrors.
   */
  static buildBrowserOptions(options, { actor, projectedCharacterLevel } = {}) {
    const guarded = foundry.utils.deepClone(options ?? {});
    guarded.filters ??= {};
    guarded.filters.locked ??= {};
    const locked = guarded.filters.locked;
    locked.arbitrary = Array.isArray(locked.arbitrary) ? [...locked.arbitrary] : [];

    if (Number(projectedCharacterLevel ?? 0) < 19) {
      locked.arbitrary.push({
        o: "NOT",
        v: { k: "system.type.subtype", o: "exact", v: "epicBoon" }
      });
    }

    const identities = this.ownedNonRepeatableIdentities(actor);
    if (identities.sourceUuids.size) {
      locked.arbitrary.push({
        o: "NOT",
        v: { k: "uuid", o: "in", v: identities.sourceUuids }
      });
    }

    for (const { identifier, subtype } of identities.identifierSubtypes.values()) {
      if (!identifier || !subtype) continue;
      locked.arbitrary.push({
        o: "NOT",
        v: {
          o: "AND",
          v: [
            { k: "system.identifier", o: "exact", v: identifier },
            { k: "system.type.subtype", o: "exact", v: subtype }
          ]
        }
      });
    }

    return guarded;
  }

  /**
   * Validate a browser result before D&D5e applies it.
   * Returns null when valid, otherwise a user-facing reason.
   */
  static invalidCandidateReason(candidate, { actor, projectedCharacterLevel } = {}) {
    if (!candidate || candidate.type !== "feat" || candidate.system?.type?.value !== "feat") {
      return "The selected document is not a feat.";
    }

    const level = Number(projectedCharacterLevel ?? actor?.system?.details?.level ?? 0);
    if (this.isEpicBoon(candidate) && level < 19) {
      return `Epic Boon feats require character level 19 or higher. The projected character level is ${level}.`;
    }

    if (!this.isRepeatable(candidate) && this.findOwnedEquivalent(candidate, actor)) {
      return `${candidate.name} is already owned and cannot be selected more than once.`;
    }

    // Retain the system's own structured prerequisite validation as a final
    // browser-level check. An ambiguous or unavailable validator fails open;
    // the existing post-Advancement validation remains the fallback.
    const validator = candidate.system?.validatePrerequisites;
    if (typeof validator === "function") {
      try {
        const result = validator.call(candidate.system, actor, {
          level,
          showMessage: false,
          throwError: false
        });
        if (result !== true && Array.isArray(result) && result.length) {
          return result.map(entry => String(entry)).join(" ");
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | Native feat prerequisite precheck failed open.`, error);
      }
    }

    return null;
  }

  static projectedCharacterLevel(manager, state) {
    const stateLevel = Number(state?.targetCharacterLevel ?? 0);
    if (stateLevel > 0) return stateLevel;
    return Number(manager?.clone?.system?.details?.level ?? manager?.actor?.system?.details?.level ?? 0);
  }

  static isEpicBoon(item) {
    return item?.type === "feat"
      && item.system?.type?.value === "feat"
      && String(item.system?.type?.subtype ?? "") === "epicBoon";
  }

  static isRepeatable(item) {
    return item?.system?.prerequisites?.repeatable === true;
  }

  static ownedNonRepeatableIdentities(actor) {
    const sourceUuids = new Set();
    const identifierSubtypes = new Map();
    for (const item of actor?.items ?? []) {
      if (item.type !== "feat" || item.system?.type?.value !== "feat" || this.isRepeatable(item)) continue;
      const sourceUuid = this.sourceUuid(item);
      if (sourceUuid) sourceUuids.add(sourceUuid);
      const identifier = String(item.system?.identifier ?? "").trim();
      const subtype = String(item.system?.type?.subtype ?? "").trim();
      if (identifier && subtype) identifierSubtypes.set(`${identifier}:${subtype}`, { identifier, subtype });
    }
    return { sourceUuids, identifierSubtypes };
  }

  static findOwnedEquivalent(candidate, actor) {
    const sourceUuid = this.sourceUuid(candidate) ?? candidate?.uuid ?? null;
    const identifier = String(candidate?.system?.identifier ?? "").trim();
    const subtype = String(candidate?.system?.type?.subtype ?? "").trim();

    for (const owned of actor?.items ?? []) {
      if (owned.type !== "feat" || owned.system?.type?.value !== "feat") continue;
      const ownedSource = this.sourceUuid(owned);
      if (sourceUuid && ownedSource && sourceUuid === ownedSource) return owned;
      if (identifier && subtype
        && identifier === String(owned.system?.identifier ?? "").trim()
        && subtype === String(owned.system?.type?.subtype ?? "").trim()) return owned;
    }
    return null;
  }

  static sourceUuid(item) {
    const candidates = [
      item?.flags?.dnd5e?.sourceId,
      item?._stats?.compendiumSource,
      item?.getFlag?.("dnd5e", "sourceId")
    ];
    return candidates.map(value => String(value ?? "").trim())
      .find(value => value.startsWith("Compendium.")) ?? null;
  }

  static async #showInvalidChoice(candidate, reason) {
    const name = foundry.utils.escapeHTML(candidate?.name ?? "The selected feat");
    const safeReason = foundry.utils.escapeHTML(reason);
    const content = `<div class="cb-structural-error">
      <p><strong>${name} cannot be selected.</strong></p>
      <p>${safeReason}</p>
      <p>The choice was not applied. Select another feat or return to Ability Score Improvement.</p>
    </div>`;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (DialogV2?.wait) {
      await DialogV2.wait({
        window: { title: "Invalid Feat Choice", modal: true },
        content,
        buttons: [{ action: "choose", label: "Choose Another Feat", icon: "fa-solid fa-rotate-left", default: true }],
        close: () => "choose"
      });
    } else {
      ui.notifications.warn(`${candidate?.name ?? "The selected feat"}: ${reason}`, { permanent: true });
    }
  }
}
