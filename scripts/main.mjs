import { MODULE_BUILD, MODULE_ID, MODULE_VERSION, defaultSettings } from "./constants.mjs";
import { CharacterBuilderSettingsApp } from "./apps/settings-app.mjs";
import { CharacterBuilderApp } from "./apps/character-builder-app.mjs";
import { CharacterBuilderToolApp } from "./apps/character-builder-tool-app.mjs";
import { LevelUpApp } from "./apps/level-up-app.mjs";
import { LevelUpService } from "./services/level-up-service.mjs";
import { LevelUpDraftManager } from "./services/level-up-draft-manager.mjs";
import { AdvancementChoiceAnnotationService } from "./services/advancement-choice-annotation-service.mjs";
import { ActorCommitService } from "./services/actor-commit-service.mjs";

Hooks.once("init", async () => {
  if (!Handlebars.helpers.eq) Handlebars.registerHelper("eq", (a, b) => a === b);
  if (!Handlebars.helpers.gt) Handlebars.registerHelper("gt", (a, b) => Number(a) > Number(b));
  if (!Handlebars.helpers.add) Handlebars.registerHelper("add", (a, b) => Number(a) + Number(b));
  if (!Handlebars.helpers.concat) Handlebars.registerHelper("concat", (...values) => values.slice(0, -1).join(""));
  await loadTemplates([
    `modules/${MODULE_ID}/templates/partials/source-preview.hbs`,
    `modules/${MODULE_ID}/templates/partials/pact-of-the-tome-selection.hbs`
  ]);

  game.settings.register(MODULE_ID, "settings", {
    scope: "world",
    config: false,
    type: Object,
    default: defaultSettings()
  });

  game.settings.register(MODULE_ID, "progressionBatchLedger", {
    scope: "world",
    config: false,
    type: Object,
    default: { entries: [] }
  });

  const localizedSettingText = (key, fallback) => {
    const localized = game.i18n.localize(key);
    return localized && localized !== key ? localized : fallback;
  };

  game.settings.registerMenu(MODULE_ID, "configuration", {
    name: localizedSettingText("CB.Settings.Title", "Character Builder Settings"),
    label: localizedSettingText("CB.Settings.Button", "Configure Character Builder"),
    hint: localizedSettingText(
      "CB.Settings.Hint",
      "Configure content sources, Ability Score methods, the Starting Equipment Shop, Level Up availability, multiclassing, and Hit Point advancement."
    ),
    icon: "fa-solid fa-arrow-up-right-dots",
    type: CharacterBuilderSettingsApp,
    restricted: true
  });

  game.keybindings.register(MODULE_ID, "openBuilder", {
    name: "Open Character Builder",
    hint: "Open Character Builder or an available Level Up for the currently controlled Player Character Actor.",
    editable: [{ key: "KeyB", modifiers: ["CONTROL", "SHIFT"] }],
    restricted: false,
    onDown: () => {
      const actor = canvas?.tokens?.controlled?.[0]?.actor;
      if (!actor) {
        ui.notifications.warn("Control a Player Character token before using this shortcut.");
        return false;
      }
      openForActor(actor);
      return true;
    }
  });

  game.characterBuilder = {
    open: actor => openForActor(actor),
    eligible: actor => isCreationEligible(actor),
    levelUpEligible: actor => LevelUpService.eligibility(actor),
    openTool: () => game.user.isGM ? new CharacterBuilderToolApp().render({ force: true }) : null
  };
});

