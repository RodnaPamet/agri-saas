# Insurance premium engine, parsers and product catalogue

Step 1 of five building the insurance premium calculator. Pure TypeScript:
no UI, no route, no database. Everything later imports these numbers — the
wizard, the server recompute on the lead, and the operator email — so this is
the step that gets the heaviest tests.

## Design

**Money is integer cents, the tariff is integer basis points.** The only
non-integer crossing the module boundary is `areaDca`, because decares
legitimately carry three decimals and three decimals of a decare are square
metres. Keeping money in cents means no step rounds a float, so the browser
and the server cannot disagree about a half-cent.

**Round-half-up in integers.** `premiumCents = floor((sumInsuredCents ×
tariffBp + 5_000) / 10_000)`. Adding half the divisor before flooring is
round-half-away-from-zero, with both operands integers throughout. Reference
case C (€37,500.55 at 10 %) lands on exactly 375,005.5 and is the test that
pins this.

**The remainder goes on the first instalment.** `base = floor(premium / n)`,
`first = premium − base × (n − 1)`. The schedule therefore always sums back to
the premium exactly; €10,000 in three is €3,333.34 + €3,333.33 + €3,333.33.
A property test asserts conservation over 2,000 seeded random inputs.

**Per-decare figures are display-only.** `premiumPerDcaCents` and
`sumInsuredPerDcaCents` are rounded per decare and will not reconstruct the
total — case B is four cents short on the round trip, and there is a test
asserting exactly that. The total is what gets paid. The type's doc comment
says so.

**Refuse, never throw, never NaN.** `quotePremium` returns
`{ ok: false, reason }` for bad input, so a caller that mishandles it gets a
visible failure rather than a figure that looks like money.

## Files

| file | holds |
|---|---|
| `src/lib/insurance/premium.ts` | `quotePremium`, `sumInsuredFromPerDca`, the caps, `INSURANCE_ENGINE_VERSION` |
| `src/lib/insurance/parse.ts` | `parseMoneyToCents`, `parseAreaDca` |
| `src/lib/insurance/products.ts` | the catalogue, `productForCrop`, `getProduct` |
| `src/lib/insurance/format.ts` | `formatCents` |
| `src/lib/insurance/index.ts` | barrel |

## Decisions

**The two parsers are deliberately asymmetric.** In money, a single separator
before exactly three digits means THOUSANDS: "100.000" and "100,000" are both
one hundred thousand. Nobody insures a crop for €100.000 meaning one hundred
euros, and reading it as a decimal would quote a premium 1,000× too small —
a silent wrong answer rather than an error. In area, "," and "." are ALWAYS
decimal, because cadastral areas are written "12,345 дка" and those three
decimals are real square metres. The same string parses to €12,345.00 and to
12.345 dca, and a test asserts both.

**`formatCents` exists beside `formatExactCurrency`.** Both
`formatExactCurrency` and `useExactMoneyFormatter` go through `formatDecimal`,
which sets only `maximumFractionDigits`, so they render €10,000 and €3,333.3.
A premium schedule must always show its cents — an instalment line reading
"€3,333.3" looks like a typo. `formatDecimal` is deliberately unchanged:
other screens depend on its output.

**`INSURANCE_ENGINE_VERSION`** is snapshotted on every lead in step 2, so a
stored quote can always be traced to the rounding rules that produced it.
Bump it on any change to rounding or tariff semantics.

**`productForCrop` matches token by token, and this was a finding.** The
roadmap specifies `productForCrop("Winter Wheat") === "wheat"`. Measured on
main: `normalizeCommodity("Winter Wheat")` returns **null** — the shared
vocabulary carries case variants and Bulgarian spellings but not varietal
names. And `'Winter Wheat'` is literally what this repo's seed data puts in a
parcel's crop. A whole-string lookup alone would therefore preselect nothing
for the very rows the wizard opens on.

Rather than add varietal aliases to `COMMODITY_ALIASES` — which the exchange,
market prices and planning all read, and which step 1 is not scoped to touch —
`productForCrop` tries the whole string first and then each token, normalising
every candidate through the same shared table so no spelling knowledge is
duplicated here. Tokens are split on non-letters rather than substring-matched,
so "ryegrass" does not match "rye".

If varietal names turn out to be wanted repo-wide, the alias table is the
right home and this fallback should be removed in the same change.

**`MAX_SUM_INSURED_CENTS` is self-checking.** A test asserts
`Number.isSafeInteger(MAX_SUM_INSURED_CENTS × 10_000)`, so raising the cap
without re-checking the product fails here rather than losing precision in
production.
