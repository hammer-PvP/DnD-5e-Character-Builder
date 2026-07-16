import { MODULE_BUILD, MODULE_ID, MODULE_VERSION, defaultSettings } from "./constants.mjs";
import { CharacterBuilderSettingsApp } from "./apps/settings-app.mjs";
import { CharacterBuilderApp } from "./apps/character-builder-app.mjs";
import { LevelUpApp } from "./apps/level-up-app.mjs";
import { LevelUpService } from "./services/level-up-service.mjs";

Hooks.once("init", async () => {
  if (!Handlebars.helpers.eq) Handlebars.registerHelper("eq", (a, b) => a === b);
  if (!Handlebars.helpers.gt) Handlebars.registerHelper("gt", (a, b) => Number(a) > Number(b));
  if (!Handlebars.helpers.add) Handlebars.registerHelper("add", (a, b) => Number(a) + Number(b));
  await loadTemplates([`modules/${MODULE_ID}/templates/partials/source-preview.hbs`]);

  game.settings.register(MODULE_ID, "settings", {
    scope: "world",
    config: false,
    type: Object,
    default: defaultSettings()
  });

  game.settings.registerMenu(MODULE_ID, "configuration", {
    name: "CB.Settings.Title",
    label: "CB.Settings.Button",
    hint: "CB.Settings.Hint",
    icon: "fa-solid fa-person-rays",
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
    levelUpEligible: actor => LevelUpService.eligibility(actor)
  };
});

Hooks.once("ready", () => {
  console.info(`Character Builder ${MODULE_VERSION} (${MODULE_BUILD}) loaded.`);
  if (game.system.id !== "dnd5e") {
    ui.notifications.error("Character Builder requires the D&D5e system.");
    return;
  }
  if (game.system.version !== "5.3.3" && game.user.isGM) {
    ui.notifications.warn(`Character Builder ${MODULE_VERSION} was validated against D&D5e 5.3.3. Detected ${game.system.version}.`);
  }
  const settings = LevelUpService.settings();
  if (game.user.isGM && settings.sources?.some(source => source.id === "srd51" && source.enabled)) {
    ui.notifications.warn("SRD 5.1 Legacy is enabled, but this beta officially supports only D&D 2024 and SRD 5.2 Modern.");
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
  if (!isCharacterActorSheet(app)) return;
  renderCharacterActorSheetControls(app, element);
});

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
  if (settings.levelUpMode !== "milestone") return;
  if (!actor.items.some(item => item.type === "class") || LevelUpService.actorLevel(actor) >= 20) return;

  // Once a Level Up Draft exists, the player must finish or reset that transaction before the grant can be changed.
  const eligibility = LevelUpService.eligibility(actor);
  if (eligibility.hasDraft) return;

  const granted = Boolean(actor.getFlag(MODULE_ID, "levelUpGrant")?.available);
  controls.unshift({
    action: "cbToggleLevelUpGrant",
    label: granted ? "Revoke Level Up" : "Grant Level Up",
    icon: granted ? "fa-solid fa-arrow-rotate-left" : "fa-solid fa-arrow-up",
    visible: true,
    onClick: async () => {
      try {
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
});

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
}

function findSheetHeader(root) {
  if (root.matches?.(".sheet-header")) return root;
  return root.querySelector?.(".sheet-header") ?? null;
}

function injectCreationButton(actor, root) {
  const header = findSheetHeader(root);
  if (!header || header.querySelector(".cb-start-sheet-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cb-start-sheet-button gold-button";
  button.dataset.tooltip = actor.getFlag(MODULE_ID, "draftActorId") ? "Resume Character Builder" : "Start Character Builder";
  button.setAttribute("aria-label", button.dataset.tooltip);
  button.innerHTML = '<i class="fa-solid fa-person-rays" inert></i>';
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    openBuilder(actor);
  });
  insertHeaderButton(header, button);
}

function injectLevelUpButton(actor, root) {
  const header = findSheetHeader(root);
  if (!header) return;

  const eligibility = LevelUpService.eligibility(actor);
  const existing = header.querySelector(".cb-level-up-sheet-button");
  if (!eligibility.ready) {
    existing?.remove();
    return;
  }
  if (existing) return;

  const right = header.querySelector(":scope > .right") ?? header.querySelector(".right");
  if (!right) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "cb-level-up-sheet-button gold-button";
  button.dataset.tooltip = eligibility.hasDraft
    ? "Resume Level Up"
    : `Level Up to Character Level ${eligibility.targetLevel}`;
  button.setAttribute("aria-label", button.dataset.tooltip);
  button.innerHTML = '<i class="fa-solid fa-arrow-up" inert></i>';
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const current = LevelUpService.eligibility(actor);
    if (!current.ready) return ui.notifications.warn(current.reason);
    openLevelUp(actor);
  });
  right.append(button);
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
    badge.dataset.tooltip = `Eldritch Invocation Augmented: ${names.join(", ")}`;
    badge.innerHTML = '<i class="fa-solid fa-wand-sparkles" inert></i> Eldritch Invocation Augmented';
    const destination = row.querySelector(".item-name, .name, .item-summary") ?? row;
    destination.append(badge);
  }
}

function insertHeaderButton(header, button) {
  const levelBadge = header.querySelector(".level-badge");
  if (levelBadge) levelBadge.insertAdjacentElement("afterend", button);
  else header.append(button);
}

function isCreationEligible(actor) {
  if (!actor || actor.type !== "character" || !actor.isOwner) return false;
  if (actor.getFlag(MODULE_ID, "isDraft") || actor.getFlag(MODULE_ID, "isLevelUpDraft")) return false;
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
          icon: '<i class="fa-solid fa-person-rays"></i>',
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
      { action: "builder", label: "Use Character Builder", icon: "fa-solid fa-person-rays" },
      { action: "defaults", label: "Use Foundry Defaults", icon: "fa-solid fa-file-pen" }
    ],
    default: "builder"
  });
  if (result === "builder") openBuilder(actor);
}
