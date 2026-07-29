# Supplier (D&D 5e)

Supplier is a GM-facing stock generator for Foundry VTT 14 and D&D 5e 5.3.3. It creates native Items inside a timestamped World Items Folder so the Folder can be imported into Item Piles or another merchant module.

The module does not run commerce. It prepares the merchant stock.

## Alpha v0.0.1f

A Supplier profile is built from three independent layers:

1. **Mundane Catalog** — includes every eligible mundane Item, with a configurable quantity for each distinct Item;
2. **Guaranteed Items** — performs the configured number of independent selections and quality rolls;
3. **Random Stock** — generates its own explicit total, shared between all enabled random pools according to their weights.

Mundane and guaranteed Items are added outside the Random Stock total.

### Highlights

- source packs define only **where** a profile may search;
- stock rules filter the native D&D5e Item document type and the native subtype stored on each Item;
- Equipment subtypes are discovered from the selected packs, including Clothing, Light/Medium/Heavy Armor, Ring, Rod, Shield, Trinket, Wand, Wondrous Item, and compatible third-party values;
- Weapon subtypes use their native simple/martial and melee/ranged classifications;
- arbitrary profiles can mix any compatible categories; visual themes do not restrict stock;
- duplicate Items across SRD 5.1, SRD 5.2, PHB, DMG, or other enabled packs are consolidated while retaining alternate native subtype aliases;
- random and guaranteed slot selection uses a two-stage roll: first an enabled subtype bucket, then one Item inside that bucket;
- large categories such as Wondrous Item no longer dominate smaller categories solely because they contain more documents;
- source magic Items and Supplier-generated equipment quality are separate behaviors;
- ready-made +1/+2/+3 source documents cannot exceed the enhancement unlocked by party level;
- party-quality mode selects a mundane weapon or armor base and then independently rolls mundane/+1/+2/+3 for every slot;
- compact configuration, collapsible repeated rules, preserved scroll/focus, Healing Potion families, background Spell Scrolls, positive prices, and timestamped World Item Folders remain available;
- every profile now has a dedicated Banned Items manager with source-specific bans, all-equivalent bans, multi-selection, search, filters, and bulk removal.

### Profile-specific banned Items

Each Supplier profile has its own **Banned Items** subpage. The GM can browse the exact source documents available to that profile and choose between:

- banning only the selected source document, leaving equivalent SRD/PHB/DMG/module versions available;
- banning every equivalent version with the same normalized name and Item document type.

The ban manager supports search, native type/subtype filters, source filters, multi-selection, per-row removal, and bulk removal. Legacy global bans from earlier Alpha builds are migrated into every existing profile.

### Native filtering model

A rule follows this hierarchy:

1. enabled source packs;
2. Item document type, such as Weapon, Equipment, Consumable, Tool, Loot, or Container;
3. native Item subtype discovered in those packs;
4. magic state, rarity, party progression, exclusions, and quantity behavior.

A profile is not restricted by its theme. A castle quartermaster, for example, can combine weapons, armor, clothing, rings, trinkets, tools, consumables, and general supplies in the same profile.

### Equipment quality modes

- **Use source Item quality** allows ready-made named or enhanced documents from the selected packs, subject to rarity and party enhancement limits.
- **Roll quality by party level** selects mundane weapon/armor bases and applies the configured +0/+1/+2/+3 progression afterward.
- **Force mundane** keeps the selected base equipment mundane.
- **Fixed bonus** applies the selected bonus to eligible mundane weapon or armor bases.

## Installation manifest

```text
https://raw.githubusercontent.com/hammer-PvP/DnD-5e-Supplier/main/module.json
```

## GitHub release

Create the tag/release:

```text
v0.0.1f
```

Attach this exact asset:

```text
dnd5e-supplier.zip
```

`Release_git.zip` is provided as a publication helper and contains only:

```text
module.json
dnd5e-supplier.zip
```

## Basic workflow

1. Open **Configure Settings → Module Settings → Supplier Configuration**.
2. Enable and prioritize Item compendiums.
3. Create or edit a Supplier profile and select its sources.
4. Open the profile’s **Banned Items** subpage to exclude exact source documents or all equivalent versions.
5. Configure Mundane Catalog groups, Guaranteed Items, and Random pools.
6. Configure party rarity and enhancement progression.
7. Open the Items Directory and click **Supplier**.
8. Select a profile, enter party level and party size, and generate stock.
9. Confirm the loot to create a World Items Folder.

## Scope

- Foundry VTT 14;
- D&D 5e 5.3.3;
- GM-only configuration and generation;
- no required dependency on Item Piles or Item Creator;
- no redistribution of protected PHB or DMG content.

## Alpha notice

The v0.0.1 baseline was validated in a live Foundry test. v0.0.1f adds profile-specific source-aware ban management and configuration stability fixes; it requires live validation before being treated as stable.
