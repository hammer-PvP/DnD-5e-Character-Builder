import { MODULE_ID, MODULE_VERSION } from "../constants.mjs";

/**
 * Applies the completed Draft Actor as one recoverable transaction. The live
 * Actor is never modified while the player moves between Builder steps.
 */
export class ActorCommitService {
  static async commit(actor, draft) {
    const snapshot = this.#actorSnapshot(actor);
    const draftData = this.#documentSource(draft);
    const itemData = draft.items.map(item => this.#documentSource(item));
    const characterName = String(draft.getFlag(MODULE_ID, "buildState")?.characterName ?? actor.name ?? "").trim()
      || actor.name;
    const prototypeToken = this.#plainClone(draftData.prototypeToken ?? {});
    prototypeToken.name = characterName;

    // Foundry updates are differential. Passing the complete nested `system`
    // object with recursive:false can cause D&D5e prepared-data objects to be
    // reused as source data. D&D5e 5.3.3 then attempts to install its legacy
    // senses shims a second time and throws "Cannot redefine property:
    // darkvision". Commit only plain leaf values so the Actor DataModel is
    // reconstructed from clean source data by Foundry.
    const baseUpdate = this.#flattenForUpdate({
      system: draftData.system,
      prototypeToken,
      img: draftData.img,
      name: characterName
    });

    let stage = "updating the Actor source";

    try {
      await actor.update(baseUpdate, { characterBuilder: true });

      stage = "removing the Actor's previous embedded Items";
      const existingIds = actor.items.map(item => item.id);
      if (existingIds.length) {
        await actor.deleteEmbeddedDocuments("Item", existingIds, {
          deleteContents: true,
          characterBuilder: true
        });
      }

      stage = "creating the completed character's embedded Items";
      if (itemData.length) {
        await actor.createEmbeddedDocuments("Item", itemData, {
          keepId: true,
          characterBuilder: true
        });
        const missing = itemData.filter(item => !actor.items.get(item._id));
        if (missing.length) {
          throw new Error(`${missing.length} embedded Item documents were not created on the final Actor.`);
        }
      }

      stage = "synchronizing final Hit Points";
      // createEmbeddedDocuments prepares the parent Actor automatically. Read
      // the resulting derived maximum without manually preparing the same D&D5e
      // DataModel a second time (which would reinstall non-configurable senses
      // compatibility accessors and throw on darkvision).
      const hp = actor.system.attributes?.hp;
      const derivedMaximum = Number(hp?.effectiveMax ?? hp?.max);
      if (Number.isFinite(derivedMaximum) && derivedMaximum >= 0) {
        await actor.update({ "system.attributes.hp.value": derivedMaximum }, { characterBuilder: true });
      }

      stage = "marking the character as completed";
      await actor.setFlag(MODULE_ID, "completed", {
        completedAt: Date.now(),
        version: MODULE_VERSION
      });
      await actor.unsetFlag(MODULE_ID, "draftActorId");
      await draft.delete();
      return actor;
    } catch (error) {
      console.error(`${MODULE_ID} | Commit failed while ${stage}. Restoring Actor snapshot.`, error);
      try {
        await this.#restore(actor, snapshot);
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Actor rollback also failed.`, rollbackError);
      }
      throw error;
    }
  }

  static #actorSnapshot(actor) {
    const source = this.#documentSource(actor);
    source.items = actor.items.map(item => this.#documentSource(item));
    return source;
  }

  static #documentSource(document) {
    const source = document?._source ?? document?.toObject?.() ?? {};
    return this.#plainClone(source);
  }

  /**
   * Clone persisted source data without carrying DataModel compatibility
   * accessors into another Document. In D&D5e 5.3, legacy sense properties are
   * enumerable, non-configurable accessors on prepared data and must never be
   * copied as source fields.
   */
  static #plainClone(value, path=[]) {
    if (Array.isArray(value)) return value.map((entry, index) => this.#plainClone(entry, [...path, index]));
    if (value instanceof Set) return Array.from(value, entry => this.#plainClone(entry, path));
    if (value instanceof Map) {
      return Object.fromEntries(Array.from(value.entries(), ([key, entry]) => [key, this.#plainClone(entry, [...path, key])]));
    }
    if (!value || typeof value !== "object") return value;

    const clone = {};
    const currentField = String(path.at(-1) ?? "");
    const isSensesField = currentField === "senses";
    const legacySenseKeys = new Set(["darkvision", "blindsight", "tremorsense", "truesight"]);

    for (const key of Object.keys(value)) {
      if (isSensesField && legacySenseKeys.has(key)) continue;

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // Persisted source fields are data properties. Ignore prepared-data
      // getters/setters rather than evaluating and copying compatibility shims.
      if (descriptor && !("value" in descriptor)) continue;

      const entry = descriptor ? descriptor.value : value[key];
      clone[key] = this.#plainClone(entry, [...path, key]);
    }
    return clone;
  }

  /**
   * Convert a complete plain source fragment into dotted, differential update
   * paths. Arrays and empty objects are retained as leaf values.
   */
  static #flattenForUpdate(value, prefix="", output={}) {
    if (Array.isArray(value) || value === null || typeof value !== "object") {
      if (prefix) output[prefix] = this.#plainClone(value);
      return output;
    }

    const keys = Object.keys(value);
    if (!keys.length) {
      if (prefix) output[prefix] = {};
      return output;
    }

    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      this.#flattenForUpdate(value[key], path, output);
    }
    return output;
  }

  static async #restore(actor, snapshot) {
    const restoreItems = this.#plainClone(snapshot.items ?? []);
    const update = this.#flattenForUpdate({
      system: snapshot.system,
      prototypeToken: snapshot.prototypeToken,
      img: snapshot.img,
      name: snapshot.name
    });

    await actor.update(update, { characterBuilderRollback: true });
    const existingIds = actor.items.map(item => item.id);
    if (existingIds.length) {
      await actor.deleteEmbeddedDocuments("Item", existingIds, {
        deleteContents: true,
        characterBuilderRollback: true
      });
    }
    if (restoreItems.length) {
      await actor.createEmbeddedDocuments("Item", restoreItems, {
        keepId: true,
        characterBuilderRollback: true
      });
    }
  }
}