Hooks.once("ready", async () => {
  console.info(`Character Builder ${MODULE_VERSION} (${MODULE_BUILD}) loaded.`);
  if (game.system.id !== "dnd5e") {
    ui.notifications.error("Character Builder requires the D&D5e system.");
    return;
  }
  if (game.system.version !== "5.3.3" && game.user.isGM) {
    ui.notifications.warn(`Character Builder ${MODULE_VERSION} was validated against D&D5e 5.3.3. Detected ${game.system.version}.`);
  }
  await ActorCommitService.recoverOwnedInterruptedTransactions();
  const settings = LevelUpService.settings();
  if (game.user.isGM && settings.sources?.some(source => source.id === "srd51" && source.enabled)) {
    ui.notifications.warn("SRD 5.1 Legacy is enabled, but this beta officially supports only D&D 2024 and SRD 5.2 Modern.");
  }
  if (game.user.isGM) {
    for (const actor of game.actors.filter(candidate => candidate.type === "character"
      && !candidate.getFlag(MODULE_ID, "isDraft")
      && !candidate.getFlag(MODULE_ID, "isLevelUpDraft"))) {
      try {
        await AdvancementChoiceAnnotationService.migrateActor(actor);
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not migrate Level Up badges for ${actor.name}.`, error);
      }
    }
  }
});

Hooks.on("createActor", async (actor, _options, userId) => {
  if (userId !== game.user.id || !isCreationEligible(actor)) return;
  const settings = foundry.utils.mergeObject(defaultSettings(), game.settings.get(MODULE_ID, "settings") ?? {}, {
    inplace: false
  });
  if (!settings.promptOnCreate) return;
  setTimeout(() => promptCreationMode(actor), 250);
});

Hooks.on("renderApplicationV2", (app, element) => {
  if (isActorDirectoryApp(app)) injectActorDirectoryTool(app, element);
  if (isCharacterActorSheet(app)) renderCharacterActorSheetControls(app, element);
});

Hooks.on("renderActorDirectory", (app, html) => injectActorDirectoryTool(app, html));

// Retain a small compatibility fallback for any legacy Actor sheet selected by the world.
Hooks.on("renderActorSheet", (app, html) => {
  if (isCharacterActorSheet(app)) return;
  const actor = app.actor ?? app.document;
  if (!actor || actor.type !== "character") return;
  const root = html instanceof HTMLElement ? html : html?.[0] ?? app.element;
  if (!root) return;
  renderCharacterActorSheetControls(app, root);
});

Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  if (!isCharacterActorSheet(app) || !game.user.isGM) return;
  const actor = app.actor ?? app.document;
  if (!actor || actor.type !== "character" || actor.getFlag(MODULE_ID, "isDraft") || actor.getFlag(MODULE_ID, "isLevelUpDraft")) return;

  const settings = LevelUpService.settings();
  const eligibility = LevelUpService.eligibility(actor);
  const hasPending = eligibility.hasDraft || Boolean(actor.getFlag(MODULE_ID, "levelUpHitPointRoll"));
  const hasClass = actor.items.some(item => item.type === "class");
  const belowLevelCap = LevelUpService.actorLevel(actor) < 20;
  const moduleControls = [];

  if (settings.levelUpMode === "milestone" && hasClass && belowLevelCap) {
    const granted = Boolean(actor.getFlag(MODULE_ID, "levelUpGrant")?.available);
    moduleControls.push({
      action: "cbToggleLevelUpGrant",
      label: granted ? "Revoke Level Up" : "Grant Level Up",
      icon: granted ? "fa-solid fa-arrow-rotate-left" : "fa-solid fa-arrow-up",
      visible: true,
      disabled: hasPending,
      onClick: async () => {
        try {
          if (hasPending) {
            ui.notifications.warn("Finish or reset the pending Level Up before changing its GM grant.");
            return;
          }
          if (actor.getFlag(MODULE_ID, "levelUpGrant")?.available) {
            await LevelUpService.revoke(actor);
            ui.notifications.info(`Level Up revoked for ${actor.name}.`);
          } else {
            await LevelUpService.grant(actor);
            ui.notifications.info(`Level Up granted to ${actor.name}.`);
          }
          await app.render({ force: true });
        } catch (error) {
          console.error(`${MODULE_ID} | Grant Level Up failed.`, error);
          ui.notifications.error(error.message);
        }
      }
    });
  }

  if (hasPending) {
    moduleControls.push({
      action: "cbResetPendingLevelUp",
      label: "Reset Pending Level Up",
      icon: "fa-solid fa-rotate-left",
      visible: true,
      onClick: async () => {
        try {
          const confirmed = await confirmAction({
            title: "Reset Pending Level Up",
            content: `<p>Delete the pending Level Up for <strong>${foundry.utils.escapeHTML(actor.name)}</strong>, including its locked Hit Die result and every draft choice?</p>`,
            yes: "Reset Level Up"
          });
          if (!confirmed) return;
          await LevelUpDraftManager.discard(actor, { gmReset: true });
          ui.notifications.info(`Pending Level Up reset for ${actor.name}.`);
          await app.render({ force: true });
        } catch (error) {
          console.error(`${MODULE_ID} | Reset Pending Level Up failed.`, error);
          ui.notifications.error(error.message);
        }
      }
    });
  }

  if (moduleControls.length) controls.unshift(...moduleControls);
});

async function confirmAction({ title, content, yes }) {
  const DialogV2 = foundry.applications.api.DialogV2;
  if (DialogV2?.confirm) {
    return DialogV2.confirm({
      window: { title },
      content,
      yes: { label: yes, icon: "fa-solid fa-check" },
      no: { label: "Cancel", icon: "fa-solid fa-xmark" }
    });
  }
  return new Promise(resolve => {
    new Dialog({
      title, content,
      buttons: {
        yes: { label: yes, callback: () => resolve(true) },
        no: { label: "Cancel", callback: () => resolve(false) }
      },
      default: "no",
      close: () => resolve(false)
    }).render(true);
  });
}

function isCharacterActorSheet(app) {
  const actor = app?.actor ?? app?.document;
  if (!actor || actor.type !== "character") return false;
  const classes = app?.options?.classes ?? [];
  const ApplicationV2 = foundry.applications.api.ApplicationV2;
  const isV2 = ApplicationV2 ? app instanceof ApplicationV2 : false;
  return app.constructor?.name === "CharacterActorSheet"
    || (isV2 && classes.includes("actor") && classes.includes("character"));
}

function renderCharacterActorSheetControls(app, element) {
  const actor = app.actor ?? app.document;
  if (!actor || actor.type !== "character" || actor.getFlag(MODULE_ID, "isDraft") || actor.getFlag(MODULE_ID, "isLevelUpDraft")) return;
  const root = element instanceof HTMLElement ? element : element?.[0] ?? app.element;
  if (!root) return;

  if (isCreationEligible(actor)) injectCreationButton(actor, root);
  else if (actor.isOwner && actor.items.some(item => item.type === "class")) injectLevelUpButton(actor, root);
  injectCantripAugmentAnnotations(actor, root);
  injectInvocationTargetAnnotations(actor, root);
  injectAdvancementChoiceAnnotations(actor, root);
}

function findSheetHeader(root) {
  if (root.matches?.(".sheet-header")) return root;
  return root.querySelector?.(".sheet-header") ?? null;
}

function sheetProgressionContainer(root) {
  const header = findSheetHeader(root);
  if (!header) return null;
  const existing = header.querySelector(".sheet-header-buttons");
  if (existing) return existing;
  const rightColumn = header.querySelector(":scope > .right > div:last-child") ?? header.querySelector(".right");
  if (!rightColumn) return null;
  const container = document.createElement("div");
  container.className = "sheet-header-buttons cb-sheet-header-buttons-fallback";
  rightColumn.prepend(container);
  return container;
}

function injectCreationButton(actor, root) {
  const container = sheetProgressionContainer(root);
  if (!container) return;
  container.querySelector(".cb-level-up-sheet-button")?.remove();
  container.classList.add("cb-start-slot-active");
  let button = container.querySelector(".cb-start-sheet-button");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "cb-start-sheet-button gold-button cb-proc-button";
    button.innerHTML = '<i class="fa-solid fa-arrow-up-right-dots" inert></i>';
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openBuilder(actor);
    });
    container.append(button);
  }
  button.dataset.tooltip = actor.getFlag(MODULE_ID, "draftActorId") ? "Resume Character Builder" : "Start Character Builder";
  button.setAttribute("aria-label", button.dataset.tooltip);
}

function injectLevelUpButton(actor, root) {
  const container = sheetProgressionContainer(root);
  if (!container) return;
  container.querySelector(".cb-start-sheet-button")?.remove();
  container.classList.remove("cb-start-slot-active");

  const eligibility = LevelUpService.eligibility(actor);
  let button = container.querySelector(".cb-level-up-sheet-button");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "cb-level-up-sheet-button gold-button";
    button.innerHTML = '<i class="fa-solid fa-arrow-up" inert></i>';
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const current = LevelUpService.eligibility(actor);
      if (!current.ready) return;
      openLevelUp(actor);
    });
    container.append(button);
  }

  const available = Boolean(eligibility.ready);
  button.disabled = !available;
  button.setAttribute("aria-disabled", available ? "false" : "true");
  button.classList.toggle("available", available && !eligibility.hasDraft);
  button.classList.toggle("has-draft", available && eligibility.hasDraft);
  button.classList.toggle("unavailable", !available);
  button.dataset.tooltip = eligibility.hasDraft
    ? "Resume Level Up"
    : available
      ? `Start Level Up to Character Level ${eligibility.targetLevel}`
      : `Level Up is not currently available. ${eligibility.reason}`;
  button.setAttribute("aria-label", button.dataset.tooltip);
}

function injectCantripAugmentAnnotations(actor, root) {
  for (const item of actor.items.filter(candidate => candidate.type === "spell")) {
    const augments = item.getFlag(MODULE_ID, "eldritchInvocationAugments") ?? [];
    if (!augments.length) continue;
    const escapedId = globalThis.CSS?.escape ? CSS.escape(item.id) : item.id;
    const row = root.querySelector?.(`[data-item-id="${escapedId}"]`);
    if (!row || row.querySelector(".cb-eldritch-augment")) continue;
    const badge = document.createElement("span");
    badge.className = "cb-eldritch-augment";
    const names = augments.map(entry => entry.name).filter(Boolean);
    badge.dataset.tooltip = `Augmented by: ${names.join(", ")}`;
    badge.innerHTML = `<i class="fa-solid fa-wand-sparkles" inert></i> Augmented: ${foundry.utils.escapeHTML(names.join(", "))}`;
    const destination = row.querySelector(".item-name, .name, .item-summary") ?? row;
    destination.append(badge);
  }
}

function injectInvocationTargetAnnotations(actor, root) {
  for (const item of actor.items) {
    const data = item.getFlag(MODULE_ID, "invocationInstance");
    if (!data?.targetCantripName) continue;
    const escapedId = globalThis.CSS?.escape ? CSS.escape(item.id) : item.id;
    const row = root.querySelector?.(`[data-item-id="${escapedId}"]`);
    if (!row || row.querySelector(".cb-invocation-target-badge")) continue;
    const badge = document.createElement("span");
    badge.className = "cb-invocation-target-badge cb-advancement-choice-badge";
    badge.dataset.tooltip = `${item.name} target: ${data.targetCantripName}`;
    badge.innerHTML = `<i class="fa-solid fa-bullseye" inert></i> Target: ${foundry.utils.escapeHTML(data.targetCantripName)}`;
    const destination = row.querySelector(".item-name, .name, .item-summary") ?? row;
    destination.append(badge);
  }
}

function injectAdvancementChoiceAnnotations(actor, root) {
  for (const item of actor.items) {
    const escapedId = globalThis.CSS?.escape ? CSS.escape(item.id) : item.id;
    const row = root.querySelector?.(`[data-item-id="${escapedId}"]`);
    if (!row) continue;
    row.querySelector(".cb-advancement-choice-badges")?.remove();

    const badges = AdvancementChoiceAnnotationService.getBadges(item);
    if (!badges.length) continue;
    const group = document.createElement("span");
    group.className = "cb-advancement-choice-badges";
    for (const data of badges) {
      const badge = document.createElement("span");
      badge.className = `cb-advancement-choice-badge cb-badge-${data.kind ?? "choice"}`;
      badge.dataset.tooltip = data.tooltip ?? data.label;
      const icon = document.createElement("i");
      icon.className = data.icon ?? "fa-solid fa-tag";
      icon.setAttribute("inert", "");
      badge.append(icon, document.createTextNode(data.label));
      group.append(badge);
    }
    const destination = row.querySelector(".item-name, .name, .item-summary") ?? row;
    destination.append(group);
  }
}

function isActorDirectoryApp(app) {
  const name = String(app?.constructor?.name ?? "");
  const classes = app?.options?.classes ?? [];
  return name.includes("ActorDirectory")
    || name.includes("ActorsDirectory")
    || (app?.collection === game.actors)
    || (classes.includes("directory") && classes.includes("actors"));
}

function injectActorDirectoryTool(_app, element) {
  if (!game.user.isGM) return;
  const root = element instanceof HTMLElement ? element : element?.[0] ?? _app?.element;
  if (!root || root.querySelector(".cb-actor-directory-tool")) return;
  const header = root.querySelector(".directory-header") ?? root.querySelector("header");
  if (!header) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cb-actor-directory-tool";
  button.innerHTML = '<i class="fa-solid fa-arrow-up-right-dots" inert></i><span>Character Builder Tool</span>';
  button.dataset.tooltip = "Open the GM Character Builder progression tool";
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    new CharacterBuilderToolApp().render({ force: true });
  });
  const actions = header.querySelector(".header-actions, .action-buttons") ?? header;
  actions.append(button);
}

function isCreationEligible(actor) {
  if (!actor || actor.type !== "character" || !actor.isOwner) return false;
  if (actor.getFlag(MODULE_ID, "isDraft") || actor.getFlag(MODULE_ID, "isLevelUpDraft")) return false;
  if (actor.getFlag(MODULE_ID, "commitSafetyLock") || actor.getFlag(MODULE_ID, "creationTransaction")) return false;
  return !actor.items.some(item => item.type === "class") || Boolean(actor.getFlag(MODULE_ID, "draftActorId"));
}

function openForActor(actor) {
  if (isCreationEligible(actor)) return openBuilder(actor);
  const eligibility = LevelUpService.eligibility(actor);
  if (eligibility.ready) return openLevelUp(actor);
  return ui.notifications.warn(eligibility.reason || "Character Builder is not currently available for this Actor.");
}

function openBuilder(actor) {
  if (!actor || actor.type !== "character") return ui.notifications.error("Character Builder can only be used with Player Character Actors.");
  if (!actor.isOwner) return ui.notifications.error("You do not own this Actor.");
  if (actor.getFlag(MODULE_ID, "commitSafetyLock")) return ui.notifications.error("Character Builder is locked for this Actor because a protected transaction could not be restored. Ask the GM to inspect the preserved backup.", { permanent: true });
  if (!isCreationEligible(actor)) return ui.notifications.warn("This Actor has already completed level 1 character creation.");
  new CharacterBuilderApp(actor).render({ force: true });
}

function openLevelUp(actor) {
  const eligibility = LevelUpService.eligibility(actor);
  if (!eligibility.ready) return ui.notifications.warn(eligibility.reason);
  new LevelUpApp(actor).render({ force: true });
}

async function promptCreationMode(actor) {
  const content = `
    <div class="character-builder-prompt">
      <p>How would you like to create <strong>${foundry.utils.escapeHTML(actor.name)}</strong>?</p>
    </div>`;

  if (globalThis.Dialog) {
    new Dialog({
      title: "Create Player Character",
      content,
      buttons: {
        builder: {
          icon: '<i class="fa-solid fa-arrow-up-right-dots"></i>',
          label: "Use Character Builder",
          callback: () => openBuilder(actor)
        },
        defaults: {
          icon: '<i class="fa-solid fa-file-pen"></i>',
          label: "Use Foundry Defaults"
        }
      },
      default: "builder"
    }).render(true);
    return;
  }

  const DialogV2 = foundry.applications.api.DialogV2;
  const result = await DialogV2.wait({
    window: { title: "Create Player Character" },
    content,
    buttons: [
      { action: "builder", label: "Use Character Builder", icon: "fa-solid fa-arrow-up-right-dots" },
      { action: "defaults", label: "Use Foundry Defaults", icon: "fa-solid fa-file-pen" }
    ],
    default: "builder"
  });
  if (result === "builder") openBuilder(actor);
}
