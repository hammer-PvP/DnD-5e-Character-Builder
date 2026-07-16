import { MODULE_ID } from "../constants.mjs";
import { LevelUpService } from "./level-up-service.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";

export class HitPointAdvancementService {
  static LOCK_FLAG = "levelUpHitPointRoll";
  static RESET_HISTORY_FLAG = "hitPointRollResetHistory";

  static sourceActor(draft) {
    const actorId = draft?.getFlag?.(MODULE_ID, "sourceActorId");
    return actorId ? game.actors.get(actorId) : null;
  }

  static lockedRoll(actor) {
    return foundry.utils.deepClone(actor?.getFlag?.(MODULE_ID, this.LOCK_FLAG) ?? null);
  }

  static #scopeKey(actor, state) {
    return [
      actor?.id ?? "unknown",
      Number(state?.sourceCharacterLevel ?? 0),
      Number(state?.targetCharacterLevel ?? 0)
    ].join(":");
  }

  static #legacyLockKey(actor, state) {
    return [
      this.#scopeKey(actor, state),
      String(state?.selectedClassIdentifier ?? ""),
      Number(state?.targetClassLevel ?? 0)
    ].join(":");
  }

  static #scopeMatches(lock, actor, state) {
    if (!lock || !actor || !state) return false;
    const scopeKey = lock.scopeKey ?? [
      actor.id,
      Number(lock.sourceCharacterLevel ?? 0),
      Number(lock.targetCharacterLevel ?? 0)
    ].join(":");
    return scopeKey === this.#scopeKey(actor, state)
      && Number(lock.sourceCharacterLevel) === Number(state.sourceCharacterLevel)
      && Number(lock.targetCharacterLevel) === Number(state.targetCharacterLevel);
  }

  static #selectionMatches(selection, state) {
    if (!selection || !state) return false;
    return String(selection.selectedClassIdentifier ?? "") === String(state.selectedClassIdentifier ?? "")
      && Number(selection.targetClassLevel ?? 0) === Number(state.targetClassLevel ?? 0);
  }

  static #originalSelection(lock) {
    return {
      selectedClassId: lock.selectedClassId ?? null,
      selectedClassSourceUuid: lock.selectedClassSourceUuid ?? null,
      selectedClassIdentifier: lock.selectedClassIdentifier ?? null,
      selectedClassName: lock.selectedClassName ?? null,
      multiclass: Boolean(lock.multiclass),
      sourceClassLevel: Number(lock.sourceClassLevel ?? 0),
      targetClassLevel: Number(lock.targetClassLevel ?? 0)
    };
  }

  static #stateSelection(state) {
    return {
      selectedClassId: state.selectedClassId ?? null,
      selectedClassSourceUuid: state.selectedClassSourceUuid ?? null,
      selectedClassIdentifier: state.selectedClassIdentifier ?? null,
      selectedClassName: state.selectedClassName ?? null,
      multiclass: Boolean(state.multiclass),
      sourceClassLevel: Number(state.sourceClassLevel ?? 0),
      targetClassLevel: Number(state.targetClassLevel ?? 0)
    };
  }

  static async hydrateLockedRoll(actor, draft) {
    const state = LevelUpDraftManager.getState(draft);
    let lock = this.lockedRoll(actor);

    // Migrate a roll stored only on an older Draft into the live Actor lock.
    if (!lock && state.hpResult?.method === "roll"
      && state.selectedClassIdentifier && Number(state.targetClassLevel) > 0) {
      const result = foundry.utils.deepClone(state.hpResult);
      result.lockKey ??= this.#legacyLockKey(actor, state);
      lock = {
        transactionId: state.transactionId,
        scopeKey: this.#scopeKey(actor, state),
        lockKey: result.lockKey,
        sourceCharacterLevel: state.sourceCharacterLevel,
        targetCharacterLevel: state.targetCharacterLevel,
        ...this.#stateSelection(state),
        denomination: result.sourceRollDenomination ?? result.denomination,
        lockedAt: result.rolledAt ?? Date.now(),
        lockedBy: game.user?.id ?? null,
        migratedFromDraft: true,
        result
      };
      await actor.setFlag(MODULE_ID, this.LOCK_FLAG, lock);
    }

    if (!lock) return null;
    lock.scopeKey ??= this.#scopeKey(actor, lock);
    const currentLevel = LevelUpService.actorLevel(actor);
    if (Number(lock.sourceCharacterLevel) !== Number(currentLevel)
      || Number(lock.targetCharacterLevel) !== Number(currentLevel) + 1) {
      await this.#archiveReset(actor, lock, "stale-transaction");
      await actor.unsetFlag(MODULE_ID, this.LOCK_FLAG);
      return null;
    }

    // An explicit player restart intentionally returns to Class selection while
    // preserving the Actor-level roll. Do not force the original Class back in.
    if (state.restartClassSelection && state.step === "class" && !state.selectedClassIdentifier) {
      if (state.transactionId !== lock.transactionId) {
        await LevelUpDraftManager.setState(draft, { transactionId: lock.transactionId });
      }
      return lock;
    }

    let selection = null;
    let result = null;
    if (state.selectedClassIdentifier && this.#selectionMatches(lock.activeSelection, state)) {
      selection = lock.activeSelection;
      result = lock.activeResult;
    } else if (state.selectedClassIdentifier && this.#selectionMatches(this.#originalSelection(lock), state)) {
      selection = this.#originalSelection(lock);
      result = lock.result;
    } else if (state.restartClassSelection && state.selectedClassIdentifier) {
      return lock;
    } else {
      selection = this.#originalSelection(lock);
      result = lock.result;
    }

    const selectedClassId = selection.multiclass
      ? null
      : (draft.items.get(selection.selectedClassId)?.id
        ?? draft.items.find(item => item.type === "class"
          && item.system?.identifier === selection.selectedClassIdentifier)?.id
        ?? selection.selectedClassId
        ?? null);
    const stepOrder = ["class", "hp", "advancements", "choices", "review"];
    const currentStepIndex = Math.max(0, stepOrder.indexOf(state.step ?? "class"));
    const patch = {
      transactionId: lock.transactionId ?? state.transactionId,
      step: currentStepIndex < 1 ? "hp" : state.step,
      selectedClassId,
      selectedClassSourceUuid: selection.selectedClassSourceUuid ?? null,
      selectedClassIdentifier: selection.selectedClassIdentifier,
      selectedClassName: selection.selectedClassName,
      multiclass: Boolean(selection.multiclass),
      sourceClassLevel: Number(selection.sourceClassLevel),
      targetClassLevel: Number(selection.targetClassLevel),
      hpMethod: result?.method ?? "roll",
      hpResult: foundry.utils.deepClone(result)
    };
    await LevelUpDraftManager.setState(draft, patch);
    return lock;
  }

  static assertClassSelectionAllowed(actor, selection, { allowRetarget = false } = {}) {
    const lock = this.lockedRoll(actor);
    if (!lock) return null;
    const proposed = {
      sourceCharacterLevel: LevelUpService.actorLevel(actor),
      targetCharacterLevel: LevelUpService.actorLevel(actor) + 1,
      ...selection
    };
    if (!this.#scopeMatches(lock, actor, proposed)) {
      throw new Error("The locked Hit Die belongs to another character-level transaction. Ask the GM to reset the pending Level Up.");
    }
    if (this.#selectionMatches(this.#originalSelection(lock), proposed)) {
      return foundry.utils.deepClone(lock.result);
    }
    if (allowRetarget) return null;
    throw new Error(`The locked ${lock.denomination ?? "Hit Die"} result belongs to ${lock.selectedClassName} Class level ${lock.targetClassLevel}. Use Restart Class Selection or ask the GM for a full reset.`);
  }

  static async methodAvailability(draft, registry) {
    const state = LevelUpDraftManager.getState(draft);
    const lock = this.lockedRoll(this.sourceActor(draft));
    const methods = this.methods();
    if (!lock) return methods.map(method => ({ ...method, disabled: false }));

    const hitDie = state.selectedClassIdentifier ? await this.classHitDie(draft, state, registry) : null;
    const retained = Boolean(state.restartClassSelection);
    const raw = Number(lock.result?.raw ?? 0);
    const canUseLocked = Boolean(hitDie && raw >= 1 && raw <= hitDie.maximum);
    return methods.map(method => {
      if (!retained) {
        return {
          ...method,
          label: method.id === "roll" ? "Use Locked Roll" : method.label,
          disabled: method.id !== "roll",
          description: method.id === "roll"
            ? `${raw} was rolled on ${lock.result?.denomination ?? lock.denomination}.`
            : "A roll is already locked for this Level Up."
        };
      }
      if (method.id === "roll") {
        return {
          ...method,
          label: "Use Locked Roll",
          disabled: !canUseLocked,
          description: canUseLocked
            ? `Reuse ${raw} from the locked ${lock.result?.denomination ?? lock.denomination} roll for ${hitDie.denomination}.`
            : `${raw} cannot fit on ${hitDie?.denomination ?? "the selected Class Hit Die"}; choose Average.`
        };
      }
      if (method.id === "average") {
        return { ...method, disabled: false, description: "Use the selected Class fixed average instead of the retained roll." };
      }
      return { ...method, disabled: true, description: "Maximum is unavailable after a Hit Die has already been rolled." };
    });
  }

  static validateLockedResult(actor, state) {
    const lock = this.lockedRoll(actor);
    if (!lock) {
      if (state?.hpResult?.method === "roll") {
        throw new Error("The rolled Hit Point result is not backed by the Actor's persistent Level Up lock.");
      }
      return true;
    }
    if (!this.#scopeMatches(lock, actor, state)) {
      throw new Error("The persistent Hit Die lock belongs to another Level Up transaction.");
    }
    if (state?.hpResult?.method !== "roll") return true;

    const expected = this.#selectionMatches(lock.activeSelection, state)
      ? lock.activeResult
      : this.#selectionMatches(this.#originalSelection(lock), state)
        ? lock.result
        : null;
    if (!expected) throw new Error("The selected Class does not match the locked Hit Die result.");
    const fields = [
      "method", "lockKey", "raw", "applied", "denomination", "sourceRollDenomination",
      "rollFormula", "rolledAt", "maximum", "average", "minimumAverage",
      "selectedClassIdentifier", "targetClassLevel"
    ];
    for (const field of fields) {
      if (String(expected?.[field] ?? "") !== String(state.hpResult?.[field] ?? "")) {
        throw new Error(`The locked Hit Point ${field} changed unexpectedly. The transaction was blocked.`);
      }
    }
    return true;
  }

  static async clearLockedRoll(actor, { reason = "committed", archive = false } = {}) {
    const lock = this.lockedRoll(actor);
    if (!lock) return;
    if (archive) await this.#archiveReset(actor, lock, reason);
    await actor.unsetFlag(MODULE_ID, this.LOCK_FLAG);
  }

  static async #archiveReset(actor, lock, reason) {
    const history = actor.getFlag(MODULE_ID, this.RESET_HISTORY_FLAG) ?? [];
    history.push({
      transactionId: lock.transactionId ?? null,
      resetAt: Date.now(),
      resetBy: game.user?.id ?? null,
      reason,
      selectedClassIdentifier: lock.selectedClassIdentifier ?? null,
      selectedClassName: lock.selectedClassName ?? null,
      targetCharacterLevel: lock.targetCharacterLevel ?? null,
      targetClassLevel: lock.targetClassLevel ?? null,
      result: foundry.utils.deepClone(lock.result ?? null)
    });
    await actor.setFlag(MODULE_ID, this.RESET_HISTORY_FLAG, history.slice(-20));
  }

  static methods() {
    const settings = LevelUpService.settings();
    const methods = settings.hitPointAdvancement?.methods ?? {};
    return [
      { id: "roll", label: "Roll", enabled: Boolean(methods.roll), icon: "fa-solid fa-dice-d20", description: "Roll once and lock the number to this Actor and target character level." },
      { id: "average", label: "Average", enabled: Boolean(methods.average), icon: "fa-solid fa-scale-balanced", description: "Use the fixed Class average." },
      { id: "maximum", label: "Maximum", enabled: Boolean(methods.maximum), icon: "fa-solid fa-heart", description: "Use the full Hit Die value." }
    ].filter(method => method.enabled);
  }

  static async classHitDie(draft, state, registry) {
    let cls = state.selectedClassId ? draft.items.get(state.selectedClassId) : null;
    if (!cls && state.selectedClassSourceUuid) cls = await fromUuid(state.selectedClassSourceUuid);
    if (!cls && state.selectedClassIdentifier) {
      const option = registry.preferredOption("class", state.selectedClassIdentifier);
      if (option) cls = await fromUuid(option.uuid);
    }
    if (!cls) throw new Error("Choose a Class before resolving Hit Points.");
    const denomination = String(cls.system?.hd?.denomination ?? "");
    const maximum = Number(denomination.replace(/^d/i, ""));
    if (!/^d\d+$/i.test(denomination) || !Number.isFinite(maximum) || maximum <= 0) {
      throw new Error(`Unable to determine the Hit Die for ${cls.name}.`);
    }
    return { cls, denomination, maximum, average: (maximum / 2) + 1 };
  }

  static async resolve(draft, registry, method) {
    const state = LevelUpDraftManager.getState(draft);
    const settings = LevelUpService.settings();
    const allowed = this.methods().map(entry => entry.id);
    const selected = allowed.includes(method)
      ? method
      : allowed.includes(settings.hitPointAdvancement?.defaultMethod)
        ? settings.hitPointAdvancement.defaultMethod
        : allowed[0];
    if (!selected) throw new Error("No Hit Point advancement method is enabled.");

    const hitDie = await this.classHitDie(draft, state, registry);
    const actor = this.sourceActor(draft);
    if (!actor) throw new Error("The source Actor for this Level Up could not be found.");
    const lockKey = this.#legacyLockKey(actor, state);
    let persistentLock = this.lockedRoll(actor);
    if (persistentLock && !this.#scopeMatches(persistentLock, actor, state)) {
      throw new Error("A Hit Die result is already locked for another Level Up transaction.");
    }
    if (persistentLock && selected === "maximum") {
      throw new Error("Maximum is unavailable after a Hit Die has already been rolled. Reuse the locked result or choose Average.");
    }
    if (persistentLock && selected === "average" && !state.restartClassSelection) {
      throw new Error("The Hit Die roll is locked. Confirm it or use Restart Class Selection before choosing Average.");
    }

    let result;
    if (persistentLock && selected === "roll") {
      const raw = Number(persistentLock.result?.raw ?? 0);
      if (raw < 1 || raw > hitDie.maximum) {
        throw new Error(`${raw} was rolled previously and cannot fit on ${hitDie.denomination}. Choose Average.`);
      }
      const minimumAverage = Boolean(settings.hitPointAdvancement?.minimumAverageOnRoll);
      const applied = minimumAverage ? Math.max(raw, hitDie.average) : raw;
      result = {
        method: "roll",
        lockKey: persistentLock.lockKey ?? persistentLock.result?.lockKey,
        sourceRollDenomination: persistentLock.result?.sourceRollDenomination
          ?? persistentLock.result?.denomination
          ?? persistentLock.denomination,
        denomination: hitDie.denomination,
        maximum: hitDie.maximum,
        average: hitDie.average,
        raw,
        applied,
        minimumAverage,
        rolledAt: persistentLock.result?.rolledAt,
        rollFormula: persistentLock.result?.rollFormula ?? persistentLock.result?.denomination,
        selectedClassIdentifier: state.selectedClassIdentifier,
        targetClassLevel: Number(state.targetClassLevel),
        reusedForDifferentHitDie: hitDie.denomination !== (persistentLock.result?.denomination ?? persistentLock.denomination)
      };
      persistentLock.activeSelection = this.#stateSelection(state);
      persistentLock.activeResult = foundry.utils.deepClone(result);
      await actor.setFlag(MODULE_ID, this.LOCK_FLAG, persistentLock);
    } else if (!persistentLock && selected === "roll") {
      const roll = await new Roll(hitDie.denomination).evaluate();
      const raw = Number(roll.total);
      const minimumAverage = Boolean(settings.hitPointAdvancement?.minimumAverageOnRoll);
      const applied = minimumAverage ? Math.max(raw, hitDie.average) : raw;
      await roll.toMessage({
        flavor: `Character Builder Level Up — ${state.selectedClassName} Hit Points (locked for character level ${state.targetCharacterLevel})`,
        speaker: ChatMessage.getSpeaker({ actor: draft })
      });
      result = {
        method: "roll",
        lockKey,
        sourceRollDenomination: hitDie.denomination,
        denomination: hitDie.denomination,
        maximum: hitDie.maximum,
        average: hitDie.average,
        raw,
        applied,
        minimumAverage,
        rolledAt: Date.now(),
        rollFormula: hitDie.denomination,
        selectedClassIdentifier: state.selectedClassIdentifier,
        targetClassLevel: Number(state.targetClassLevel),
        reusedForDifferentHitDie: false
      };
      persistentLock = {
        transactionId: state.transactionId,
        scopeKey: this.#scopeKey(actor, state),
        lockKey,
        sourceCharacterLevel: state.sourceCharacterLevel,
        targetCharacterLevel: state.targetCharacterLevel,
        ...this.#stateSelection(state),
        denomination: hitDie.denomination,
        lockedAt: Date.now(),
        lockedBy: game.user?.id ?? null,
        result: foundry.utils.deepClone(result),
        activeSelection: this.#stateSelection(state),
        activeResult: foundry.utils.deepClone(result)
      };
      await actor.setFlag(MODULE_ID, this.LOCK_FLAG, persistentLock);
    } else if (selected === "maximum") {
      result = {
        method: "maximum", lockKey, denomination: hitDie.denomination,
        maximum: hitDie.maximum, average: hitDie.average,
        raw: hitDie.maximum, applied: hitDie.maximum, minimumAverage: false,
        selectedClassIdentifier: state.selectedClassIdentifier,
        targetClassLevel: Number(state.targetClassLevel), resolvedAt: Date.now()
      };
    } else {
      result = {
        method: "average", lockKey, denomination: hitDie.denomination,
        maximum: hitDie.maximum, average: hitDie.average,
        raw: hitDie.average, applied: hitDie.average, minimumAverage: false,
        selectedClassIdentifier: state.selectedClassIdentifier,
        targetClassLevel: Number(state.targetClassLevel), resolvedAt: Date.now()
      };
      if (persistentLock) {
        persistentLock.activeSelection = this.#stateSelection(state);
        persistentLock.activeResult = foundry.utils.deepClone(result);
        await actor.setFlag(MODULE_ID, this.LOCK_FLAG, persistentLock);
      }
    }

    await LevelUpDraftManager.setState(draft, {
      hpMethod: selected,
      hpResult: result,
      step: "hp"
    });
    return result;
  }

  static advancementValue(result) {
    if (!result) throw new Error("Resolve Hit Points before applying the Level Up.");
    if (result.method === "average") return "avg";
    if (result.method === "maximum") return "max";
    return Math.trunc(Number(result.applied));
  }

  static summary(result) {
    if (!result) return "Not resolved";
    if (result.method === "roll") {
      const reused = result.reusedForDifferentHitDie
        ? `; reused for ${result.denomination}`
        : "";
      if (result.minimumAverage && result.applied !== result.raw) {
        return `${result.raw} locked roll${reused}; ${result.average} applied by Minimum Average`;
      }
      return `${result.applied} locked roll${reused}`;
    }
    if (result.method === "maximum") return `${result.maximum} (Maximum ${result.denomination})`;
    return `${result.average} (Average ${result.denomination})`;
  }
}
