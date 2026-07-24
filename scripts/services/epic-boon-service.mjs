import { MODULE_ID } from "../constants.mjs";
import { LevelUpService } from "./level-up-service.mjs";
import { NativeAdvancementModalGuard } from "./native-advancement-modal-guard.mjs";
import { NativeFeatChoiceGuard } from "./native-feat-choice-guard.mjs";
import { SourceRegistry } from "./source-registry.mjs";

/**
 * GM-granted Epic Boon rewards. A grant only creates a pending permission.
 * The player chooses an official Epic Boon and D&D5e applies its native
 * Advancements directly to the live level-20 Actor.
 */
export class EpicBoonService {
  static PENDING_FLAG = "pendingEpicBoonGift";
  static HISTORY_FLAG = "epicBoonGiftHistory";
  static #activeClaims = new Set();

  static settings() {
    return LevelUpService.settings();
  }

  static pending(actor) {
    return actor?.getFlag?.(MODULE_ID, this.PENDING_FLAG) ?? null;
  }

  static grantEligibility(actor) {
    const settings = this.settings();
    if (!settings.enableEpicBoons) return { eligible: false, reason: "Epic Boons are disabled in Character Builder settings." };
    if (!settings.enableGrantEpicBoons) return { eligible: false, reason: "Grant Epic Boons is disabled in Character Builder settings." };
    if (!actor || actor.type !== "character") return { eligible: false, reason: "Player Character Actors only." };
    if (actor.getFlag(MODULE_ID, "isDraft") || actor.getFlag(MODULE_ID, "isLevelUpDraft")) {
      return { eligible: false, reason: "Draft Actors are not eligible." };
    }
    if (!actor.items.some(item => item.type === "class")) {
      return { eligible: false, reason: "Complete Character Creation first." };
    }
    const level = LevelUpService.actorLevel(actor);
    if (level !== 20) return { eligible: false, reason: "Available only for level 20 characters." };
    if (this.pending(actor)?.available) return { eligible: false, reason: "Epic Boon already pending." };
    return { eligible: true, reason: "Ready for an Epic Boon grant." };
  }

  static async grant(actor, metadata = {}) {
    if (!game.user.isGM) throw new Error("Only a GM can grant an Epic Boon.");
    const settings = this.settings();
    if (!settings.enableEpicBoons || !settings.enableGrantEpicBoons) {
      throw new Error("Grant Epic Boons requires both Enable Epic Boons and Enable Grant Epic Boons in Character Builder settings.");
    }
    const eligibility = this.grantEligibility(actor);
    if (!eligibility.eligible) throw new Error(eligibility.reason);

    const grantId = foundry.utils.randomID?.(24) ?? crypto.randomUUID();
    const pending = {
      available: true,
      grantId,
      grantedAt: Date.now(),
      grantedBy: game.user.id,
      characterLevel: 20,
      ...(metadata.batchId ? { batchId: metadata.batchId } : {}),
      ...(metadata.idempotencyToken ? { idempotencyToken: metadata.idempotencyToken } : {})
    };
    await actor.setFlag(MODULE_ID, this.PENDING_FLAG, pending);
    actor.sheet?.render?.(false);
    return pending;
  }

  static async revoke(actor) {
    if (!game.user.isGM) throw new Error("Only a GM can revoke a pending Epic Boon.");
    if (!this.pending(actor)?.available) throw new Error("This Actor has no pending Epic Boon.");
    await actor.unsetFlag(MODULE_ID, this.PENDING_FLAG);
    actor.sheet?.render?.(false);
  }

