import { MODULE_ID } from "../constants.mjs";

/**
 * Thin adapter over D&D5e's native Group Actors for Character Builder batch tools.
 *
 * Character Builder deliberately does not maintain a second Party roster. Group
 * membership remains authored and persisted by D&D5e itself. The GM Tool may
 * target All Characters or one native Group; only character-type members are
 * exposed to Character Builder progression/rest batch actions.
 */
export class PartyGroupService {
  static groups() {
    return [...(game.actors ?? [])]
      .filter(actor => actor?.type === "group")
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  }

  static group(groupId) {
    if (!groupId) return null;
    const group = game.actors?.get?.(String(groupId)) ?? null;
    return group?.type === "group" ? group : null;
  }

  static characters(groupId = "") {
    const group = this.group(groupId);
    const candidates = group
      ? this.#groupCharacterMembers(group)
      : [...(game.actors ?? [])].filter(actor => actor?.type === "character");

    return candidates
      .filter(actor => actor
        && !actor.getFlag?.(MODULE_ID, "isDraft")
        && !actor.getFlag?.(MODULE_ID, "isLevelUpDraft"))
      .filter((actor, index, rows) => rows.findIndex(candidate => candidate.id === actor.id) === index)
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  }

  static #groupCharacterMembers(group) {
    // D&D5e 5.3.3 exposes playerCharacters directly on GroupData. Keep a
    // conservative fallback over the native members collection for resilience.
    const nativeCharacters = group?.system?.playerCharacters;
    if (Array.isArray(nativeCharacters)) return [...nativeCharacters];

    return [...(group?.system?.members ?? [])]
      .map(member => member?.actor ?? null)
      .filter(actor => actor?.type === "character");
  }
}
