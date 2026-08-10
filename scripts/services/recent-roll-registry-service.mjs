/**
 * Ephemeral registry of public roll messages. It is fed from ChatMessage
 * creation so every connected client observes the same recent-roll history.
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
    const row = {
      messageId: message.id,
      messageUuid: message.uuid ?? null,
      actorUuid,
      actorName: actor?.name ?? message.speaker?.alias ?? "Creature",
      rollType,
      total: Number(rolls[0].total),
      at: Date.now()
    };

    if (["attack", "ability", "skill", "tool"].includes(rollType) && actorUuid) {
      const rows = this.#d20ByActor.get(actorUuid) ?? [];
      rows.push(row);
      this.#d20ByActor.set(actorUuid, rows.slice(-20));
    }
    if (rollType === "damage") this.#damage.push(row);
    this.#prune();
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
