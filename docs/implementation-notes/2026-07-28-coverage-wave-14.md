# 2026-07-28 — Coverage wave 14: aiming at the group that actually fails

**Commit:** _(this PR)_

The first wave written after #433 made the coverage gate legible. Waves 1–13
(#405, #415, #419, #422, #424, #426, #428) covered 44 files and moved the gate
by +0.65 branches, because most of those files sit under the four path
thresholds that Jest removes from the `global` group. This wave targets the
`global` group only.

## Where the gap actually is

Re-derived from the `coverage-report` artifact of the last completed `main`
gate run, restricted to files NOT under `./src/lib/` or
`./src/app-layer/{usecases,policies,events}/`:

```
branches   59.95%  (12934/21575)   floor 63  ->  +659 needed
functions  60.54%  (3966/6551)     floor 64  ->  +227 needed
lines      76.53%  (20570/26878)   floor 70  ->  already passing
```

Matching the gate's reported 59.94 / 60.54 to two decimals confirms the
population is the right one. **Only branches and functions bind** — lines and
statements clear their floors comfortably. That reframes the work: a test that
merely executes a file's happy path adds lines and barely moves the gate. What
counts is exercising decision points.

## Files

| File | Role |
|---|---|
| `tests/rendered/filter-range-panel.test.tsx` | new — 20 behavioural tests over the range filter |
| `src/components/ui/date-picker/shared.ts` | −171 lines — three unreferenced helpers deleted |

## `FilterRangePanel`: 0% → 88.76% branches

The panel had **zero executing tests**. Eight `tests/guards/*` specs reference
it, but guards scan source as *text* and never mount the component, so every
decision point was unprotected — a distinction worth internalising when reading
the ranking, since a heavily-guarded file can still be at 0%.

The 20 tests cover four contracts:

- **Commit** — Enter, blur, cleared-bound widening, an inverted range being
  swapped rather than emitted backwards, and a custom parser's rejection
  applying nothing instead of emitting a `NaN`-derived token.
- **Keyboard stepping** — step direction, the zero-clamp, hundredths on a
  decimal-scaled (cents) filter, and an explicit `rangeNumberStep` beating the
  scale default.
- **Navigation** — Backspace-on-empty returning to the filter list, Backspace
  on a non-empty field editing instead, caret-driven hopping between the two
  bounds, and the capture handler's `closest("input, …")` bail-out.
- **Escape scoping** — Escape closes the whole filter only once *both* bounds
  are applied.

Plus `inputMode`, which decides whether a phone shows a numeric or decimal
keypad. That is load-bearing for a product used one-handed in a field.

## Deleting rather than testing `date-picker/shared.ts`

`formatDate`, `isBrowserLocaleClockType24h` and `validatePresets` had **zero
importers repo-wide**. Only `DatePickerContext` is consumed; both pickers
import the canonical `formatDate` from `@/lib/format-date`. CodeQL never
flagged them because they are *exported* — unreferenced, but not unused
locals, so they fell outside the #427 sweep.

Testing them would have been coverage-shaped by construction: no caller means
no break to catch. Deleting removes 73 uncovered branches from the `global`
denominator, which moves the gate for free, and takes two latent defects with
it:

- **`validatePresets` skips January.** The range branch guards with
  `if (presetMonth && presetMonth < fromMonth.getMonth())`. `getMonth()` returns
  `0` for January, so a January `from` is falsy and bypasses the lower-bound
  check entirely — exactly the case most likely to violate it. The sibling
  single-date branch has no such guard, so the two paths disagreed; that
  asymmetry is what makes it a bug rather than a decision.
- **The 24-hour heuristic fails every locale this product ships to.**
  `isBrowserLocaleClockType24h` parses `Intl.DateTimeFormat(lang, {hour:'numeric'})`
  output as a number. Only `en-GB` yields a bare `"03"`. German returns
  `"03 Uhr"`, French `"03 h"`, and **Bulgarian `"03 ч."`** — all `NaN`, all
  silently classified as 12-hour. Had anything wired this up, the Bulgarian app
  would have rendered `3:30 PM`.

The `fromDay`/`toDay` guards carry the same falsy-zero shape but cannot
misfire, since `getDate()` returns 1–31. They went with the deletion rather
than being fixed in place.

## Decisions

- **Mutation check instead of red-green.** Characterization tests for existing
  code pass on first run, which proves nothing. Three targeted mutations were
  applied to the panel — dropping the zero-clamp, always passing the
  outer-close handler, and dropping the empty-draft Backspace guard — producing
  exactly three failures against seventeen passes, then reverted. The tests can
  fail for the reasons claimed.
- **Deletion over coverage for dead code.** Covering 73 branches would have
  scored marginally better than removing them (+0.34pp vs +0.20pp). Removing
  them is still correct: it deletes a latent bug rather than freezing it into a
  test, and leaves nothing for a future caller to wire up by mistake.
- **`fireEvent` for the capture handler, `userEvent` everywhere else.** The
  panel auto-focuses the min input on mount, so a `userEvent` keystroke aimed
  at the separator is swallowed by that field and never reaches the
  outside-an-input branch. That one case dispatches directly at the target;
  the rest drive the component the way a user does.

## What this wave does not close

Roughly an eighth of the branch gap. The ranking that should drive waves 15+,
by absolute uncovered branches within the `global` group:

| Area | Uncovered branches | Files | Branch % |
|---|---|---|---|
| `src/components/ui` | 2,497 | 547 | 61.2% |
| `src/app` | 1,719 | 111 | 51.7% |
| `src/app-layer/repositories` | 887 | 48 | 48.0% |
| `src/app-layer/jobs` | 626 | 51 | 68.2% |
| `src/auth.ts` | 241 | 1 | 10.4% |

`src/auth.ts` is the densest single target in the repo — 241 uncovered branches
in one file, and security-critical (JWT callbacks, session recording, the
membership cap). It is the strongest candidate for wave 15.
