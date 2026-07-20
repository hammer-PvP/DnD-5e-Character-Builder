# Character Builder 0.9.5f — Native Feat Duplicate Filtering and Safe Recovery

This patch adds a narrow safety layer around the source-native D&D5e Ability Score Improvement feat browser.

## What changes

When a native ASI/feat Advancement opens the feat browser, Character Builder starts from the exact native browser filters and adds only deterministic exclusions:

- non-repeatable feats already owned by the projected Actor;
- Epic Boon feats while projected total character level is below 19.

The patch does not rebuild the feat catalog, decide when a class grants a feat, or infer complex prerequisites from descriptive text.

## Identity rules

Duplicate filtering uses, in order:

1. official source UUID (`flags.dnd5e.sourceId` or compendium source);
2. feat identifier plus official feat subtype for PHB/SRD mirror documents.

Display name is never used as mechanical identity. Feats marked repeatable remain selectable.

## Epic Boons

Epic Boon eligibility uses projected total character level.

- Projected level below 19: Epic Boons are excluded.
- Projected level 19+: Epic Boons remain available when the active native Advancement legitimately offers a general feat choice.
- Reaching total level 19 does not itself create a feat opportunity.

This allows valid multiclass cases such as Fighter 3 / Paladin 15 advancing Paladin to 16, while blocking the recurring native error that exposed Epic Boons to a single-class character at levels 4, 8, 12, or 16.

## Safe recovery

A browser result is checked before D&D5e applies it to the Advancement clone. If the result is invalid:

- the feat is not applied;
- the Level Up Draft is unchanged;
- the same feat browser reopens;
- the ASI alternative remains available;
- previous native choices and the locked Hit Die result remain intact.

Post-Advancement validation remains as a fallback for unsupported drag-and-drop or unexpected system paths.

## Compatibility

- Foundry VTT 14.364
- D&D5e 5.3.3
- Player's Handbook 2024
- SRD 5.2 Modern
