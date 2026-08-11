# Character Builder Settings Reference

This reference documents every visible Character Builder setting in v0.9.9o. Unless stated otherwise, settings are **world settings**, can be changed only by a Game Master, and do not require a server restart. Saving the settings window affects future Character Creation, Level Up, Character Keeper, or runtime-assistance operations; it does not retroactively delete character content.

## Splash Tutorial

### Don't Show Splash Tutorial

- **Scope:** Client/user preference.
- **Default:** Off.
- **Enabled:** The tutorial does not open automatically for that user. It can still be opened manually.
- **Disabled:** The tutorial may open according to the current tutorial revision.

### Show Splash Tutorial to Everyone Once

- **Scope:** One-time GM action, not a persistent toggle.
- **Effect:** Clears suppression for online users immediately and schedules the current tutorial revision for offline users at their next login.
- **Actor impact:** None.

## Content Sources

### Select Content Sources

- **Scope:** World.
- **Default:** Installed PHB 2024 and SRD 5.2 sources are enabled; SRD 5.1 is disabled.
- **Effect:** Controls which active module, system, and world Item compendiums supply Classes, Subclasses, Features, Feats, Spells, Backgrounds, Species, and equipment.
- **Disabled source:** Existing Actor content is not removed. The source is excluded from new Builder searches and choices.
- **Priority:** Higher-priority enabled sources win when equivalent content must be resolved.
- **Reload:** Not normally required.

## Rules Progression Model

### Rules Generation

- **Scope:** World.
- **Default:** Modern D&D (2024 / SRD 5.2).
- **Modern D&D:** Holds subclass selection until Class level 3 and normalizes older Class documents whose subclass choice was authored at level 1 or 2. Native D&D5e Advancement remains responsible for the actual selection and grants.
- **D&D 5th Edition (2014):** Preserves the levels authored in the selected Class and Subclass documents.
- **Actor impact:** A policy normalization pass updates only the structural subclass-choice level. Live Advancement values, Weapon Mastery, proficiencies, ItemGrant records, and ASI/Feat choices are preserved.
- **Conflict risk:** Modules that independently rewrite Class Advancement schedules may conflict.

## Ability Score Methods

At least one method must remain enabled.

### Point Buy

- **Default:** On.
- **Enabled:** Players can use the standard point-buy workflow.
- **Disabled:** Point Buy is removed from new Character Creation choices.

### Standard Array

- **Default:** On.
- **Enabled:** Players can assign the standard six values.
- **Disabled:** Standard Array is removed from new Character Creation choices.

### Custom Array

- **Default:** Off.
- **Enabled:** Players can assign the six GM-configured positional slots.
- **Disabled:** The saved six values remain stored but are not offered.
- **Values:** Each slot must be a whole number from 1 to 20. Equal numbers remain distinct slots.

### Roll

- **Default:** On.
- **Enabled:** Players can generate rolled sets.
- **Disabled:** Rolled Ability Scores are not offered.

### Manual Entry

- **Default:** Off.
- **Enabled:** Players can enter Ability Scores manually.
- **Disabled:** Manual entry is not offered.
- **Risk:** Enabling manual entry intentionally gives the player freedom outside the automated point/array limits.

### Roll Mode

- **Default:** Limited Rolls, 2 complete sets.
- **Single Roll:** Exactly one complete set.
- **Limited Rolls:** Allows the configured number of complete sets, including the first.
- **Unlimited Rolls:** Does not impose a set limit.
- **Actor impact:** Only new or currently edited creation Drafts are affected.

## Starting Equipment Shop

### Shop Bonus Gold

- **Scope:** World.
- **Default:** 0 GP.
- **Effect:** Adds the configured GP to a Character Creation Draft as soon as creation begins. The currency remains available whether or not the Shop is opened.
- **Disabled equivalent:** Set to 0.
- **Existing Actors:** Not changed.

## Level Up Availability

### Advancement Method

- **Default:** Milestone — GM Grant Required.
- **Experience Points:** Level Up becomes available at the next total-character-level XP threshold.
- **Milestone:** A GM must grant Level Up for that Actor.
- **Actor impact:** Changes availability only; it does not alter existing levels or XP.

### Enable Multiclass

- **Default:** On.
- **Enabled:** Players may add a new Class during Level Up.
- **Disabled:** Only existing Classes may be advanced. Existing multiclass Actors are not modified.

### Enforce Multiclass Requirements

