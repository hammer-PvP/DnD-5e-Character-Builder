import { MODULE_ID } from "./constants.mjs";
import { SupplierConfigApplication } from "./config-app.mjs";
import { SupplierApplication } from "./supplier-app.mjs";
import { initializeDefaultSources, registerSettings } from "./settings.mjs";

Hooks.once("init", () => {
  registerSettings(SupplierConfigApplication);
  console.log(`${MODULE_ID} | Initialized`);
});

Hooks.once("ready", async () => {
  await initializeDefaultSources();
  game.modules.get(MODULE_ID).api = {
    open: () => new SupplierApplication().render(true),
    configure: () => new SupplierConfigApplication().render(true)
  };
});

Hooks.on("renderItemDirectory", (application, html) => {
  if (!game.user?.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".dnd5e-supplier-directory-row")) return;

  const nativeActions = root.querySelector(".directory-header .header-actions")
    ?? root.querySelector(".directory-header .action-buttons");
  const header = root.querySelector(".directory-header");
  if (!header) return;

  const row = document.createElement("div");
  row.className = "dnd5e-supplier-directory-row";
  row.innerHTML = `
    <button type="button" class="dnd5e-supplier-directory-button">
      <i class="fa-solid fa-store" aria-hidden="true"></i>
      <span>${game.i18n.localize("DND5E_SUPPLIER.Button")}</span>
    </button>`;
  row.querySelector("button")?.addEventListener("click", () => new SupplierApplication().render(true));

  // Never insert inside the native Create Item / Create Folder action group.
  if (nativeActions) nativeActions.insertAdjacentElement("afterend", row);
  else header.append(row);
});
