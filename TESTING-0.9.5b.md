# Character Builder 0.9.5b — Foundry Test Matrix

This patch changes only the presentation and lifecycle coordination of source-native D&D5e Advancement windows.

## 1. Character Creation — Species

1. Start Character Builder on a new level-0 character.
2. Select a Species that opens native choices.
3. Verify a dark backdrop covers the Foundry interface.
4. Verify the native Advancement is fully visible above the backdrop.
5. Click the Character Builder area behind it and verify no interaction occurs.
6. Complete the native flow.
7. Verify the backdrop disappears and Character Builder becomes interactive.
8. Verify the Species and its source-defined grants are unchanged from 0.9.5a.

## 2. Character Creation — Class

1. Select a Class with native choices.
2. Verify the same guarded modal behavior.
3. Resize or rerender Character Builder while the native window is open.
4. Verify the native window remains above Character Builder.
5. Complete the flow and verify Class data, Hit Points, and grants are correct.

## 3. Character Creation — Background

1. Select a Background with Ability Score and other native choices.
2. Verify background interaction is blocked outside the native window.
3. Close the native window without completing it.
4. Verify the backdrop is removed.
5. Verify Character Builder is interactive again.
6. Verify the prior Background, Ability Scores, Items, effects, and Draft flags are restored.
7. Reopen and complete the Background flow successfully.

## 4. Primary Selection Replacement Cancellation

1. Complete one Species selection.
2. Begin replacing it with another Species.
3. Complete any native removal step, then close the new selection Advancement.
4. Verify the original Species and its Draft changes are restored.
5. Repeat for Class.
6. Verify no duplicate or orphaned Advancement Items remain.

## 5. Level Up — Class Progression

1. Start a normal Level Up.
2. Resolve Hit Points and open native Class Progression.
3. Verify the backdrop and foreground priority.
4. Attempt to click Back, restart Class selection, or other Builder controls behind it.
5. Verify those controls do not respond.
6. Complete the native Advancement.
7. Verify the backdrop disappears and the Level Up flow proceeds normally.
8. Commit the Level Up and verify no transaction or history regression.

## 6. Level Up — Native Cancellation

1. Open native Class Progression.
2. Close or cancel it.
3. Verify the modal guard is removed.
4. Verify the Level Up Draft remains available.
5. Verify the locked Hit Die result remains unchanged.
6. Reopen native Class Progression and complete it.

## 7. Source-Native Feature Choice

1. Trigger a native feature choice opened during Level Up, such as a feat, subclass, Fighting Style, Weapon Mastery, proficiency, or another non-managed source choice.
2. Verify the same protected backdrop and foreground behavior.
3. Complete and cancel representative flows.
4. Verify the resulting source-native data is unchanged from 0.9.5a.

## 8. Single Active Advancement

1. Open a native Advancement through Character Builder.
2. Attempt to trigger another Character Builder-managed native Advancement before closing the first.
3. Verify the second flow does not open.
4. Verify the existing native window is kept in front.
5. Close the first flow and verify a later Advancement can open normally.

## 9. Native Dialog Regression

1. Use Previous, Restart, or close controls that cause D&D5e to open its own confirmation dialog.
2. Verify the D&D5e dialog appears above the native Advancement and remains usable.
3. Verify confirming or cancelling that dialog does not leave a stuck backdrop.

## 10. Error and Reload Cleanup

1. Cause or simulate an error while rendering the native window.
2. Verify no backdrop remains after the error.
3. Reload the browser while a native Advancement is open.
4. Verify the old backdrop cannot persist after reload.
5. Reopen Character Builder and verify the Draft remains recoverable.

## 11. Stable-System Regression Smoke Test

1. Complete one Character Creation from start to protected commit.
2. Complete one normal Level Up from start to protected commit.
3. Open Settings and verify the 0.9.5a responsive layout remains unchanged.
4. Verify `Reset Pending Level Up` remains available to the GM in XP Mode.
5. Verify the Character Builder sheet button spacing remains unchanged.
6. Verify no spell, Metamagic, Invocation, Pact of the Tome, ownership, GM tool, or protected-commit behavior changed.
