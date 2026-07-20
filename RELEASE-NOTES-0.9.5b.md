# Character Builder 0.9.5b — Release Notes

## Native Advancement Modal Guard

This patch is limited to window priority and interaction safety around source-native D&D5e Advancement flows.

When Character Builder opens a native Advancement:

- the native window is kept above Character Builder;
- a dark protected backdrop blocks the Builder, Actor sheet, and other background controls;
- the active Character Builder application is made inert while the native window is open;
- a second native Advancement cannot be opened concurrently;
- rerendering Character Builder cannot place it above the active native window;
- completion, cancellation, closing the window, or a render error always removes the temporary guard.

The backdrop does not replace or restyle the D&D5e Advancement window. All source-native choices, validation, and document application remain controlled by D&D5e 5.3.3.

### Cancellation Safety

Character Creation Species, Class, and Background workflows now settle cleanly when their native Advancement is closed. When a replacement flow had already removed an earlier Draft selection, cancellation restores the pre-flow Draft snapshot rather than leaving a partial selection state.

## Compatibility

- Foundry VTT 14.364.
- D&D5e 5.3.3.
- Player's Handbook 2024 and SRD 5.2 Modern.
- SRD 5.1 remains unsupported.
