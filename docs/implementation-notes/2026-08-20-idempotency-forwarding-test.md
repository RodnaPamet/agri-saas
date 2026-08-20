# 2026-08-20 — Idempotency forwarding: the wire nobody tested

**Commit:** `<pending> test(offline): drive the Idempotency-Key forwarding the outbox depends on`

Closes gap #6 of the enforcement-seam audit (2026-08-19), GitHub issue #626.

## Design

The offline outbox replays a queued journal entry or spray job over flaky rural
LTE using its item id as the `Idempotency-Key`. Three routes read that header
and forward it to a usecase that dedupes on it.

**No test in the repo imports any of those three route modules**, so the
forwarding hop sits at 0% runtime coverage — while both halves *around* it are
thoroughly tested against themselves:

| What exists | What it proves | What it cannot see |
|---|---|---|
| `offline-pwa-coverage.test.ts:213` greps `sync.ts` for the header string | the client sends it | anything at runtime |
| `log-entry-idempotency.test.ts`, `field-operation-idempotency.test.ts` | the usecase dedupes **when given** a key | that the route stopped giving it one |
| `journal-offline-create.spec.ts` drains **once**, asserts one row | one POST makes one row | holds identically with the forwarding deleted |

Deleting the forwarding does not even fail typecheck: the key is a *trailing
optional* parameter on both usecases, so omitting the argument is well-typed by
definition, and `tsconfig.json` sets no `noUnusedLocals` to catch the orphaned
`const`. Measured: the mutation compiles clean and leaves the two existing
idempotency suites at 8/8 green.

The failure mode is the scenario the whole design exists for — a retry writing a
**duplicated spray or harvest record into the БАБХ regulatory log**.

### Why unit tests can prove this at all

Sequential dedup — which is what an outbox replay actually performs — is
resolved entirely by the application-level pre-check (`journal.ts:238`,
`field-operation.ts:142`) *before* any unique index is consulted. So the logic
under test is real TypeScript. The DB `@@unique([tenantId, clientMutationId])`
index is the **concurrent-race** backstop only, and that path already has an
integration test.

This mattered: an integration test here would sit behind
`DB_AVAILABLE ? describe : describe.skip` and silently report nothing wherever
Postgres is unreachable, leaving the gap open while reading closed.

### The third route is deliberately excluded

`journal/[id]/files/route.ts` forwards the key too, but its dedup is
**content-addressed** (SHA-256 → `FileRecord` reuse →
`@@unique([logEntryId, fileRecordId])`), and the key is consumed at exactly one
place: an audit `detailsJson` field. The audit's prescribed assertion — "drive
twice, assert one row + same id" — passes there **whether or not the header is
forwarded**. Writing it that way would have produced a fourth self-referential
half-test that looked like coverage. It needs a different assertion and belongs
in its own file.

## Files

| File | Role |
|---|---|
| `tests/unit/idempotency-forwarding-enforced.test.ts` | New. Drives the real `POST` handlers for `/journal` and `/locations/:id/operations` twice each with the same key, asserting one create; plus key-stamping, a no-key control proving dedup isn't accidental, and a distinct-keys case. |

## Decisions

- **Stateful repository mocks, not `mockResolvedValue`.** This is the whole
  harness. A `jest.fn()` resolving `null` both times lets the second POST create
  a second row, so the test could only pass by asserting something else; one
  resolving a row *every* time short-circuits the FIRST POST too, so "one
  create" holds even with the forwarding deleted. Only a mock that remembers
  what the first call wrote distinguishes forwarded from not-forwarded.

- **Two independent `NextRequest` objects per scenario.** `withValidatedBody`
  does `await req.json()`, which consumes the body stream. Replaying the same
  request object returns 400 `Invalid JSON payload`, and "only one row" would
  then pass for entirely the wrong reason — the second request never reaching
  the usecase at all.

- **The create COUNT is load-bearing, not the returned id.** A stateful store
  returning a constant id would satisfy an id-equality assertion with the
  forwarding deleted. Both are asserted; the count is the one that bites.

- **Both responses asserted 201.** `assertModuleEnabled` throws
  `forbidden('module_disabled: JOURNAL')` if unmocked and `getTenantCtx` throws
  without a session — either makes the second POST fail before the pre-check, so
  "exactly one row" would hold trivially. The same assertion defends against a
  429 if `RATE_LIMIT_ENABLED` ever leaks into the env.

- **`@opentelemetry/api` is NOT mocked here, unlike the usecase suites.**
  Driving the real route pulls in Sentry and the real
  `observability/{tracing,context}.ts` (`errors/api.ts` imports the submodules
  directly, so a barrel mock does not intercept them). A bare
  `{ trace: { getActiveSpan } }` literal drops `createContextKey` and
  `getTracer` → "Test suite failed to run". Spreading `actual.trace` does not
  fix it either: `trace` is a singleton whose methods live on its prototype, and
  object spread copies only own enumerable properties. The real module is safe
  because every call site is optional-chained.
