import { MODULE_ID } from "../constants.mjs";
import { ClassProgressionGuard } from "./class-progression-guard.mjs";
import { PlayerSheetIntegritySettingsService } from "./player-sheet-integrity-settings-service.mjs";
import { PreparedSpellLimitService } from "./prepared-spell-limit-service.mjs";
import { SpellPreparationCadenceService } from "./spell-preparation-cadence-service.mjs";

/**
 * Authoritative policy for direct player changes to Spell.system.prepared.
 *
 * Spell access, prepared-list size, and preparation timing are separate rules.
 * This service answers only whether a player may directly edit the native
 * prepared field. Character Builder transactions and GM administration remain
 * authorized through their existing option flags.
 */
export class SpellPreparationAuthorityService {
  static enabled(candidate = null) {
    const settings = candidate ?? globalThis.game?.settings?.get?.(MODULE_ID, "settings") ?? {};
    return PlayerSheetIntegritySettingsService.ruleEnabled("preparedSpellLimit", settings)
      || settings.manageSpellPreparationWithKeeper !== false;
  }

  static classForSpell(actor, spell) {
    const direct = PreparedSpellLimitService.owningClassForSpell(actor, spell);
    if (direct) return direct;

    const flags = spell?.flags?.[MODULE_ID] ?? {};
    const owners = Array.isArray(flags.featureSpellOwners) ? flags.featureSpellOwners : [];
    for (const owner of owners) {
      const byId = owner?.classItemId ? actor?.items?.get?.(owner.classItemId) : null;
      if (byId?.type === "class") return byId;
      const byIdentifier = PreparedSpellLimitService.classByIdentifier(actor, owner?.classIdentifier);
      if (byIdentifier) return byIdentifier;
    }

    const sourceItem = String(spell?.system?.sourceItem ?? "").trim();
    const subclassMatch = /^subclass:([^:]+)$/i.exec(sourceItem);
    if (subclassMatch?.[1]) {
      const subclass = [...(actor?.items ?? [])].find(item => item?.type === "subclass"
        && String(item.system?.identifier ?? "").trim().toLowerCase() === subclassMatch[1].toLowerCase());
      const parentIdentifier = subclass?.system?.classIdentifier ?? subclass?.system?.class?.identifier ?? subclass?.system?.class;
      const cls = PreparedSpellLimitService.classByIdentifier(actor, parentIdentifier);
      if (cls) return cls;
    }
    return null;
  }

  static managesSpell(actor, spell, candidate = null) {
    if (!this.enabled(candidate) || !actor || spell?.type !== "spell") return false;
    if (Number(spell.system?.level ?? 0) <= 0) return false;
    const cls = this.classForSpell(actor, spell);
    return Boolean(cls && SpellPreparationCadenceService.forClass(cls));
  }

  static mayChangeFromSheet(actor, spell, { user = globalThis.game?.user, candidate = null } = {}) {
    if (!actor || spell?.type !== "spell" || Number(spell.system?.level ?? 0) <= 0) return { allowed: true };
    if (!this.managesSpell(actor, spell, candidate)) return { allowed: true };
    if (!user || user.isGM) return { allowed: true };
    if (!ClassProgressionGuard.isProtectedActor(actor)) return { allowed: true };
    const owns = actor?.testUserPermission ? actor.testUserPermission(user, "OWNER") : actor?.isOwner;
    if (!owns) return { allowed: true };

    const cls = this.classForSpell(actor, spell);
    const cadence = SpellPreparationCadenceService.forClass(cls);
    let timing = "through a Character Builder preparation window";
    if (cadence === SpellPreparationCadenceService.LONG_REST) timing = "through Character Keeper during a Long Rest";
    else if (cadence === SpellPreparationCadenceService.LONG_REST_REPLACE_ONE) {
      timing = "during Character Creation or an eligible Level Up, with one optional one-for-one replacement after a Long Rest";
    } else if (cadence === SpellPreparationCadenceService.LEVEL_UP) timing = "through the class's Character Builder progression choices";

    return {
      allowed: false,
      classItemId: cls?.id ?? null,
      classIdentifier: String(cls?.system?.identifier ?? "").trim().toLowerCase(),
      cadence,
      message: `${cls?.name ?? "This class"} spell preparation is managed ${timing}. The GM can still change preparation directly from the sheet.`
    };
  }
}
