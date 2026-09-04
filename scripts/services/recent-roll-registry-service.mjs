import { MODULE_ID } from "../constants.mjs";

const ROLL_FLAG = "dnd5eCharacterBuilderRollResolution";

/**
 * Ephemeral registry of public roll messages. It is fed from ChatMessage
 * creation/update so every connected client observes the same recent-roll
 * history. When the shared roll-resolution queue finalizes after the original
 * ChatMessage exists, the public-safe finalized total is reconciled back into
 * the existing registry row instead of leaving Cutting Words on the base roll.
 */
export class RecentRollRegistryService {
  static #initialized = false;
  static #d20ByActor = new Map();
  static #damage = [];
  static #maxAgeMs = 120000;

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    Hooks.on("createChatMessage", message => this.#captureMessage(message));
    Hooks.on("updateChatMessage", message => this.#captureMessage(message));
  }

  static latestD20(actorUuid, { maxAgeMs = 60000 } = {}) {
    this.#prune();
    const rows = this.#d20ByActor.get(String(actorUuid ?? "")) ?? [];
    const cutoff = Date.now() - maxAgeMs;
    return [...rows].reverse().find(row => row.at >= cutoff) ?? null;
  }

  static latestDamage({ maxAgeMs = 60000 } = {}) {
    this.#prune();
    const cutoff = Date.now() - maxAgeMs;
    return [...this.#damage].reverse().find(row => row.at >= cutoff) ?? null;
  }

  static #captureMessage(message) {
    const rollType = String(message?.getFlag?.("dnd5e", "roll.type") ?? "");
    const rolls = Array.from(message?.rolls ?? []).filter(roll => Number.isFinite(Number(roll?.total)));
    if (!rolls.length) return;
    const actor = message.getAssociatedActor?.()
      ?? game.actors?.get?.(message.speaker?.actor)
      ?? null;
    const actorUuid = actor?.uuid ?? (message.speaker?.actor ? `Actor.${message.speaker.actor}` : null);
    const resolution = this.#publicResolution(message, rolls[0]);
    const currentTotal = Number.isFinite(Number(resolution?.currentTotal))
      ? Number(resolution.currentTotal)
      : Number(rolls[0].total);
    const originalTotal = Number.isFinite(Number(resolution?.originalTotal))
      ? Number(resolution.originalTotal)
      : Number(rolls[0].total);
    const row = {
      messageId: message.id,
      messageUuid: message.uuid ?? null,
      actorUuid,
      actorName: actor?.name ?? message.speaker?.alias ?? "Creature",
      rollType,
      total: currentTotal,
      originalTotal,
      currentTotal,
      finalized: resolution?.finalized === true,
      rollKey: resolution?.rollKey ?? null,
      at: Number(resolution?.at ?? message.timestamp ?? Date.now()) || Date.now()
    };

    if (["attack", "ability", "skill", "tool"].includes(rollType) && actorUuid) {
      this.#upsertD20(actorUuid, row);
    }
    if (rollType === "damage") this.#upsertDamage(row);
    this.#prune();
  }

  static #publicResolution(message, roll) {
    const publicSnapshot = message?.getFlag?.(MODULE_ID, "publicRollResolution");
    if (publicSnapshot && typeof publicSnapshot === "object") return publicSnapshot;

    // If the queue finalized before ChatMessage persistence, D&D5e serializes
    // the Roll options with the snapshot already attached. Read only the
    // public-safe numeric fields needed by the registry.
    const stored = roll?.options?.[ROLL_FLAG];
    if (!stored || typeof stored !== "object") return null;
    return {
      rollKey: stored.rollKey ?? null,
      originalTotal: stored.originalTotal,
      currentTotal: stored.currentTotal,
      finalized: stored.finalized === true,
      at: Date.now()
    };
  }

  static #upsertD20(actorUuid, row) {
    const rows = this.#d20ByActor.get(actorUuid) ?? [];
    const index = rows.findIndex(existing => existing.messageId === row.messageId);
    if (index >= 0) rows[index] = { ...rows[index], ...row };
    else rows.push(row);
    this.#d20ByActor.set(actorUuid, rows.slice(-20));
  }

  static #upsertDamage(row) {
    const index = this.#damage.findIndex(existing => existing.messageId === row.messageId);
    if (index >= 0) this.#damage[index] = { ...this.#damage[index], ...row };
    else this.#damage.push(row);
    this.#damage = this.#damage.slice(-40);
  }

  static #prune() {
    const cutoff = Date.now() - this.#maxAgeMs;
    for (const [key, rows] of this.#d20ByActor) {
      const kept = rows.filter(row => row.at >= cutoff).slice(-20);
      if (kept.length) this.#d20ByActor.set(key, kept);
      else this.#d20ByActor.delete(key);
    }
    this.#damage = this.#damage.filter(row => row.at >= cutoff).slice(-40);
  }
}
