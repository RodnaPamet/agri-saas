# 2026-10-04 — the E2E job fails when audit writes were swallowed

**Commit:** `<pending> fix(ci): fail the E2E job when the run swallowed audit writes`

Addresses the hole #1289 names: the audit extension's failure path is
fail-safe by design (Refs #1269 — the business write has already COMMITTED, so
failing it afterwards would be worse), which means **at the CI gate a working
audit subsystem and a completely dead one are the same observation.**

## Design

One step inside the existing `e2e-shard` matrix job, reading the log that
job's `Run E2E tests` step already tees:

```
Run E2E tests ──tee──▶ $RUNNER_TEMP/e2e-shard-<n>.log
                              │
                              ├──▶ Name the failing specs   (#748, existing)
                              └──▶ check-e2e-audit-writes.mjs  (this change)
                                      • audit.write_failed      must be 0
                                      • pii.middleware_registered must be > 0
```

**Not a new job.** Nine checks are required by
`repos/RodnaPamet/agri-saas/branches/main/protection`, and a SKIPPED required
check counts as PASSING — so a new top-level job would be both a protection
change and a thing that can pass by not running. A step inside a job that is
already required fails that job.

**No `if:` on the step.** The default condition runs a step only when every
previous step succeeded, which is exactly the case this is about: a GREEN
shard concealing a dead audit path. A shard that failed earlier is red without
this step, so being skipped there can never read as a pass. The step sits
before the artifact uploads so a failure still attaches the Playwright report.

**Both halves are mandatory.** The count alone is satisfied perfectly by an
unreadable, empty or moved log — all of which report zero failures. The
positive control is what separates "clean" from "could not look"; without it
the check fails toward GREEN the moment its input breaks, which is the defect
class it exists to catch.

## Files

| File | Role |
| --- | --- |
| `scripts/check-e2e-audit-writes.mjs` | The check. Strips ANSI, counts both markers with `indexOf` (not a RegExp — `.` would match any character), fails on a missing/empty log, on a zero control, or on any failure. Prints both numbers side by side. |
| `.github/workflows/ci.yml` | One step in `e2e-shard`, after `Name the failing specs`, before the uploads. |
| `tests/guards/e2e-audit-writes-not-silently-zero.test.ts` | Wiring (step present, in that job, same log path, no `continue-on-error`) **and** execution of the real script against dirty / clean / empty / missing / control-less / ANSI / near-miss inputs. |
| `CLAUDE.md` | New paragraph under "Green is not the same as executed" — the fail-safe-path mechanism, alongside the mocked-dependency one the issue names as the same shape. |

## Decisions

- **The log, not a row count.** Counting `AuditLog` after the run was the
  issue's suggested stronger variant and is weaker here for two measured
  reasons: `prisma/seed.ts:336` creates audit rows (so a bare count is
  non-zero on a dead subsystem and the check would need a baseline), and the
  extension is not the only writer — `src/lib/audit-log.ts`,
  `src/lib/audit/audit-writer.ts` and the retention / data-lifecycle /
  retention-notifications jobs insert directly — so a positive row delta does
  not exclude a dead extension. `audit.write_failed` observes the failure
  itself. `AuditLog` is `FORCE ROW LEVEL SECURITY` with a `superuser_bypass`
  policy keyed on `current_setting('role') != 'app_user'`, so a psql count as
  `ci` would in fact see every row — the row-count variant is feasible, just
  less direct.
- **`pii.middleware_registered` as the control.** Emitted once per process by
  `src/lib/prisma.ts`, and it reaches the step's stdout only because
  `playwright.config.ts` sets `webServer.stdout: 'pipe'`. The guard asserts
  that too, because the control going silently to zero is the one way this
  check could start reporting a meaningless zero.
- **Measured on the real job logs before shipping**, inside the tee'd step's
  own window rather than across the whole job:

  | run | shard 1 failures | shard 2 failures | control (each shard) | gate |
  | --- | --- | --- | --- | --- |
  | `e1acca2c5` (green) | 275 | 85 | 2 | **FAIL** |
  | post-#1288 (green) | 0 | 0 | 2 | PASS |

  Both runs were green at the gate, which is the whole point.
- **The jest guard proves the gate's logic and wiring, never that CI ran it.**
  The #1288 defect was reachable only from the bundled Next runtime;
  `tests/integration/audit-write-failure-is-loud.test.ts` and
  `before-commit-audit-queue.test.ts` both execute the writer, assert rows
  appear, and stayed green throughout the outage.
