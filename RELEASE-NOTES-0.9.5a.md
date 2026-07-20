# Character Builder 0.9.5a — Release Notes

## Conservative Maintenance Patch

This patch intentionally changes only three isolated areas and does not alter class progression, spell ownership, protected commit behavior, or the GM batch progression tool.

### Reset Pending Level Up in XP Mode

- Keeps `Grant Level Up` and `Revoke Level Up` exclusive to Milestone Mode.
- Makes `Reset Pending Level Up` available to GMs in both Milestone and XP modes whenever a Level Up Draft or locked Hit Die result exists.
- Reset continues to delete only pending Level Up state and preserves the Actor's current XP.

### Character Sheet Button Spacing

- Preserves the approved `Start Character Builder` size, icon, colors, border, and proc animation.
- Adds an isolated sheet-header slot state and shifts only the Character Builder start button away from the D&D5e level ornament.
- Keeps the button non-shrinking and its glow visible without changing the permanent Level Up button.

### Responsive Settings Layout

- Constrains the Settings window to the current viewport.
- Keeps the compact Character Builder heading and action footer visible.
- Makes only the settings body vertically scrollable.
- Uses a two-column desktop grid and automatically returns to one column on narrower screens.
- Reduces accumulated spacing without reducing the primary control text.
- Adds a non-destructive `Cancel` action and preserves scroll position across rerenders.

## Compatibility

- Foundry VTT 14.364.
- D&D5e 5.3.3.
- Player's Handbook 2024 and SRD 5.2 Modern.
- SRD 5.1 remains unsupported.
