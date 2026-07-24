import { MODULE_BUILD, MODULE_ID, MODULE_VERSION, defaultSettings } from "./constants.mjs";
import { CharacterBuilderSettingsApp } from "./apps/settings-app.mjs";
import { CharacterBuilderApp } from "./apps/character-builder-app.mjs";
import { CharacterBuilderToolApp } from "./apps/character-builder-tool-app.mjs";
import { LevelUpApp } from "./apps/level-up-app.mjs";
import { LevelUpService } from "./services/level-up-service.mjs";
import { LevelUpDraftManager } from "./services/level-up-draft-manager.mjs";
import { AdvancementChoiceAnnotationService } from "./services/advancement-choice-annotation-service.mjs";
import { ActorCommitService } from "./services/actor-commit-service.mjs";
import { EpicBoonService } from "./services/epic-boon-service.mjs";
import { ClassProgressionGuard } from "./services/class-progression-guard.mjs";
import { RestManagementApp } from "./apps/rest-management-app.mjs";
import { SourceRegistry } from "./services/source-registry.mjs";

let scribeIconPromise = null;

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
      "Configure content sources, Ability Score methods, the Starting Equipment Shop, Level Up availability, Epic Boon grants, multiclassing, and Hit Point advancement."
    ),
    icon: "fa-solid fa-arrow-up-right-dots",
    type: CharacterBuilderSettingsApp,
    restricted: true
  });

  game.keybindings.register(MODULE_ID, "openBuilder", {
    name: "Open Character Builder",
    hint: "Open Character Builder, an available Level Up, or a pending Epic Boon for the currently controlled Player Character Actor.",
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
    epicBoonEligible: actor => EpicBoonService.grantEligibility(actor),
    claimEpicBoon: actor => EpicBoonService.claim(actor),
    openKeeper: (actor, restType = "long", config = {}) => RestManagementApp.launch(actor, restType, config),
    scribeSpell: actor => RestManagementApp.launchScribe(actor),
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

Hooks.on("preCreateItem", (item, data, options) =>
  ClassProgressionGuard.blockDirectCreate(item, data, options)
);

Hooks.on("dnd5e.preAdvancementManagerComplete", (manager, updates, toCreate, toUpdate, toDelete) =>
  ClassProgressionGuard.blockNativeAdvancement(manager, updates, toCreate, toUpdate, toDelete)
);

Hooks.on("dnd5e.preShortRest", (actor, config) => interceptRest(actor, "short", config));
Hooks.on("dnd5e.preLongRest", (actor, config) => interceptRest(actor, "long", config));

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

  if (EpicBoonService.pending(actor)?.available) {
    moduleControls.push({
      action: "cbRevokeEpicBoon",
      label: "Revoke Epic Boon",
      icon: "fa-solid fa-star-half-stroke",
      visible: true,
      onClick: async () => {
        try {
          await EpicBoonService.revoke(actor);
          ui.notifications.info(`Pending Epic Boon revoked for ${actor.name}.`);
          await app.render({ force: true });
        } catch (error) {
          console.error(`${MODULE_ID} | Revoke Epic Boon failed.`, error);
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
      window: { title, modal: true },
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

  const progressionControls = sheetProgressionContainer(root);
  progressionControls?.classList.toggle("cb-sheet-control-grid", actor.isOwner && actor.items.some(item => item.type === "class"));
  if (isCreationEligible(actor)) injectCreationButton(actor, root);
  else if (actor.isOwner && actor.items.some(item => item.type === "class")) injectLevelUpButton(actor, root);
  replaceNativeClassEntryControls(actor, root);
  injectScribeSpellButton(actor, root);
  injectCantripAugmentAnnotations(actor, root);
  injectInvocationTargetAnnotations(actor, root);
  injectAdvancementChoiceAnnotations(actor, root);
}

function interceptRest(actor, restType, config = {}) {
  if (config?.characterBuilderRestBypass) return true;
  if (!actor || actor.type !== "character") return true;
  if (actor.getFlag(MODULE_ID, "isDraft") || actor.getFlag(MODULE_ID, "isLevelUpDraft")) return true;
  if (!actor.isOwner) return true;
  if (actor.getFlag(MODULE_ID, "runtimeManagementSafetyLock")) {
    ui.notifications.error("Character Keeper is safety-locked for this Actor. A GM must inspect the previous failed transaction before another rest.", { permanent: true });
    return false;
  }
  void RestManagementApp.launch(actor, restType, config ?? {}).catch(error => {
    console.error(`${MODULE_ID} | Character Keeper could not start.`, error);
    ui.notifications.error(error.message);
  });
  return false;
}

function injectScribeSpellButton(actor, root) {
  const container = sheetProgressionContainer(root);
  if (!container) return;
  const existing = container.querySelector(".cb-scribe-spell-sheet-button");
  const wizard = actor.items.find(item => item.type === "class" && item.system?.identifier === "wizard");
  const settings = LevelUpService.settings();
  if (!actor.isOwner || !wizard || settings.allowSpellScrollScribing === false) {
    existing?.remove();
    return;
  }
  const longRest = container.querySelector('[data-action="rest"][data-type="long"]');
  if (!longRest) {
    existing?.remove();
    return;
  }
  let button = existing;
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "cb-scribe-spell-sheet-button gold-button";
    button.innerHTML = '<img class="cb-scribe-spell-sheet-icon" src="systems/dnd5e/icons/svg/ink-pot.svg" alt="" draggable="false" inert>';
    button.dataset.tooltip = "Scribe Spell to Spellbook";
    button.setAttribute("aria-label", "Scribe Spell to Spellbook");
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await RestManagementApp.launchScribe(actor);
      } catch (error) {
        console.error(`${MODULE_ID} | Scribe Spell could not open.`, error);
        ui.notifications.error(error.message);
      }
    });
    container.append(button);
  }
  void resolveScribeSpellIcon().then(src => {
    const icon = button?.querySelector?.(".cb-scribe-spell-sheet-icon");
    if (icon && src) icon.src = src;
  });
}

async function resolveScribeSpellIcon() {
  scribeIconPromise ??= (async () => {
    try {
      const registry = new SourceRegistry();
      await registry.load();
      const options = registry.optionsForKey("spell", "comprehend-languages");
      return options.find(option => option.sourceId === "phb2024")?.img
        ?? options.find(option => option.sourceId === "srd52")?.img
        ?? options[0]?.img
        ?? "systems/dnd5e/icons/svg/ink-pot.svg";
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not resolve the Scribe Spell placeholder icon.`, error);
      return "systems/dnd5e/icons/svg/ink-pot.svg";
    }
  })();
  return scribeIconPromise;
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

  const settings = LevelUpService.settings();
  const eligibility = LevelUpService.eligibility(actor);
  const pendingEpicBoon = Boolean(settings.enableEpicBoons && EpicBoonService.pending(actor)?.available);
  let button = container.querySelector(".cb-level-up-sheet-button");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "cb-level-up-sheet-button gold-button";
    button.innerHTML = '<i class="fa-solid fa-arrow-up" inert></i>';
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      try {
        if (EpicBoonService.pending(actor)?.available) {
          await openEpicBoon(actor);
          return;
        }
        const current = LevelUpService.eligibility(actor);
        if (!current.ready) return;
        openLevelUp(actor);
      } catch (error) {
        console.error(`${MODULE_ID} | Epic Boon claim failed.`, error);
        ui.notifications.error(error.message, { permanent: true });
      }
    });
    container.append(button);
  }

  const available = pendingEpicBoon || Boolean(eligibility.ready);
  button.disabled = !available;
  button.setAttribute("aria-disabled", available ? "false" : "true");
  button.classList.toggle("available", available && !eligibility.hasDraft);
  button.classList.toggle("has-draft", available && eligibility.hasDraft);
  button.classList.toggle("unavailable", !available);
  button.dataset.tooltip = pendingEpicBoon
    ? "Claim Epic Boon"
    : eligibility.hasDraft
      ? "Resume Level Up"
      : available
        ? `Start Level Up to Character Level ${eligibility.targetLevel}`
        : `Level Up is not currently available. ${eligibility.reason}`;
  button.setAttribute("aria-label", button.dataset.tooltip);
}

function replaceNativeClassEntryControls(actor, root) {
  const classSection = root.querySelector("section.classes");
  if (!classSection) return;

  for (const control of classSection.querySelectorAll('[data-action="findItem"][data-item-type="subclass"]')) {
    control.remove();
  }

  const classControls = [...classSection.querySelectorAll('[data-action="findItem"][data-item-type="class"]')];
  const existingSlot = classSection.querySelector(".cb-start-character-builder-class-slot");
  if (!isCreationEligible(actor)) {
    existingSlot?.remove();
    for (const control of classControls) control.remove();
    return;
  }

  let slot = existingSlot ?? classControls.shift();
  for (const extra of classControls) {
    if (extra !== slot) extra.remove();
  }
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "pill-lg empty roboto-upper";
    classSection.append(slot);
  }
  slot.removeAttribute("data-action");
  slot.removeAttribute("data-item-type");
  slot.classList.add("cb-start-character-builder-class-slot");
  slot.setAttribute("role", "button");
  slot.setAttribute("tabindex", "0");
  const label = actor.getFlag(MODULE_ID, "draftActorId") ? "Resume Character Builder" : "Start Character Builder";
  slot.innerHTML = `<i class="fa-solid fa-arrow-up-right-dots" inert></i><span>${label}</span>`;
  slot.dataset.tooltip = label;
  slot.setAttribute("aria-label", label);
  const activate = event => {
    if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    openBuilder(actor);
  };
  slot.onclick = activate;
  slot.onkeydown = activate;
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
  if (LevelUpService.settings().enableEpicBoons && EpicBoonService.pending(actor)?.available) return openEpicBoon(actor);
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

async function openEpicBoon(actor) {
  if (!LevelUpService.settings().enableEpicBoons) {
    return ui.notifications.warn("Epic Boons are disabled by the Game Master.");
  }
  if (!EpicBoonService.pending(actor)?.available) {
    return ui.notifications.warn("This Actor has no pending Epic Boon.");
  }
  return EpicBoonService.claim(actor);
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
    window: { title: "Create Player Character", modal: true },
    content,
    buttons: [
      { action: "builder", label: "Use Character Builder", icon: "fa-solid fa-arrow-up-right-dots" },
      { action: "defaults", label: "Use Foundry Defaults", icon: "fa-solid fa-file-pen" }
    ],
    default: "builder"
  });
  if (result === "builder") openBuilder(actor);
}
