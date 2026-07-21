import { MODULE_ID } from "../constants.mjs";

/**
 * Keeps class progression on live Player Character Actors inside Character
 * Builder without disabling normal inventory, spell, or consumable drops.
 */
export class ClassProgressionGuard {
  static isProtectedActor(actor) {
    return actor?.type === "character"
      && !actor.getFlag(MODULE_ID, "isDraft")
      && !actor.getFlag(MODULE_ID, "isLevelUpDraft");
  }

  static isClassProgressionItem(data) {
    const type = data?.type;
    if (type === "class" || type === "subclass") return true;
    return type === "feat" && data?.system?.type?.value === "class";
  }

  static isAuthorized(options = {}) {
    return Boolean(
      options.characterBuilder
      || options.characterBuilderLevelUp
      || options.characterBuilderLevelUpRollback
      || options.characterBuilderRollback
      || options.characterBuilderPactOfTheTome
      || options.characterBuilderPactOfTheTomeRollback
      || options.characterBuilderEpicBoonGift
      || options.characterBuilderEpicBoonRollback
      || options.characterBuilderRuntimeManagement
      || options.characterBuilderRuntimeRollback
    );
  }

  static blockDirectCreate(item, _data, options = {}) {
    const actor = item?.parent;
    if (!this.isProtectedActor(actor) || !this.isClassProgressionItem(item)) return;
    if (this.isAuthorized(options)) return;

    // Native sheet and drag/drop creation keeps the source Item ID. Limit this
    // guard to those interactive paths (and native Advancement completion) so
    // unrelated programmatic Actor maintenance is not silently intercepted.
    if (!options.keepId && !options.isAdvancement) return;
    ui.notifications.warn("Class and subclass content must be added through Character Builder.");
    return false;
  }

  static blockNativeAdvancement(manager, _updates, toCreate = []) {
    const actor = manager?.actor;
    if (!this.isProtectedActor(actor) || this.isAuthorized(manager?.options ?? {})) return;
    if (!toCreate.some(data => this.isClassProgressionItem(data))) return;
    ui.notifications.warn("Class and subclass content must be added through Character Builder.");
    return false;
  }
}
