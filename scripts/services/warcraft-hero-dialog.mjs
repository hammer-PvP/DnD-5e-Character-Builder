// Wait for the outgoing window to leave the modal stack before starting its successor.
export async function heroDialog(options) {
  let closing;
  const buttons = options.buttons.map(button => ({
    ...button,
    callback(event, target, dialog) {
      if (dialog?.rendered) {
        closing = new Promise(resolve => {
          const hook = Hooks.on("closeApplicationV2", app => {
            if (app !== dialog) return;
            Hooks.off("closeApplicationV2", hook);
            resolve();
          });
        });
      }
      return button.callback ? button.callback(event, target, dialog) : button.action;
    }
  }));
  const result = await foundry.applications.api.DialogV2.wait({ ...options, buttons, rejectClose: false });
  await closing;
  return result;
}

const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
const label = hero => game.i18n.localize(hero.name);

async function heroDescription(hero) {
  const sections = [];
  if (hero.subclass) sections.push("Subclass: @UUID[" + hero.subclass + "]");
  for (const table of [hero.replacedClassFeatures, hero.replacedSubclassFeatures]) {
    for (const [level, swaps] of Object.entries(table ?? {})) {
      for (const [identifier, uuid] of Object.entries(swaps)) {
        sections.push("Level " + level + ": " + escape(identifier.replaceAll("-", " ")) + " → @UUID[" + uuid + "]");
      }
    }
  }
  if (!hero.subclass) sections.unshift("Choose your subclass from the usual options for this class.");
  return foundry.applications.ux.TextEditor.implementation.enrichHTML(sections.map(text => "<p>" + text + "</p>").join(""));
}

export async function confirmWarcraft(hero, { sharedName = "", atSubclass = false } = {}) {
  const buttons = [{ action: "back", label: atSubclass ? "Back to subclasses" : "Back to class options" }];
  if (sharedName) buttons.push({ action: "standard", label: "Keep " + sharedName });
  buttons.push({ action: "apply", label: "Become " + label(hero) });
  return heroDialog({
    window: { title: label(hero) },
    content: "<p>Apply " + escape(label(hero)) + " progression to this character?</p>" + await heroDescription(hero),
    buttons
  });
}
