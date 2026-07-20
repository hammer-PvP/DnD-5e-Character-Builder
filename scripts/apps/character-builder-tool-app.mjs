import { MODULE_ID } from "../constants.mjs";
import { LevelUpService } from "../services/level-up-service.mjs";
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
        const disabledReason = !created
          ? "Complete Character Creation first."
          : level >= 20
            ? "Character is already level 20."
            : mode === "milestone" && (hasDraft || hpLocked)
              ? "Finish or reset the pending Level Up first."
              : mode === "milestone" && granted
                ? "Level Up already granted."
                : "";
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
          disabled: Boolean(disabledReason),
          disabledReason,
          search: actor.name.toLowerCase()
        };
      });
    return { mode, milestone: mode === "milestone", xpMode: mode === "xp", actors, busy: this.busy };
  }

  _onRender() {
    const root = this.element;
    root.querySelector('[data-action="close"]')?.addEventListener("click", () => this.close());
    root.querySelector('[data-action="select-all"]')?.addEventListener("click", event => this.#selectAll(event));
    root.querySelector('[data-action="clear-selection"]')?.addEventListener("click", event => this.#clear(event));
    root.querySelector('[data-action="current-scene"]')?.addEventListener("click", event => this.#selectCurrentScene(event));
    root.querySelector('[data-action="apply"]')?.addEventListener("click", event => this.#apply(event));
    root.querySelector('[data-character-search]')?.addEventListener("input", event => this.#filter(event));
    root.querySelector('[name="totalXp"]')?.addEventListener("input", () => this.#refreshPreview());
    root.querySelectorAll('[name="actorIds"]').forEach(input => input.addEventListener("change", () => this.#refreshPreview()));
    this.#refreshPreview();
  }

  #selectedIds() {
    return [...this.element.querySelectorAll('[name="actorIds"]:checked:not(:disabled)')].map(input => input.value);
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
    const selected = this.#selectedIds();
    const count = selected.length;
    const countNode = this.element.querySelector('[data-selected-count]');
    if (countNode) countNode.textContent = String(count);

    const totalInput = this.element.querySelector('[name="totalXp"]');
    const preview = ProgressionToolService.previewXp(totalInput?.value ?? 0, count);
    for (const [key, value] of Object.entries({
      xpPerActor: preview.xpPerActor,
      totalDistributed: preview.totalDistributed,
      remainder: preview.remainder
    })) {
      const node = this.element.querySelector(`[data-${key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}]`);
      if (node) node.textContent = Number(value).toLocaleString();
    }

    for (const row of this.element.querySelectorAll('[data-actor-row]')) {
      const actorId = row.dataset.actorId;
      const award = selected.includes(actorId) ? preview.xpPerActor : 0;
      const current = Number(row.dataset.currentXp ?? 0);
      const awardNode = row.querySelector('[data-actor-award]');
      const resultNode = row.querySelector('[data-actor-result]');
      if (awardNode) awardNode.textContent = `+${award.toLocaleString()}`;
      if (resultNode) resultNode.textContent = (current + award).toLocaleString();
    }

    const apply = this.element.querySelector('[data-action="apply"]');
    if (apply) {
      const xpMode = this.element.querySelector(".cb-tool-shell")?.dataset.mode === "xp";
      apply.disabled = this.busy || count === 0 || (xpMode && preview.xpPerActor <= 0);
    }
  }

  async #apply(event) {
    event.preventDefault();
    if (this.busy) return;
    const actorIds = this.#selectedIds();
    const actors = actorIds.map(id => game.actors.get(id)).filter(Boolean);
    if (!actors.length) return ui.notifications.warn("Select at least one character.");

    const xpMode = this.element.querySelector(".cb-tool-shell")?.dataset.mode === "xp";
    const totalXp = Math.trunc(Number(this.element.querySelector('[name="totalXp"]')?.value ?? 0));
    const preview = ProgressionToolService.previewXp(totalXp, actors.length);
    if (xpMode && preview.xpPerActor <= 0) return ui.notifications.warn("Enter enough XP to grant at least 1 XP to every selected character.");

    const content = xpMode
      ? `<p>Distribute <strong>${preview.xpPerActor.toLocaleString()} XP</strong> to each of <strong>${actors.length}</strong> characters?</p><p>Total distributed: ${preview.totalDistributed.toLocaleString()} XP.<br>Unassigned remainder: ${preview.remainder.toLocaleString()} XP.</p>`
      : `<p>Grant one Level Up to <strong>${actors.length}</strong> selected character${actors.length === 1 ? "" : "s"}?</p>`;
    const confirmed = await this.#confirm({
      title: xpMode ? "Confirm XP Distribution" : "Confirm Level Up Grants",
      content,
      yes: xpMode ? "Distribute XP" : "Grant Level Ups"
    });
    if (!confirmed) return;

    this.busy = true;
    let refreshAfter = false;
    this.#setBusy(true);
    try {
      const result = xpMode
        ? await ProgressionToolService.distributeXp(actors, totalXp)
        : await ProgressionToolService.grantLevelUps(actors);
      const successes = result.results.filter(row => row.ok).length;
      const failures = result.results.filter(row => !row.ok);
      const summary = result.results.map(row => `${row.ok ? "✓" : "✗"} ${row.name}: ${row.message}`).join("\n");
      if (failures.length) {
        ui.notifications.warn(`${successes} character(s) updated; ${failures.length} failed. See console for details.`, { permanent: true });
        console.warn(`${MODULE_ID} | Character Builder Tool partial result\n${summary}`, result);
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
