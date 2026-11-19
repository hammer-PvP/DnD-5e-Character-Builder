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

async function confirmHero(hero, description) {
  return await heroDialog({
    window: { title: label(hero) },
    content: "<p>Apply " + escape(label(hero)) + " progression to this character?</p>" + description,
    buttons: [{ action: "back", label: "Back to choices" }, { action: "apply", label: "OK" }]
  }) === "apply";
}

export async function chooseStartingHero(variants) {
  const descriptions = await Promise.all(variants.map(heroDescription));
  const content = variants.map((hero, i) => "<details><summary>" + escape(label(hero))
    + "</summary>" + descriptions[i] + "</details>").join("");
  while (true) {
    const single = variants.length === 1;
    const choice = await heroDialog({
      window: { title: single ? "Start this character as " + label(variants[0]) + "?" : "Choose a Warcraft progression" },
      content,
      buttons: [...variants.map(hero => ({ action: hero.identifier, label: single ? "Yes" : label(hero) })),
        { action: "defer", label: "Not now" }]
    });
    const i = variants.findIndex(hero => hero.identifier === choice);
    if (i < 0) return choice ? { hero: null } : null;
    if (await confirmHero(variants[i], descriptions[i])) return { hero: variants[i] };
  }
}

// The same native subclass (for example Draconic Sorcery) can also be taken without its Warcraft variant.
export async function chooseLevelThreeProgression(cls, variants, registry) {
  const suggested = Object.values(cls.toObject().system.advancement ?? {}).find(step => step.type === "Subclass")?.configuration?.suggested;
  const available = [...registry.byUuid.values()].filter(row => row.type === "subclass"
    && row.system?.classIdentifier === cls.system.identifier && (!suggested?.fixed || suggested.uuid === row.uuid));
  if (!available.length) return { native: true };
  const descriptions = await Promise.all(variants.map(heroDescription));
  const rows = [];
  for (const sub of available) {
    const specific = variants.filter(hero => hero.subclass === sub.uuid);
    if (!specific.length || !sub.uuid.startsWith("Compendium.dnd-world-warcraft.")) {
      rows.push({ sub, title: sub.name });
    }
    for (const hero of specific) rows.push({ sub, hero, title: sub.name + " · " + label(hero) });
  }
  const flexible = variants.filter(hero => !hero.subclass);
  rows.sort((a, b) => a.title.localeCompare(b.title));
  const editor = foundry.applications.ux.TextEditor.implementation;
  const options = await Promise.all(rows.map(async ({ sub, hero, title }, i) => {
    const source = await fromUuid(sub.uuid);
    const description = await editor.enrichHTML(source?.system?.description?.value || "@UUID[" + sub.uuid + "]",
      { relativeTo: source, secrets: Boolean(game.user?.isGM) });
    return '<section><label><input type="radio" name="subclass" required value="' + i + '"> '
      + escape(title) + '</label><details><summary>Details</summary>' + description
      + (hero ? descriptions[variants.indexOf(hero)] : "") + '</details></section>';
  }));
  if (flexible.length) {
    options.push('<fieldset><legend>Warcraft progression for an unrestricted subclass</legend><select name="hero"><option value="">Use class progression</option>'
      + flexible.map(hero => '<option value="' + escape(hero.identifier) + '">' + escape(label(hero)) + '</option>').join("")
      + "</select>" + flexible.map(hero => "<details><summary>" + escape(label(hero)) + "</summary>"
        + descriptions[variants.indexOf(hero)] + "</details>").join("") + "</fieldset>");
  }
  while (true) {
    const selection = await heroDialog({
      window: { title: cls.name + " · Choose subclass" }, position: { width: 560 },
      content: '<div style="max-height:55vh;overflow:auto">' + options.join("") + "</div>",
      render: (_event, dialog) => {
        const profile = dialog.element.querySelector('select[name="hero"]');
        if (!profile) return;
        const form = profile.form;
        const updateProfile = () => {
          const selected = form.querySelector('input[name="subclass"]:checked')?.value ?? "";
          profile.disabled = selected === "" || Boolean(rows[Number(selected)]?.hero);
        };
        updateProfile();
        form.addEventListener("change", updateProfile);
      },
      buttons: [{ action: "select", label: "Select", callback: (_event, button) => {
        const form = new FormData(button.form);
        return { row: form.get("subclass"), hero: form.get("hero") };
      } }, { action: "cancel", label: "Cancel" }]
    });
    if (!selection || selection === "cancel") return null;
    const row = selection.row != null && rows[Number(selection.row)];
    if (!row) continue;
    const hero = row.hero ?? flexible.find(option => option.identifier === selection.hero);
    if (!hero || await confirmHero(hero, descriptions[variants.indexOf(hero)])) return { uuid: row.sub.uuid, hero };
  }
}
