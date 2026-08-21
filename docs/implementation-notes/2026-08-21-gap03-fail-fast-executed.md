# 2026-08-21 — GAP-03 checks 2 and 3, executed (#674 item 2)

**Commit:** `see git log` test(security): boot three surfaces with a bad key and watch them refuse

## Design

CLAUDE.md claims three independent checks each refuse to start a production
process whose `DATA_ENCRYPTION_KEY` is missing, too short, or equal to the
documented dev fallback. The 2026-08-19 enforcement-seam audit found only the
first had ever run. This closes the other two by executing them.

- **Check 2 — the Node hooks.** Three real child processes (`tsx`), one per
  surface, booted with `NODE_ENV=production` and a deliberately bad key. The
  thing under test *is* `process.exit(1)`, which cannot be observed from inside
  the process that calls it — which is exactly why it had never been tested.
  `startup-encryption-check.ts` was factored so the LOGIC is unit-testable
  without spawning, and that factoring is right; it just left the half that
  turns a failed check into a dead process uncovered.
- **Check 3 — the Compose layer.** A real `docker compose config` invocation.
  Cheap: pure interpolation, no containers. Gated on docker availability with a
  visible skip banner and a `STARTUP_GUARD_REQUIRE_DOCKER=1` escalation, the
  shape `rls-coverage.test.ts` established — a skipped suite is otherwise
  indistinguishable from a passing one.

## Files

| file | role |
|---|---|
| `tests/unit/security/startup-fail-fast-execution.test.ts` | **new** — 38 tests: the three surfaces × five behaviours, the Compose layer, the sentinel's real reach, and the ordering characterisation |
| `tests/fixtures/startup/boot-instrumentation.ts` | **new** — runs the real `register()` hook so it can be spawned; prints `REGISTER_RETURNED_OK` as the negative control |
| `src/lib/security/startup-encryption-check.ts` | docblock corrected — the sentinel cannot fail for the reason it claimed |
| `CLAUDE.md` | three GAP-03 claims corrected against measurement |

## Decisions

- **The sentinel cannot fail for its documented reason.** It claimed to catch
  "a key that's structurally valid (32+ chars, not the fallback) but breaks
  under HKDF/AES-GCM (e.g. a binary blob written to env)". Measured, no such key
  exists: `deriveKey` is HMAC-SHA256 over `Buffer.from(raw, 'utf8')`, and
  `Buffer.from` never throws on a JS string — a lone surrogate becomes U+FFFD.
  High bytes, lone surrogates, astral-plane characters and pure whitespace all
  round-trip. Its one reachable failure is a key below the floor, which check 1
  rejects one line earlier at every call site.

  Kept, not deleted: it is the only thing that would catch a future derivation
  which *can* throw (a real `crypto.hkdfSync`, a base64 decode, a KMS fetch).
  But the docblock now says that rather than promising live defence, because a
  check trusted for the wrong reason is worse than one nobody trusts. The
  measurement is an executing test, so the claim cannot quietly go stale.

- **The fail-fast is not fast on either standalone entrypoint** — #698. Both
  `scripts/worker.ts` and `scripts/scheduler.ts` run the check in a **non-awaited**
  async IIFE, so module evaluation races past it. Measured log order under a bad
  key: the worker prints `worker process started` (both BullMQ `Worker`s
  constructed, subscribed to the queue) *before* `[startup] FATAL`; the
  scheduler prints `registering repeatable jobs` first. `src/instrumentation.ts`
  is correct — `register()` awaits the check inline.

  Two **characterisation** tests pin the current, wrong order, labelled with the
  issue number. They will fail when #698 is fixed, which is the point: the
  defect is visible in CI rather than only in a filed issue. Fixing it here
  would have turned a test PR into a production-entrypoint refactor.

- **CLAUDE.md was wrong in three places**, each caught by running the thing:
  the worker runs the sentinel too (the doc implied only the web tier); the
  Compose list named three manifests when there are **four** — the missing one
  being `deploy/docker-compose.vm.yml`, which the live agrent stack actually
  runs; and the sentinel claim above.

- **The Compose rule derives from content, not from a filename list.** A
  manifest that hands `DATA_ENCRYPTION_KEY` to a service must use the `:?` form.
  `docker-compose.yml` and `docker-compose.test.yml` pass no key at all, so the
  rule does not reach them — and a companion test asserts that, so the exclusion
  is a fact rather than an oversight. A new production manifest is covered the
  moment it exists.

- **The dev-ergonomics assertion is double-guarded, and the test says so.**
  Removing *either* the hook's `NODE_ENV === 'production'` gate or the early
  return inside `checkProductionEncryptionKey` leaves it green; only removing
  both fails it. Measured and recorded in the test, because the next reader
  would otherwise assume a single-point mutation kills it.

- **Cost was measured and then cut 3×.** The first draft ran in **257 s**, of
  which **180 s** was two `spawnSync` calls waiting for a healthy BullMQ worker
  to exit — which is precisely what a worker does not do. `SURVIVE` mode caps
  that wait at 15 s and requires an "alive" marker in the captured output, so
  the shorter wait is *proven* sufficient rather than assumed; without the
  marker, a wait that was too short would look exactly like a clean pass. Boots
  are also memoised by `(entry, env)` — they are deterministic, and several
  assertions want different views of the same run (exit code, absence of the
  key, message order). Final: **82 s**. The `test` job's cap is 35 minutes
  across a quarter of the suite, so this sits well inside the headroom, but the
  number is recorded here because it is the kind of cost that creeps.

- **The "never echoes the key" assertion needed a distinctive key.** With a
  value like `too-short` the assertion passes vacuously — the string appears
  nowhere either way. The fixture key is `zzq-marker-must-not-be-logged` so the
  search has something real to find.
