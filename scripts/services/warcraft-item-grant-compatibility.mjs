// Warcraft 1.0.0 registers this listener for every ItemGrantFlow render, including
// inherited render events for advancements whose configuration has no item list.
export function guardWarcraftItemGrantRender() {
  if (game.modules.get("dnd-world-warcraft")?.version !== "1.0.0") return;
  const event = "renderItemGrantFlow";
  const matches = (Hooks.events[event] ?? []).filter(({ fn }) =>
    fn?.name === "renderItemGrantFlow" && Function.prototype.toString.call(fn).includes("advancement.configuration.items.find(i => i.uuid === PET_SPECIALIZATION)"));
  if (matches.length !== 1) return;
  const { fn, id } = matches[0];
  Hooks.off(event, id);
  Hooks.on(event, (app, ...args) => {
    if (typeof app.advancement?.configuration?.items?.find === "function") return fn(app, ...args);
  });
}
