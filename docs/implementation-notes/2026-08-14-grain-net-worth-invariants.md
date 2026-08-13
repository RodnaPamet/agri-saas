# 2026-08-14 — The invariant that would have caught the calculator's cost bug

**Commit:** (pending — see PR)

Third of a three-prompt roadmap. See `2026-08-13-grain-calculator-one-answer.md`
and the uncertainty-vocabulary work that preceded it.

## The evidence

`finalizeRow` once returned `netWorth = netAssetPosition` for the "no cost
currency recorded anywhere" branch — subtracting no cost at all. The original
note records exactly why it survived:

> nothing inside the usecase could see it. `netWorth = netAssetPosition` is
> internally consistent and its unit tests passed. It became a contradiction
> only when this page put `cashCostTotal` on screen four inches from it.

That was still true. `tests/unit/grain-net-worth.test.ts` asserted hardcoded
outputs — `expect(wheat.netWorth).toBe(650)` — never the RELATIONSHIP between
the three fields. Every example was consistent with itself, which is precisely
the shape of test the bug passed. A wrong figure and a right figure are equally
easy to hardcode.

## The identity, applied where nobody has to remember it

`tests/helpers/grain-net-worth-invariants.ts` asserts, for every row:

```
netWorth != null  ⇒  netWorth === round2(netAssetPosition − cashCostTotal)
netWorth == null  ⇒  netWorthUnavailableReason is a non-empty string
```

The delivery mechanism matters more than the assertion. Rather than a new
bespoke test case, the usecase's test file wraps its own call:

```ts
async function netWorthResult(...args: Parameters<typeof getGrainNetWorth>) {
    const result = await getGrainNetWorth(...args);
    assertNetWorthInvariants(result.rows);
    return result;
}
```

All 33 call sites go through it. A scenario written about lease rent, payroll
attribution or exclusions now checks the arithmetic too, without its author
having thought about it — which is the point, because the author of the branch
that broke had not.

**Mutation proof.** Reintroducing `netWorth = netAssetPosition` fails at
`grain-net-worth-invariants.ts:61` — the identity, not a hardcoded expectation
— in the scenario *"subtracts cost that arrived with NO currency at all — the
journal-entered case"*: `650` expected, `750` received. Exactly the branch the
bug lived in.

The refusal invariant belongs in the usecase's contract rather than only in the
island's rendering, for the same reason: the island can only show what it is
given, so "a refusal is always explained" has to be guaranteed upstream of it.

## Narrowing the row

`CalculatorRow` went from **30 fields to 26**. Eight the island never read were
dropped; the presentation decisions it used to make moved to
`calculator/page.tsx`, which now MAPS the usecase row instead of
`JSON.parse(JSON.stringify(result))`:

| moved server-side | was |
|---|---|
| `netUncertainty` / `costUncertainty` | derived in the island per render |
| `costCurrencyCodes` / `rentCurrencyUnknown` | island filtered the rent sentinel itself |
| `showProduceRent` | island tested `rentCostProduceKg > 0` inline |
| `costBreakdown` | island assembled three labelled slices from three raw fields |

The island's existing property — *never re-derives a cost, a yield or a price*
— survives and is easier to see, because it now derives nothing at all.

## Files

| file | role |
|---|---|
| `tests/helpers/grain-net-worth-invariants.ts` | the identity + refusal contract |
| `tests/unit/grain-net-worth.test.ts` | one wrapper, 33 scenarios newly covered |
| `src/app-layer/usecases/grain-net-worth.ts` | +29 lines, contract only |
| `…/grain/calculator/page.tsx` | maps instead of round-tripping |
| `…/grain/calculator/CalculatorClient.tsx` | narrower DTO, no derivation |
| `…/grain/calculator/components.tsx` | `SumLine`, `ExclusionsCard`, `UnvaluedNote`, `describeEntry` |

## Decisions

- **The fixtures derive what the server derives.** Once `netUncertainty` moved
  server-side, a fixture could hardcode `EXACT` while setting
  `unvaluedNoUnitCost: 2` — a test asserting an unqualified headline and
  passing while production showed a bound. `withServerDerived` applies the same
  three derivations `page.tsx` applies, so the fixture models the server rather
  than wishing at it. Moving logic across a boundary silently converts
  "computed" into "supplied", and a supplied value in a fixture is a wish
  unless something ties it back.

- **The usecase's internals were not touched, and this is checkable.** The diff
  is 29 insertions and 0 deletions; no line touches `computeStandingCrop`,
  `computeGrainOnHand`, `computeAttributedCost`, `computeRent`,
  `computePayroll` or `computeCashOut`. The contract changed; the computation
  did not.

- **The invariant helper reports the commodity with the failure.** It compares
  `{ commodity, netWorth }` objects rather than bare numbers, because
  "expected 650, received 750" surfacing inside a scenario about lease rent is
  a poor way to learn that the identity broke.

## Where the brief's diagnosis was off

It said the island "is 919 lines largely because of" the wide DTO. Narrowing
the DTO removed roughly fifteen lines. The island was long because four
presentational components and a formatter shared its file; extracting them took
it from **655 to 557 code lines** (919 → 840 total). Both changes were worth
making — but the DTO was not the cause of the length, and it is worth recording
which lever actually moved it.
