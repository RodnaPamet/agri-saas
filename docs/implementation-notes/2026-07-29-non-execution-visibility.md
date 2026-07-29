# 2026-07-29 — Making non-execution visible (RLS guardrail + the guards-are-text note)

**Commit:** _(this PR)_

## Design

A recurring defect across this repo: **checks that pass by not running.** A
skipped or non-executing check is indistinguishable from a passing one, so it
reads as green forever. Known instances at the time of writing:

1. `tests/guardrails/rls-coverage.test.ts` — `DB_AVAILABLE ? describe :
   describe.skip`. Observed live: it failed six assertions against a
   reachable-but-stale database, then went **silent** when that database
   became unreachable. The sweep got *greener* by running less (skipped
   1 → 15).
2. `tests/guards/*` assert on source TEXT and contribute zero runtime
   coverage — a file can be named by eight guards and sit at 0%.
3. Behavioural tooltip suites self-skipped behind `TOOLTIPS_ENABLED` and had
   not executed for months (already fixed by
   `tests/guards/tooltip-kill-switch-consistency.test.ts`).
4. `Load Test (k6)` stayed broken eight days for the same structural reason
   (fixed in #397).

This PR addresses (1) and documents (2). It does **not** touch the coverage
gate's push-to-`main`-only trigger — that is deliberate and was re-confirmed.

### The RLS guardrail

The suite has to stay DB-backed: without a live, migrated Postgres there is
nothing to compare `pg_policies` against. So the fix is not "stop skipping",
it is "make the skip audible", in three layers:

```
describe('… — execution status')      ← ALWAYS runs. Prints a banner naming
                                        what did NOT run, and the probed
                                        (credential-redacted) URL.

describe('… inventory (no database    ← Two assertions that never needed a
          required)')                   DB, lifted out of the gated block.

describeFn(DB_SUITE_NAME)             ← The 12 DB-backed assertions. The
                                        suite NAME carries the verdict,
                                        so --verbose / JSON reporters /
                                        CI annotations show it too.
```

Plus `RLS_GUARDRAIL_REQUIRE_DB=1`, which turns the banner into a thrown
error for any environment that guarantees a database.

The structural half is `tests/guards/rls-coverage-skip-visibility.test.ts`,
built on the same inverse-assertion idea as the tooltip kill-switch guard:
rather than trusting a comment, it asserts the properties that make a silent
skip impossible — the gate stays derived from the imported probe, no hard
`describe.skip(` or `.only(` appears, the status suite is ungated and says
"NOT VERIFIED", the escalation flag actually throws, and every DB-backed
assertion title is still declared. A mutation-regression case proves both
detectors fire on a known-bad input.

## Files

| File | Role |
|---|---|
| `tests/guardrails/rls-coverage.test.ts` | Always-running execution-status suite + banner + `RLS_GUARDRAIL_REQUIRE_DB` escalation; two DB-free assertions moved out of the gated block; gated suite name carries the verdict |
| `tests/guards/rls-coverage-skip-visibility.test.ts` | New — structural ratchet that makes a silent skip mechanically impossible to reintroduce |
| `CLAUDE.md` | New "Green is not the same as executed" section under Testing Conventions |

## Decisions

- **Warn by default, fail only on request.** The suite is DB-backed by
  design and a developer without a local Postgres must still be able to run
  the guardrail sweep. Making the absence of a DB fail unconditionally would
  push contributors toward `--testPathIgnorePatterns`, which is a worse
  silence. `RLS_GUARDRAIL_REQUIRE_DB=1` exists for the environments that can
  make the stronger promise.
- **Not wired into CI in this PR.** CI's `test` job does provide a migrated
  Postgres, so `RLS_GUARDRAIL_REQUIRE_DB=1` would be honest there and would
  catch a service-container or `migrate deploy` failure that currently
  degrades to a silent skip. It is left off because the availability probe is
  a 5-second `spawnSync` of a full Node + Prisma connect, and a loaded runner
  could time it out and redden CI for a non-defect. Wiring it in is a
  deliberate follow-up, not an oversight.
- **Console banner over a failing test.** Jest attaches console output to the
  suite in its default reporter, so the banner lands in the output a reader
  is already scanning — no extra reporter, no CI plumbing, works identically
  locally and in Actions.
- **The suite name carries the verdict too.** The banner covers the default
  reporter; the dynamic suite/test names cover `--verbose`, `--json`, and any
  downstream annotation tooling that only sees titles.
- **Two DB-free assertions lifted out rather than left alone.** The inventory
  floor and the axis-disjointness check read only the Prisma DMMF. They sat
  inside the gated block by proximity and silently stopped running whenever
  Postgres was down — the same defect one layer in. Moving them is why the
  skipped count drops from 14 to 12 for this file.
- **Guard file lives in `tests/guards/`, not `tests/guardrails/`.** It is a
  pure text scan, which is what that directory means in this repo — and CI
  runs `tests/guards/` as an explicit named gate on shard 1.