- **Default:** On.
- **Dependency:** Has effect only when Enable Multiclass is on.
- **Enabled:** Applies the configured official prerequisite model.
- **Disabled:** Allows authorized multiclass selection without prerequisite enforcement.

### Enable Feats

- **Default:** On.
- **Enabled:** Allows optional Feat choices, including Feats that grant a +1 Ability Score increase.
- **Disabled:** Optional Feat selections are rejected after the native browser closes. Mandatory source grants and existing Feats remain unchanged.

### Enable Ability Score Improvement

- **Default:** On.
- **Enabled:** Allows the generic two-point Ability Score Improvement choice.
- **Disabled:** The generic ASI +2 route is rejected. Feat-granted +1 increases remain governed by Enable Feats.

### Enable Epic Boons

- **Default:** On.
- **Enabled:** Allows optional Epic Boon choices when otherwise eligible.
- **Disabled:** New optional Epic Boon choices are blocked. Existing Epic Boons are never removed.

### Enable Grant Epic Boons

- **Default:** Off.
- **Dependency:** Requires Enable Epic Boons.
- **Enabled:** Gives the GM controls to grant pending Epic Boon choices to eligible level-20 Player Characters.
- **Disabled:** New grants are unavailable; already applied boons remain.

## Character Keeper — Wizard Scribing

### Allow Spell Scroll Scribing

- **Default:** On.
- **Enabled:** Eligible Wizards can copy written spells and Spell Scrolls through Character Keeper.
- **Disabled:** The Keeper scribing launcher is unavailable. Existing spellbook entries are not changed.

### Charge Wizard Scribing Costs

- **Default:** On.
- **Enabled:** Deducts the configured official 50 GP per spell level.
- **Disabled:** The checkout still reports the rules cost but charges 0 GP.

### Require Arcana Check for Spell Scroll Scribing

- **Default:** On.
- **Enabled:** Requires a public Intelligence (Arcana) check against DC 10 + spell level.
- **Disabled:** A confirmed eligible attempt succeeds automatically.

### Charge Scribing Cost on Failed Check

- **Default:** On.
- **Dependency:** Relevant only when the Arcana check is required.
- **Enabled:** A failed check consumes the Spell Scroll and charges the GP cost.
- **Disabled:** A failed check consumes the Spell Scroll but preserves currency.

## Character Keeper — GM-Managed Rest Availability

### GM-Managed Rest Availability

- **Scope:** World, GM-only.
- **Default:** **Off**.
- **Disabled:** Character Builder does not restrict Short Rest or Long Rest. Native D&D5e behavior remains authoritative.
- **Enabled:** Native Short Rest and Long Rest buttons remain visible on completed Player Character sheets but are disabled until the GM grants the matching rest from **Character Builder Tool**.
- **Grant scope:** The Tool acts only on the characters currently selected by the GM. Short Rest and Long Rest availability are stored independently per Actor.
- **Player action:** A grant never performs the rest. It enables the normal native sheet button; the player chooses when to use it.
- **Visual state:** An available rest button is highlighted/glowing. A locked rest button remains visible but disabled.
- **Consumption:** One successful completed native rest consumes the matching grant after Character Keeper and enabled post-rest processing complete. If a post-native Keeper transaction fails and can be recovered, the grant is retained rather than forcing the player to request another rest.
- **Safety:** The restriction is checked both on sheet controls and in D&D5e's pre-rest hooks. Character Builder does not duplicate HP, Hit Dice, spell-slot, Item-use, or other native recovery logic.
- **Disabling later:** Existing Character Builder rest grants are cleared and normal unrestricted D&D5e rest behavior resumes.
- **Interaction with D&D5e settings:** This setting does not override a stricter native D&D5e rest policy or another module's independent restriction.

## Character Keeper — Player Character Sheet Integrity

### Player Character Sheet Integrity

