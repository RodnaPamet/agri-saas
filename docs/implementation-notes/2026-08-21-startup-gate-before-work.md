# 2026-08-21 — the fail-fast that was not fast (#698)

**Commit:** `see git log` fix(startup): gate the worker and scheduler before they do any work

## Design

One shared, awaited gate — `assertProductionEncryptionReady(log)` in
`src/lib/security/startup-gate.ts` — called first in each entrypoint's `main()`.

Before this, both standalone scripts ran the GAP-03 check inside a
**non-awaited async IIFE** at module scope. Module evaluation continued
straight past it; the `await import(...)` inside did not resume until the body
had finished. Measured log order under a bad key:

```
worker:     starting worker
            worker process started — press Ctrl+C to stop   ← subscribed to both queues
            [startup] FATAL: DATA_ENCRYPTION_KEY is required …

scheduler:  registering repeatable jobs
            [startup] FATAL: DATA_ENCRYPTION_KEY is required …
```

`src/instrumentation.ts` never had the problem — `register()` is async and
awaits inline. That is the shape restored here.

## Files

| file | role |
|---|---|
| `src/lib/security/startup-gate.ts` | **new** — the awaited gate; one home for the production decision and both halves |
| `scripts/worker.ts` | real `main()`; `Worker` construction moved behind the gate; bootstrap IIFE awaited |
| `scripts/scheduler.ts` | gate moved into the existing `main()` |
| `tests/unit/security/startup-fail-fast-execution.test.ts` | the two #702 characterisation tests flipped; SURVIVE mode rewritten |
| `tests/guardrails/encryption-key-enforcement.test.ts` | asserts `await`, not presence |

## Decisions

- **The bug was wider than the issue said.** `worker.ts` had a *second*
  non-awaited IIFE — the automation-bus / mailer bootstrap — racing the same
  `new Worker(...)`. Both halves matter: without
  `installAutomationBusDispatcher`, an automation event emitted by an
  early-claimed job is silently dropped; without `initMailerFromEnv`, the
  worker is still on the console sink and the notification outbox it runs
  "sends" mail that never leaves. Checked rather than assumed: the third
  member, `installRlsTripwire`, is a documented **no-op**, so nothing
  isolation-critical was ever in that race.

- **`shutdown` had to become tolerant.** `worker` / `soilWorker` / `connection`
  were module-level `const`s, so a signal handler could never see them
  undefined. They are now assigned inside `main()`, and a SIGTERM arriving
  during the gate would have thrown — turning an orderly stop into `exit 1`.
  Optional-chained.

- **A presence check cannot see this defect.** The guardrail asserted
  `checkProductionEncryptionKey` appears in the file — true both before and
  after. It now asserts `await assertProductionEncryptionReady(` and the
  *absence* of the `void` form, and the ordering is asserted behaviourally by
  spawning the real processes.

- **The ordering assertion had to be an INDEX, not an absence.** My first
  version asserted `worker process started` does not appear, plus
  `fatal <= 1`. Both passed against a deliberately reverted (`void`) worker:
  measured, that prints `starting worker` then the refusal — fatal at index
  **1** — and the un-awaited gate resolves before the heavy bootstrap import,
  so the absence assertions hold too. Only `expect(fatal).toBe(0)` separates
  them. A mutation proof found this; the assertion I would have shipped was
  green against the bug it was written for.

- **SURVIVE mode now waits on a marker, not a clock.** It used `spawnSync`
  with a fixed 15s window. Run alone: 38/38. Under a full parallel sweep, two
  BOOT cases failed with `Received: {"msg":"starting worker"}` — the worker had
  got that far and the window expired. #698 makes it strictly worse, since the
  sentinel now *blocks* startup instead of racing it. Raising the constant
  would only move the race; reading the stream until the marker appears removes
  it, and kills a healthy boot the instant it has proven itself. Side effect:
  the suite went **82s → 33s**.

  Found by the parallel session running the full sweep, and credited because I
  would have shipped the flake.

- **The gate takes `env` as a parameter, not a `process.env` read.** Same
  reason `checkProductionEncryptionKey` does: this check exists to catch a
  runtime whose `SKIP_ENV_VALIDATION=1` bypassed the zod schema, so it cannot
  use the validated `env` object — and reading the raw one inside `src/` is
  what `no-fallbacks.test.ts` forbids. Pushing the read out to the two callers
  (both in `scripts/`, which that guard does not scan) keeps the function pure
  and needs no exemption. Noted in passing: that guard is a plain substring
  scan, so it also flagged the token inside a docblock CODE EXAMPLE — the same
  prose-is-not-code limitation `payload-url-scheme.test.ts` parses its way
  around. Worked around here rather than fixed; not this diff.

## Worth knowing

`scripts/worker.ts` and `scripts/scheduler.ts` are **outside `tsconfig.json`**,
so `npm run typecheck` does not read them — this refactor was type-checked with
a throwaway config instead. Both files are clean; the only errors that config
surfaces are two pre-existing `EdgeRuntime` globals in `src/lib/prisma.ts` that
Next provides at build time. Making that a standing script is a real gap worth
closing, and is not in this diff.