  static async claim(actor) {
    if (!this.settings().enableEpicBoons) throw new Error("Epic Boons are disabled by the Game Master.");
    if (!actor || actor.type !== "character") throw new Error("Epic Boons can be claimed only by Player Character Actors.");
    if (!actor.isOwner) throw new Error("You do not own this Actor.");
    const pending = this.pending(actor);
    if (!pending?.available) throw new Error("This Actor has no pending Epic Boon.");
    if (LevelUpService.actorLevel(actor) !== 20) throw new Error("Epic Boon gifts can be claimed only at character level 20.");
    if (this.#activeClaims.has(actor.id)) throw new Error("An Epic Boon choice is already open for this Actor.");

    this.#activeClaims.add(actor.id);
    let snapshot = null;
    let transactionId = null;
    try {
      const sourceUuid = await this.#selectEpicBoon(actor);
      if (!sourceUuid) return { completed: false, cancelled: true };

      const source = await fromUuid(sourceUuid);
      const invalid = await this.#invalidSelectionReason(source, actor, sourceUuid);
      if (invalid) throw new Error(invalid);

      transactionId = foundry.utils.randomID?.(24) ?? crypto.randomUUID();
      snapshot = this.#claimSnapshot(actor);
      const itemData = game.items?.fromCompendium
        ? game.items.fromCompendium(source, { keepId: true })
        : source.toObject();
      delete itemData._id;
      itemData.flags ??= {};
      itemData.flags.dnd5e ??= {};
      itemData.flags.dnd5e.sourceId = sourceUuid;
      itemData.flags[MODULE_ID] = {
        ...(itemData.flags[MODULE_ID] ?? {}),
        epicBoonGift: {
          transactionId,
          grantId: pending.grantId,
          sourceUuid,
          grantedAt: pending.grantedAt,
          grantedBy: pending.grantedBy,
          claimedAt: null,
          claimedBy: game.user.id
        }
      };

      const Manager = globalThis.dnd5e?.applications?.advancement?.AdvancementManager;
      if (!Manager) throw new Error("D&D5e AdvancementManager is unavailable.");
      const manager = Manager.forNewItem(actor, itemData, {
        window: { title: "Claim Epic Boon" },
        characterBuilderEpicBoonGift: true
      });
      if (!manager.steps.length) {
        throw new Error("The selected Epic Boon has no native Advancement steps. The gift was not consumed.");
      }

      return await NativeAdvancementModalGuard.run(manager, {
        onComplete: async () => this.#finalizeClaim(actor, { transactionId, sourceUuid, pending })
      });
    } catch (error) {
      if (snapshot && transactionId && this.#claimChanged(actor, snapshot, transactionId)) {
        try {
          await this.#rollbackClaim(actor, snapshot, transactionId);
          const restored = new Error(`${error.message} The Epic Boon changes were rolled back and the gift remains pending.`);
          restored.cause = error;
          restored.epicBoonRolledBack = true;
          throw restored;
        } catch (rollbackError) {
          if (rollbackError?.epicBoonRolledBack) throw rollbackError;
          console.error(`${MODULE_ID} | Epic Boon rollback failed.`, rollbackError);
          const critical = new Error("Critical Epic Boon rollback failure. The GM must inspect this Actor before another Epic Boon is claimed.");
          critical.cause = error;
          critical.rollbackCause = rollbackError;
          throw critical;
        }
      }
      throw error;
    } finally {
      this.#activeClaims.delete(actor.id);
    }
  }

  static async #selectEpicBoon(actor) {
    const Browser = globalThis.dnd5e?.applications?.CompendiumBrowser;
    if (!Browser?.selectOne) throw new Error("D&D5e Compendium Browser is unavailable.");

    while (true) {
      const result = await Browser.selectOne({
        tab: "feats",
        hint: "Choose one Epic Boon.",
        filters: {
          locked: {
            types: new Set(["feat"]),
            additional: {
              category: { feat: 1 },
              subtype: { epicBoon: 1 }
            }
          }
        }
      });
      if (!result) return null;

      const candidate = await fromUuid(result);
      const invalid = await this.#invalidSelectionReason(candidate, actor, result);
      if (!invalid) return result;
      await this.#showInvalidChoice(candidate, invalid);
    }
  }

  static async #invalidSelectionReason(candidate, actor, sourceUuid) {
    if (!this.settings().enableEpicBoons) return "Epic Boons are disabled by the Game Master.";
    if (!NativeFeatChoiceGuard.isEpicBoon(candidate)) {
      return "The selected document is not an Epic Boon.";
    }

    const registry = new SourceRegistry();
    await registry.load();
    if (!String(sourceUuid ?? "").startsWith("Compendium.") || !registry.isUuidAllowed(sourceUuid)) {
      return "The selected Epic Boon is not from a content source enabled in Character Builder settings.";
    }

