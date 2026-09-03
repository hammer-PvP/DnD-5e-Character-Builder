# Character Builder Settings Reference

This reference documents every visible Character Builder setting in v0.9.9x4. Unless stated otherwise, settings are **world settings**, can be changed only by a Game Master, and do not require a server restart. Saving the settings window affects future Character Creation, Level Up, Character Keeper, or runtime-assistance operations; it does not retroactively delete character content.

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

### Level Up Ready Sound

- **Scope:** World, GM-only.
- **Default:** Empty (no sound).
- **File selection:** Uses Foundry's native audio File Picker; the Test button plays locally without saving.
- **Channel:** Foundry **Interface Sounds**, so each user's Interface volume controls playback.
- **XP mode:** Plays only when an Actor crosses from below to at-or-above the next character-level XP threshold. Remaining above the threshold or unrelated Actor updates do not replay the cue.
- **Milestone mode:** Plays only when a previously unavailable GM Level Up grant becomes available.
- **Recipients:** The cue is broadcast to active non-GM users explicitly owning or assigned to that Actor; the initiating client also receives Foundry's local one-off playback.

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

## Character Keeper — Long Rest Spell Preparation

### Manage Long Rest Spell Preparation with Character Keeper

- **Scope:** World, GM-only.
- **Default:** **On**.
- **Enabled:** Cleric, Druid, Paladin, and Wizard ordinary level 1+ preparation is handled through Character Keeper at Long Rest. Players cannot prepare or unprepare those managed spells directly from the Actor sheet.
- **Disabled:** Character Keeper no longer offers the Long Rest preparation action and players regain normal manual preparation controls.
- **GM:** GM sheet edits remain allowed in either state.
- **Authorized transactions:** Character Creation, Level Up, Character Keeper commits, grants, and other Character Builder-authorized updates bypass the player guard.
- **Commit timing:** Keeper selections remain staged until the authoritative Long Rest finishes; cancelling D&D5e or Rest Recovery leaves the live prepared list unchanged.
- **Class cadence:** Ranger, Bard, Sorcerer, and Warlock do not gain Long Rest preparation from this option because their ordinary preparation/repertoire timing is Level Up.
- **Review tools:** The spell search/filter toolbar stays visible while scrolling long spell lists. **All** shows the ordinary preparation pool; **Prepared** shows only currently selected ordinary prepared spells and updates immediately as selections change.

## Character Keeper — GM-Managed Rest Availability

### GM-Managed Rest Availability

