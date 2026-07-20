# Character Builder 0.9.5c — Custom Sorcerer Metamagic

## Scope

This patch is dedicated to Sorcerer Metamagic. It does not change other class progression, the Native Advancement Modal Guard, protected commits, spell ownership, GM progression tools, settings, Eldritch Invocations, or Pact of the Tome.

## Custom Metamagic Selection

- Removes the Sorcerer Metamagic ItemChoice from the visible native Advancement queue.
- Keeps the official source ItemChoice as the structural owner of every Metamagic option.
- Presents new Metamagic options as Character Builder cards in `Spells & Features`.
- Requires exactly two new options at Sorcerer levels 2, 10, and 17.
- Opens source details from the card without changing its checkbox state.
- Keeps already-known options visible, greyed out, and unavailable.

## Optional Replacement

- Offers one optional Metamagic replacement after every Sorcerer level gained from level 3 onward.
- Keeps replacement separate from the two mandatory new choices at levels 10 and 17.
- The `Replace` list contains only Metamagic Items actually owned by the Sorcerer.
- The `With` list disables options already known, selected as new during the same Level Up, or identical to the option being removed.
- Selecting `No replacement` clears the dependent replacement choice immediately.

## Data Integrity

- Creates each selected option from the enabled source pool.
- Stores exact 16-character embedded Item IDs in native ItemChoice `added` and `replaced` values.
- Records source UUID, class Item ID, Advancement ID, transaction ID, character level, and Sorcerer level on each managed acquisition.
- Applies selection and replacement only to the Level Up Draft before protected commit.
- Restores the full pre-choice Draft snapshot if creation, deletion, validation, or source resolution fails.
- Preserves historical `added` records for a replaced original so the native replacement record remains resolvable.

## Compatibility

- Foundry VTT 14.364.
- D&D5e 5.3.3.
- Player's Handbook 2024 and SRD 5.2 Modern.
- SRD 5.1 remains unsupported.
