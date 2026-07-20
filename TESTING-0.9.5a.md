# Character Builder 0.9.5a — Foundry Test Matrix

This maintenance patch changes only XP-mode administrative reset visibility, the `Start Character Builder` sheet-button spacing, and the Settings window layout.

## 1. XP Mode — Reset Pending Level Up

1. Set `Advancement Method` to `Experience Points`.
2. Give a character enough XP to unlock Level Up.
3. Start Level Up, select or roll Hit Points, and close the Builder without committing.
4. Open the character sheet header controls as GM.
5. Confirm `Reset Pending Level Up` is present.
6. Confirm `Grant Level Up` and `Revoke Level Up` are absent in XP Mode.
7. Use `Reset Pending Level Up` and accept the confirmation.
8. Verify the Level Up Draft is deleted.
9. Verify the locked Hit Die result is deleted.
10. Verify current XP is unchanged.
11. Verify Level Up remains available when the Actor still meets the XP threshold.
12. Open the same Actor as a player and verify the administrative reset is not present.

## 2. Milestone Regression

1. Set `Advancement Method` to `Milestone — GM Grant Required`.
2. Verify `Grant Level Up` appears when no grant exists.
3. Grant a Level Up and verify `Revoke Level Up` replaces it.
4. Start but do not commit the Level Up.
5. Verify grant/revoke is disabled while pending.
6. Verify `Reset Pending Level Up` is present.
7. Reset the pending Level Up and verify the unused Milestone grant behavior remains unchanged from 0.9.5.

## 3. Start Character Builder Button

1. Open an uninitialized level-0 character sheet.
2. Verify the button retains the approved gold design, dotted stair icon, dark border, and proc glow.
3. Verify the button no longer touches or passes underneath the D&D5e level ornament.
4. Resize the sheet through its supported widths.
5. Verify the button does not shrink.
6. Verify the right and vertical glow remain visible.
7. Complete Character Creation and verify the normal Level Up button replaces the start button without a layout regression.

## 4. Settings — 1920×1080

1. Open `Character Builder Settings` on a 1920×1080 display.
2. Verify the window stays inside the viewport.
3. Verify the Character Builder heading remains visible.
4. Verify the `Cancel` and `Save Settings` footer remains visible.
5. Scroll the central body to reach every setting.
6. Verify the header and footer do not scroll.
7. Verify Content Sources spans the full width.
8. Verify the smaller setting groups use two columns.
9. Change source priority and save; reopen and verify persistence.
10. Change each existing setting category and verify save behavior is unchanged.
11. Click `Cancel` after changing controls and verify nothing is saved.

## 5. Settings — Smaller Viewports

1. Resize the Foundry browser or use a smaller monitor.
2. Verify the Settings window remains inside the viewport.
3. Verify the settings grid changes to one column at narrow width.
4. Verify there is no horizontal scrollbar.
5. Verify the source badges and ordering buttons remain usable.
6. Verify the internal vertical scrollbar is usable and visually integrated.
7. Trigger a rerender and verify the body returns to its previous scroll position.

## 6. Stable-System Regression Smoke Test

1. Complete one Character Creation commit.
2. Complete one normal Level Up commit.
3. Open the GM Character Builder Tool in Milestone Mode.
4. Open the GM Character Builder Tool in XP Mode.
5. Confirm no class, spell, Advancement, ownership, or protected-transaction behavior changed from 0.9.5.
