# 2026-09-04 — Lighthouse reports were never uploaded, so no perf change could be evidenced

**Commit:** `<pending> ci(lighthouse): upload the LHR reports and print the median metrics`

## Design

#796 asks for a font preload **derived from `src/styles/fonts.lock.json`**, and its own
step 3 asks for an LCP measurement before and after. That measurement is not currently
possible, and the reason is one line of workflow config.

`lighthouserc.json` sets `numberOfRuns: 3` and `upload.outputDir: .lighthouseci`, so each
run writes three `lhr-<timestamp>.json`. The workflow's upload step globbed
`.lighthouseci/*` — but **`.lighthouseci` is a hidden directory**, and
`actions/upload-artifact@v7` defaults `include-hidden-files: false`. The glob therefore
matched nothing.

Measured on run 33839332043: the artifact contains **exactly one file**, `tmp/app.log`
(12,312 bytes). Every Lighthouse report this repository has ever produced was discarded
at the end of its job.

So the repo has a `Gate: Lighthouse mobile budget` that passes or fails against
thresholds, and no way to see the number it judged.

## Files

| file | role |
|---|---|
| `.github/workflows/lighthouse.yml` | `include-hidden-files: true`; new `Median metrics` step with `if: always()` |
| `scripts/ci/lighthouse-median.mjs` | reads `.lighthouseci`, prints a per-metric median table to stdout + `$GITHUB_STEP_SUMMARY` |
| `tests/unit/ci/lighthouse-median.test.ts` | spawns the real script against fixture directories |

## Decisions

- **The empty case is LOUD.** A reporter that printed nothing on an empty directory would
  reproduce, one level up, the exact defect it exists to fix: silence that reads as
  success. `::warning::` annotations name what was not found. Mutation-proved — deleting
  the warning reddens a test.

- **It exits 0 unconditionally, and that is deliberate.** Lighthouse is *not* in main's
  required status checks (`Build`, `Lint`, `Typecheck`, `E2E`, `Security`,
  `CodeQL SAST`, `Docker Build & Scan`, `Test`, `Coverage`). This restores visibility of a
  number; it adds no enforcement, and a diagnostic step must never turn an unrelated
  failure red.

- **`if: always()` on the median step.** The run where the number matters most is the one
  whose budget just failed.

- **Per-metric median, not lhci's "median run".** With three runs they usually coincide.
  Where they differ, a per-metric median is the more honest summary of a metric
  `lighthouserc.json` itself documents as varying 900–2630 ms run to run (TBT).

- **Unreadable reports are counted, never silently skipped.** A partially-read run must
  not be presented as a complete one. Also mutation-proved.

- **This does NOT close #796.** It makes #796 answerable. The preload should then be run
  as a pre-registered experiment: record the median LCP on `/login`, add the preload
  derived from `fonts.lock.json`, record it again, and decide from the delta — including
  deciding *not* to ship it.

  That framing matters more than usual here, because `lighthouserc.json`'s own re-baseline
  note names a different suspect: *"the biggest lever is trimming the full message catalog
  sent to unauthenticated pages."* A font preload may not move LCP on `/login` at all, and
  a preload that is not used quickly enough costs a console warning and wasted bytes on
  the metered rural LTE this product optimises for. **Adding it without the number would
  be a plausible-sounding change with no evidence behind it** — which is what the issue
  itself warns against.

- **Derive from the lock, not the directory** (for the eventual preload PR).
  `npm run fonts:vendor` verifies `fonts.lock.json` against the files and exits 1 on
  drift, so deriving from the lock inherits that guarantee. A `public/fonts/` listing does
  not: if a face goes missing the preload list silently gets shorter and stays green,
  which is the precise failure #796 is written against.
