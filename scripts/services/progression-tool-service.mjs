import { MODULE_ID } from "../constants.mjs";
import { LevelUpService } from "./level-up-service.mjs";
import { EpicBoonService } from "./epic-boon-service.mjs";

/**
 * GM-only group progression operations. The tool grants milestone permissions
 * or distributes integer XP; it never performs a Level Up on behalf of a
 * player.
 */
export class ProgressionToolService {
  static ledgerSetting = "progressionBatchLedger";

  static async grantLevelUps(actors) {
    this.#assertGM();
    const unique = this.#uniqueActors(actors);
    if (!unique.length) throw new Error("Select at least one character.");

    const batch = await this.#beginBatch("milestone", unique, {});
    const results = [];
    for (const actor of unique) {
      try {
        const eligibility = LevelUpService.eligibility(actor);
        if (!actor.items.some(item => item.type === "class")) throw new Error("Complete Character Creation first.");
        if (LevelUpService.actorLevel(actor) >= 20) throw new Error("Character is already level 20.");
        if (eligibility.hasDraft || actor.getFlag(MODULE_ID, "levelUpHitPointRoll")) {
          throw new Error("Finish or reset the pending Level Up first.");
        }
        if (actor.getFlag(MODULE_ID, "levelUpGrant")?.available) {
          results.push({ actorId: actor.id, name: actor.name, ok: true, skipped: true, message: "Level Up was already granted." });
          continue;
        }
        await LevelUpService.grant(actor, { batchId: batch.batchId, idempotencyToken: batch.idempotencyToken });
        results.push({ actorId: actor.id, name: actor.name, ok: true, message: "Level Up granted." });
        actor.sheet?.render?.(false);
      } catch (error) {
        results.push({ actorId: actor.id, name: actor.name, ok: false, message: error.message });
      }
    }
    await this.#completeBatch(batch, results);
    return { ...batch, results };
  }

  static async grantEpicBoons(actors) {
    this.#assertGM();
    if (!LevelUpService.settings().enableGrantEpicBoons) {
      throw new Error("Grant Epic Boons is disabled in Character Builder settings.");
    }
    const unique = this.#uniqueActors(actors);
    if (!unique.length) throw new Error("Select at least one character.");

    const batch = await this.#beginBatch("epicBoon", unique, {});
    const results = [];
    for (const actor of unique) {
      try {
        await EpicBoonService.grant(actor, {
          batchId: batch.batchId,
          idempotencyToken: batch.idempotencyToken
        });
        results.push({ actorId: actor.id, name: actor.name, ok: true, message: "Epic Boon granted." });
      } catch (error) {
        results.push({ actorId: actor.id, name: actor.name, ok: false, message: error.message });
      }
    }
    await this.#completeBatch(batch, results);
    return { ...batch, results };
  }

  static async distributeXp(actors, totalXp) {
    this.#assertGM();
    const unique = this.#uniqueActors(actors);
    const total = Math.trunc(Number(totalXp));
    if (!unique.length) throw new Error("Select at least one character.");
    if (!Number.isFinite(total) || total <= 0) throw new Error("Enter a positive whole-number XP total.");

    const xpPerActor = Math.trunc(total / unique.length);
    const remainder = total - (xpPerActor * unique.length);
    if (xpPerActor <= 0) {
      throw new Error(`${total.toLocaleString()} XP divided among ${unique.length} characters grants 0 XP each. Select fewer characters or enter a larger XP amount.`);
    }

    const batch = await this.#beginBatch("xp", unique, { totalXp: total, xpPerActor, remainder });
    const results = [];
    for (const actor of unique) {
      try {
        if (!actor.items.some(item => item.type === "class")) throw new Error("Complete Character Creation first.");
        if (LevelUpService.actorLevel(actor) >= 20) throw new Error("Character is already level 20.");

        const lastBatch = actor.getFlag(MODULE_ID, "lastProgressionBatch");
        if (lastBatch?.idempotencyToken === batch.idempotencyToken) {
          results.push({ actorId: actor.id, name: actor.name, ok: true, skipped: true, message: "XP was already applied for this batch." });
          continue;
        }

        const currentXp = Math.max(0, Math.trunc(Number(actor.system?.details?.xp?.value ?? 0)));
        const resultingXp = currentXp + xpPerActor;
        await actor.update({
          "system.details.xp.value": resultingXp,
          [`flags.${MODULE_ID}.lastProgressionBatch`]: {
            batchId: batch.batchId,
            idempotencyToken: batch.idempotencyToken,
            mode: "xp",
            amount: xpPerActor,
            previousXp: currentXp,
            resultingXp,
            appliedAt: Date.now(),
            appliedBy: game.user.id
          }
        }, { characterBuilderProgressionBatch: batch.batchId });
        results.push({
          actorId: actor.id,
          name: actor.name,
          ok: true,
          amount: xpPerActor,
          previousXp: currentXp,
          resultingXp,
          levelUpAvailable: LevelUpService.eligibility(actor).ready,
          message: `+${xpPerActor.toLocaleString()} XP`
        });
        actor.sheet?.render?.(false);
      } catch (error) {
        results.push({ actorId: actor.id, name: actor.name, ok: false, message: error.message });
      }
    }
    await this.#completeBatch(batch, results);
    return { ...batch, xpPerActor, remainder, results };
  }

  static previewXp(totalXp, actorCount) {
    const total = Math.max(0, Math.trunc(Number(totalXp) || 0));
    const count = Math.max(0, Math.trunc(Number(actorCount) || 0));
    const xpPerActor = count ? Math.trunc(total / count) : 0;
    return {
      totalXp: total,
      actorCount: count,
      xpPerActor,
      totalDistributed: xpPerActor * count,
      remainder: total - (xpPerActor * count)
    };
  }

  static async #beginBatch(mode, actors, extra) {
    const batchId = foundry.utils.randomID?.(24) ?? crypto.randomUUID();
    const idempotencyToken = foundry.utils.randomID?.(32) ?? crypto.randomUUID();
    const batch = {
      batchId,
      idempotencyToken,
      mode,
      status: "applying",
      actorIds: actors.map(actor => actor.id),
      grantedBy: game.user.id,
      grantedAt: Date.now(),
      ...extra,
      results: []
    };
    await this.#appendLedger(batch);
    return batch;
  }

  static async #completeBatch(batch, results) {
    const ledger = this.#ledger();
    const entries = [...(ledger.entries ?? [])];
    const index = entries.findIndex(entry => entry.batchId === batch.batchId);
    const completed = { ...batch, status: "complete", completedAt: Date.now(), results: foundry.utils.deepClone(results) };
    if (index >= 0) entries[index] = completed;
    else entries.push(completed);
    await game.settings.set(MODULE_ID, this.ledgerSetting, { entries: entries.slice(-50) });
  }

  static async #appendLedger(batch) {
    const ledger = this.#ledger();
    const entries = [...(ledger.entries ?? []), foundry.utils.deepClone(batch)].slice(-50);
    await game.settings.set(MODULE_ID, this.ledgerSetting, { entries });
  }

  static #ledger() {
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, this.ledgerSetting) ?? { entries: [] });
  }

  static #uniqueActors(actors) {
    const map = new Map();
    for (const actor of actors ?? []) {
      if (actor?.type === "character" && !actor.getFlag(MODULE_ID, "isDraft") && !actor.getFlag(MODULE_ID, "isLevelUpDraft")) {
        map.set(actor.id, actor);
      }
    }
    return [...map.values()];
  }

  static #assertGM() {
    if (!game.user.isGM) throw new Error("Only a GM can use the Character Builder Tool.");
  }
}
