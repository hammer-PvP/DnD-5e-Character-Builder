# Character Builder 0.9.5

## Protected Character Creation

- Adds the same Protected Transaction confirmation and progress presentation used by Level Up to the final Character Creation commit.
- Persists a complete safety snapshot and transaction record before the first live Actor mutation.
- Applies the completed Draft with guarded stages, exact embedded Item IDs, transaction metadata, final verification, and full rollback on failure.
- Preserves the Character Creation Draft after a failed transaction.
- Detects interrupted Character Creation transactions on reconnect and restores the original Actor from the persistent snapshot.
- Locks further Character Builder changes and preserves the safety record when rollback cannot be verified.
- Handles D&D5e cached Cast spell Items conservatively during commit and rollback to avoid duplicate embedded-document deletion.

## GM Character Builder Tool

- Adds a full-width, GM-only `Character Builder Tool` button to the Actor Directory header.
- Milestone Mode lists eligible Player Character Actors and grants one Level Up to every selected Actor.
- XP Mode accepts a total XP value, divides it equally among selected Actors, truncates fractional XP, and displays the unassigned remainder.
- Writes only whole-number XP values and immediately allows normal Level Up eligibility to react to the new XP threshold.
- Records batch IDs, idempotency tokens, GM identity, timestamps, per-Actor results, and the latest applied XP batch.
- Keeps the existing individual `Grant Level Up`, `Revoke Level Up`, and `Reset Pending Level Up` controls on each Actor sheet.

## Sheet Interaction and UI

- Moves `Start Character Builder` into the D&D5e sheet-header rest controls and gives it the Character Builder stair/arrow icon, solid gold emphasis, dark border, and a restrained proc-style glow.
- Keeps a permanent Level Up button in the same interaction area after Character Creation.
- Shows unavailable Level Up at reduced opacity, fully disabled and non-interactive.
- Restores the traditional upward arrow for starting Level Up and adds a golden proc-style glow only while a new Level Up is available.
- Respects `prefers-reduced-motion` by replacing pulsing animations with a static glow.
- Makes the `Spells & Features` header and `Confirm Spells` action fixed while only the choice content scrolls.
- Uses the Character Builder stair/arrow icon in the creation prompt and settings identity.

## Compatibility

- Foundry VTT 14.364.
- D&D5e 5.3.3.
- Player's Handbook 2024 and SRD 5.2 Modern.
- SRD 5.1 remains unsupported.
