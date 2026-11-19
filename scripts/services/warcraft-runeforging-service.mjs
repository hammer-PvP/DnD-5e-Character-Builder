import { activeWarcraft, sourceOf } from "./warcraft-progression-service.mjs";
import { WarBondManagementService } from "./war-bond-management-service.mjs";

const CLASS_PACK = "Compendium.dnd-world-warcraft.classes.Item.";

export function isWarcraftRune(item) {
  return Boolean(activeWarcraft() && item?.system?.type?.subtype === "rune" && sourceOf(item).startsWith(CLASS_PACK));
}

export function runeContext(actor) {
  if (!activeWarcraft() || !actor?.items?.some(item => sourceOf(item) === CLASS_PACK + "wowpdnRuneforgin")) return null;
  const runes = actor.items.filter(isWarcraftRune);
  if (runes.length !== 1) return null;
  const rune = runes[0];
  const activity = [...rune.system.activities].find(action => action.type === "enchant");
  if (!activity) return null;
  const bonds = WarBondManagementService.appliedEnchantments(actor, activity);
  const weapons = actor.items.filter(item => item.type === "weapon" && (bonds.some(row => row.weapon.id === item.id)
    || !WarBondManagementService.enchantmentErrors(activity, item).length));
  return { rune, activity, bonds, weapons };
}

export async function removeRuneInscriptions(actor, runes) {
  for (const rune of runes) {
    for (const activity of rune.system.activities) {
      if (activity.type !== "enchant") continue;
      for (const { effect } of WarBondManagementService.appliedEnchantments(actor, activity)) await effect.delete();
    }
  }
}

export async function bloodRuneRest(actor, context = runeContext(actor)) {
  if (!context?.bonds.length || context.rune.system.identifier !== "blood") return;
  const cls = actor.items.find(item => item.type === "class" && item.system.identifier === "paladin");
  if (!cls) return;
  const amount = Number(cls.system.levels) + Number(actor.system.abilities.cha.mod);
  if (amount > Number(actor.system.attributes.hp.temp ?? 0)) await actor.update({ "system.attributes.hp.temp": amount });
}

export function validateRuneWeapon(actor, payload) {
  const context = runeContext(actor);
  const weapon = context?.weapons.find(item => item.id === payload?.weaponId);
  if (!weapon || context.rune.id !== payload.runeId) throw new Error("Choose an eligible weapon for your current rune.");
  return { context, weapon };
}

export async function inscribeWeapon(actor, payload) {
  const { context, weapon } = validateRuneWeapon(actor, payload);
  const { bonds, activity } = context;
  const kept = bonds.find(row => row.weapon.id === weapon.id);
  if (!kept) {
    const profile = activity.availableEnchantments?.[0];
    if (!profile || !await activity.applyEnchantment(profile._id ?? profile.id, weapon, { strict: true })) {
      throw new Error("The rune enchantment could not be applied.");
    }
  }
  for (const row of bonds) if (row !== kept) await row.effect.delete();
  await bloodRuneRest(actor, { ...context, bonds: [{ weapon }] });
  return { changed: !kept || bonds.length > 1, weaponId: weapon.id };
}

export async function chooseRuneWeapon(actor, staged) {
  const context = runeContext(actor);
  if (!context) return null;
  const { bonds, rune, weapons } = context;
  if (!weapons.length) { ui.notifications.info("No eligible weapons in this inventory."); return null; }
  const selected = staged?.weaponId ?? bonds[0]?.weapon.id;
  const label = document.createElement("label");
  const select = document.createElement("select");
  label.textContent = rune.name + " · Current weapon: " + (bonds[0]?.weapon.name ?? "None");
  for (const weapon of weapons) {
    const option = new Option(weapon.name, weapon.id, weapon.id === selected, weapon.id === selected);
    select.append(option);
  }
  label.append(select);
  const id = await foundry.applications.api.DialogV2.wait({
    window: { title: "Inscribe Weapon" }, content: label.outerHTML,
    buttons: [{ action: "save", label: "Use at Long Rest", callback: (_event, _button, dialog) => dialog.element.querySelector("select").value },
      { action: "cancel", label: "Cancel", callback: () => null }],
    render: (_event, dialog) => {
      const root = dialog.element;
      root.addEventListener("dragover", event => event.preventDefault());
      root.addEventListener("drop", async event => {
        event.preventDefault();
        const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
        const item = data.type === "Item" && data.uuid ? await fromUuid(data.uuid) : null;
        if (item && weapons.some(weapon => weapon.uuid === item.uuid)) root.querySelector("select").value = item.id;
      });
    }, rejectClose: false
  });
  return id ? { runeId: rune.id, weaponId: id } : null;
}