- **Scope:** World, GM-only.
- **Default:** **Off**.
- **Disabled:** Character Builder does not restrict Short Rest or Long Rest. Native D&D5e behavior remains authoritative.
- **Enabled:** Native Short Rest and Long Rest buttons remain visible on completed Player Character sheets but are disabled until the GM grants the matching rest from **Character Builder Tool**.
- **Grant/Revoke scope:** The Tool acts only on the characters currently selected by the GM. Short Rest and Long Rest availability are stored independently per Actor. If none or only some selected Actors currently have a rest grant, the control is **Grant** and normalizes all selected Actors to available. If every selected Actor already has that rest grant, the control becomes **Revoke** and removes it from all selected Actors.
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
- **Master switch:** Enables or disables the entire integrity layer without erasing the individual package choices.
- **Configure Integrity Rules:** Opens a separate GM configuration window with seven broad checkboxes. Every checkbox includes a short description of exactly what it protects and what normal gameplay remains available.
- **Recommended defaults:** The six established structural packages remain enabled by default; the new Hit Point Fields package is disabled by default. Existing worlds upgrading from the former all-or-nothing integrity setting inherit those recommended package values while retaining the previous master-switch state.
- **Character Data & Proficiencies:** Restricts manual Actor data such as name, portrait, biography, abilities, skills, saving throw proficiencies, languages, traits, senses, movement, and similar structural fields. Normal HP/gameplay state is not converted into a progression audit.
- **Inventory & Item Editing:** Restricts direct add/remove/duplicate/edit, external drops, and manual quantity/uses changes for weapons, equipment, consumables, containers, loot, and tools. Normal use/consumption, equip, attune, favorites, same-Actor sorting, and authorized programmatic inventory transfers remain available.
- **Character Content & Progression:** Restricts direct spell/feat/species/background/class-feature editing, Active Effect changes, external character-content drops, and unauthorized native Advancement changes. Normal casting and feature use remain available. When the GM explicitly disables this package while the master switch is enabled, Character Builder's direct class/subclass progression guard is relaxed for that intentionally permissive configuration.
- **Resources & Spell Slots:** Restricts manual spell-slot pips, Actor resources, Heroic Inspiration, and chat-card **Refund Resource**. Normal Activity consumption, rest recovery, and automated resource changes remain available.
- **Currency:** Restricts manual currency values on the Actor and containers. The native D&D5e Currency Manager remains available for Convert/Transfer, and Item Piles/API transactions remain supported.
- **Prepared Spell Limit:** When manual preparation is available, players cannot exceed the class's canonical normal preparation limit. When **Manage Long Rest Spell Preparation with Character Keeper** is enabled, the Keeper owns those Long Rest preparation changes instead. Always Prepared and feature-granted spells are excluded from the count.
- **Hit Point Fields:** Optional and disabled by default. When enabled, prevents protected players from typing directly into Current HP, Maximum HP, Temporary HP, and Temporary HP Maximum sheet controls **and** prevents manual HP changes through an HP-configured Token HUD resource bar. Native damage, healing, rests, Activities, automation, and GM edits remain available.
- **Allow Casting Unprepared Spells:** Configured only inside **Configure Integrity Rules**. **On** allows ordinary unprepared level 1+ spells; **Out of Combat Only** permits them only outside a started Combat; **Off** requires preparation everywhere. This casting policy is independent from the Character Keeper preparation-edit lock. Wizard Ritual Adept retains the qualifying out-of-combat ritual exception when casting is Off.
- **Prepared-limit activation:** When this package becomes active, any existing excess normal prepared spells on player-owned protected Actors are automatically unprepared from highest spell level to lowest. Within the same level, bottom-most entries are removed first. The GM is never asked to choose those excess spells one-by-one.
- **Prepared-limit warning:** A player attempting to prepare beyond the limit receives a normal Foundry warning such as `Paladin prepared spell limit reached (6/6). Unprepare another spell before preparing this one.` Despreparing is always allowed.
- **Character Validator boundary:** Ordinary daily prepared-count mismatch is no longer a Character Validation issue. The Validator still checks structural spell grants, Always Prepared state, full-list access, limited-list repertoire ownership, Wizard spellbook entitlements, and spell provenance.
- **Inventory integrations:** The restriction is intentionally applied to native/manual sheet UI paths, not globally to `Actor.createEmbeddedDocuments`, Item update/delete APIs, or D&D5e Activity consumption. Item Piles and other programmatic/API-based loot, trade, vendor, and transfer workflows remain compatible by design.
- **GM:** GM interaction remains unrestricted.
- **Character Builder:** Character Builder, Level Up, Character Keeper, and authorized module transactions remain unrestricted.


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
- **Concentration & Dependent Effects:** After all Character/Item post-roll providers resolve, a final failed Concentration save does **not** immediately end concentration. Character Builder posts a GM-only decision in Chat. **Keep Concentration** preserves the effect; **Drop Concentration** calls native `Actor.endConcentration()`, after which D&D5e handles dependent effects normally. A post-roll bonus that turns the save into a success never creates the decision card.
- **Managed Summons:** Materializes native D&D5e summons as linked managed Actors after `dnd5e.postSummon`, inherits ownership from the summoning Actor, preserves the native number of summons, and tracks each native summon invocation as one summon instance. The Ranger Primal Companion rule acts as a source-specific exclusive-companion policy. Concentration-linked summons are cleaned only after native concentration actually ends.
- **Managed Summons — Organize Companion Actors in Folders:** Stores managed summon Actors in a per-summoner Actor folder named `<FirstName> - Companions`. Disable this option to keep managed Actors at the Actor Directory root.
- **Summon Profile Level Guard:** Immediately before D&D5e calculates/consumes Activity resources, blocks a native Summon Activity when its own source-authored `level.min` / `level.max` profile restrictions leave `availableProfiles` empty at the effective spell/feature level. No slot or Item use is consumed. The rule is generic and also applies to constrained Summons invoked by native free-cast Forward Activities.
- **Weapon Mastery Chat Assistance:** Enriches the originating weapon Attack Activity card only when D&D5e confirms a mastery option for that Actor/weapon. The mastery name is a compact native link to the official D&D5e mastery reference. Graze adds a contextual damage button after a provable miss, Cleave adds a specialized weapon-damage button that omits a positive attack-ability modifier, and Topple shows only its calculated DC. Vex, Sap, Nick, Push, and Slow are link-only. No target, distance, turn, once-per-turn, or Action Economy state is tracked.
- **Ranger — Primal Companion:** Completes only the native summon lifecycle gaps. The finalized native synthetic Beast is materialized as a Ranger-specific linked Actor, starts at its already-derived maximum HP, inherits the Ranger Actor's ownership, and replaces that Ranger's previous companion. D&D5e remains authoritative for AC, PB, Beast's Strike, damage, effects, and maximum HP.
- **Homebrew — Healing Potion: Maximum Healing as Action:** Disabled by default. Eligible Healing Potions keep their native Bonus Action healing and gain a Character Builder-managed Action Healing Activity that maximizes every numeric die with Foundry's native `minN` modifier. **Configure Potions** auto-recognizes official Healing Potions and lets the GM register third-party/homebrew consumables by drag-and-drop. The Assistance/Potion configuration windows are intentionally non-modal so the GM can keep them open while browsing World Items and Compendiums; only the focused Activity choice after a drop is modal when needed.

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
