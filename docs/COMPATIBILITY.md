# Character Builder Compatibility Policy

Foundry VTT modules share one browser JavaScript context. Character Builder therefore cannot create a true sandbox around itself, but it can minimize assumptions about shared globals and coordinate unavoidable method interception.

## Required dependency

Character Builder requires libWrapper 1.13.5.1 or newer.

Official project:

`https://github.com/ruipin/fvtt-lib-wrapper`

The package manifest declares libWrapper under `relationships.requires` and includes its official manifest URL. Foundry can resolve the dependency during installation and prevents Character Builder from being enabled when the dependency is unavailable.

## Current wrapper inventory

Character Builder registers one `WRAPPER` target:

`dnd5e.applications.advancement.AdvancementManager.prototype._onClose`

The wrapper always continues the original call. It is used only to settle and clean up the protected native Advancement workflow. An official `closeApplicationV2` hook remains as an idempotent fallback. Sequential native remove/add transactions also reserve the Character Builder Advancement lane until both native windows finish, preventing another Builder workflow from entering between them.

## Shared-environment safeguards

- No direct replacement of Foundry, D&D5e, Array, Set, Map, Actor, Item, or Application prototype methods.
- No reliance on non-standard Array helpers such as `.first()`, `.last()`, `.compact()`, or `.unique()` for transaction-critical logic.
- Collection values are read through concrete Array, Set, and Map handling.
- Handlebars helpers use the full `dnd5eCharacterBuilder` prefix.
- Application windows include the unique `dnd5e-character-builder` class.
- Document flags, settings, sockets, and transaction metadata use the `dnd5e-character-builder` namespace.
- The public API is exposed through `game.modules.get("dnd5e-character-builder").api`.

## Conflict reports

A useful report includes:

- Foundry VTT version;
- D&D5e system version;
- Character Builder version;
- libWrapper version;
- complete active-module list;
- exact workflow and character choices;
- full browser-console stack;
- exported Actor JSON when Actor data is involved.

A stack frame from a generated `Bundle.js` should include the package or browser source path shown when the frame is opened in developer tools.