- **Scope:** World, GM-only.
- **Default:** **Off**.
- **Disabled:** Character Builder does not add the protected-player sheet restrictions described below; the module's pre-existing class-progression protections remain independent.
- **Enabled — player may:** use/cast attacks, spells, features, Activities, consumables, potions, and scrolls normally; let D&D5e consume quantities/uses/slots through those workflows; prepare or unprepare eligible spells; equip or unequip; attune or unattune; favorite entries; expand descriptions; break concentration through the native control; and manually reorder/move Items already on the same Actor.
- **Enabled — player may not:** enter Actor or embedded-Item edit mode; directly edit Item data; add, delete, duplicate, identify, or recharge content from the sheet; drag/copy external Items from the sidebar/Compendium onto the Actor; manually alter currency, Item quantity, spell/Pact slots, Actor resources, Item uses, Activity uses, Heroic Inspiration, or Active Effects; or use chat-card **Refund Resource**.
- **Inventory integrations:** The restriction is intentionally applied to native/manual sheet UI paths, not globally to `Actor.createEmbeddedDocuments`, Item update/delete APIs, or D&D5e Activity consumption. Item Piles and other programmatic/API-based loot, trade, vendor, and transfer workflows remain compatible by design.
- **Internal organization:** A same-Actor drag with D&D5e's native `move` behavior is allowed so players can sort spells/items and organize inventory without creating new content.
- **GM:** GM interaction remains unrestricted.
- **Character Builder:** Character Builder, Level Up, Character Keeper, and authorized module transactions remain unrestricted.
- **Refund implementation:** Refund protection is handled at the chat-card UI/event layer. Character Builder does not wrap D&D5e `Activity.refund()`, avoiding libWrapper package-identity conflicts.
- **Implementation boundary:** The guard does not globally reject every Actor/Item update because legitimate D&D5e consumption/recovery and external gameplay integrations also update those documents from the player's client.


## Character Keeper — Optional Homebrew Rest Recovery

### Half Long-Rest Recovery on Short Rest

- **Scope:** World, GM-only.
- **Default:** **Off**.
- **Enabled:** After D&D5e completes a native Short Rest, Character Keeper additionally restores half of every eligible Long-Rest-only reserve, rounded down.
- **Disabled:** Character Builder performs no additional recovery. The Short Rest remains completely native.
- **Formula:** `min(missing, floor(maximum / 2))`.
- **Examples:**
  - Maximum 4, all 4 spent: recover 2.
  - Maximum 4, only 1 spent: recover 1.
  - Maximum 3, all 3 spent: recover 1.
  - Maximum 1: recover 0.
- **Eligible:**
  - normal spell slots recovered on Long Rest but not Short Rest;
  - Actor resources marked Long Rest and not Short Rest;
  - Item uses with Long-Rest-only recovery;
  - Activity uses with Long-Rest-only recovery.
- **Excluded:**
  - HP, Hit Dice, temporary HP, Death Saves, Exhaustion;
  - spell preparation and effects that expire on Long Rest;
  - consumable quantities and dawn/day recovery;
  - Pact Magic and any reserve already recovered by a native Short Rest;
  - resources with maximum 1, because half rounds down to 0.
- **Order:** The native Short Rest runs exactly once. The homebrew layer is applied afterward through a protected GM-authoritative transaction.
- **Audit:** Every applied recovery is listed in chat. A cooldown or no-resource result is also reported.
- **Conflict risk:** Disable this option when another rest module implements the same additional recovery.

### Short Rest Homebrew Cooldown

- **Scope:** World, GM-only.
- **Default:** 5 minutes.
- **Dependency:** Has effect only while Half Long-Rest Recovery on Short Rest is enabled.
- **Effect:** Uses Foundry's synchronized server time to limit only the additional homebrew recovery for each Actor.
- **During cooldown:** The native Short Rest still completes normally, including Hit Dice, Pact Magic, and ordinary Short-Rest resources. Only the extra homebrew recovery is skipped.
- **0 minutes:** Allows homebrew recovery on every completed Short Rest. Transaction locks and rest-session idempotency still block duplicate clicks and simultaneous requests.
- **Range:** 0–10080 whole minutes.
- **Persistence:** The Actor stores the next eligible server timestamp, so reloading the world does not reset the cooldown.

## Rules Automation Assistance

### Rules Automation Assistance

- **Scope:** World, GM-only.
- **Default:** Off.
- **Enabled:** Runs only the individually enabled assistance rules.
- **Disabled:** Suspends all assistance without erasing the per-rule choices.
- **Actor impact:** Does not remove Items or permanently rewrite weapon/spell formulas.
- **Conflict risk:** Disable individual rules already automated by another module.

### Configure Assistance Rules

Each rule is enabled by default inside the saved rule set, but does nothing while the master switch is off.

