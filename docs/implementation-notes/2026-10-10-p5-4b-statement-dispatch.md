# 2026-10-10 — P5.4b: DSA Art 17 statement dispatch

**Commit:** `<pending>` P5.4b: deliver Art 17 statements in the recipient's language

## Design

P5.4a wrote statements into `StatementOfReasons` with `deliveredAt` NULL and
surfaced the undelivered queue to the console. This phase drains it.

```
scheduler (*/10 * * * *)
   └─ executorRegistry.execute('statement-dispatch', {})
        └─ runStatementDispatch({ limit })
             ├─ findMany   deliveredAt: null, orderBy createdAt asc, take limit
             └─ per row (failure isolated to the row):
                  ├─ User.uiLanguage  → resolveRecipientLocale()   → locale
                  ├─ ModerationAction → actionKind + rationale
                  ├─ translateFor(locale, 'statementOfReasons.*')  → body
                  ├─ sendEmail({ to, subject, text })
                  └─ update { deliveredAt: now, locale, bodyRendered: body }
```

The order of the last two steps is the whole point: nothing is marked delivered
unless the send resolved, and the text that was sent is what gets stored.

## Files

| File | Role |
|---|---|
| `src/app-layer/jobs/statement-dispatch.ts` | the job — drain, resolve locale, compose, send, write back |
| `src/app-layer/jobs/types.ts` | `StatementDispatchPayload`, the `JobPayloadMap` entry, and the `attempts: 1` retry entry |
| `src/app-layer/jobs/executor-registry.ts` | registers the executor |
| `src/app-layer/jobs/schedules.ts` | the `*/10 * * * *` `ScheduleDefinition` |
| `messages/{en,bg}.json` | `statementOfReasons.*` — subject, intro, reasonLabel, redress, and one line per `ModerationActionKind` |
| `src/app/api/admin/moderation/statements/route.ts` | docblock + the `FALLBACK_LOCALE` comment, now that dispatch exists |
| `src/lib/openapi/paths/moderation.paths.ts` | `locale` is a hint dispatch overwrites; `bodyRendered` on the POST is a draft |
| `tests/integration/p5-4b-statement-dispatch.test.ts` | the executing test, mutation-proved three ways |

## Decisions

- **Compose at send time, not at queue time.** P5.1 chose to store the body
  rendered, for the `NotificationOutbox` reason: what was sent is a fact. Art 17
  requires the recipient's language, which the moderator's request cannot know.
  Composing here reconciles both, at the cost of making the console's
  `bodyRendered` a draft — which the OpenAPI description now says outright,
  because a field whose stored value differs from the submitted one is a
  contract fact, not an implementation detail.

  This corrected the issue draft on #1595, which described the locale chain as
  "bg, then en". `en` is specifically wrong for an authenticated recipient:
  `DEFAULT_LOCALE` is documented for unauthenticated surfaces, while
  `User.uiLanguage` defaults to `bg` at the column. `RECIPIENT_FALLBACK_LOCALE`
  already existed for exactly this, so the fix was to use the resolver rather
  than to write a chain.

- **`attempts: 1` — the only entry in `JOB_DEFAULTS` with no retry.** The job
  sends mail and stamps delivery per row, so a run-level retry would re-send
  every statement that already went out before the failure. The retry is
  per-row and implicit: a failed row stays `deliveredAt: null`, which IS the
  queue, so the next scheduled run picks it up ten minutes later. `backoff` is
  supplied anyway because the type requires it, and is commented as inert so
  nobody infers a policy that cannot fire.

- **`success: true` with a non-zero skip count.** The honest shape for "the run
  worked and some rows are stuck". A run that failed on one bad mailbox would
  retry the batch under any `attempts > 1` and re-send the rest. The stuck rows
  are not hidden by this — they remain on the console's undelivered view, which
  P5.4a built precisely because a statement that never went out is a compliance
  failure nothing else shows.

- **Every 10 minutes.** P5's exit criterion is a median handling time measured
  from `createdAt` to `deliveredAt`. A nightly drain would add up to 24 hours of
  lag to a regulator-visible number for no operational gain; a 2-minute beat
  would spend a worker slot on an almost-always-empty queue, since a moderation
  decision is a human act rather than a stream.

- **A missing mailbox is left undelivered, not tidied away.** `recipient?.email`
  absent and `ModerationAction` missing both count as skipped and log a warning.
  Marking such a row delivered would be the one outcome worse than leaving it:
  the gap would disappear from the only view that shows it.

- **The test aims its failure at a RECIPIENT, not a call index.** The first
  version used `mockRejectedValueOnce` and failed — correctly — because the
  queue is global and oldest-first, so the rejection landed on a row the
  previous test had deliberately left stuck. That is the per-row retry working,
  and the fix belonged in the test. Worth knowing before writing the next test
  against this queue.
