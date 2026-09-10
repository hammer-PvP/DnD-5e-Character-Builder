import { MODULE_ID } from "../constants.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const RULE_ID = "ammunition-automation";
const PREFERENCE_FLAG = "ammunitionPreferences";
const MESSAGE_FLAG = "ammunitionUsage";

/**
 * Opt-in UI/policy layer over D&D5e 5.3.3's native ammunition pipeline.
 *
 * D&D5e remains authoritative for the attack roll, ammunition magical bonus,
 * damage roll, attack-message linkage, quantity update, and auto-destroy. This
 * service resolves compatible stacks (including contained Items), optionally
 * remembers a stack per Weapon Activity, suppresses the duplicate native ammo
 * field after that resolution, and renders the resulting balance in the same
 * attack ChatMessage.
 */
export class AmmunitionAssistanceService {
  static #initialized = false;
  static #preferenceWrites = new Map();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;

    Hooks.on("renderChatMessageHTML", (message, html) => {
      try {
        this.#renderMessageFooter(message, html);
      } catch (error) {
        console.warn(`${MODULE_ID} | Ammunition Chat footer failed to render.`, error);
      }
    });
  }

  static enabled() {
    return RulesAssistanceSettingsService.ruleEnabled(RULE_ID);
  }

  /**
   * libWrapper entry point for dnd5e.documents.activity.AttackActivity#rollAttack.
   */
  static async wrapRollAttack(activity, wrapped, config = {}, dialog = {}, message = {}) {
    if (!this.enabled() || !this.#isEligibleAttack(activity)) {
      return wrapped(config, dialog, message);
    }

    // Explicit API/module choices are authoritative. Character Builder only
    // resolves ammunition when the caller did not already specify it. Do not
    // add a second UI policy layer around another module's explicit choice.
    if (Object.prototype.hasOwnProperty.call(config ?? {}, "ammunition")) {
      return wrapped(config, dialog, message);
    }

    const rows = this.#compatibleRows(activity);
    if (!rows.length) {
      ui.notifications?.warn?.(`${activity.item?.name ?? "Weapon"}: no compatible ammunition is available.`);
      return null;
    }

    let selected = null;
    let remember = false;
    const preference = this.#preference(activity);
    if (preference) {
      selected = rows.find(row => row.id === preference.itemId) ?? null;
      if (selected) remember = true;
      else await this.#clearPreference(activity);
    }

    if (!selected && rows.length === 1) {
      selected = rows[0];
    } else if (!selected) {
      const choice = await this.#prompt(rows, activity);
      if (!choice) return null;
      selected = rows.find(row => row.id === choice.itemId) ?? null;
      if (!selected) {
        ui.notifications?.warn?.("The selected ammunition is no longer available. Try the attack again.");
        return null;
      }
      remember = choice.remember === true;
    }

    // Feed the selected real Item ID directly into D&D5e's existing attack
    // pipeline. The system itself applies ammoMagic to hit/damage and consumes
    // the exact embedded Item after a real Attack Roll is posted.
    config.ammunition = selected.id;
    dialog.options ??= {};
    dialog.options.ammunitionOptions = [];
    this.#prepareMessageFlag(message, activity, selected, { preferenceActive: remember });

    const rolls = await wrapped(config, dialog, message);
    if (!rolls?.length) return rolls;

    const liveSelected = activity.actor?.items?.get?.(selected.id) ?? null;
    const preferenceStillValid = Boolean(remember && liveSelected
      && (Number(liveSelected.system?.quantity ?? 0) > 0 || liveSelected.system?.properties?.has?.("ret")));
    if (preferenceStillValid) await this.#setPreference(activity, selected.id);
    else if (remember) await this.#clearPreference(activity);
    await this.#finalizeMessageFlag(rolls, activity, selected, preferenceStillValid);
    return rolls;
  }

  static #isEligibleAttack(activity) {
    const item = activity?.item;
    return Boolean(item?.type === "weapon"
      && item?.actor
      && item.system?.properties?.has?.("amm"));
  }

  static #compatibleRows(activity) {
    const weapon = activity?.item;
    const actor = activity?.actor ?? weapon?.actor;
    if (!weapon || !actor) return [];
    const requiredSubtype = String(weapon.system?.ammunition?.type ?? "").trim();
    const rows = [];

    for (const ammo of actor.itemTypes?.consumable ?? []) {
      if (String(ammo.system?.type?.value ?? "") !== "ammo") continue;
      if (requiredSubtype && String(ammo.system?.type?.subtype ?? "") !== requiredSubtype) continue;
      const quantity = Math.max(0, Number(ammo.system?.quantity ?? 0));
      if (!quantity) continue;
      const container = this.#containerFor(ammo, actor);
      rows.push({
        id: ammo.id,
        item: ammo,
        name: ammo.name ?? "Ammunition",
        quantity,
        containerId: container?.id ?? null,
        containerName: container?.name ?? null,
        label: this.#optionLabel(ammo.name ?? "Ammunition", quantity, container?.name)
      });
    }

    return rows.sort((left, right) => left.label.localeCompare(right.label, game.i18n?.lang));
  }

  static #containerFor(item, actor) {
    const containerId = String(item?.system?.container ?? "").trim();
    return containerId ? actor?.items?.get?.(containerId) ?? null : null;
  }

  static #optionLabel(name, quantity, containerName) {
    return `${name} — ${quantity}${containerName ? ` (${containerName})` : ""}`;
  }

  static #preference(activity) {
    const map = activity?.item?.getFlag?.(MODULE_ID, PREFERENCE_FLAG) ?? {};
    const activityId = String(activity?.id ?? activity?._id ?? "");
    const itemId = String(map?.[activityId]?.itemId ?? map?.[activityId] ?? "").trim();
    return itemId ? { itemId } : null;
  }

  static async #setPreference(activity, itemId) {
    const weapon = activity?.item;
    const activityId = String(activity?.id ?? activity?._id ?? "");
    if (!weapon?.isOwner || !activityId || !itemId) return;
    await this.#serializePreferenceWrite(weapon, async () => {
      const map = foundry.utils.deepClone(weapon.getFlag(MODULE_ID, PREFERENCE_FLAG) ?? {});
      map[activityId] = { itemId: String(itemId), updatedAt: Date.now(), userId: game.user?.id ?? null };
      await weapon.setFlag(MODULE_ID, PREFERENCE_FLAG, map);
    });
  }

  static async #clearPreference(activity) {
    const weapon = activity?.item;
    const activityId = String(activity?.id ?? activity?._id ?? "");
    if (!weapon?.isOwner || !activityId) return;
    await this.#clearPreferenceByIds(weapon.actor?.id, weapon.id, activityId);
  }

  static async #clearPreferenceByIds(actorId, weaponId, activityId) {
    const actor = game.actors?.get?.(actorId) ?? null;
    const weapon = actor?.items?.get?.(weaponId) ?? null;
    if (!weapon?.isOwner || !activityId) return false;
    await this.#serializePreferenceWrite(weapon, async () => {
      const map = foundry.utils.deepClone(weapon.getFlag(MODULE_ID, PREFERENCE_FLAG) ?? {});
      if (!Object.prototype.hasOwnProperty.call(map, activityId)) return;
      delete map[activityId];
      if (Object.keys(map).length) await weapon.setFlag(MODULE_ID, PREFERENCE_FLAG, map);
      else await weapon.unsetFlag(MODULE_ID, PREFERENCE_FLAG);
    });
    return true;
  }

  static async #serializePreferenceWrite(weapon, fn) {
    const key = weapon?.uuid ?? weapon?.id;
    const previous = this.#preferenceWrites.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(fn).finally(() => {
      if (this.#preferenceWrites.get(key) === operation) this.#preferenceWrites.delete(key);
    });
    this.#preferenceWrites.set(key, operation);
    return operation;
  }

  static async #prompt(rows, activity) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2?.wait) throw new Error("Foundry DialogV2 is unavailable for Ammunition selection.");
    const options = rows.map((row, index) =>
      `<option value="${foundry.utils.escapeHTML(row.id)}"${index === 0 ? " selected" : ""}>${foundry.utils.escapeHTML(row.label)}</option>`
    ).join("");
    const content = `<form class="standard-form cb-ammunition-selector">
      <div class="form-group">
        <label>Ammunition</label>
        <div class="form-fields"><select name="ammunition">${options}</select></div>
      </div>
      <label class="checkbox">
        <input type="checkbox" name="remember">
        Use this ammunition until I change it
      </label>
      <p class="hint">The choice applies only to this weapon's Attack activity. Fired ammunition is consumed whether the attack hits or misses.</p>
    </form>`;

    return DialogV2.wait({
      window: { title: `${activity.item?.name ?? "Weapon"} — Ammunition`, modal: true },
      content,
      buttons: [
        {
          action: "use",
          label: "Use Ammunition",
          icon: "fa-solid fa-bullseye",
          default: true,
          callback: (_event, button) => {
            const data = new foundry.applications.ux.FormDataExtended(button.form).object;
            const remember = data.remember === true || data.remember === "on" || data.remember === "true" || data.remember === 1 || data.remember === "1";
            return { itemId: String(data.ammunition ?? ""), remember };
          }
        },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => null }
      ],
      close: () => null
    });
  }

  static #prepareMessageFlag(message, activity, row, { preferenceActive = false } = {}) {
    const consumes = !row.item?.system?.properties?.has?.("ret");
    const predicted = consumes ? Math.max(0, Number(row.quantity ?? 0) - 1) : Number(row.quantity ?? 0);
    foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.${MESSAGE_FLAG}`, {
      actorId: activity.actor?.id ?? null,
      weaponItemId: activity.item?.id ?? null,
      activityId: String(activity.id ?? activity._id ?? ""),
      ammunitionItemId: row.id,
      ammunitionName: row.name,
      containerId: row.containerId,
      containerName: row.containerName,
      remaining: predicted,
      preferenceActive: Boolean(preferenceActive)
    });
  }

  static async #finalizeMessageFlag(rolls, activity, row, preferenceActive) {
    const message = rolls?.[0]?.parent;
    if (!message?.setFlag) return;
    const liveAmmo = activity.actor?.items?.get?.(row.id) ?? null;
    const remaining = liveAmmo ? Math.max(0, Number(liveAmmo.system?.quantity ?? 0)) : 0;
    const data = {
      actorId: activity.actor?.id ?? null,
      weaponItemId: activity.item?.id ?? null,
      activityId: String(activity.id ?? activity._id ?? ""),
      ammunitionItemId: row.id,
      ammunitionName: row.name,
      containerId: row.containerId,
      containerName: row.containerName,
      remaining,
      preferenceActive: Boolean(preferenceActive)
    };
    await message.setFlag(MODULE_ID, MESSAGE_FLAG, data);
  }

  static #renderMessageFooter(message, html) {
    const data = message?.getFlag?.(MODULE_ID, MESSAGE_FLAG) ?? null;
    if (!data || !html) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    root.querySelectorAll(".cb-ammunition-footer").forEach(node => node.remove());

    const content = root.querySelector(".message-content") ?? root;
    const footer = document.createElement("div");
    footer.className = "cb-ammunition-footer";

    const label = document.createElement("span");
    const location = data.containerName ? ` (${data.containerName})` : "";
    label.textContent = `${data.ammunitionName ?? "Ammunition"}${location}: ${Math.max(0, Number(data.remaining ?? 0))} remaining`;
    footer.append(label);

    if (data.preferenceActive) {
      const actor = game.actors?.get?.(data.actorId) ?? null;
      const weapon = actor?.items?.get?.(data.weaponItemId) ?? null;
      if (weapon?.isOwner) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cb-ammunition-ask-again";
        button.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Ask every attack';
        button.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          void this.#clearPreferenceByIds(data.actorId, data.weaponItemId, data.activityId).then(cleared => {
            if (cleared) ui.notifications?.info?.(`${weapon.name}: ammunition will be asked again on the next attack.`);
          }).catch(error => {
            console.warn(`${MODULE_ID} | Could not clear Ammunition preference.`, error);
            ui.notifications?.error?.("Could not clear the ammunition preference.");
          });
        });
        footer.append(button);
      }
    }

    content.append(footer);
  }
}

export const AMMUNITION_ASSISTANCE_RULE_ID = RULE_ID;
