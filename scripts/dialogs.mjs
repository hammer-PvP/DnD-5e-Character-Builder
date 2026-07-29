export async function confirmCreation({ profile, level, players, preview }) {
  const distinct = preview.length;
  const units = preview.reduce((total, item) => total + Number(item.quantity || 0), 0);
  const content = `
    <div class="dnd5e-supplier-confirmation">
      <p>${game.i18n.localize("DND5E_SUPPLIER.Confirm.Question")}</p>
      <dl>
        <dt>${game.i18n.localize("DND5E_SUPPLIER.Profile")}</dt><dd>${foundry.utils.escapeHTML(profile.name)}</dd>
        <dt>${game.i18n.localize("DND5E_SUPPLIER.PartyLevel")}</dt><dd>${level}</dd>
        <dt>${game.i18n.localize("DND5E_SUPPLIER.PartySize")}</dt><dd>${players}</dd>
        <dt>${game.i18n.localize("DND5E_SUPPLIER.DistinctItems")}</dt><dd>${distinct}</dd>
        <dt>${game.i18n.localize("DND5E_SUPPLIER.TotalUnits")}</dt><dd>${units}</dd>
      </dl>
    </div>`;

  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2) {
    return DialogV2.confirm({
      window: { title: game.i18n.localize("DND5E_SUPPLIER.Confirm.Title") },
      content,
      yes: {
        icon: "fa-solid fa-folder-plus",
        label: game.i18n.localize("DND5E_SUPPLIER.Confirm.Yes")
      },
      no: {
        icon: "fa-solid fa-xmark",
        label: game.i18n.localize("Cancel")
      },
      modal: true,
      rejectClose: false
    });
  }

  return new Promise(resolve => {
    new Dialog({
      title: game.i18n.localize("DND5E_SUPPLIER.Confirm.Title"),
      content,
      buttons: {
        yes: {
          icon: '<i class="fa-solid fa-folder-plus"></i>',
          label: game.i18n.localize("DND5E_SUPPLIER.Confirm.Yes"),
          callback: () => resolve(true)
        },
        no: {
          icon: '<i class="fa-solid fa-xmark"></i>',
          label: game.i18n.localize("Cancel"),
          callback: () => resolve(false)
        }
      },
      default: "yes",
      close: () => resolve(false)
    }, { width: 460 }).render(true);
  });
}
