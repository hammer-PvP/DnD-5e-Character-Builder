import {
  MODULE_ID, ABILITIES, STANDARD_ARRAY, POINT_BUY_COSTS, POINT_BUY_BUDGET, defaultSettings
} from "../constants.mjs";
import { SourceRegistry } from "../services/source-registry.mjs";
import { DraftManager } from "../services/draft-manager.mjs";
import { AdvancementService } from "../services/advancement-service.mjs";
import { EquipmentService } from "../services/equipment-service.mjs";
import { ShopService } from "../services/shop-service.mjs";
import { EquipmentShopApp } from "./equipment-shop-app.mjs";
import { SpellAccessService } from "../services/spell-access-service.mjs";
import { HitPointService } from "../services/hit-point-service.mjs";
import { ValidationService } from "../services/validation-service.mjs";
import { SourceResolver } from "../services/source-resolver.mjs";
import { CustomBackgroundService, CUSTOM_BACKGROUND_UUID } from "../services/custom-background-service.mjs";
import { ItemGrantIntegrityService } from "../services/item-grant-integrity-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TextEditorImplementation = foundry.applications.ux.TextEditor.implementation;

export class CharacterBuilderApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.draft = null;
    this.registry = new SourceRegistry();
    this.previewUuid = null;
    this.previewKind = null;
    this.pendingPrimaryUuid = { species: null, class: null };
    this.pendingCharacterName = null;
    this.primarySelectionBusy = false;
    this.primaryListScroll = { species: 0, class: 0 };
    this.renderedStep = null;
    this.pendingStepScroll = null;
  }

  static DEFAULT_OPTIONS = {
    id: "dnd5e-character-builder",
    classes: ["character-builder", "standard-form"],
    tag: "form",
    position: { width: 1240, height: 840 },
    window: { title: "Character Builder", resizable: true }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/character-builder.hbs` }
  };

  get id() {
    return `dnd5e-character-builder-${this.actor.id}`;
  }

  render(options = {}) {
    const visibleStep = this.renderedStep;
    const targetStep = this.draft ? DraftManager.getBuildState(this.draft).step ?? "abilitiesBackground" : visibleStep;
    const content = this.element?.querySelector?.(".cb-step-content");
    if (visibleStep && targetStep === visibleStep && content) {
      this.pendingStepScroll = { step: visibleStep, top: content.scrollTop };
      if (["species", "class"].includes(visibleStep)) this.#rememberPrimaryListScroll(visibleStep);
    } else {
      this.pendingStepScroll = null;
    }
    return super.render(options);
  }

  async _prepareContext() {
    this.draft ??= await DraftManager.getOrCreate(this.actor);
    await this.registry.load();

    let state = DraftManager.getBuildState(this.draft);
    const migratedStep = this.#normalizeStep(state.step);
    const migratedCharacterName = String(state.characterName ?? this.actor.name ?? "").trim() || "Player Character";
    if (migratedStep !== state.step || !state.characterName) {
      await DraftManager.setBuildState(this.draft, {
        step: migratedStep,
        characterName: migratedCharacterName
      });
      state = DraftManager.getBuildState(this.draft);
    }

    const settings = foundry.utils.mergeObject(defaultSettings(), game.settings.get(MODULE_ID, "settings") ?? {}, {
      inplace: false
    });
    const step = state.step ?? "abilitiesBackground";
    const species = this.draft.items.find(item => item.type === "race") ?? null;
    const background = this.draft.items.find(item => item.type === "background") ?? null;
    const characterClass = this.draft.items.find(item => item.type === "class") ?? null;

    let selectedBackgroundUuid = state.selectedBackgroundUuid
      ?? background?.getFlag(MODULE_ID, "sourceSnapshot")?.uuid
      ?? (background?.getFlag(MODULE_ID, "customBackground") ? CUSTOM_BACKGROUND_UUID : null)
      ?? background?._stats?.compendiumSource
      ?? background?.getFlag("dnd5e", "sourceId")
      ?? null;
    if (selectedBackgroundUuid && !CustomBackgroundService.isCustom(selectedBackgroundUuid) &&
        !this.registry.isUuidAllowed(selectedBackgroundUuid)) {
      selectedBackgroundUuid = null;
    }
    if (selectedBackgroundUuid !== state.selectedBackgroundUuid) {
      await DraftManager.setBuildState(this.draft, {
        selectedBackgroundUuid,
        abilitiesSaved: selectedBackgroundUuid ? state.abilitiesSaved : false
      });
      state = DraftManager.getBuildState(this.draft);
    }

    let preview = null;
    const primaryStep = ["species", "class"].includes(step) ? step : null;
    if (!primaryStep || this.previewKind !== primaryStep) {
      this.previewUuid = null;
      this.previewKind = null;
    }
    if (this.previewUuid && !this.registry.isUuidAllowed(this.previewUuid)) {
      this.previewUuid = null;
      this.previewKind = null;
    }
    if (this.previewUuid) preview = await this.registry.enrichDocument(this.previewUuid);
    if (!preview && primaryStep) {
      const fallback = primaryStep === "class" ? characterClass : species;
      const fallbackUuid = this.#primarySourceUuid(fallback);
      if (fallbackUuid) preview = await this.registry.enrichDocument(fallbackUuid);
    }

    const enabledMethods = Object.entries(settings.abilityMethods ?? {})
      .filter(([, enabled]) => enabled)
      .map(([id]) => ({ id, label: this.#abilityMethodLabel(id) }));
    const configuredMethod = state.abilityMethod ?? "pointBuy";
    const effectiveMethod = enabledMethods.some(method => method.id === configuredMethod)
      ? configuredMethod : enabledMethods[0]?.id ?? "pointBuy";

    const backgroundSource = selectedBackgroundUuid
      ? await this.#resolveBackgroundDocument(selectedBackgroundUuid)
      : null;
    const baseAbilities = state.baseAbilities ?? { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };
    const backgroundApplied = Boolean(background && state.abilitiesSaved);
    const selectedRollValues = (state.rollSets ?? [])[state.selectedRollSet] ?? [];
    const pointBuy = this.#pointBuySummary(baseAbilities);

    const abilities = ABILITIES.map(ability => {
      const base = Number(baseAbilities[ability.key] ?? 8);
      const optionValues = effectiveMethod === "standardArray" ? STANDARD_ARRAY
        : effectiveMethod === "roll" ? selectedRollValues : [];
      const nextCost = base < 15 ? POINT_BUY_COSTS[base + 1] - POINT_BUY_COSTS[base] : Infinity;
      const final = backgroundApplied
        ? Number(this.draft.system.abilities?.[ability.key]?.value ?? base)
        : base;
      return {
        ...ability,
        base,
        bonus: final - base,
        final,
        pointBuy: effectiveMethod === "pointBuy",
        usesSelect: ["standardArray", "roll"].includes(effectiveMethod),
        usesInput: effectiveMethod === "manual",
        canDecrease: base > 8,
        canIncrease: base < 15 && pointBuy.remaining >= nextCost,
        options: optionValues.map((value, index) => ({
          value,
          index,
          selected: Number(value) === base
        }))
      };
    });

    const backgroundGroups = [
      { id: "custom", label: "CUSTOM", items: [CustomBackgroundService.option(this.registry)] },
      ...this.registry.optionsByType("background")
    ].map(group => ({
      ...group,
      items: group.items.map(item => ({ ...item, selected: item.uuid === selectedBackgroundUuid }))
    }));
    const selectedBackgroundOption = backgroundGroups
      .flatMap(group => group.items)
      .find(item => item.uuid === selectedBackgroundUuid) ?? null;

    let backgroundSelection = null;
    if (backgroundSource) {
      const description = await TextEditorImplementation.enrichHTML(backgroundSource.system?.description?.value ?? "", {
        async: true,
        relativeTo: backgroundSource,
        secrets: true
      });
      const advancementSummary = this.#advancementData(backgroundSource).map(entry => ({
        title: entry.title || entry.type,
        hint: entry.hint || ""
      }));
      backgroundSelection = {
        uuid: selectedBackgroundUuid,
        name: backgroundSource.name,
        img: backgroundSource.img,
        description,
        advancementSummary,
        sourceLabel: CustomBackgroundService.isCustom(selectedBackgroundUuid)
          ? "CUSTOM"
          : this.registry.findOption(selectedBackgroundUuid)?.sourceLabel ?? "Enabled Source"
      };
    }

    const equipmentState = state.equipment ?? {};
    const equipmentPanels = [characterClass, background].filter(Boolean).map(item =>
      EquipmentService.buildPanel(item, this.registry, this.draft, equipmentState[item.id] ?? {})
    );
    const shoppingCart = await ShopService.context(this.draft, this.registry, { view: "committed" });
    const spellAccess = await SpellAccessService.buildContext(this.draft, this.registry);

    const steps = [
      { id: "abilitiesBackground", label: "Ability Scores & Background", complete: Boolean(background && state.abilitiesSaved) },
      { id: "species", label: "Species", complete: Boolean(species) },
      { id: "class", label: "Class", complete: Boolean(characterClass) },
      { id: "spells", label: "Spell Selection", complete: Boolean(state.spellAccessSaved) },
      { id: "equipment", label: "Starting Equipment", complete: Boolean(state.equipmentSaved) },
      {
        id: "review",
        label: "Review",
        complete: Boolean(background && state.abilitiesSaved && species && characterClass &&
          state.spellAccessSaved && state.equipmentSaved)
      }
    ].map(entry => ({ ...entry, active: entry.id === step }));

    const selectedSpeciesUuid = this.#primarySourceUuid(species);
    const selectedClassUuid = this.#primarySourceUuid(characterClass);
    const pendingSpeciesUuid = this.pendingPrimaryUuid.species;
    const pendingClassUuid = this.pendingPrimaryUuid.class;
    const effectiveSpeciesUuid = pendingSpeciesUuid ?? selectedSpeciesUuid;
    const effectiveClassUuid = pendingClassUuid ?? selectedClassUuid;
    const decoratePrimaryGroups = (groups, committedUuid, pendingUuid, effectiveUuid) => groups.map(group => ({
      ...group,
      items: group.items.map(item => ({
        ...item,
        committed: item.uuid === committedUuid,
        pending: Boolean(pendingUuid && item.uuid === pendingUuid && item.uuid !== committedUuid),
        checked: item.uuid === effectiveUuid
      }))
    }));

    return {
      actor: this.actor,
      draft: this.draft,
      state,
      characterName: this.pendingCharacterName ?? state.characterName ?? this.actor.name,
      step,
      steps,
      species,
      background,
      characterClass,
      preview,
      previewKind: this.previewKind ?? ({ race: "species", class: "class" }[preview?.type] ?? null),
      speciesGroups: decoratePrimaryGroups(
        this.registry.optionsByType("race"), selectedSpeciesUuid, pendingSpeciesUuid, effectiveSpeciesUuid
      ),
      speciesConfirmed: Boolean(selectedSpeciesUuid && !pendingSpeciesUuid),
      speciesConfirmDisabled: !effectiveSpeciesUuid || effectiveSpeciesUuid === selectedSpeciesUuid,
      speciesCanContinue: Boolean(selectedSpeciesUuid && !pendingSpeciesUuid),
      backgroundGroups,
      selectedBackgroundUuid,
      selectedBackgroundOption,
      backgroundSelection,
      classGroups: decoratePrimaryGroups(
        this.registry.optionsByType("class"), selectedClassUuid, pendingClassUuid, effectiveClassUuid
      ),
      classConfirmed: Boolean(selectedClassUuid && !pendingClassUuid),
      classConfirmDisabled: !effectiveClassUuid || effectiveClassUuid === selectedClassUuid,
      classCanContinue: Boolean(selectedClassUuid && !pendingClassUuid),
      abilities,
      abilityMethod: effectiveMethod,
      enabledMethods,
      rollSets: (state.rollSets ?? []).map((values, index) => ({
        index,
        label: `Set ${index + 1}`,
        valuesText: values.join(", "),
        selected: Number(state.selectedRollSet) === index
      })),
      selectedRollSet: state.selectedRollSet,
      rollLimit: settings.rollSets,
      canRollMore: settings.rollSets === 0 || (state.rollSets ?? []).length < settings.rollSets,
      pointBuy,
      spellAccess,
      equipmentPanels,
      shoppingCart,
      review: this.#reviewContext(),
      canFinalize: steps.find(entry => entry.id === "review")?.complete,
      sourceOrder: SourceRegistry.orderedSources().map(source => source.label)
    };
  }

  _onRender() {
    const root = this.element;

    const characterNameInput = root.querySelector('[name="characterName"]');
    characterNameInput?.addEventListener("input", event => {
      this.pendingCharacterName = event.currentTarget.value;
    });
    characterNameInput?.addEventListener("change", async event => {
      await this.#storeCharacterName(event.currentTarget.value);
    });

    root.querySelectorAll("[data-action]").forEach(element => {
      element.addEventListener("click", event => this.#onAction(event));
    });

    root.querySelectorAll("[data-filter-target]").forEach(input => {
      input.addEventListener("input", event => this.#filterOptions(event));
    });

    root.querySelectorAll('[name="abilityMethod"]').forEach(input => {
      input.addEventListener("change", async event => {
        await DraftManager.setBuildState(this.draft, {
          abilityMethod: event.currentTarget.value,
          abilitiesSaved: false
        });
        this.render({ force: true });
      });
    });

    root.querySelectorAll('[name^="abilities."]').forEach(input => {
      input.addEventListener("change", async () => {
        await this.#storeVisibleBaseAbilities();
      });
    });

    root.querySelectorAll('input[name="pendingSpecies"], input[name="pendingClass"]').forEach(input => {
      input.addEventListener("change", event => {
        const kind = event.currentTarget.dataset.kind;
        if (!kind || !Object.hasOwn(this.pendingPrimaryUuid, kind)) return;
        this.#rememberPrimaryListScroll(kind);
        const checked = event.currentTarget.checked;
        this.pendingPrimaryUuid[kind] = checked ? event.currentTarget.value : null;
        this.previewUuid = checked ? event.currentTarget.value : null;
        this.previewKind = checked ? kind : null;
        this.render({ force: true });
      });
    });

    root.querySelectorAll('input[name="spellAccess.cantrips"], input[name="spellAccess.spells"]').forEach(input => {
      input.addEventListener("change", async () => {
        this.#updateSpellCounters();
        await this.#storeVisibleSpellSelections();
        const confirm = this.element.querySelector('[data-action="save-spell-access"]');
        const proceed = this.element.querySelector('.spells-step [data-action="continue"]');
        if (confirm) confirm.disabled = false;
        if (proceed) proceed.disabled = true;
      });
    });
    this.#updateSpellCounters();

    root.querySelectorAll('[name^="equipment."]').forEach(input => {
      input.addEventListener("change", async () => {
        this.#refreshEquipmentVisibility();
        await this.#captureEquipmentSelection();
        this.render({ force: true });
      });
    });
    this.#refreshEquipmentVisibility();
    this.#restorePrimaryListScroll();
    this.#restoreStepScroll();
  }

  async #onAction(event) {
    event.preventDefault();
    const target = event.currentTarget;
    const action = target.dataset.action;

    switch (action) {
      case "step":
        await this.#navigateToStep(target.dataset.step);
        break;
      case "preview":
        this.#rememberPrimaryListScroll(target.dataset.kind);
        this.previewUuid = target.dataset.uuid;
        this.previewKind = target.dataset.kind;
        this.render({ force: true });
        break;
      case "open-preview": {
        const document = await fromUuid(target.dataset.uuid || this.previewUuid);
        document?.sheet.render(true);
        break;
      }
      case "configure-preview":
      case "configure-option":
        target.disabled = true;
        await this.#configurePreview(target.dataset.uuid, target.dataset.kind);
        break;
      case "confirm-primary": {
        const kind = target.dataset.kind;
        this.#rememberPrimaryListScroll(kind);
        const committed = kind === "species"
          ? this.draft.items.find(item => item.type === "race")
          : this.draft.items.find(item => item.type === "class");
        const uuid = this.pendingPrimaryUuid[kind] ?? this.#primarySourceUuid(committed);
        target.disabled = true;
        await this.#configurePreview(uuid, kind);
        break;
      }
      case "select-background":
        await DraftManager.setBuildState(this.draft, {
          selectedBackgroundUuid: target.dataset.uuid || null,
          abilitiesSaved: false,
          equipmentSaved: false
        });
        this.render({ force: true });
        break;
      case "continue":
        await this.#continue();
        break;
      case "back":
        await this.#back();
        break;
      case "roll-set":
        await this.#rollSet();
        break;
      case "select-roll-set":
        await DraftManager.setBuildState(this.draft, {
          selectedRollSet: Number(target.dataset.index),
          abilitiesSaved: false
        });
        this.render({ force: true });
        break;
      case "ability-adjust":
        await this.#adjustAbility(target.dataset.ability, Number(target.dataset.delta));
        break;
      case "save-abilities-background":
        await this.#saveAbilitiesAndBackground({ advance: false });
        break;
      case "save-spell-access":
        await this.#saveSpellAccess({ advance: false });
        break;
      case "open-shop":
        await this.#openShop();
        break;
      case "remove-cart-item":
        await this.#removeCartItem(target.dataset.uuid);
        break;
      case "save-equipment":
        await this.#saveEquipment({ advance: true });
        break;
      case "finalize":
        await this.#finalize();
        break;
      case "discard":
        await this.#discard();
        break;
      case "open-document": {
        const document = await fromUuid(target.dataset.uuid);
        document?.sheet.render(true);
        break;
      }
    }
  }

  async #storeCharacterName(value) {
    const characterName = String(value ?? "").trim();
    if (!characterName) return;
    this.pendingCharacterName = characterName;
    await DraftManager.setBuildState(this.draft, { characterName });
  }

  async #configurePreview(uuid = this.previewUuid, kind = this.previewKind) {
    if (!uuid || !kind || this.primarySelectionBusy) return;
    if (!this.registry.isUuidAllowed(uuid)) {
      return ui.notifications.error("That document belongs to a disabled content source.");
    }

    this.primarySelectionBusy = true;
    try {
      this.previewUuid = uuid;
      this.previewKind = kind;
      const document = await fromUuid(uuid);
      if (!document) return ui.notifications.error("The selected source document could not be loaded.");

      const type = { species: "race", class: "class" }[kind];
      if (!type) return;

      const current = this.draft.items.find(item => item.type === type);
      if (this.#primarySourceUuid(current) === uuid) {
        this.pendingPrimaryUuid[kind] = null;
        return;
      }

      if (type === "class") {
        await SpellAccessService.invalidate(this.draft);
        await EquipmentService.invalidate(this.draft);
      }
      ui.notifications.info(`Selecting ${document.name} with the native D&D5e Advancement flow.`);

      await AdvancementService.replacePrimaryDocument(this.draft, document, type, async () => {
        this.previewUuid = document.uuid;
        const changes = {};
        if (type === "class") {
          changes.spellAccess = {};
          changes.spellAccessSaved = false;
          changes.equipment = {};
          changes.equipmentSaved = false;
          await HitPointService.enforceFirstLevelMaximum(this.draft);
        }
        if (Object.keys(changes).length) await DraftManager.setBuildState(this.draft, changes);
        await SourceResolver.enforceAllowedSources(this.draft, this.registry);
      }, { registry: this.registry });
      this.pendingPrimaryUuid[kind] = null;
    } catch (error) {
      console.error(`${MODULE_ID} | ${kind} selection failed.`, error);
      ui.notifications.error(`Character Builder could not select that ${kind}: ${error.message}`);
    } finally {
      this.primarySelectionBusy = false;
      this.render({ force: true });
    }
  }

  #rememberPrimaryListScroll(kind) {
    if (!kind || !Object.hasOwn(this.primaryListScroll, kind)) return;
    const selector = kind === "species" ? "#cb-species-options" : "#cb-class-options";
    const list = this.element?.querySelector?.(selector);
    if (list) this.primaryListScroll[kind] = list.scrollTop;
  }

  #restorePrimaryListScroll() {
    const step = DraftManager.getBuildState(this.draft).step;
    if (!["species", "class"].includes(step)) return;
    const selector = step === "species" ? "#cb-species-options" : "#cb-class-options";
    const list = this.element?.querySelector?.(selector);
    if (!list) return;
    const scrollTop = Number(this.primaryListScroll[step] ?? 0);
    requestAnimationFrame(() => {
      const currentList = this.element?.querySelector?.(selector);
      if (currentList) currentList.scrollTop = scrollTop;
    });
  }

  #restoreStepScroll() {
    const step = DraftManager.getBuildState(this.draft).step ?? "abilitiesBackground";
    const pending = this.pendingStepScroll?.step === step ? this.pendingStepScroll : null;
    this.renderedStep = step;
    this.pendingStepScroll = null;
    requestAnimationFrame(() => {
      const content = this.element?.querySelector?.(".cb-step-content");
      if (content) content.scrollTop = pending ? Number(pending.top ?? 0) : 0;
    });
  }

  async #continue() {
    const state = DraftManager.getBuildState(this.draft);
    const step = state.step ?? "abilitiesBackground";

    if (step === "equipment") {
      this.#clearTransientPrimaryState();
      return this.#saveEquipment({ advance: true });
    }

    const order = ["abilitiesBackground", "species", "class", "spells", "equipment", "review"];
    const current = order.indexOf(step);
    const error = this.#stepValidation(step);
    if (error) return ui.notifications.warn(error);
    await this.#navigateToStep(order[Math.min(current + 1, order.length - 1)]);
  }

  async #back() {
    const state = DraftManager.getBuildState(this.draft);
    const order = ["abilitiesBackground", "species", "class", "spells", "equipment", "review"];
    const current = order.indexOf(state.step ?? "abilitiesBackground");
    await this.#navigateToStep(order[Math.max(current - 1, 0)]);
  }

  async #navigateToStep(step) {
    const normalized = this.#normalizeStep(step);
    this.#clearTransientPrimaryState();
    if (["species", "class"].includes(normalized)) this.primaryListScroll[normalized] = 0;
    this.pendingStepScroll = null;
    await DraftManager.setBuildState(this.draft, { step: normalized });
    this.render({ force: true });
  }

  #clearTransientPrimaryState() {
    this.previewUuid = null;
    this.previewKind = null;
    this.pendingPrimaryUuid.species = null;
    this.pendingPrimaryUuid.class = null;
  }

  #stepValidation(step) {
    const state = DraftManager.getBuildState(this.draft);
    if (step === "abilitiesBackground") {
      if (!this.draft.items.some(item => item.type === "background")) return "Select and confirm a Background.";
      if (!state.abilitiesSaved) return "Confirm valid Ability Scores and Background bonuses before continuing.";
    }
    if (step === "species" && !this.draft.items.some(item => item.type === "race")) return "Select a Species.";
    if (step === "class" && !this.draft.items.some(item => item.type === "class")) return "Select a Class.";
    if (step === "spells" && !state.spellAccessSaved) return "Complete the Class spell access selections before continuing.";
    if (step === "equipment" && !state.equipmentSaved) return "Save Starting Equipment before continuing.";
    return null;
  }

  async #rollSet() {
    const settings = foundry.utils.mergeObject(defaultSettings(), game.settings.get(MODULE_ID, "settings") ?? {}, {
      inplace: false
    });
    const state = DraftManager.getBuildState(this.draft);
    const rollSets = state.rollSets ?? [];
    if (settings.rollSets !== 0 && rollSets.length >= settings.rollSets) {
      return ui.notifications.warn("The configured roll-set limit has been reached.");
    }

    const results = [];
    for (let index = 0; index < 6; index++) {
      const roll = await new Roll("4d6dl1").evaluate();
      results.push(Number(roll.total));
    }
    rollSets.push(results);
    await DraftManager.setBuildState(this.draft, {
      rollSets,
      selectedRollSet: rollSets.length - 1,
      abilitiesSaved: false
    });
    this.render({ force: true });
  }

  async #adjustAbility(key, delta) {
    if (!ABILITIES.some(ability => ability.key === key) || ![-1, 1].includes(delta)) return;
    const state = DraftManager.getBuildState(this.draft);
    if ((state.abilityMethod ?? "pointBuy") !== "pointBuy") return;

    const base = foundry.utils.deepClone(state.baseAbilities ?? {});
    const current = Number(base[key] ?? 8);
    const next = current + delta;
    if (next < 8 || next > 15) return;
    base[key] = next;
    if (this.#pointBuySummary(base).remaining < 0) return;

    await DraftManager.setBuildState(this.draft, { baseAbilities: base, abilitiesSaved: false });
    this.render({ force: true });
  }

  async #storeVisibleBaseAbilities() {
    const form = new FormData(this.element);
    const state = DraftManager.getBuildState(this.draft);
    const base = foundry.utils.deepClone(state.baseAbilities ?? {});
    for (const ability of ABILITIES) {
      const value = Number(form.get(`abilities.${ability.key}`));
      if (Number.isFinite(value)) base[ability.key] = value;
    }
    await DraftManager.setBuildState(this.draft, { baseAbilities: base, abilitiesSaved: false });
    this.render({ force: true });
  }


  async #saveAbilitiesAndBackground({ advance = false } = {}) {
    try {
      const form = new FormData(this.element);
      const method = String(form.get("abilityMethod") ?? "pointBuy");
      const state = DraftManager.getBuildState(this.draft);
      const base = {};

      for (const ability of ABILITIES) {
        base[ability.key] = method === "pointBuy"
          ? Number(state.baseAbilities?.[ability.key] ?? 8)
          : Number(form.get(`abilities.${ability.key}`) ?? state.baseAbilities?.[ability.key]);
      }
      const baseError = this.#validateBaseAbilities(method, base, state);
      if (baseError) return ui.notifications.error(baseError);

      const backgroundUuid = String(form.get("selectedBackgroundUuid") ?? state.selectedBackgroundUuid ?? "");
      if (!backgroundUuid) return ui.notifications.error("Select a Background.");
      if (!CustomBackgroundService.isCustom(backgroundUuid) && !this.registry.isUuidAllowed(backgroundUuid)) {
        return ui.notifications.error("The selected Background belongs to a disabled content source.");
      }

      const source = await this.#resolveBackgroundDocument(backgroundUuid);
      if (!source) return ui.notifications.error("The selected Background could not be loaded.");

      const fingerprint = JSON.stringify({ method, base, backgroundUuid });
      const existing = this.draft.items.find(item => item.type === "background");
      if (state.abilitiesSaved && state.abilityBackgroundFingerprint === fingerprint && existing) {
        if (advance) await DraftManager.setBuildState(this.draft, { step: "species" });
        return this.render({ force: true });
      }

      // Remove the previous Background first so its native Advancement changes,
      // including Ability Score bonuses, are fully reversed by D&D5e.
      if (existing) await AdvancementService.removeItem(this.draft, existing);

      const baseUpdate = {};
      for (const ability of ABILITIES) baseUpdate[`system.abilities.${ability.key}.value`] = base[ability.key];
      await this.draft.update(baseUpdate);

      // The Background is passed to the native D&D5e AdvancementManager intact.
      // Its Ability Score Improvement is selected exactly once in the system UI,
      // alongside any other choices provided by the Background.
      await AdvancementService.addItem(this.draft, source, "background", null, {
        registry: this.registry
      });

      if (CustomBackgroundService.isCustom(backgroundUuid)) {
        await this.#ensureCustomBackgroundCommon();
      }
      await HitPointService.enforceFirstLevelMaximum(this.draft);
      await DraftManager.setBuildState(this.draft, {
        abilityMethod: method,
        baseAbilities: base,
        selectedBackgroundUuid: backgroundUuid,
        backgroundAbilityAssignments: {},
        abilityBackgroundFingerprint: fingerprint,
        abilitiesSaved: true,
        equipmentSaved: false,
        ...(advance ? { step: "species" } : {})
      });
      ui.notifications.info("Ability Scores and Background confirmed.");
      this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Ability Scores and Background failure`, error);
      ui.notifications.error(error.message);
    }
  }

  #validateBaseAbilities(method, base, state) {
    if (Object.values(base).some(value => !Number.isFinite(value))) return "Every Ability Score requires a value.";
    if (method === "pointBuy") {
      if (Object.values(base).some(value => value < 8 || value > 15 || !Number.isInteger(value))) {
        return "Point Buy values must be whole numbers from 8 to 15.";
      }
      const cost = Object.values(base).reduce((total, value) => total + POINT_BUY_COSTS[value], 0);
      if (cost > POINT_BUY_BUDGET) return `Point Buy exceeds the ${POINT_BUY_BUDGET}-point budget (${cost}/${POINT_BUY_BUDGET}).`;
    }
    if (method === "standardArray") {
      const actual = Object.values(base).sort((a, b) => b - a);
      const expected = [...STANDARD_ARRAY].sort((a, b) => b - a);
      if (actual.join(",") !== expected.join(",")) return "Use every Standard Array value exactly once.";
    }
    if (method === "roll") {
      const set = state.rollSets?.[state.selectedRollSet];
      if (!set) return "Roll and select a complete Ability Score set first.";
      const actual = Object.values(base).sort((a, b) => b - a);
      const expected = [...set].sort((a, b) => b - a);
      if (actual.join(",") !== expected.join(",")) return "Assign each value from the selected roll set exactly once.";
    }
    return null;
  }

  async #saveSpellAccess({ advance = false } = {}) {
    try {
      const form = new FormData(this.element);
      const result = await SpellAccessService.save(this.draft, this.registry, form);
      if (advance) await this.#navigateToStep("equipment");
      ui.notifications.info(`Class spell access saved (${result.created} Spell Items added).`);
      this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Spell access failure`, error);
      ui.notifications.error(error.message);
    }
  }

  async #captureEquipmentSelection() {
    if (!this.element?.querySelector?.(".equipment-step")) return null;
    try {
      const formData = Object.fromEntries(new FormData(this.element).entries());
      const plan = await EquipmentService.captureSelection(this.draft, this.registry, formData);
      const settings = foundry.utils.mergeObject(defaultSettings(), game.settings.get(MODULE_ID, "settings") ?? {}, {
        inplace: false
      });
      const shop = await ShopService.initializeDraft(this.draft, this.registry, plan.budgetBreakdown, settings, {
        equipmentFingerprint: EquipmentService.selectionFingerprint(plan.equipmentState)
      });
      if (shop.resetPurchases) {
        ui.notifications.info("Shop purchases were reset because the starting equipment choices changed.");
      }
      return plan;
    } catch (error) {
      console.error(`${MODULE_ID} | Unable to capture equipment selection.`, error);
      return null;
    }
  }

  async #openShop() {
    const plan = await this.#captureEquipmentSelection();
    if (!plan) return ui.notifications.error("Starting Equipment selections could not be prepared for the Shop.");
    new EquipmentShopApp(this.draft, this.registry, this).render({ force: true });
  }

  async #removeCartItem(uuid) {
    if (!uuid) return;
    try {
      const context = await ShopService.context(this.draft, this.registry);
      const row = context.cart.find(item => item.uuid === uuid);
      if (!row) return;
      await ShopService.changeQuantity(this.draft, this.registry, uuid, -Number(row.quantity ?? 1));
      this.render({ force: true });
    } catch (error) {
      ui.notifications.warn(error.message);
    }
  }

  async #saveEquipment({ advance = false } = {}) {
    try {
      const formData = Object.fromEntries(new FormData(this.element).entries());
      await EquipmentService.apply(this.draft, this.registry, formData);
      await DraftManager.setBuildState(this.draft, {
        equipmentSaved: true,
        ...(advance ? { step: "review" } : {})
      });
      ui.notifications.info("Starting Equipment saved to the draft.");
      this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Starting Equipment failure`, error);
      ui.notifications.error(error.message);
    }
  }

  async #finalize() {
    const error = ["abilitiesBackground", "species", "class", "spells", "equipment"]
      .map(step => this.#stepValidation(step)).find(Boolean);
    if (error) return ui.notifications.error(error);

    const state = DraftManager.getBuildState(this.draft);
    const characterNameInput = this.element.querySelector('[name="characterName"]');
    const characterName = String(
      characterNameInput?.value ?? this.pendingCharacterName ?? state.characterName ?? this.actor.name ?? ""
    ).trim();
    if (!characterName) return ui.notifications.error("Enter a Character Name before finishing the character.");
    await DraftManager.setBuildState(this.draft, { characterName });
    this.pendingCharacterName = characterName;

    const issues = ValidationService.validateDraft(this.draft);
    if (issues.length) return ui.notifications.error(issues.join(" "));

    try {
      await SourceResolver.enforceAllowedSources(this.draft, this.registry);
      await ItemGrantIntegrityService.reconcile(this.draft, this.registry, { context: "creation" });
      await AdvancementService.dedupe(this.draft);
      ItemGrantIntegrityService.validate(this.draft, { context: "creation" });
      await DraftManager.commit(this.actor, this.draft);
      ui.notifications.info(`${this.actor.name} was completed with Character Builder.`);
      this.close();
      this.actor.sheet.render(true);
    } catch (commitError) {
      console.error(`${MODULE_ID} | Character finalization failed.`, commitError);
      ui.notifications.error(`Character Builder could not apply the Draft: ${commitError.message}`);
    }
  }

  async #discard() {
    const confirmed = await Dialog.confirm({
      title: "Discard Character Builder Draft",
      content: "<p>Delete the current Character Builder draft? The original Actor will remain unchanged.</p>"
    });
    if (!confirmed) return;
    await DraftManager.discard(this.actor);
    this.close();
  }

  #advancementData(item) {
    const collection = item?.advancement;
    if (collection?.contents) return collection.contents.map(row => row.toObject ? row.toObject() : foundry.utils.deepClone(row));
    if (collection?.values) return [...collection.values()].map(row => row.toObject ? row.toObject() : foundry.utils.deepClone(row));
    return Object.values(item?.toObject?.().system?.advancement ?? item?.system?.advancement ?? {});
  }

  async #resolveBackgroundDocument(uuid) {
    if (CustomBackgroundService.isCustom(uuid)) return CustomBackgroundService.document(this.registry);
    return fromUuid(uuid);
  }

  #pointBuySummary(baseAbilities) {
    const spent = Object.values(baseAbilities).reduce((total, value) => total + (POINT_BUY_COSTS[value] ?? 99), 0);
    return { spent, remaining: POINT_BUY_BUDGET - spent, valid: spent <= POINT_BUY_BUDGET };
  }

  #abilityMethodLabel(id) {
    return { pointBuy: "Point Buy", standardArray: "Standard Array", roll: "Roll", manual: "Manual" }[id] ?? id;
  }

  #reviewContext() {
    if (!this.draft) return {};
    const species = this.draft.items.find(item => item.type === "race");
    const background = this.draft.items.find(item => item.type === "background");
    const cls = this.draft.items.find(item => item.type === "class");
    const feats = this.draft.items.filter(item => item.type === "feat");
    const spells = this.draft.items.filter(item => item.type === "spell" && !item.getFlag(MODULE_ID, "internalCache"));
    const equipment = this.draft.items.filter(item =>
      ["weapon", "equipment", "consumable", "tool", "container", "loot"].includes(item.type)
    );
    return {
      species: species?.name ?? "Not selected",
      background: background?.name ?? "Not selected",
      class: cls ? `${cls.name} ${cls.system.levels ?? 1}` : "Not selected",
      hp: this.draft.system.attributes.hp.value ?? 0,
      feats: feats.map(item => ({
        name: item.name,
        img: item.img,
        uuid: item.uuid,
        source: this.#itemSource(item, "Feature or Feat"),
      })),
      spells: spells.map(item => ({
        name: item.name,
        img: item.img,
        uuid: item.uuid,
        prepared: Number(item.system.prepared ?? 0),
        source: this.#spellSource(item)
      })),
      equipment: equipment.map(item => ({
        name: item.name,
        img: item.img,
        uuid: item.uuid,
        quantity: item.system.quantity ?? 1,
        source: this.#itemSource(item, "Starting Equipment")
      })),
      currency: this.draft.system.currency,
      abilities: ABILITIES.map(ability => ({ ...ability, value: this.draft.system.abilities[ability.key].value }))
    };
  }

  #spellSource(spell) {
    const source = this.#itemSource(spell, null);
    if (source) return source;
    return "Spell Selection";
  }

  #itemSource(item, fallback = "Character Builder") {
    const equipmentSource = item.getFlag(MODULE_ID, "sourceItemName");
    if (equipmentSource) return equipmentSource;

    const sourceItemId = item.getFlag(MODULE_ID, "sourceItemId");
    if (sourceItemId) {
      const sourceItem = this.draft.items.get(sourceItemId);
      if (sourceItem) return sourceItem.name;
    }

    const classItemId = item.getFlag(MODULE_ID, "classItemId");
    if (classItemId) {
      const classItem = this.draft.items.get(classItemId);
      if (classItem) return classItem.name;
    }

    const systemSourceItem = String(item.system?.sourceItem ?? "");
    if (systemSourceItem.startsWith("class:")) {
      const classIdentifier = systemSourceItem.slice("class:".length);
      const classItem = this.draft.items.find(candidate =>
        candidate.type === "class" && candidate.system.identifier === classIdentifier
      );
      return classItem?.name ?? "Class";
    }
    if (systemSourceItem) {
      const directSource = this.draft.items.get(systemSourceItem)
        ?? this.draft.identifiedItems?.get(systemSourceItem)?.first?.();
      if (directSource) return directSource.name;
    }

    const advancementOrigin = item.getFlag("dnd5e", "advancementOrigin");
    if (advancementOrigin) {
      const [itemId] = advancementOrigin.split(".");
      return this.draft.items.get(itemId)?.name ?? "Granted Feature";
    }

    return fallback;
  }

  #filterOptions(event) {
    const input = event.currentTarget;
    const target = this.element.querySelector(input.dataset.filterTarget);
    if (!target) return;
    const query = input.value.trim().toLowerCase();
    target.querySelectorAll(".cb-primary-option, .cb-spell-option").forEach(card => {
      card.hidden = Boolean(query && !card.dataset.search.includes(query));
    });
    target.querySelectorAll(".cb-source-group").forEach(group => {
      group.hidden = ![...group.querySelectorAll(".cb-primary-option, .cb-spell-option")].some(card => !card.hidden);
    });
  }

  #updateSpellCounters() {
    this.element.querySelectorAll("[data-spell-selection]").forEach(section => {
      const maximum = Number(section.dataset.maximum ?? 0);
      const inputs = [...section.querySelectorAll('input[type="checkbox"]')];
      const selected = inputs.filter(input => input.checked).length;
      section.querySelector("[data-selection-count]")?.replaceChildren(document.createTextNode(`${selected} / ${maximum}`));
      for (const input of inputs) input.disabled = !input.checked && selected >= maximum;
      section.classList.toggle("complete", selected === maximum);
      section.classList.toggle("invalid", selected > maximum);
    });
  }


  async #storeVisibleSpellSelections() {
    const form = new FormData(this.element);
    const cls = this.draft.items.find(item => item.type === "class");
    if (!cls) return;
    await DraftManager.setBuildState(this.draft, {
      spellAccess: {
        classIdentifier: cls.system.identifier,
        cantrips: [...new Set(form.getAll("spellAccess.cantrips").map(String))],
        spells: [...new Set(form.getAll("spellAccess.spells").map(String))]
      },
      spellAccessSaved: false,
      equipmentSaved: false
    });
  }

  #refreshEquipmentVisibility() {
    this.element.querySelectorAll("[data-equipment-panel]").forEach(panel => {
      const itemId = panel.dataset.equipmentPanel;
      const mode = panel.querySelector(`[name="equipment.${itemId}.mode"]:checked`)?.value ?? "package";
      panel.querySelector("[data-package-options]")?.toggleAttribute("hidden", mode !== "package");
      const packageIndex = panel.querySelector(`[name="equipment.${itemId}.packageIndex"]`)?.value ?? "0";
      panel.querySelectorAll("[data-package-index]").forEach(packageElement => {
        packageElement.toggleAttribute("hidden", packageElement.dataset.packageIndex !== String(packageIndex));
      });
    });
  }

  #primarySourceUuid(item) {
    return item?.getFlag(MODULE_ID, "sourceSnapshot")?.uuid
      ?? item?._stats?.compendiumSource
      ?? item?.getFlag("dnd5e", "sourceId")
      ?? null;
  }

  async #ensureCustomBackgroundCommon() {
    const source = this.draft.toObject();
    const current = foundry.utils.getProperty(source, "system.traits.languages.value") ?? [];
    const languages = Array.isArray(current) ? [...current] : Array.from(current ?? []);
    if (languages.includes("common")) return;
    await this.draft.update({ "system.traits.languages.value": ["common", ...languages] });
  }

  #normalizeStep(step) {
    if (["origins", "abilities"].includes(step)) return "abilitiesBackground";
    return step ?? "abilitiesBackground";
  }
}
