# 2026-07-29 — Locking the coverage gains into the floors

**Commit:** _(this PR)_

The `Coverage (≥60%)` gate was red on `main` for weeks and a long series
of test waves put it back to green. None of those waves lifted a floor,
so none of the gain was locked. This PR does the locking, from a
measured artifact, and closes the structural hole that let the previous
round of gains erode in the first place.

## Design

### Why a floor is the only defence

The coverage gate **runs on push to main only, never on PRs** — a
deliberate cost decision, re-confirmed and left alone here. A dip is
therefore invisible until after the merge. The floors in
`jest.thresholds.json` are the only thing that turns a dip into a
failure rather than a new normal, which is exactly how ~6 points leaked
away after PR #233 last calibrated them.

### Measure per threshold group, not from the whole-map total

Jest removes a file from the `global` group the moment it matches a PATH
threshold. `jest.thresholds.json` declares paths for
`./src/app-layer/{usecases,policies,events}/` and `./src/lib/`, so
`global` is scored over everything *else*. The `total` block in
`coverage-summary.json` is the whole map and is **not** the number the
gate checks `global` against — on this artifact they differ by 4.0
points on branches (69.36 whole-map vs 65.36 for the `global` group).

The re-aggregation reproduces jest's grouping exactly: PATH groups are
prefix-matched against the absolute path, a file matching any PATH group
leaves `global`, and `pct` uses istanbul's truncating
`floor(covered/total*10000)/100`.

It was validated against the last main run whose gate actually failed,
30456542044, whose log reads:

```
Coverage summary
Statements   : 80.14% ( 46125/57550 )
Branches     : 68.26% ( 28554/41830 )
Functions    : 69.53% ( 8146/11715 )
Lines        : 82.29% ( 42165/51235 )
Jest: Coverage for functions (62.65%) does not meet "global" threshold (64%)
```

Re-aggregating that run's artifact by group yields `global` functions
**62.65%** — CI's enforcement figure to the digit, while the whole-map
summary printed right above it says 69.53%. Two populations, both
correct; only the first one is the one the gate checks.

### Which artifact, and why it had to be this one

Two merges in quick succession each redefined the numbers, and measuring
before either one would have produced wrong floors.

**#458 (`5b361224`) changed the denominator.** It made
`coveragePathIgnorePatterns` actually apply. Its list holds 16 pure
re-export barrels; 15 were in the report and carried **350 functions,
212 of them uncovered, and zero branches** (the 16th,
`src/app-layer/notifications/index.ts`, is loaded by no test and was
already absent). The shift is the shape you would expect from removing
function-only noise: `global` functions 64.24 → 65.38 while `global`
branches is unchanged to the digit, because these files have no
branches at all; lines and statements move slightly *down* (`global`
statements 77.02 → 76.60), since the barrels' few statements were
covered.

