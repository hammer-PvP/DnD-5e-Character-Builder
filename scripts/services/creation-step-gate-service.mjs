import { CreationEditService } from "./creation-edit-service.mjs";

/**
 * Character Creation navigation is deliberately split into two concerns:
 * browsing is always allowed, while mutations follow one deterministic commit
 * order. This service is the single policy source for those gates.
 */
export class CreationStepGateService {
  static ORDER = Object.freeze([
    "abilitiesBackground",
    "species",
    "class",
    "spells",
    "equipment",
    "review"
  ]);

  static LABELS = Object.freeze({
    abilitiesBackground: "Ability Scores & Background",
    species: "Species",
    class: "Class",
    spells: "Spell Selection",
    equipment: "Starting Equipment",
    review: "Review"
  });

  static completion(draft, state = {}) {
    const editing = CreationEditService.editingStages(state);
    const background = draft?.items?.some?.(item => item.type === "background") ?? false;
    const species = draft?.items?.some?.(item => item.type === "race") ?? false;
    const characterClass = draft?.items?.some?.(item => item.type === "class") ?? false;
    const complete = {
      abilitiesBackground: Boolean(background && state.abilitiesSaved && !editing.abilitiesBackground),
      species: Boolean(species && !editing.species),
      class: Boolean(characterClass && !editing.class),
      spells: Boolean(state.spellAccessSaved && !editing.spells),
      equipment: Boolean(state.equipmentSaved && !editing.equipment)
    };
    // Review is the final actionable stage, not a completed choice of its own.
    // It becomes Current once every preceding required stage is complete.
    complete.review = false;
    return complete;
  }

  static prerequisites(step) {
    const normalized = this.normalize(step);
    const index = this.ORDER.indexOf(normalized);
    if (index <= 0) return [];
    return this.ORDER.slice(0, Math.min(index, this.ORDER.length - 1));
  }

  static missingPrerequisites(draft, state, step) {
    const complete = this.completion(draft, state);
    return this.prerequisites(step).filter(required => !complete[required]);
  }

  static canCommit(draft, state, step) {
    return this.missingPrerequisites(draft, state, step).length === 0;
  }

  static status(draft, state, step) {
    const normalized = this.normalize(step);
    const complete = this.completion(draft, state);
    if (complete[normalized]) return "complete";
    return this.canCommit(draft, state, normalized) ? "current" : "browseOnly";
  }

  static decorateSteps(draft, state, activeStep) {
    const complete = this.completion(draft, state);
    return this.ORDER.map(id => {
      const status = complete[id] ? "complete" : (this.canCommit(draft, state, id) ? "current" : "browseOnly");
      return {
        id,
        label: this.LABELS[id] ?? id,
        complete: status === "complete",
        current: status === "current",
        browseOnly: status === "browseOnly",
        status,
        statusLabel: status === "complete" ? "Complete" : status === "current" ? "Current" : "Browse Only",
        active: id === activeStep,
        missingLabels: this.missingPrerequisites(draft, state, id).map(required => this.LABELS[required] ?? required)
      };
    });
  }

  static blockMessage(draft, state, step) {
    const missing = this.missingPrerequisites(draft, state, step);
    if (!missing.length) return "";
    const labels = missing.map(required => this.LABELS[required] ?? required);
    return `Complete ${this.#join(labels)} before making selections in ${this.LABELS[this.normalize(step)] ?? "this step"}. You can still browse and inspect its options.`;
  }

  static dependentStages(stage) {
    const normalized = this.normalize(stage);
    const index = this.ORDER.indexOf(normalized);
    if (index < 0) return [];
    return this.ORDER.slice(index + 1).filter(id => id !== "review");
  }

  static normalize(step) {
    if (["origins", "abilities"].includes(step)) return "abilitiesBackground";
    return this.ORDER.includes(step) ? step : "abilitiesBackground";
  }

  static #join(values) {
    if (values.length < 2) return values[0] ?? "the required previous step";
    if (values.length === 2) return `${values[0]} and ${values[1]}`;
    return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
  }
}
