# The comment-stripper ratchet now keys on SHAPE, not on a NAME (#1605)

#1588 converted 61 block-first comment strippers and took
`tests/guards/comment-stripper-order.test.ts` from a cap of 61 to 2. I reported
that as the ratchet reaching its floor.

It was accurate about the ratchet's population and wrong about the defect. The
classifier keyed on a declaration NAME:

```ts
const DECL = /(?:const|function)\s+(?:stripComments|stripped|withoutComments|decomment)\b/;
```

`social-routes-flag-gated` has one called `codeOf` — four lines, exactly the
wrong order — and the ratchet could not see it while reporting **2 against a
cap of 2 with a drift sentinel confirming no slack**. A reader had every reason
to believe the class was closed, which is the worst property a number can have.

## The population, measured by shape and order

| | |
|---|---|
| strippers inside the name-based population | 61 (all converted by #1588) |
| **outside it** | **31** |
| of those, block-first and real | 29 |
| of those, line-first and already correct | 2 |

Converted in this change: **10 by hand** (multi-line chains the #1588
converter's exact-text match missed) and **19 mechanically**, with the
converter extended for shapes it had not seen — a single-line-only block form
`/\/\*.*?\*\//g` that never handled a multi-line comment at all, and a
space-replacement line form.

Remaining: **6**, all legitimate, all named in `NOT_TYPESCRIPT` with a reason.

## Three measurement errors on the way, all the same shape

Recorded because the errors are more useful than the fix.

**Proximity for order.** My first census looked for a block strip with a line
strip *within eight lines*. The defect is ORDER, and the ratchet's own
`classifyLine` had always measured order. Mine measured nearness, and was wrong
in both directions: it called two line-first strippers offenders
(`scan-roots-resolve`, `overlay-viewport-units` — whose "unusual shape" turned
out to BE the correct order) and missed eight whose strips sit further apart.
Reported 24; the answer is 31.

**A constant's name for where it is applied.** Separately the same day, I
claimed a rate-limit tier did not exist because no constant was named for it —
twice, in opposite directions. See #1602.

**A file mentioning `.css` for a stripper's corpus.**
`no-renegade-color-tokens` matched because its docblock mentions `tokens.css`
while describing an OLD guard. Its `codeOf` runs over
`collectSourceFiles({ extensions: ['.ts', '.tsx'] })`.

Each was an attribute *near* the property, cheap to compute, and wrong — and in
each case the authoritative answer sat a few lines away in code already open.
After the third I stopped trying to pre-compute the CSS/TS split and let the
TESTS be the oracle: convert everything, run each suite, and a file whose
corpus `blankNonCode` does not suit fails its own assertions. All 29 passed,
which settled the question without a fourth proxy.

## `NOT_TYPESCRIPT` — six survivors, and `CSS_ONLY` was too narrow a name

`blankNonCode` is a TypeScript/JavaScript scanner. Pointed at another language
it does not merely fail to help; it mis-reads that language's comment syntax,
which is worse than the ordering it would replace.

- **CSS ×4** — `animation-vocabulary`, `r22-prb-border-and-focus`,
  `tokens-generated-in-sync`, `vendored-font-integrity`. `//` is not a comment
  in CSS, so there is no line pass to order wrongly.
- **SQL ×1** — `ag-ledger-migration-safety` strips `--` as well as `/* */`.
  `--` is not a comment in TypeScript at all, so `blankNonCode` would leave
  every SQL line comment in place: for a migration-safety guard that means
  reading commented-out DDL as real DDL.
- **Not a comment stripper ×1** — `nav-item-geometry-discipline` uses
  `/\/\*\*|\*\/|\*/g` to remove JSDoc MARKERS so the prose inside can be read.
  The opposite purpose, and `blankNonCode` would blank the very text it exists
  to examine. It matches the shape scan because a marker and a block-open share
  characters — the cost of keying on shape, and cheaper than keying on a name.

Pinned by IDENTITY as well as count: a bare cap of 6 would let a seventh
block-first TypeScript stripper land in slack vacated by one of these.
Requiring the set to be exactly these files makes the cap for a TypeScript
stripper 0. Every entry needs a reason ≥30 characters and a file that exists,
because an entry without a reason is indistinguishable from an omission.

## Two assertions had to be re-aimed, and one was mine

**The denominator floor.** It read `classified.length > 50`, right when 61
strippers existed and wrong the moment the conversions succeeded — a floor set
to yesterday's population fails on the work going well. The corpus floor
(`files.length > 600`) is the real "did we look" check and stays; the stripper
count now floors at the allowlist size, below which the identity assertion
could not hold anyway.

**A fourth deletion-measuring control.** `earth-engine-calls-are-bounded`
asserted `CODE.length < SRC.length` — measuring DELETION as proof the stripper
ran, which blanking cannot do. That is the same defect #1588 found in three
other controls, and this is the fourth. Now `toBe(SRC.length)` plus
`not.toBe(SRC)`: length preserved, content changed. The stronger property, and
the one that makes every reported offset line up with the real file.

## Mutation proof

A block-first stripper named `codeOf` — the exact blind spot — turns both the
cap (`7 block-first comment strippers, cap 6`) and the identity assertion red.
The old classifier would have reported it as clean.
