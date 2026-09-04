import { MODULE_ID } from "../constants.mjs";

export class ValidationService {
  static validateDraft(draft) {
    const issues = [];
    const species = draft.items.find(item => item.type === "race");
    const background = draft.items.find(item => item.type === "background");
    const cls = draft.items.find(item => item.type === "class");

    if (!species) issues.push("Species is missing.");
    if (!background) issues.push("Background is missing.");
    if (!cls) issues.push("Class is missing.");

    if (cls) {
      const totalLevels = draft.items
        .filter(item => item.type === "class")
        .reduce((sum, item) => sum + Number(item.system.levels ?? 0), 0);
      if (totalLevels !== 1) issues.push(`The Draft must be character level 1, but contains ${totalLevels} class levels.`);

      const hp = Number(draft.system.attributes.hp.value ?? 0);
      if (hp <= 0) issues.push("Hit Points were not calculated.");

      const progression = cls.system.spellcasting?.progression ?? "none";
      if (progression !== "none" && !draft.getFlag(MODULE_ID, "buildState")?.spellAccessSaved) {
        issues.push("Class spell access has not been saved.");
      }
    }

    return issues;
  }
}
