import { MODULE_ID } from "../constants.mjs";
import { activeWarcraft, warcraftChoices } from "./warcraft-progression-service.mjs";
import { SourceResolver } from "./source-resolver.mjs";

// The optional book provides the rules text and links in the installed language.
const PLAYING_PAGES = {
  "death-knight": "wowDeathKnight00.gL82O0Vn607HF94R",
  "demon-hunter": "wowDemonHunter00.ctrmS25r9uMiB8Ha",
  evoker: "wowEvoker0000000.ZO0AzXeLXv6ZGTeS",
  hunter: "wowHunter0000000.kXeFX6BSYQHUyIy2",
  mage: "wowMage000000000.Oo0DZC18lXB2Ym67",
  priest: "wowPriest0000000.IxQBH5MGVimevPbp",
  shaman: "wowShaman0000000.9RHgZFZjb0cjPSYB",
  warrior: "wowWarrior000000.Zmo8Ruw6Y3YdhfOV"
};

export function classVariants(option, registry) {
  return warcraftChoices(option.identifier, option.name, registry, { level: 1 })?.rows.slice(1) ?? [];
}

async function levelThreeFeatures(document) {
  const entries = Object.values(document?.toObject().system.advancement ?? {})
    .filter(step => step.type === "ItemGrant" && Number(step.level) === 3)
    .flatMap(step => Object.values(step.configuration?.items ?? {}))
    .filter(entry => !entry.optional);
  return (await Promise.all(entries.map(entry => SourceResolver.linkedDocument(entry.uuid, document)))).filter(Boolean);
}

export async function levelThreeIdentity(cls, sourceUuid, registry, selected) {
  if (!cls) return null;
  const identifier = cls.system.identifier;
  const current = cls.flags?.["dnd-world-warcraft"]?.heroClass;
  const variants = classVariants({ identifier, name: cls.name }, registry);
  if (!variants.length) return null;
  const config = activeWarcraft().config.heroClasses[identifier];
  const locked = config.find(hero => hero.identifier === current && hero.subclass);
  if (locked) {
    const subclass = await fromUuid(locked.subclass);
    const features = await levelThreeFeatures(subclass);
    const names = await Promise.all(features.map(async item => {
      const replacement = locked.replacedSubclassFeatures?.[3]?.[item.system.identifier];
      return replacement ? (await fromUuid(replacement))?.name ?? item.name : item.name;
    }));
    return { locked: true, name: cls.name, subclass: subclass?.name, features: names.join(", ") };
  }
  const source = sourceUuid ? await fromUuid(sourceUuid) : null;
  const baseName = source?.name ?? cls.getFlag(MODULE_ID, "sourceSnapshot")?.name
    ?? (current ? identifier.charAt(0).toUpperCase() + identifier.slice(1) : cls.name);
  const choices = warcraftChoices(identifier, baseName, registry, { level: 3, current, selected });
  if (!choices) return null;
  const baseFeatures = await levelThreeFeatures(source ?? cls);
  for (const row of choices.rows) {
    const hero = config.find(variant => variant.identifier === row.id);
    const swaps = hero?.replacedClassFeatures?.[3] ?? {};
    const changes = await Promise.all(Object.entries(swaps).map(async ([key, uuid]) => {
      const original = baseFeatures.find(item => item.system.identifier === key)?.name ?? key.replaceAll("-", " ");
      const replacement = await fromUuid(uuid);
      return replacement ? replacement.name + " replaces " + original + "." : "Replaces " + original + ".";
    }));
    const gains = baseFeatures.filter(item => !swaps[item.system.identifier]).map(item => item.name);
    if (gains.length) changes.push("Gain " + gains.join(", ") + ".");
    if (!changes.length) changes.push(hero
      ? "Your class is named " + row.name + " and uses " + baseName + " features at this level."
      : "Continue the " + baseName + " progression.");
    row.source = hero ? "World of Warcraft" : "D&D";
    row.detail = changes.join(" ");
  }
  return choices;
}

export async function warcraftClassPreview(base, selection, registry, { multiclass = false } = {}) {
  if (!base || !selection || selection === "standard") return base;
  const identifier = base.document.system.identifier;
  const module = activeWarcraft();
  const hero = module?.config?.heroClasses?.[identifier]?.find(row => row.identifier === selection);
  if (!hero || !classVariants({ identifier, name: base.name }, registry).some(row => row.id === selection)) return base;
  const name = game.i18n.localize(hero.name);
  const [journalId, pageId] = (PLAYING_PAGES[selection] ?? "").split(".");
  const book = pageId ? await fromUuid(`Compendium.dnd-world-warcraft.book.JournalEntry.${journalId}.JournalEntryPage.${pageId}`) : null;
  const enrich = (html, owner) => foundry.applications.ux.TextEditor.implementation.enrichHTML(html,
    { relativeTo: owner, secrets: false });
  const byLevel = new Map();
  function add(level, link) {
    if (!byLevel.has(level)) byLevel.set(level, new Set());
    byLevel.get(level).add(link);
  }
  const escape = foundry.utils.escapeHTML;
  for (const step of Object.values(base.document.toObject().system.advancement ?? {})) {
    if (step.type !== "ItemGrant" || Number(step.level) !== 1) continue;
    if (step.classRestriction === (multiclass ? "primary" : "secondary")) continue;
    for (const entry of Object.values(step.configuration?.items ?? {})) {
      if (entry.optional) continue;
      const doc = await SourceResolver.linkedDocument(entry.uuid, base.document);
      if (doc && !hero.replacedClassFeatures?.[1]?.[doc.system?.identifier]) add(1, "@UUID[" + doc.uuid + "]");
    }
  }
  for (const swaps of [hero.replacedClassFeatures, hero.replacedSubclassFeatures]) {
    for (const [level, pairs] of Object.entries(swaps ?? {})) {
      for (const [original, replacement] of Object.entries(pairs)) {
        add(Number(level), escape(original.replaceAll("-", " ")) + " → @UUID[" + replacement + "]");
      }
    }
  }
  if (hero.subclass) add(3, "@UUID[" + hero.subclass + "]");
  const levels = await Promise.all([...byLevel].sort(([a], [b]) => a - b).map(async ([level, links]) => ({
    level, html: await enrich([...links].map(link => "<li>" + link + "</li>").join(""), base.document)
  })));
  return { ...base, name, img: hero.img, sourceLabel: module.title ?? "World of Warcraft", advancements: [],
    sourceDocumentUuid: book?.visible !== false ? book?.uuid : null,
    warcraft: { heading: "Becoming " + (/^[aeiou]/i.test(name) ? "an " : "a ") + name,
      rules: book?.text?.content && book.visible !== false ? await enrich(book.text.content, book) : "",
      baseName: base.name, levels } };
}
