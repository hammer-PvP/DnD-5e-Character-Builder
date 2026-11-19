import { activeWarcraft, sourceOf } from "./warcraft-progression-service.mjs";

const prefix = "Compendium.dnd-world-warcraft.origins.Item.";
const manualClick = new WeakSet();
const startingAuto = new WeakSet();
const autoActors = new WeakSet();
const dialogs = new WeakSet();

function forThisEvent(set, actor) {
  if (!actor) return;
  set.add(actor);
  queueMicrotask(() => set.delete(actor));
}

export function adjustRestDie(config) {
  if (!activeWarcraft() || !config?.characterBuilderShortRest || !config.subject?.items) return;
  const sources = new Set(config.subject.items.map(sourceOf));
  const parts = config.rolls?.[0]?.parts;
  const faces = /^d(\d+)$/.exec(config.denomination)?.[1];
  if (!faces || typeof parts?.[0] !== "string") return;
  if (sources.has(prefix + "wowsptTrollHeali")) {
    parts[0] = parts[0].replace(new RegExp("\\b1d" + faces + "\\b", "i"), "1d" + faces + "min" + faces);
  }
  const bonus = ["wowsptInnerPeace", "wowsptQuietConte"].filter(id => sources.has(prefix + id)).length;
  if (bonus) parts.push(String(bonus));
  delete config.characterBuilderShortRest;
}

export function registerRestDice(api, moduleId) {
  Hooks.on("renderShortRestDialog", (app, element) => {
    const root = element?.[0] ?? element;
    if (!root?.addEventListener || dialogs.has(root)) return;
    dialogs.add(root);
    root.addEventListener("click", event => {
      if (event.target?.closest?.('[data-action="rollHitDie"]')) forThisEvent(manualClick, app.actor);
    }, true);
  });
  Hooks.on("dnd5e.shortRest", (actor, config) => { if (config.autoHD) forThisEvent(startingAuto, actor); });
  api.register(moduleId, "dnd5e.documents.Actor5e.prototype.autoSpendHitDice", async function (wrapped, ...args) {
    if (!startingAuto.delete(this)) return wrapped(...args);
    autoActors.add(this);
    try { return await wrapped(...args); } finally { autoActors.delete(this); }
  }, "WRAPPER");
  api.register(moduleId, "dnd5e.documents.Actor5e.prototype.rollHitDie", function (wrapped, ...args) {
    if (manualClick.delete(this) || (!args.length && autoActors.has(this))) {
      args[0] = { ...args[0], characterBuilderShortRest: true };
    }
    return wrapped(...args);
  }, "WRAPPER");
  Hooks.on("dnd5e.preRollHitDie", adjustRestDie);
}