**Wave 23 (#461, `f61def62`) changed the numerator.** It covered
`NewCropPlanModal`, `InventoryClient` and `ControlExceptionsPanel` —
+114 functions, all three in `src/components/**` / `src/app/**`, i.e.
squarely in the `global` remainder. So it moved `global` and nothing
else: functions 65.38 → **67.24**, branches 64.20 → **65.36**, with all
four path groups unchanged to two decimals.

That second merge is what makes the floors in this PR different from a
measurement taken an hour earlier. On the post-#458 artifact `global`
functions measured 65.38, so `measured − 2` was 63 — *below* the
enforced 64, unraisable. On the post-wave-23 artifact it measures 67.24,
`measured − 2` is 65, and the floor moves. The final numbers therefore
come from run **30483470674** (`main@f61def62`), which passed the gate.

The method was cross-checked along the way: the post-#458 numbers were
independently projected from the *pre*-#458 artifact (30472134775) by
removing the barrels by hand, and the projection matched the real
post-#458 artifact on all 20 metrics. Wave 23's own commit message
projected `global` functions at 67.17% from that same artifact; the
measured value is 67.24%. Close, but the floor was set from the
measurement, not the projection.

### Calibration

#233's convention, unchanged: **`measured − 2`, capped at 70, never
lowering an already-stricter floor.** The 2-point buffer absorbs
ordinary churn on a gate nobody sees until after merge; the cap is a
brittleness ceiling, because a hard gate above 70% reddens on any normal
untested-feature dip.

Applied faithfully, it moves three numbers:

| Group | Metric | Measured | Floor before | Floor after | Margin |
|---|---|---|---|---|---|
| `global` | functions | 67.24 | 64 | **65** | +2.24 |
| `usecases/` | branches | 70.99 | 67 | **68** | +2.99 |
| `lib/` | functions | 79.66 | 66 | **70** | +9.66 |

Every other metric is pinned, for one of two reasons:

- **the cap binds** (16 of 20 metrics): `measured − 2` lands above 70,
  so the floor stays at whatever an earlier pass earned — 88 for
  `policies/` functions, 77 for `usecases/` lines, and so on. The cap
  prevents *raising* past 70; it never licenses a drop;
- **`measured − 2` truncates to exactly the floor already in force**:
  `global` branches (65.36 − 2 = 63.36 → 63) and `events/` functions
  (63.41 − 2 = 61.41 → 61).

No metric measures below its current floor. The gate passes on today's
main with the new floors, with the margins in the table below.

**`global` branches is the one to watch.** At 65.36 its margin is
+2.36, so it now sits *outside* the 2-point buffer — but the floor
still cannot move, because truncating `measured − 2` lands on the 63
already enforced. It takes measured **≥ 66.00** before a floor of 64 is
justified. Since only the `global` remainder can move it, that is a
concrete target for the next wave.

### The second ratchet, which had gone stale

There are two "never lower a floor" mechanisms:

1. `jest.thresholds.json` — the ENFORCED floors, passed to jest by the
   CI gate via `--coverageThreshold`;
2. `RATCHET_FLOOR` in `tests/guards/coverage-ratchet.test.ts` — the
   STRUCTURAL floor that makes "never lowered" a CI failure rather than
   a convention.

They had drifted apart. `RATCHET_FLOOR` was seeded at the
post-Roadmap-3 state and never lifted when #233 recalibrated, so it sat
**ten points** below on `global` functions (54 vs an enforced 64), seven
below on `global` branches and `usecases/` functions, and four to five
below on `lib/`. A PR could have dropped the enforced global functions
floor from 64 to 55 and the guard would have passed it.

That gap mattered more than it looks, because the coverage gate does not
run on PRs: at PR time the static guard is the *only* thing that sees a
lowered floor at all. The mirror is now at parity, and
`quality-coverage-integrity.test.ts` — which already owned "keys + their
`RATCHET_FLOOR` parity" — now asserts VALUE parity too, so raising a
threshold requires raising its twin in the same diff.

## Observed vs enforced, all five groups

Run 30483470674, `main@f61def62`. Floors marked ✎ changed in this PR.

| Group | Metric | Observed | Floor | Margin |
|---|---|---|---|---|
| `global` | branches | 65.36 | 63 | +2.36 |
| `global` | functions | 67.24 | 65 ✎ | +2.24 |
| `global` | lines | 80.06 | 70 | +10.06 |
| `global` | statements | 77.75 | 70 | +7.75 |
| `usecases/` | branches | 70.99 | 68 ✎ | +2.99 |
| `usecases/` | functions | 78.40 | 70 | +8.40 |
| `usecases/` | lines | 85.04 | 77 | +8.04 |
| `usecases/` | statements | 82.82 | 75 | +7.82 |
| `policies/` | branches | 87.12 | 78 | +9.12 |
| `policies/` | functions | 96.82 | 88 | +8.82 |
| `policies/` | lines | 94.38 | 88 | +6.38 |
| `policies/` | statements | 93.65 | 85 | +8.65 |
| `events/` | branches | 77.01 | 72 | +5.01 |
| `events/` | functions | 63.41 | 61 | +2.41 |
| `events/` | lines | 81.59 | 78 | +3.59 |
| `events/` | statements | 80.28 | 75 | +5.28 |
| `lib/` | branches | 76.80 | 70 | +6.80 |
| `lib/` | functions | 79.66 | 70 ✎ | +9.66 |
| `lib/` | lines | 87.98 | 71 | +16.98 |
| `lib/` | statements | 86.06 | 70 | +16.06 |

## Files

| File | Role |
|---|---|
| `jest.thresholds.json` | The enforced floors. `global` functions 64→65, `usecases/` branches 67→68, `lib/` functions 66→70. |
| `tests/guards/coverage-ratchet.test.ts` | `RATCHET_FLOOR` brought to parity with the enforced floors (it was up to 10 points behind); header note records that parity is now required, not encouraged. |
| `tests/guards/quality-coverage-integrity.test.ts` | New VALUE-parity assertion + its mutation proof, and a `RATCHET_FLOOR` source parser with a non-vacuity check. |
| `.github/workflows/ci.yml` | Calibration provenance beside the gate step: run id, per-group measured figures, why only three floors moved. |
| `docs/coverage-policy.md` | Floors-vs-measured table refreshed (it predated #233); the mirror-lag hole and the parity rule documented; next-steps re-pointed at `global`. |
| `jest.config.js` | Two prose blocks that this PR invalidated: "how to raise" said ~3% below observed (the real convention is `measured − 2` capped at 70), and "why the global is below 60" described numbers from 2026-04. |

## Decisions

- **The convention was applied literally, including the cap, even though
  it makes for a thin diff.** Sixteen of twenty metrics measure well
  above 70 and could carry a much higher floor (`policies/` functions
  measures 96.82 against a floor of 88). Raising them would spend
  the brittleness budget #233 deliberately set aside, on a gate that
  gives no PR-time warning. Three floors moved; that is the honest
  output of the rule.
- **`global` branches was left alone rather than fudged.** At 65.36 its
  margin is +2.36, but `measured − 2` truncates to the 63 already
  enforced, so there is nothing to raise. Rounding *up* to 64 would cut
  the buffer to 1.36 and make the next ordinary feature PR turn main
  red — on a gate that gives no warning until after the merge. It is
  reported as the next target instead.
- **The measurement was retaken when main moved.** The first pass
  measured `main@5b361224` and correctly concluded `global` functions
  could not be raised (65.38 − 2 = 63 < the enforced 64). Wave 23
  merged during the work and added +114 covered functions to the
  `global` remainder; re-measuring on `f61def62` put it at 67.24 and
  the floor moved to 65. Deriving floors from a stale main is the
  specific error this campaign kept making, so the artifact was
  re-downloaded rather than the delta projected.
- **Value parity is now asserted, not merely encouraged.** The
  encouragement had already failed once, silently, for three months.
  The assertion parses `RATCHET_FLOOR` out of the test source rather
  than importing it, because exporting the constant would make a
  guard-private hard minimum look like a shared helper; the parser
  asserts it found ≥5 scopes so a regex miss cannot make the check
  vacuously green.
- **The gate still does not run on PRs.** Out of scope by direction;
  the static parity guard is the PR-time substitute.
