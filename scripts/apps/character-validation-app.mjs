import { MODULE_ID } from "../constants.mjs";
import { CharacterValidationService } from "../services/character-validation-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CharacterValidationApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(sourceActor, revisionActor, options = {}) {
    super(options);
    this.sourceActor = sourceActor;
    this.actor = revisionActor;
    this.scan = null;
    this.scanState = "pending";
    this.scanError = null;
    this._initialScanPromise = null;
    this.step = "overview";
    this.index = 0;
    this.results = new Map();
    this.busy = false;
    this.finished = false;
  }

  static DEFAULT_OPTIONS = {
    id: "dnd5e-character-validation",
    classes: ["dnd5e-character-builder", "character-builder", "character-validation-app", "standard-form"],
    position: { width: 1000, height: 760 },
    window: { title: "Character Builder — Character Validation", resizable: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/character-validation.hbs` }
  };

  get id() {
    return `dnd5e-character-validation-${this.actor.id}`;
  }

  static async launch(sourceActor) {
    if (!game.user?.isGM) {
      ui.notifications.warn("Character Validation is available to the GM only.");
      return null;
    }
    const revisionActor = await CharacterValidationService.createRevision(sourceActor);
    const app = new CharacterValidationApp(sourceActor, revisionActor);
    await app.render({ force: true });
    ui.notifications.info(`Created ${revisionActor.name}. The original Actor will not be modified.`);
    return app;
  }

  async _prepareContext() {
    const scan = this.scan ?? {
      issues: [],
      issueCount: 0,
      safeCount: 0,
      guidedCount: 0,
      warningCount: 0,
      coverage: []
    };
    const issues = scan.issues ?? [];
    const currentIssue = this.step === "issues" ? issues[this.index] ?? null : null;
    const currentResult = currentIssue ? this.results.get(currentIssue.id) ?? null : null;
    const completed = [...this.results.values()];
    const processedIds = new Set(completed.map(row => row.issueId));
    const unresolved = issues.filter(issue => !processedIds.has(issue.id));
    const repaired = completed.filter(row => row.status === "repaired");
    const skipped = completed.filter(row => row.status === "skipped");

    return {
      sourceActor: { id: this.sourceActor.id, name: this.sourceActor.name, img: this.sourceActor.img },
      actor: { id: this.actor.id, name: this.actor.name, img: this.actor.img },
      step: this.step,
      isOverview: this.step === "overview",
      isIssues: this.step === "issues",
      isReview: this.step === "review",
      isComplete: this.step === "complete",
      scan,
      scanState: this.scanState,
      isScanning: this.scanState === "pending" || this.scanState === "scanning",
      scanFailed: this.scanState === "error",
      scanReady: this.scanState === "ready",
      scanError: this.scanError,
      currentIssue,
      currentResult,
      currentProcessed: Boolean(currentResult),
      issueNumber: currentIssue ? this.index + 1 : 0,
      issueTotal: issues.length,
      canGoBack: this.index > 0,
      repaired,
      skipped,
      unresolved,
      busy: this.busy,
      finished: this.finished
    };
  }

  _onRender() {
    for (const element of this.element.querySelectorAll("[data-action]")) {
      element.addEventListener("click", event => this.#onAction(event));
    }
    if (this.scanState === "pending" && !this._initialScanPromise) {
      this._initialScanPromise = this.#runInitialScan();
    }
  }

  async #runInitialScan() {
    this.scanState = "scanning";
    this.scanError = null;
    try {
      const scan = await CharacterValidationService.scan(this.actor);
      this.scan = scan;
      this.scanState = "ready";
    } catch (error) {
      console.error(`${MODULE_ID} | Character Validation initial scan failed.`, error);
      this.scan = null;
      this.scanState = "error";
      this.scanError = error?.message || String(error);
    } finally {
      this._initialScanPromise = null;
      if (this.element?.isConnected) await this.render({ force: true });
    }
  }

  async #onAction(event) {
    event.preventDefault();
    event.stopPropagation();
    if (this.busy) return;
    const action = event.currentTarget.dataset.action;
    try {
      switch (action) {
        case "start":
          if (this.scanState !== "ready") return;
          this.step = (this.scan?.issues?.length ?? 0) ? "issues" : "review";
          this.index = 0;
          await this.render({ force: true });
          break;
        case "retry-scan":
          if (!this._initialScanPromise) {
            this.scanState = "pending";
            this.scanError = null;
            await this.render({ force: true });
          }
          break;
        case "repair":
          await this.#repairCurrent();
          break;
        case "skip":
          await this.#skipCurrent();
          break;
        case "previous":
          this.index = Math.max(0, this.index - 1);
          await this.render({ force: true });
          break;
        case "next":
          await this.#advance();
          break;
        case "review":
          this.step = "review";
          await this.render({ force: true });
          break;
        case "finish":
          await this.#finish();
          break;
        case "open-revision":
          this.actor.sheet?.render?.(true);
          break;
        case "open-source":
          this.sourceActor.sheet?.render?.(true);
          break;
        case "close":
          await this.close();
          break;
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Character Validation action failed.`, error);
      ui.notifications.error(error.message, { permanent: true });
    }
  }

  async #repairCurrent() {
    const issue = this.scan?.issues?.[this.index];
    if (!issue) return this.#advance();
    if (this.results.has(issue.id)) return this.#advance();

    this.busy = true;
    await this.render({ force: true });
    try {
      const result = await CharacterValidationService.applyRepair(this.actor, issue);
      this.results.set(issue.id, result);
      ui.notifications.info(result.message ?? `${issue.title} repaired.`);
      const fresh = await CharacterValidationService.scan(this.actor);
      const remaining = (fresh.issues ?? []).filter(candidate => !this.results.has(candidate.id));
      this.scan = { ...fresh, issues: remaining, issueCount: remaining.length };
      if (remaining.length) {
        this.index = Math.min(this.index, remaining.length - 1);
        this.step = "issues";
      } else {
        this.index = 0;
        this.step = "review";
      }
    } finally {
      this.busy = false;
      await this.render({ force: true });
    }
  }

  async #skipCurrent() {
    const issue = this.scan?.issues?.[this.index];
    if (issue && !this.results.has(issue.id)) {
      this.results.set(issue.id, {
        status: "skipped",
        issueId: issue.id,
        title: issue.title,
        message: `${issue.title} was skipped by the GM.`
      });
    }
    await this.#advance();
  }

  #advanceState() {
    const issues = this.scan?.issues ?? [];
    if (this.index < issues.length - 1) {
      this.index += 1;
      this.step = "issues";
    } else {
      this.step = "review";
    }
  }

  async #advance() {
    this.#advanceState();
    await this.render({ force: true });
  }

  async #finish() {
    this.busy = true;
    await this.render({ force: true });
    try {
      const issues = this.scan?.issues ?? [];
      const processed = new Set(this.results.keys());
      const unresolved = issues.filter(issue => !processed.has(issue.id));
      await CharacterValidationService.finalize(this.actor, {
        sourceActor: this.sourceActor,
        results: [...this.results.values()],
        unresolved
      });
      this.finished = true;
      this.step = "complete";
      ui.notifications.info(`Character Validation finished for ${this.actor.name}.`);
      await this.render({ force: true });
    } finally {
      this.busy = false;
    }
  }
}
