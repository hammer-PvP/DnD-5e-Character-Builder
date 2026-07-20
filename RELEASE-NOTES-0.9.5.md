# Character Builder 0.9.5 — Release Notes

This update focuses on safer Character Creation finalization, clearer player-facing progression controls, and a native GM workflow for advancing multiple Player Character Actors without macros.

## Highlights

- **Protected Character Creation Commit:** the final creation step now uses a guarded confirmation and real progress display, writes a persistent safety snapshot before changing the Actor, rolls back completely on failure, and restores interrupted transactions after reconnect.
- **Character Builder Tool:** a GM-only, full-width Actor Directory button grants Milestone Level Ups to selected characters or distributes a total XP award equally in XP Mode.
- **Integer XP distribution:** fractional results are truncated, the remainder is shown and left unassigned, and the normal XP threshold unlocks each player's Level Up button.
- **Individual controls preserved:** Grant Level Up, Revoke Level Up, and Reset Pending Level Up remain available on each Actor sheet in Milestone Mode.
- **Fixed Spells & Features header:** Confirm Spells remains visible while long choice lists scroll independently.
- **Progression interaction slot:** Start Character Builder uses the gold stair/arrow identity beside the native rest controls; the recurring Level Up button stays visible but disabled until available, then receives a restrained golden proc glow.

## Scope Notes

The GM tool grants authorization or XP only. It does not automatically select classes, roll Hit Dice, choose spells, or commit Level Ups for players. Character Keeper and rest-triggered maintenance remain future work.
