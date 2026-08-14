import { CharacterValidationProgressionService } from "./character-validation-progression-service.mjs";
import { SourceRegistry } from "./source-registry.mjs";

const BLOCKING_KINDS = new Set([
  "advancement-choice-incomplete",
  "subclass-entitlement-incomplete",
  "weapon-mastery-incomplete",
  "fighting-style-incomplete",
  "warlock-invocation-entitlement",
  "trait-grant-missing",
  "trait-choice-mechanical-missing",
  "trait-choice-incomplete"
]);

/**
 * Transaction-boundary completeness guard shared by Character Creation and
 * Level Up. The Character Validator remains the canonical projection engine;
 * this service only turns proven progression deficits into a commit gate.
 *
 * Level Up compares the pending Draft against the live Actor so legacy gaps do
 * not become unrelated blockers. Only a newly introduced or worsened deficit
 * can stop the current transaction.
 */
export class AdvancementCompletionGateService {
  static async issues(draft, { registry = null, baselineActor = null } = {}) {
    if (!draft) throw new Error("A Character Builder Draft is required for Advancement completeness validation.");

    registry ??= new SourceRegistry();
    if (!registry.loaded) await registry.load();

    const draftIssues = this.#blocking(
      await CharacterValidationProgressionService.scanBlockingAdvancementCompletion(draft, registry)
    );
    if (!baselineActor || !draftIssues.length) return draftIssues;

    const baselineIssues = this.#blocking(
      await CharacterValidationProgressionService.scanBlockingAdvancementCompletion(baselineActor, registry)
    );
    const baselineByIdentity = new Map();
    for (const issue of baselineIssues) {
      const key = this.#identity(issue);
      baselineByIdentity.set(key, Math.max(
        baselineByIdentity.get(key) ?? 0,
        this.#deficit(issue)
      ));
    }

    return draftIssues.filter(issue => {
      const baselineDeficit = baselineByIdentity.get(this.#identity(issue)) ?? 0;
      return this.#deficit(issue) > baselineDeficit;
    });
  }

  static async assertComplete(draft, {
    registry = null,
    baselineActor = null,
    context = "Character progression"
  } = {}) {
    const issues = await this.issues(draft, { registry, baselineActor });
    if (!issues.length) return [];

    const labels = issues.slice(0, 3).map(issue => issue.title || issue.summary || issue.kind);
    const remainder = issues.length - labels.length;
    const suffix = remainder > 0 ? ` (+${remainder} more)` : "";
    const error = new Error(
      `${context} is incomplete. Resolve the required Advancement choice${issues.length === 1 ? "" : "s"} before continuing: ${labels.join("; ")}${suffix}.`
    );
    error.name = "AdvancementCompletionError";
    error.code = "DND5E_CHARACTER_BUILDER_ADVANCEMENT_INCOMPLETE";
    error.advancementCompletionIssues = issues;
    throw error;
  }

  static #blocking(issues) {
    return (issues ?? []).filter(issue => {
      if (!BLOCKING_KINDS.has(issue?.kind)) return false;
      if (issue.kind !== "warlock-invocation-entitlement") return true;
      return Number(issue.data?.actual ?? 0) < Number(issue.data?.expected ?? 0);
    });
  }

  static #identity(issue) {
    const data = issue?.data ?? {};
    return [
      issue?.kind ?? "unknown",
      data.ownerId ?? data.classItemId ?? "",
      data.sourceAdvancementId ?? data.localAdvancementId ?? "",
      data.token ?? ""
    ].map(value => String(value ?? "")).join(":");
  }

  static #deficit(issue) {
    const expected = Number(issue?.data?.expected);
    const actual = Number(issue?.data?.actual);
    if (Number.isFinite(expected) && Number.isFinite(actual)) return Math.max(0, expected - actual);
    return 1;
  }
}
