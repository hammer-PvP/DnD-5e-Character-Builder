# Character Builder 0.9.5f — Native Feat Guard Test Matrix

## Single-class Epic Boon regression

Test an ordinary single-class character at each native ASI opportunity:

- level 3 → 4;
- level 7 → 8;
- level 11 → 12;
- level 15 → 16.

Expected: no Epic Boon appears in the native feat browser.

## Multiclass projected-level eligibility

### Valid Epic Boon case

Use Fighter 3 / Paladin 15 and advance Paladin 15 → 16.

Expected:

- projected total character level is 19;
- Paladin 16 supplies the legitimate ASI/feat opportunity;
- Epic Boons remain visible and selectable.

Repeat by advancing Fighter 3 → 4 from total level 18.

### No opportunity case

Reach total character level 19 on a class level that grants no ASI/feat Advancement.

Expected: Character Builder does not create any feat or Epic Boon choice.

## Non-repeatable duplicates

1. Acquire War Caster at an earlier ASI.
2. Open a later ASI feat browser.

Expected: War Caster is absent from the selectable results.

Repeat with a non-repeatable feat acquired from Background, Species, class, or subclass.

## Repeatable feats

Acquire an officially repeatable feat and open another valid feat opportunity.

Expected: the repeatable feat remains available when its other prerequisites are satisfied.

## Safe recovery fallback

Use a path that returns an invalid feat despite filtering, or temporarily remove the browser exclusion in a test copy.

Expected:

- an `Invalid Feat Choice` message appears;
- the feat is not applied to the native clone;
- the feat browser reopens;
- Ability Score Improvement remains available;
- no restart of Class Progression is required;
- the locked Hit Die result is unchanged.

## Regression checks

- Valid general feats remain visible.
- Origin Feat and other restricted ItemChoice pools are unchanged.
- Fighter bonus ASI levels remain source-driven.
- Metamagic selection and replacement remain unchanged.
- Warlock projected cantrip and Invocation target behavior remain unchanged.
- Commit and rollback remain unchanged.