- **Great Weapon Fighting:** Treats eligible weapon damage die results of 1 or 2 as 3.
- **Thrown Weapon Fighting:** Adds the fighting-style bonus to eligible thrown attacks.
- **Cleric — Blessed Strikes: Potent Spellcasting:** Adds Wisdom to eligible Cleric cantrip damage.
- **Druid — Elemental Fury: Potent Spellcasting:** Adds Wisdom to eligible Druid cantrip damage.
- **Wizard — Empowered Evocation:** Adds Intelligence to one eligible damage roll of a Wizard Evocation spell.
- **Bard — Bardic Inspiration:** While the official native Bardic Inspiration effect is available, every eligible attack roll, ability check, skill check, tool check, or saving throw receives the same compact post-roll decision. Choosing Use rolls the source Bard's current die and removes the native effect; choosing Keep leaves it untouched. Item-origin effects are excluded.
  - Prompt visibility never depends on hidden AC/DC success or failure. The player sees the current total, source Bard, die, and **Use / Keep** only.
  - The decision has no visual blur/backdrop, remains draggable and on top, but is functionally modal: other clicks/actions are blocked until the decision is resolved.
  - When used, the public result reports totals only. A separate GM-only resolution may include the hidden target and Success/Failure result.
  - Uses the shared per-roll `character` phase before any `items`-phase provider. It returns its updated total without finalizing the queue early; finalization occurs only after all ordered providers/lifecycle finalizers complete. Structured `target` / `succeeded` data are internal coordination data and must not be used by providers as a player-facing prompt visibility condition.
- **Mage Armor Effect Application:** Applies and maintains the native Mage Armor effect on eligible targets.
- **Agonizing Blast Native Binding:** Maintains the native enchantment on the cantrip selected by the Invocation.
- **Paladin — Lay on Hands: Remove Poison:** After the native activity successfully spends its Lay on Hands cost, removes the native `Poisoned` status from the single recorded target using the D&D5e status API.
- **Contextual Roll Modifiers:** Reads declarative modifiers from active effects on the roller or the single current target and applies them only to the current native roll. Blade Ward 2024 is the first official adapter (`Incoming Attack Roll -1d4`). The runtime never writes the penalty onto the attacker or weapon.
- **Source-to-Target Damage Riders:** Appends a source document's native Damage Activity to the current Attack damage process only when that source Actor controls the matching effect on the single selected target. Hunter's Mark and Hex are the initial adapters; Foe Slayer supplies Hunter's Mark's improved native damage Activity when present. Hex also records the controller/source binding when D&D5e creates the GM-selected native `Hexed <Ability>` target effect, repairing its concentration dependency if an intermediary native usage card lost that anchor.
- **Bard — Cutting Words:** No automatic popup. A hostile target binds to its latest eligible Attack/Ability/Skill/Tool roll; a friendly target binds to the latest pending Damage message. The approved damage mode subtracts the Bardic die from D&D5e's final calculated damage immediately before HP, after normal resistance/vulnerability/immunity math.
- **Concentration & Dependent Effects:** After all Character/Item post-roll providers resolve, a failed Concentration save ends concentration through native `Actor.endConcentration()`. Effects bound through D&D5e `dependentOn` are then removed by the system. A post-roll bonus that turns the save into a success preserves concentration.

## Hit Point Advancement

At least one method must remain enabled.

### Roll Hit Die

- **Default:** On.
- **Enabled:** Allows a locked public Hit Die roll for the pending class level.
- **Disabled:** Roll is not offered.

### Average

- **Default:** On.
- **Enabled:** Allows the class average HP value.
- **Disabled:** Average is not offered unless used by the minimum-average safety rule for an allowed roll.

### Maximum Hit Die

- **Default:** On.
- **Enabled:** Allows the maximum Hit Die value.
- **Disabled:** Maximum is not offered.

### Use the class average whenever a locked roll is lower

- **Default:** On.
- **Enabled:** Replaces a lower locked roll result with the class average.
- **Disabled:** Uses the locked roll result as rolled.

### Default Method

- **Default:** Average.
- **Effect:** Preselects one of the enabled HP methods. It does not force the player to use it when other methods are allowed.

## Creation Prompt

### Ask whether to use Character Builder when a new Player Character Actor is created

- **Scope:** World.
- **Default:** On.
- **Enabled:** Shows the Builder/native-choice prompt after a new Player Character Actor is created.
- **Disabled:** Suppresses only the automatic prompt. The Builder remains available from its normal launch controls.
- **Actor impact:** Existing Actors are not changed.

## Maintenance

### Restore Current Version Defaults

- **Scope:** Protected GM action.
- **Effect:** Replaces world configuration with the defaults declared by the installed module version and refreshes discovered content sources.
- **Does not modify:** Actors, Items, levels, spells, features, progress records, transactions, Drafts, Scenes, or campaign data.
- **User preference option:** Can separately reset tutorial suppression/revision for individual users.
