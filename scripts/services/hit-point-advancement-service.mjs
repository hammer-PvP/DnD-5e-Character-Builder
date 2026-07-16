import { MODULE_ID } from "../constants.mjs";
import { LevelUpService } from "./level-up-service.mjs";
import { LevelUpDraftManager } from "./level-up-draft-manager.mjs";

export class HitPointAdvancementService {
  static methods() {
    const settings = LevelUpService.settings();
    const methods = settings.hitPointAdvancement?.methods ?? {};
    return [
      { id: "roll", label: "Roll", enabled: Boolean(methods.roll), icon: "fa-solid fa-dice-d20" },
      { id: "average", label: "Average", enabled: Boolean(methods.average), icon: "fa-solid fa-scale-balanced" },
      { id: "maximum", label: "Maximum", enabled: Boolean(methods.maximum), icon: "fa-solid fa-heart" }
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
    const lockKey = [
      draft.getFlag(MODULE_ID, "sourceActorId"),
      state.targetCharacterLevel,
      state.selectedClassIdentifier,
      state.targetClassLevel
    ].join(":");

    const existing = state.hpResult;
    if (settings.hitPointAdvancement?.lockRoll
      && existing?.method === "roll"
      && existing.lockKey === lockKey
      && selected !== "roll") {
      throw new Error("The Hit Die roll is locked for this Level Up. Confirm it or ask the GM to reset the pending Level Up.");
    }

    let result;
    if (selected === "roll") {
      if (existing?.method === "roll" && existing.lockKey === lockKey) {
        result = existing;
      } else {
        const roll = await new Roll(hitDie.denomination).evaluate();
        const raw = Number(roll.total);
        const minimumAverage = Boolean(settings.hitPointAdvancement?.minimumAverageOnRoll);
        const applied = minimumAverage ? Math.max(raw, hitDie.average) : raw;
        await roll.toMessage({
          flavor: `Character Builder Level Up — ${state.selectedClassName} Hit Points (locked for level ${state.targetCharacterLevel})`,
          speaker: ChatMessage.getSpeaker({ actor: draft })
        });
        result = {
          method: "roll",
          lockKey,
          denomination: hitDie.denomination,
          maximum: hitDie.maximum,
          average: hitDie.average,
          raw,
          applied,
          minimumAverage,
          rolledAt: Date.now(),
          rollFormula: hitDie.denomination
        };
      }
    } else if (selected === "maximum") {
      result = {
        method: "maximum",
        lockKey,
        denomination: hitDie.denomination,
        maximum: hitDie.maximum,
        average: hitDie.average,
        raw: hitDie.maximum,
        applied: hitDie.maximum,
        minimumAverage: false,
        resolvedAt: Date.now()
      };
    } else {
      result = {
        method: "average",
        lockKey,
        denomination: hitDie.denomination,
        maximum: hitDie.maximum,
        average: hitDie.average,
        raw: hitDie.average,
        applied: hitDie.average,
        minimumAverage: false,
        resolvedAt: Date.now()
      };
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
      if (result.minimumAverage && result.applied !== result.raw) {
        return `${result.raw} rolled on ${result.denomination}; ${result.average} applied by Minimum Average`;
      }
      return `${result.applied} rolled on ${result.denomination}`;
    }
    if (result.method === "maximum") return `${result.maximum} (Maximum ${result.denomination})`;
    return `${result.average} (Average ${result.denomination})`;
  }
}
