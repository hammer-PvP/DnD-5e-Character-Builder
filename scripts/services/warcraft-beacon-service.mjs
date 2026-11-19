import { activeWarcraft, sourceOf } from "./warcraft-progression-service.mjs";
import { RulesAssistanceSettingsService } from "./rules-assistance-settings-service.mjs";

const beaconSource = "Compendium.dnd-world-warcraft.classes.Item.wowpdnBeaconLigh";
const nativeUpdates = new WeakMap();
const hitPoints = new Map();
const queues = new Map();

function sceneActors() {
  const actors = new Map();
  for (const actor of game.actors) actors.set(actor.uuid, actor);
  for (const scene of game.scenes) for (const token of scene.tokens) {
    if (!token.actorLink && token.actor) actors.set(token.actor.uuid, token.actor);
  }
  return actors;
}

function healSource(message) {
  if (!message) return null;
  for (const card of new Set([message, message.getOriginatingMessage?.()])) {
    const item = card?.getAssociatedItem?.();
    const actor = item?.actor ?? card?.getAssociatedActor?.();
    if (actor && (item?.type === "spell" || item?.system?.identifier === "lay-on-hands")) return actor;
  }
  return null;
}

function hasBeacon(actor, caster) {
  return [...(actor.appliedEffects ?? actor.effects ?? [])].some(effect => {
    if (effect.disabled || effect.isSuppressed || effect.active === false || effect.duration?.expired) return false;
    if (effect.duration?.remaining != null && effect.duration.remaining <= 0) return false;
    const link = effect.system?.origin;
    const origin = effect.origin ? fromUuidSync(effect.origin, { strict: false }) : null;
    const item = (link?.item && fromUuidSync(link.item, { strict: false }))
      || (origin?.documentName === "Item" ? origin : (origin?.item ?? origin?.parent));
    return (effect.getSourceActor?.() ?? item?.actor)?.uuid === caster.uuid && sourceOf(item) === beaconSource;
  });
}

function track(actor) {
  const hp = Number(actor?.system?.attributes?.hp?.value);
  if (actor?.uuid && Number.isFinite(hp)) hitPoints.set(actor.uuid, hp);
}

export function secondaryHealing(previous, current) {
  return Math.max(0, Math.floor((current - previous) / 2));
}

function resolveHealing(actor, changes, options, userId) {
  const previous = hitPoints.get(actor.uuid);
  track(actor);
  const id = options?.characterBuilderBeaconMessage;
  if (!id || previous === undefined || !activeWarcraft() || !RulesAssistanceSettingsService.ruleEnabled("warcraft-beacon")) return;
  if ((game.users.activeGM?.id ?? userId) !== game.user.id) return;
  if (!foundry.utils.hasProperty(changes, "system.attributes.hp.value")) return;
  const amount = secondaryHealing(previous, hitPoints.get(actor.uuid));
  if (!amount) return;
  const caster = healSource(game.messages.get(id));
  if (!caster) return;
  for (const marked of sceneActors().values()) {
    if (marked.uuid === actor.uuid || !marked.isOwner || !hasBeacon(marked, caster)) continue;
    const key = marked.uuid;
    const apply = async () => {
      if (hasBeacon(marked, caster)) await marked.applyDamage([{ type: "healing", value: amount }]);
    };
    const job = (queues.get(key) ?? Promise.resolve()).then(apply).catch(error => console.warn("Beacon of Light", error));
    queues.set(key, job);
    void job.then(() => { if (queues.get(key) === job) queues.delete(key); });
  }
}

export function registerBeacon(api, moduleId) {
  for (const actor of sceneActors().values()) track(actor);
  Hooks.on("createActor", track);
  Hooks.on("createToken", token => track(token.actor));
  Hooks.on("deleteActor", actor => hitPoints.delete(actor.uuid));
  Hooks.on("deleteToken", token => { if (!token.actorLink) hitPoints.delete(token.actor?.uuid); });
  Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) => {
    const message = options.origin ?? options.originatingMessage;
    if (amount < 0 && message?.id && healSource(message)) nativeUpdates.set(updates, message.id);
  });
  api.register(moduleId, "dnd5e.documents.Actor5e.prototype.update", function (wrapped, updates, options, ...args) {
    const messageId = nativeUpdates.get(updates);
    if (messageId) options = { ...options, characterBuilderBeaconMessage: messageId };
    return wrapped(updates, options, ...args);
  }, "WRAPPER");
  Hooks.on("updateActor", resolveHealing);
}
