import { MODULE_ID } from "../constants.mjs";

/**
 * Minimal guard around the native D&D5e Ability Score Improvement feat choice.
 *
 * The native Compendium Browser remains completely authoritative. Character
 * Builder passes the original browser options through unchanged and validates
 * only the UUID confirmed by the player before D&D5e applies that feat to the
 * Advancement clone.
 *
 * This service does not filter, rebuild, clone, decorate, hide, or otherwise
 * modify browser entries, indexes, sources, tooltips, or sidebar filters.
 */
export class NativeFeatChoiceGuard {
  static #active = null;

  /**
   * Run a native AdvancementManager while guarding confirmed ASI feat choices.
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

      // The browser receives the exact native options object. Invalid choices
      // are stopped only after confirmation and are never returned to D&D5e.
      while (NativeFeatChoiceGuard.#active === context) {
        const result = await originalSelectOne.call(this, options, renderOptions);
        if (!result) return null;

        let candidate = null;
        try {
          candidate = await fromUuid(result);
        } catch (error) {
          console.warn(`${MODULE_ID} | Failed to resolve the confirmed native feat UUID.`, error);
        }

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
   * ItemChoice feat browsers use CompendiumBrowser.select and remain outside
   * this guard.
   */
  static isAbilityScoreFeatBrowser(options = {}) {
    const locked = options?.filters?.locked ?? {};
    return options?.tab === "feats"
      && locked?.additional?.category?.feat === 1
      && !locked?.additional?.subtype
      && (!locked.types || locked.types.has?.("feat"));
  }

  /**
   * Validate only the feat confirmed by the player.
   *
   * Returns null when valid, otherwise a user-facing reason. No prerequisite
   * engine is implemented here; all other feat rules remain native to D&D5e.
   */
  static invalidCandidateReason(candidate, { actor, projectedCharacterLevel } = {}) {
    if (!candidate || candidate.type !== "feat" || candidate.system?.type?.value !== "feat") {
      return "The selected document could not be resolved as a feat from its source compendium.";
    }

    if (this.isAbilityScoreImprovement(candidate)) {
      return "Ability Score Improvement cannot be selected here. This screen is only for choosing a feat. If you want to increase ability scores, return to the previous screen and use the Ability Score Improvement option.";
    }

    const level = Number(projectedCharacterLevel ?? actor?.system?.details?.level ?? 0);
    if (this.isEpicBoon(candidate) && level < 19) {
      return `Epic Boon feats require character level 19 or higher. The projected character level is ${level}.`;
    }

    if (!this.isRepeatable(candidate) && this.findOwnedEquivalent(candidate, actor)) {
      return `${candidate.name} is already owned and cannot be selected more than once.`;
    }

    return null;
  }

  static projectedCharacterLevel(manager, state) {
    const stateLevel = Number(state?.targetCharacterLevel ?? 0);
    if (stateLevel > 0) return stateLevel;
    return Number(manager?.clone?.system?.details?.level ?? manager?.actor?.system?.details?.level ?? 0);
  }

  static isAbilityScoreImprovement(item) {
    return item?.type === "feat"
      && item.system?.type?.value === "feat"
      && String(item.system?.identifier ?? "").trim() === "ability-score-improvement";
  }

  static isEpicBoon(item) {
    return item?.type === "feat"
      && item.system?.type?.value === "feat"
      && String(item.system?.type?.subtype ?? "") === "epicBoon";
  }

  static isRepeatable(item) {
    return item?.system?.prerequisites?.repeatable === true;
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
    const isAsi = NativeFeatChoiceGuard.isAbilityScoreImprovement(candidate);
    const content = `<div class="cb-structural-error">
      ${isAsi ? "" : `<p><strong>${name} cannot be selected.</strong></p>`}
      <p>${safeReason}</p>
      <p>This choice was not applied. Select a different feat or return to the previous step.</p>
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
