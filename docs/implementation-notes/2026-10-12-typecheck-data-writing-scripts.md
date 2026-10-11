# 2026-10-12 — typechecking the scripts that can change data

**Issue:** #1485

## Design

`tsconfig.json` excludes `scripts`. `tsconfig.scripts.json` exists to close
that where it matters, and its include list was two entries — so **2 of 48
scripts were typechecked** and nothing (not `tsc`, not `tsx`, not jest) read
the other 46.

That was deliberate, and the config said why: the rest of `scripts/` is
"one-off operational tooling that does not hold to the app's strictness, and
folding it in would make this a migration instead of a gate" (#806).

The include list is now 20 entries: the two queue entrypoints, `scripts/seed.ts`,
and every script that can WRITE to a database.
`tests/guards/data-writing-scripts-are-typechecked.test.ts` derives the
population from disk so the list cannot fall behind.

## The premise was measured, and the exceptions were not strictness

Of the **18** scripts that can modify data, **15 passed the program
unchanged**. The three that failed were not strictness mismatches — they were
scripts that could not run:

| script | what the typecheck found |
|---|---|
| `seed-staging.ts` | called `hashForLookup` with **no import** → `ReferenceError` at step 2; it could never resolve its admin user |
| `seed-demo.ts` | `billingAccount.create` missing the required `stripeCustomerId` → threw **every time** into a `catch` that swallowed it |
| `itest-spray.ts` | imports `importLocationSpatialFile`, which #40 renamed **and** made off-thread |

Two are fixed here. The third is a rework and is #1659.

`seed-demo.ts` is the one worth dwelling on. The swallowing catch carried the
comment *"BillingAccount shape varies by deployment; non-fatal for the demo"*.
The shape does not vary — `stripeCustomerId` is `@unique` and not optional — so
the create was simply invalid, and **"Persona differentiator #2 — billing plan"
never happened** for any tenant without an existing billing row. The plan caps
those personas exist to exercise were never applied. A swallowing catch makes a
permanently-broken write look exactly like a working one, which is this repo's
own fail-safe-path lesson one level down.

`seed-staging.ts` is almost funnier: its docblock **already** blames this same
exclusion for three field bugs it carried, and `hashForLookup` survived that
pass.

## Why WRITES rather than runs-in-production

The config's criterion is *runs in production*. These scripts' risk is *writes
to production*, and for a type error the two are the same class — either way it
surfaces when somebody runs the thing against live data, with no earlier
signal. The difference is that a broken `worker.ts` fails loudly on a schedule
somebody watches, while a broken backfill fails once, in front of an operator,
mid-incident.

`scripts/backfill-journal-title-descriptors.ts` rewrites entries in the journal
a **regulatory register** is generated from, and its own docblock says it was
"actually run against production".

## Files

| file | role |
|---|---|
| `tsconfig.scripts.json` | 2 → 20 include entries, with the measurement recorded |
| `scripts/seed-staging.ts` | the missing `hashForLookup` import |
| `scripts/seed-demo.ts` | the billing upsert can now succeed; the catch that hid it is gone |
| `tests/guards/data-writing-scripts-are-typechecked.test.ts` | NEW — derives the population |
| `tests/guards/scripts-typechecked.test.ts` | its "covers exactly them" claim, corrected |
| `.github/workflows/ci.yml` | the step name and comment described 2 files |

## Decisions

- **`scripts/seed.ts` was already in scope by the config's own criterion and
  was missed.** Production seeding runs `dist/seed.mjs`, which `build:seed`
  bundles from it — so it is a third production entrypoint. It passes unchanged.

- **Derived, not curated.** #1485 named the choice; #805 already answered it for
  the `ci-failure` watchlist: *"a curated list is a list somebody forgets"*. A
  tsconfig cannot glob a semantic property, so the list stays literal and the
  guard is what makes it answerable — add a data-writing script and CI tells you
  to list it. Proved both ways: a synthetic new writer fails, and deleting a
  real entry from the include list fails.

- **The write detector must not over-select.** The guard asserts
  `writers.length < scripts.length` and that `findMany` / `findUnique` /
  `count` do NOT match. A detector matching every file would satisfy the main
  assertion for the wrong reason — the inverse of the selector that survived
  gutting in #1645, where a floor was satisfied by a pattern matching
  everything.

- **Comments are blanked before the scan**, because this change deliberately
  leaves scars: `seed-demo.ts` now carries a comment naming
  `billingAccount.create` to explain what was wrong with it.

- **The include list is checked for stale entries.** tsconfig `include`
  silently ignores a path matching no file, so a renamed script would leave the
  program reading one file fewer and still exiting 0 — the empty-selection
  defect one level up.

- **An ESM `import` in a CommonJS script, verified at runtime not just by
  `tsc`.** `seed-staging.ts` uses `require` and `__dirname`; `tsc` was happy
  with an added `import`, and `tsc` is not the runtime. A probe under `tsx`
  confirmed all three coexist before the fix was kept.

- **Neither seed runs in CI.** Only `prisma/seed.ts` does (`ci.yml:1415`,
  `:2088`), so making `seed-demo`'s billing write actually succeed has no CI
  blast radius — it matters for the operators who run it.

- **The two script guards stay separate.** `scripts-typechecked` pins the
  plumbing (the config exists, `npm run typecheck` runs it, CI invokes it); this
  one pins what is in the program. A complete list is worth nothing if CI
  stopped invoking it, and an invoked program is worth nothing if the list fell
  behind.

- **The issue's own measurement was off, and it does not change the
  conclusion.** #1485 says "38 scripts, 14 write" from a non-recursive scan that
  missed `scripts/rag/`. It is 48 and 18 — three more writers, all of which
  passed.
