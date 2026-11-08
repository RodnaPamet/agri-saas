# 2026-11-08 — removing the lev peg, and refusing лв/дка on write

**Issue:** #2793. **Owner ruling:** "Refuse лв/дка on write too, then strip
everything" (2026-11-08).

## Design

`bgnToEur()` and `BGN_PER_EUR = 1.95583` are gone, and with them every lev
branch: `normaliseCostToEur`, `canonicalCostCurrency`, and the division in
`rent-basis.ts`. A lev code is now refused exactly like a dollar one.

The issue argued this was dead code. It was *nearly* — and the gap is the
reason the ruling was needed.

```
#2793 measured:  CostEntry BGN 1 row -> DELETED      ✓ dead
                 Contract           0 rows           ✓ dead
                 ExchangeListing    all EUR          ✓ dead
#2793 did NOT measure:
                 rent-basis.ts:206  BGN_PER_EUR      ← a FOURTH consumer
                 parcel-lease.ts:78 canonicalRentUnit('лв/дка') stored,
                                    with NOTHING refusing it
```

So a lev-priced lease was **creatable on 2026-11-08**, and removing the
division alone would have reported 500 лв/ha as 500 €/ha under a
`currency: 'EUR'` label — a silent ~96% overstatement, where the old code was
at least exact. Production had **0 leases** (`leases=0 priced=0 units=none`),
so nobody was affected either way; the order is what mattered.

Hence two halves, in this order:

1. **The write path refuses it.** `assertRecordableRentUnit` in
   `parcel-lease.ts` throws `LEASE_RENT_UNIT_NOT_EUR` for a money rent unit
   whose currency is not `RENT_MONEY_CURRENCY`. `lease-payment.ts` applies the
   same function to a SUPPLIED payment unit.
2. **The read path refuses it.** `resolveRentBasis` returns its
   `{ resolved: false, raw, reason }` arm, so a lev lease lands in
   `grain-net-worth`'s `leasesUnresolvedRent` — a named exclusion with a
   reason, not a figure.

## Files

| File | Role |
|---|---|
| `src/lib/exchange/currency.ts` | `BGN_PER_EUR` + `bgnToEur` DELETED; the docblock records why neither should come back |
| `src/lib/grain/currencies.ts` | lev arms removed from `normaliseCostToEur` and `canonicalCostCurrency`; the `import` of the peg is gone |
| `src/lib/agro/rent-units.ts` | NEW `RENT_MONEY_CURRENCY` + `isRecordedMoneyRentUnit` — one constant, three call sites |
| `src/lib/grain/rent-basis.ts` | the money arm refuses a non-EUR currency instead of dividing |
| `src/app-layer/usecases/parcel-lease.ts` | `assertRecordableRentUnit`, exported; `updateParcelLease` now reads `rentUnit` for the comparison |
| `src/app-layer/usecases/lease-payment.ts` | the same rule on a supplied unit, with the lease's own unit exempt |
| `messages/{en,bg}/app.json` | `LEASE_RENT_UNIT_NOT_EUR` |
| `src/lib/openapi/paths/leases.paths.ts` | the code on all three write operations |
| `src/lib/openapi/paths/grain.paths.ts` | the five peg descriptions #2793 named |

## Decisions

- **`RENT_UNIT_LEVA` STAYS canonical.** Dropping it from the canonical set
  would make a stored lev lease an *unrecognised* unit, and
  `resolveRentBasis`'s refusal for that case says the figure "may be a
  per-hectare or absolute-per-parcel figure" — false of a per-decare lev rate,
  and it would send a reader off to parse free text. Recognised-and-refused is
  a named refusal; unrecognised is a shrug.

- **The refusal compares the CURRENCY, not the unit.** `canonical ===
  RENT_UNIT_LEVA` would work today and fail silently the next time a money unit
  is added to `MONEY_RENT_UNIT_CURRENCY` — which is precisely the change
  `grain-net-worth.ts` predicted in a comment as the one that would revive its
  `RENT_CURRENCY_UNRECORDED` branch. Comparing currencies makes a new money
  unit refused by default.

- **A legacy lev lease stays EDITABLE, and this mirrors
  `COST_ENTRY_LEGACY_CURRENCY_LOCKED` deliberately.** The refusal is on a
  CHANGE: restating the row's own unit is accepted, because the form posts
  every field and an operator correcting the lessor's name resubmits the stored
  `лв/дка`. A flat check would make such a lease permanently uncorrectable.
  `€/дка` is accepted as the way out, and moving BACK is refused — the
  exemption is keyed on the row's own stored unit, so no lease can reach lev in
  two edits.

- **A payment against a legacy lev lease still books.** The obligation is owed
  whatever this product can report, and refusing would lose a real settlement
  and report the lessor unpaid for ever. Only a SUPPLIED unit that differs from
  the lease's own is judged.

- **The LABEL and the AMOUNT moved together.** That invariant is stated at
  three sites in `grain-net-worth.ts` and was the whole content of #2546 and
  #2547, which went in opposite directions. Removing a peg is the third
  instance: `canonicalCostCurrency` stopped folding `BGN` in the same change as
  `normaliseCostToEur` stopped converting it, so an all-lev farm is coherent in
  lev again — exactly as it was before #2546 — and the euro SPELLINGS still
  fold, which is the half #2546 was built for.

- **`BGN_PER_EUR` was not kept as a historical record.** Its own docblock said
  it was exported so "the migration note, the tests and any future backfill all
  read the same constant", and the migration
  (`20260729120000_exchange_euro_denomination`) carries `ROUND(p / 1.95583, 2)`
  as a SQL literal. A migration is immutable, so it is the better authority —
  and a peg constant with no consumer is the next relabelling waiting for a
  caller.

- **Two test cases would have gone VACUOUS rather than red**, which is why
  every lev fixture moved to `€/дка` rather than being left to fail. Area
  independence (`expect(small).toEqual(large)`) compares two identical
  refusals; a zero-rent case asserting `resolved: false` stops saying anything
  about zero. Both now carry a control asserting the result RESOLVED.

- **`rentUnit` precedence over `rentUnitRaw` got a stronger test for free.**
  Its two values are now on opposite sides of the refusal, so inverting
  precedence produces a REFUSAL rather than a number off by the old peg.