    if (!NativeFeatChoiceGuard.isRepeatable(candidate)
      && NativeFeatChoiceGuard.findOwnedEquivalent(candidate, actor)) {
      return `${candidate.name} is already owned and cannot be selected more than once.`;
    }
    return null;
  }

  static async #finalizeClaim(actor, { transactionId, sourceUuid, pending }) {
    const item = actor.items.find(candidate =>
      candidate.getFlag(MODULE_ID, "epicBoonGift")?.transactionId === transactionId
    );
    if (!item) throw new Error("The Epic Boon Item was not found after native Advancement completion.");

    const history = foundry.utils.deepClone(actor.getFlag(MODULE_ID, this.HISTORY_FLAG) ?? []);
    const claimedAt = Date.now();
    const entry = {
      transactionId,
      grantId: pending.grantId,
      sourceUuid,
      boonItemId: item.id,
      boonName: item.name,
      boonIdentifier: item.system?.identifier ?? "",
      grantedAt: pending.grantedAt,
      grantedBy: pending.grantedBy,
      claimedAt,
      claimedBy: game.user.id,
      characterLevel: LevelUpService.actorLevel(actor),
      advancement: foundry.utils.deepClone(item.system?.advancement ?? {})
    };

    await item.setFlag(MODULE_ID, "epicBoonGift", {
      ...item.getFlag(MODULE_ID, "epicBoonGift"),
      claimedAt,
      claimedBy: game.user.id
    });
    await actor.update({
      [`flags.${MODULE_ID}.${this.HISTORY_FLAG}`]: [...history, entry].slice(-50),
      [`flags.${MODULE_ID}.-=${this.PENDING_FLAG}`]: null
    }, { characterBuilderEpicBoonGift: true });
    ui.notifications.info(`${item.name} was added to ${actor.name}.`);
    actor.sheet?.render?.(false);
  }

  static #claimSnapshot(actor) {
    return {
      itemIds: new Set(actor.items.map(item => item.id)),
      abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"]
        .map(key => [key, Number(actor.system?.abilities?.[key]?.value ?? 0)])),
      pending: foundry.utils.deepClone(this.pending(actor)),
      historyExists: actor.getFlag(MODULE_ID, this.HISTORY_FLAG) !== undefined,
      history: foundry.utils.deepClone(actor.getFlag(MODULE_ID, this.HISTORY_FLAG) ?? [])
    };
  }

  static #claimChanged(actor, snapshot, transactionId) {
    if (actor.items.some(item => item.getFlag?.(MODULE_ID, "epicBoonGift")?.transactionId === transactionId)) return true;
    if (!this.pending(actor)?.available) return true;
    const currentHistory = actor.getFlag(MODULE_ID, this.HISTORY_FLAG) ?? [];
    if (currentHistory.length !== snapshot.history.length) return true;
    return Object.entries(snapshot.abilities)
      .some(([key, value]) => Number(actor.system?.abilities?.[key]?.value ?? 0) !== value);
  }

  static async #rollbackClaim(actor, snapshot, transactionId) {
    const boon = actor.items.find(item => item.getFlag?.(MODULE_ID, "epicBoonGift")?.transactionId === transactionId);
    const createdIds = new Set();
    if (boon) createdIds.add(boon.id);
    if (boon) {
      for (const item of actor.items) {
        if (snapshot.itemIds.has(item.id)) continue;
        const origin = String(item.getFlag?.("dnd5e", "advancementOrigin") ?? item.flags?.dnd5e?.advancementOrigin ?? "");
        const root = String(item.getFlag?.("dnd5e", "advancementRoot") ?? item.flags?.dnd5e?.advancementRoot ?? "");
        if (origin.startsWith(`${boon.id}.`) || root.startsWith(`${boon.id}.`)) createdIds.add(item.id);
      }
    }
    if (createdIds.size) {
      await actor.deleteEmbeddedDocuments("Item", [...createdIds], { characterBuilderEpicBoonRollback: true });
    }

    const update = Object.fromEntries(Object.entries(snapshot.abilities)
      .map(([key, value]) => [`system.abilities.${key}.value`, value]));
    update[`flags.${MODULE_ID}.${this.PENDING_FLAG}`] = snapshot.pending;
    if (snapshot.historyExists) update[`flags.${MODULE_ID}.${this.HISTORY_FLAG}`] = snapshot.history;
    else update[`flags.${MODULE_ID}.-=${this.HISTORY_FLAG}`] = null;
    await actor.update(update, { characterBuilderEpicBoonRollback: true });
    actor.sheet?.render?.(false);
  }

  static async #showInvalidChoice(candidate, reason) {
    const name = foundry.utils.escapeHTML(candidate?.name ?? "The selected document");
    const content = `<div class="cb-structural-error">
      <p><strong>${name} cannot be selected.</strong></p>
      <p>${foundry.utils.escapeHTML(reason)}</p>
      <p>The choice was not applied. Choose another Epic Boon or close the browser.</p>
    </div>`;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (DialogV2?.wait) {
      await DialogV2.wait({
        window: { title: "Invalid Epic Boon Choice", modal: true },
        content,
        buttons: [{ action: "choose", label: "Choose Another Epic Boon", icon: "fa-solid fa-rotate-left", default: true }],
        close: () => "choose"
      });
    } else ui.notifications.warn(`${candidate?.name ?? "Epic Boon"}: ${reason}`, { permanent: true });
  }
}
