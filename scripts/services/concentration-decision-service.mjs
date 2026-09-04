import { MODULE_ID } from "../constants.mjs";

const FLAG_KEY = "concentrationDecision";
const ACTION_RESOLVE = "resolve-concentration-decision";

/**
 * GM-facing approval gate for failed Concentration checks.
 *
 * The roll-resolution lifecycle decides only that a final Concentration result
 * failed. This service records that failure in Chat and leaves native D&D5e
 * concentration untouched until a GM explicitly chooses Keep or Drop.
 */
export class ConcentrationDecisionService {
  static #initialized = false;
  static #resolving = new Set();

  static initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    Hooks.on("renderChatMessageHTML", (message, element) => this.#decorateMessage(message, element));
    Hooks.on("renderChatMessage", (message, html) => this.#decorateMessage(message, html));
  }

  static async request({ actor, rollKey, originalTotal = null, finalTotal = null, target = null, rollId = null } = {}) {
    if (!actor || !rollKey) return null;

    const existing = [...(game.messages ?? [])].find(message => {
      const decision = message?.getFlag?.(MODULE_ID, FLAG_KEY);
      return decision?.rollKey === rollKey;
    });
    if (existing) return existing;

    const effects = this.#concentrationEffects(actor);
    if (!effects.length) return null;

    const effectRows = effects.map(effect => ({
      uuid: effect.uuid ?? null,
      id: effect.id ?? null,
      name: this.#concentrationName(effect)
    })).filter(row => row.uuid || row.id);
    if (!effectRows.length) return null;

    const decision = {
      version: 1,
      status: "pending",
      actorUuid: actor.uuid ?? null,
      actorId: actor.id ?? null,
      actorName: actor.name ?? "Actor",
      rollKey: String(rollKey),
      rollId: rollId ? String(rollId) : null,
      originalTotal: Number.isFinite(Number(originalTotal)) ? Number(originalTotal) : null,
      finalTotal: Number.isFinite(Number(finalTotal)) ? Number(finalTotal) : null,
      target: Number.isFinite(Number(target)) ? Number(target) : null,
      effects: effectRows,
      requestedAt: Date.now(),
      resolvedAt: null,
      resolvedBy: null,
      resolution: null
    };

    const message = await ChatMessage.implementation.create({
      speaker: ChatMessage.getSpeaker?.({ actor }) ?? { actor: actor.id, alias: actor.name },
      content: this.#content(decision),
      flags: {
        [MODULE_ID]: {
          [FLAG_KEY]: decision
        }
      }
    });
    return message ?? null;
  }

  static #decorateMessage(message, html) {
    const root = this.#element(html);
    const decision = message?.getFlag?.(MODULE_ID, FLAG_KEY);
    if (!root || !decision) return;

    for (const button of root.querySelectorAll(`[data-action="${ACTION_RESOLVE}"]`)) {
      const pending = decision.status === "pending";
      button.disabled = !pending || !game.user?.isGM;
      if (!game.user?.isGM) button.title = "Waiting for a GM decision";
      if (button.dataset.cbConcentrationDecisionBound === "true") continue;
      button.dataset.cbConcentrationDecisionBound = "true";
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        void this.#resolve(message, String(button.dataset.decision ?? ""));
      });
    }
  }

  static async #resolve(message, resolution) {
    if (!game.user?.isGM) {
      ui.notifications?.warn?.("Only a GM can resolve a failed Concentration check.");
      return;
    }
    if (!["keep", "drop"].includes(resolution)) return;
    if (!message?.id || this.#resolving.has(message.id)) return;

    const current = foundry.utils.deepClone(message.getFlag?.(MODULE_ID, FLAG_KEY) ?? {});
    if (current.status !== "pending") return;

    this.#resolving.add(message.id);
    try {
      const actor = await this.#resolveActor(current);
      if (!actor) throw new Error("The concentrating Actor could not be resolved.");

      let endedCount = 0;
      if (resolution === "drop") {
        for (const row of current.effects ?? []) {
          const effect = this.#resolveConcentrationEffect(actor, row);
          if (!effect) continue;
          const ended = await actor.endConcentration(effect);
          endedCount += Array.isArray(ended) ? ended.length : 0;
        }
      }

      const next = {
        ...current,
        status: "resolved",
        resolution,
        endedCount,
        resolvedAt: Date.now(),
        resolvedBy: game.user.id
      };
      await message.update({
        content: this.#content(next),
        [`flags.${MODULE_ID}.${FLAG_KEY}`]: next
      });
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not resolve Concentration decision.`, error);
      ui.notifications?.error?.(`Concentration decision failed: ${error.message}`);
    } finally {
      this.#resolving.delete(message.id);
    }
  }

  static async #resolveActor(decision) {
    if (decision?.actorUuid) {
      try {
        const document = await fromUuid(decision.actorUuid);
        if (document?.documentName === "Actor") return document;
      } catch (_error) {}
    }
    return decision?.actorId ? game.actors?.get?.(decision.actorId) ?? null : null;
  }

  static #resolveConcentrationEffect(actor, row) {
    if (!actor || !row) return null;
    const effects = this.#concentrationEffects(actor);
    return effects.find(effect =>
      (row.uuid && String(effect.uuid ?? "") === String(row.uuid))
      || (row.id && String(effect.id ?? "") === String(row.id))
    ) ?? null;
  }

  static #content(decision) {
    const actorName = foundry.utils.escapeHTML?.(String(decision.actorName ?? "Actor")) ?? String(decision.actorName ?? "Actor");
    const finalTotal = Number.isFinite(Number(decision.finalTotal)) ? Number(decision.finalTotal) : "?";
    const target = Number.isFinite(Number(decision.target)) ? Number(decision.target) : "?";
    const names = (decision.effects ?? []).map(row => String(row.name ?? "Concentration")).filter(Boolean);
    const sourceLabel = foundry.utils.escapeHTML?.(names.join(", ")) ?? names.join(", ");

    let status = `<p class="cb-concentration-decision-status pending"><i class="fa-solid fa-hourglass-half"></i> Waiting for GM decision. Concentration remains active.</p>`;
    let actions = `
      <div class="cb-concentration-decision-actions">
        <button type="button" data-action="${ACTION_RESOLVE}" data-decision="keep"><i class="fa-solid fa-shield-heart"></i> Keep Concentration</button>
        <button type="button" class="danger" data-action="${ACTION_RESOLVE}" data-decision="drop"><i class="fa-solid fa-link-slash"></i> Drop Concentration</button>
      </div>`;

    if (decision.status === "resolved") {
      if (decision.resolution === "drop") {
        status = `<p class="cb-concentration-decision-status dropped"><i class="fa-solid fa-link-slash"></i> Concentration dropped by GM.</p>`;
      } else {
        status = `<p class="cb-concentration-decision-status kept"><i class="fa-solid fa-shield-heart"></i> Concentration kept by GM.</p>`;
      }
      actions = "";
    }

    return `
      <section class="cb-concentration-decision-card" data-cb-concentration-decision>
        <header><i class="fa-solid fa-brain"></i><div><strong>Concentration Check Failed</strong><small>${actorName}</small></div></header>
        <div class="cb-concentration-decision-summary">
          <span><strong>Result</strong> ${finalTotal}</span>
          <span><strong>DC</strong> ${target}</span>
        </div>
        <p><strong>Concentrating on:</strong> ${sourceLabel || "Active concentration"}</p>
        ${status}
        ${actions}
      </section>`;
  }

  static #concentrationName(effect) {
    const itemRef = effect?.getFlag?.("dnd5e", "item") ?? effect?.flags?.dnd5e?.item ?? {};
    const embedded = effect?.parent?.items?.get?.(itemRef.id);
    return String(embedded?.name ?? itemRef.name ?? effect?.name ?? "Concentration")
      .replace(/^Concentrating:\s*/i, "");
  }

  static #concentrationEffects(actor) {
    const effects = actor?.concentration?.effects;
    if (!effects) return [];
    if (Array.isArray(effects)) return effects;
    if (Array.isArray(effects.contents)) return effects.contents;
    return [...effects];
  }

  static #element(value) {
    if (!value) return null;
    const HTMLElementCtor = globalThis.HTMLElement;
    if (HTMLElementCtor && value instanceof HTMLElementCtor) return value;
    if (HTMLElementCtor && value?.[0] instanceof HTMLElementCtor) return value[0];
    return value?.nodeType === 1 ? value : null;
  }
}
