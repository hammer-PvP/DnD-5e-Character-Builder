import { MODULE_ID } from "../constants.mjs";
import { LevelUpService } from "../services/level-up-service.mjs";
import { EpicBoonService } from "../services/epic-boon-service.mjs";
import { ProgressionToolService } from "../services/progression-tool-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CharacterBuilderToolApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.busy = false;
  }

  static DEFAULT_OPTIONS = {
    id: "character-builder-tool",
    classes: ["character-builder", "character-builder-tool", "standard-form"],
    tag: "form",
    position: { width: 680, height: 720 },
    window: { title: "Character Builder Tool", resizable: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/character-builder-tool.hbs` }
  };

  async _prepareContext() {
    if (!game.user.isGM) throw new Error("Only a GM can use the Character Builder Tool.");
    const settings = LevelUpService.settings();
    const mode = settings.levelUpMode === "xp" ? "xp" : "milestone";
    const epicBoonEnabled = Boolean(settings.enableGrantEpicBoons);
    const actors = game.actors
      .filter(actor => actor.type === "character"
        && !actor.getFlag(MODULE_ID, "isDraft")
        && !actor.getFlag(MODULE_ID, "isLevelUpDraft"))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
      .map(actor => {
        const level = LevelUpService.actorLevel(actor);
        const created = actor.items.some(item => item.type === "class");
        const hasDraft = Boolean(actor.getFlag(MODULE_ID, "levelUpDraftId") && game.actors.get(actor.getFlag(MODULE_ID, "levelUpDraftId")));
        const hpLocked = Boolean(actor.getFlag(MODULE_ID, "levelUpHitPointRoll"));
        const granted = Boolean(actor.getFlag(MODULE_ID, "levelUpGrant")?.available);
        const pendingEpicBoon = Boolean(EpicBoonService.pending(actor)?.available);
        const levelUpDisabledReason = !created
          ? "Complete Character Creation first."
          : level >= 20
            ? "Character is already level 20."
            : mode === "milestone" && (hasDraft || hpLocked)
              ? "Finish or reset the pending Level Up first."
              : mode === "milestone" && granted
                ? "Level Up already granted."
                : "";
        const boonEligibility = EpicBoonService.grantEligibility(actor);
        const levelUpEligible = !levelUpDisabledReason;
        const epicBoonEligible = epicBoonEnabled && boonEligibility.eligible;
        const selectable = levelUpEligible || epicBoonEligible;
        const disabledReason = selectable
          ? ""
          : pendingEpicBoon
            ? "Epic Boon already pending."
            : levelUpDisabledReason || (epicBoonEnabled ? boonEligibility.reason : "No available progression action.");
        const status = pendingEpicBoon
          ? "Epic Boon Pending"
          : epicBoonEligible
            ? "Epic Boon Ready"
            : levelUpEligible
              ? "Ready"
              : disabledReason;
        return {
          id: actor.id,
          name: actor.name,
          img: actor.img,
          level,
          xp: Math.max(0, Math.trunc(Number(actor.system?.details?.xp?.value ?? 0))),
          xpRequired: Number(actor.system?.details?.xp?.max ?? 0),
          created,
          hasDraft,
          granted,
          pendingEpicBoon,
          levelUpEligible,
          epicBoonEligible,
          disabled: !selectable,
          disabledReason,
          status,
          search: actor.name.toLowerCase()
        };
      });
    return {
      mode,
      milestone: mode === "milestone",
      xpMode: mode === "xp",
      epicBoonEnabled,
      actors,
      busy: this.busy
    };
  }

  _onRender() {
    const root = this.element;
    root.querySelector('[data-action="close"]')?.addEventListener("click", () => this.close());
    root.querySelector('[data-action="select-all"]')?.addEventListener("click", event => this.#selectAll(event));
    root.querySelector('[data-action="clear-selection"]')?.addEventListener("click", event => this.#clear(event));
    root.querySelector('[data-action="current-scene"]')?.addEventListener("click", event => this.#selectCurrentScene(event));
    root.querySelector('[data-action="apply"]')?.addEventListener("click", event => this.#applyProgression(event));
    root.querySelector('[data-action="grant-epic-boon"]')?.addEventListener("click", event => this.#grantEpicBoons(event));
    root.querySelector('[data-character-search]')?.addEventListener("input", event => this.#filter(event));
    root.querySelector('[name="totalXp"]')?.addEventListener("input", () => this.#refreshPreview());
    root.querySelectorAll('[name="actorIds"]').forEach(input => input.addEventListener("change", () => this.#refreshPreview()));
    this.#refreshPreview();
  }

  #selectedRows() {
    return [...this.element.querySelectorAll('[data-actor-row]')]
      .filter(row => row.querySelector('[name="actorIds"]:checked:not(:disabled)'));
  }

  #selectedActors(kind) {
    const dataKey = kind === "epicBoon" ? "epicBoonEligible" : "levelUpEligible";
    return this.#selectedRows()
      .filter(row => row.dataset[dataKey] === "true")
      .map(row => game.actors.get(row.dataset.actorId))
      .filter(Boolean);
  }

  #visibleSelectableInputs() {
    return [...this.element.querySelectorAll('[data-actor-row]:not([hidden]) [name="actorIds"]:not(:disabled)')];
  }

  #selectAll(event) {
    event.preventDefault();
    for (const input of this.#visibleSelectableInputs()) input.checked = true;
    this.#refreshPreview();
  }

  #clear(event) {
    event.preventDefault();
    for (const input of this.element.querySelectorAll('[name="actorIds"]')) input.checked = false;
    this.#refreshPreview();
  }

  #selectCurrentScene(event) {
    event.preventDefault();
    const sceneActorIds = new Set((canvas?.scene?.tokens ?? []).map(token => token.actorId).filter(Boolean));
    for (const input of this.element.querySelectorAll('[name="actorIds"]')) {
      input.checked = !input.disabled && sceneActorIds.has(input.value);
    }
    this.#refreshPreview();
  }

  #filter(event) {
    const query = String(event.currentTarget.value ?? "").trim().toLowerCase();
    for (const row of this.element.querySelectorAll('[data-actor-row]')) {
      row.hidden = Boolean(query && !String(row.dataset.search ?? "").includes(query));
    }
  }

  #refreshPreview() {
    const progressionActors = this.#selectedActors("levelUp");
    const boonActors = this.#selectedActors("epicBoon");
    const countNode = this.element.querySelector('[data-selected-count]');
    if (countNode) countNode.textContent = String(progressionActors.length);

    const totalInput = this.element.querySelector('[name="totalXp"]');
    const preview = ProgressionToolService.previewXp(totalInput?.value ?? 0, progressionActors.length);
    for (const [key, value] of Object.entries({
      xpPerActor: preview.xpPerActor,
      totalDistributed: preview.totalDistributed,
      remainder: preview.remainder
    })) {
      const node = this.element.querySelector(`[data-${key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}]`);
      if (node) node.textContent = Number(value).toLocaleString();
    }

    const progressionIds = new Set(progressionActors.map(actor => actor.id));
    for (const row of this.element.querySelectorAll('[data-actor-row]')) {
      const actorId = row.dataset.actorId;
      const award = progressionIds.has(actorId) ? preview.xpPerActor : 0;
      const current = Number(row.dataset.currentXp ?? 0);
      const awardNode = row.querySelector('[data-actor-award]');
      const resultNode = row.querySelector('[data-actor-result]');
      if (awardNode) awardNode.textContent = `+${award.toLocaleString()}`;
      if (resultNode) resultNode.textContent = (current + award).toLocaleString();
    }

    const apply = this.element.querySelector('[data-action="apply"]');
    if (apply) {
      const xpMode = this.element.querySelector(".cb-tool-shell")?.dataset.mode === "xp";
      apply.disabled = this.busy || progressionActors.length === 0 || (xpMode && preview.xpPerActor <= 0);
    }
    const boon = this.element.querySelector('[data-action="grant-epic-boon"]');
    if (boon) boon.disabled = this.busy || boonActors.length === 0;
  }

  async #applyProgression(event) {
    event.preventDefault();
    if (this.busy) return;
    const actors = this.#selectedActors("levelUp");
    if (!actors.length) return ui.notifications.warn("Select at least one character eligible for this progression action.");

    const xpMode = this.element.querySelector(".cb-tool-shell")?.dataset.mode === "xp";
    const totalXp = Math.trunc(Number(this.element.querySelector('[name="totalXp"]')?.value ?? 0));
    const preview = ProgressionToolService.previewXp(totalXp, actors.length);
    if (xpMode && preview.xpPerActor <= 0) return ui.notifications.warn("Enter enough XP to grant at least 1 XP to every selected eligible character.");

    const content = xpMode
      ? `<p>Distribute <strong>${preview.xpPerActor.toLocaleString()} XP</strong> to each of <strong>${actors.length}</strong> eligible characters?</p><p>Total distributed: ${preview.totalDistributed.toLocaleString()} XP.<br>Unassigned remainder: ${preview.remainder.toLocaleString()} XP.</p>`
      : `<p>Grant one Level Up to <strong>${actors.length}</strong> selected eligible character${actors.length === 1 ? "" : "s"}?</p>`;
    const confirmed = await this.#confirm({
      title: xpMode ? "Confirm XP Distribution" : "Confirm Level Up Grants",
      content,
      yes: xpMode ? "Distribute XP" : "Grant Level Ups"
    });
    if (!confirmed) return;

    await this.#runBatch(async () => xpMode
      ? ProgressionToolService.distributeXp(actors, totalXp)
      : ProgressionToolService.grantLevelUps(actors), { xpMode });
  }

  async #grantEpicBoons(event) {
    event.preventDefault();
    if (this.busy) return;
    const actors = this.#selectedActors("epicBoon");
    if (!actors.length) return ui.notifications.warn("Select at least one eligible level 20 character.");

    const names = actors.map(actor => `<li>${foundry.utils.escapeHTML(actor.name)}</li>`).join("");
    const confirmed = await this.#confirm({
      title: "Confirm Epic Boon Grants",
      content: `<p>Are you sure you want to grant an Epic Boon to <strong>${actors.length}</strong> selected eligible character${actors.length === 1 ? "" : "s"}?</p><ul>${names}</ul>`,
      yes: "Grant Epic Boons"
    });
    if (!confirmed) return;

    await this.#runBatch(() => ProgressionToolService.grantEpicBoons(actors), { epicBoon: true });
  }

  async #runBatch(operation, { xpMode = false, epicBoon = false } = {}) {
    this.busy = true;
    let refreshAfter = false;
    this.#setBusy(true);
    try {
      const result = await operation();
      const successes = result.results.filter(row => row.ok).length;
      const failures = result.results.filter(row => !row.ok);
      const summary = result.results.map(row => `${row.ok ? "✓" : "✗"} ${row.name}: ${row.message}`).join("\n");
      if (failures.length) {
        ui.notifications.warn(`${successes} character(s) updated; ${failures.length} failed. See console for details.`, { permanent: true });
        console.warn(`${MODULE_ID} | Character Builder Tool partial result\n${summary}`, result);
      } else if (epicBoon) {
        ui.notifications.info(`Granted an Epic Boon to ${successes} character(s).`);
      } else {
        ui.notifications.info(xpMode
          ? `Distributed ${result.xpPerActor.toLocaleString()} XP to ${successes} character(s).`
          : `Granted Level Up to ${successes} character(s).`);
      }
      refreshAfter = true;
    } catch (error) {
      console.error(`${MODULE_ID} | Character Builder Tool failed.`, error);
      ui.notifications.error(error.message, { permanent: true });
    } finally {
      this.busy = false;
      this.#setBusy(false);
      if (refreshAfter) await this.render({ force: true });
    }
  }

  #setBusy(busy) {
    this.element?.classList.toggle("busy", busy);
    this.element?.querySelectorAll("button, input, select").forEach(control => {
      if (busy) control.dataset.cbWasDisabled = control.disabled ? "true" : "false";
      control.disabled = busy || control.dataset.cbWasDisabled === "true";
      if (!busy) delete control.dataset.cbWasDisabled;
    });
  }

  async #confirm({ title, content, yes }) {
    const DialogV2 = foundry.applications.api.DialogV2;
    if (DialogV2?.confirm) {
      return DialogV2.confirm({
        window: { title }, content,
        yes: { label: yes, icon: "fa-solid fa-check" },
        no: { label: "Cancel", icon: "fa-solid fa-xmark" }
      });
    }
    return Dialog.confirm({ title, content, yes: () => true, no: () => false, defaultYes: false });
  }
}
