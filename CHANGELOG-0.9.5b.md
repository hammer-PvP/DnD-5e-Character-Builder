# Character Builder 0.9.5b

## Native Advancement Modal Guard

- Adds a protected full-screen backdrop whenever Character Builder opens a source-native D&D5e Advancement window.
- Keeps the active native Advancement above Character Builder without using an arbitrary global z-index.
- Blocks mouse and keyboard interaction with the Character Builder window while the native flow is active.
- Allows only one Character Builder-managed native Advancement at a time.
- Removes the backdrop and restores Character Builder interaction after completion, cancellation, window close, or a render error.
- Preserves the native D&D5e Advancement interface, data model, source choices, and application behavior.
- Safely restores Character Creation Draft state when a Species, Class, or Background replacement is cancelled after an earlier native removal step.

## Scope Preservation

- No class progression rules changed.
- No spell ownership or spell-selection behavior changed.
- No Metamagic implementation changed.
- No Eldritch Invocation or Pact of the Tome behavior changed.
- No protected commit, progression-tool, settings, or character-sheet control behavior changed.
