import { MODULE_ID } from "../constants.mjs";

/**
 * First character level always uses the maximum class Hit Die. Later level-up
 * choices are intentionally outside the scope of this level 1 creation alpha.
 */
export class HitPointService {
  static async enforceFirstLevelMaximum(actor) {
    const classes = actor.items.filter(item => item.type === "class");
    const totalLevels = classes.reduce((sum, item) => sum + Number(item.system.levels ?? 0), 0);
    if (totalLevels !== 1 || classes.length !== 1) return null;

    const cls = classes[0];
    const denomination = String(cls.system.hd?.denomination ?? "d0");
    const dieMaximum = Number(denomination.replace(/^d/i, ""));
    if (!Number.isFinite(dieMaximum) || dieMaximum <= 0) {
      console.warn(`${MODULE_ID} | Could not determine Hit Die maximum for ${cls.name}`, denomination);
      return null;
    }

    const constitution = Number(actor.system.abilities.con.value ?? 10);
    const constitutionModifier = Math.floor((constitution - 10) / 2);
    const maximum = Math.max(1, dieMaximum + constitutionModifier);

    const advancement = foundry.utils.deepClone(cls.system.advancement ?? {});
    let changed = false;
    for (const entry of Object.values(advancement)) {
      if (entry.type !== "HitPoints") continue;
      entry.value ??= {};
      if (entry.value["1"] !== "max") {
        entry.value["1"] = "max";
        changed = true;
      }
    }

    if (changed) {
      await cls.update({ "system.advancement": advancement }, { diff: false, recursive: false });
    }

    await actor.update({
      "system.attributes.hp.value": maximum,
      "system.attributes.hp.max": null
    });

    return { maximum, dieMaximum, constitutionModifier, className: cls.name };
  }

  static async synchronizeCurrentToDerivedMaximum(actor) {
    // Embedded Item changes already cause Foundry to prepare the parent Actor.
    // Never call Actor#prepareData directly here: D&D5e 5.3.3 installs
    // non-configurable compatibility accessors such as senses.darkvision during
    // preparation, so preparing the same DataModel object twice throws
    // "Cannot redefine property: darkvision" even for characters without it.
    const hp = actor.system.attributes.hp;
    const maximum = Number(hp.effectiveMax ?? hp.max ?? hp.value ?? 1);
    if (!Number.isFinite(maximum) || maximum <= 0) return null;
    await actor.update({ "system.attributes.hp.value": maximum });
    return maximum;
  }
}
