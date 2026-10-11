# 2026-10-11 — P5.5b: the notice shadow score

**Commit:** `<pending>` P5.5b: shadow-score DSA notices, read by nothing

## Design

```
scheduler (*/15)
  └─ executorRegistry.execute('notice-score', {})
       └─ runNoticeScore({ limit })
            ├─ isNoticeScoringConfigured()        → no key: do nothing at all
            ├─ RAW   SELECT id FROM ContentReport
            │        WHERE NOT EXISTS (SELECT 1 FROM NoticeScore …)
            │        ORDER BY createdAt ASC LIMIT n          ← bounded anti-join
            ├─ PRISMA findMany({ id: { in: … } })            ← so `detail` DECRYPTS
            └─ per notice:
                 ├─ scoreNotice()
                 │    ├─ isPlatformAiSpendAllowed('notice-score')   ← #1423's ceiling
                 │    ├─ Anthropic messages.create (tool_use)
                 │    └─ recordPlatformAiUsage(...)   ← before parsing, always
                 └─ noticeScore.create(...)          ← the ONLY writer
```

Nothing reads a score. That is the specification, and it is held by a guard plus
an RLS policy rather than by intention.

## Files

| File | Role |
|---|---|
| `src/app-layer/ai/notice-scorer.ts` | the model call; gates on the platform budget, validates, never throws |
| `src/app-layer/jobs/notice-score.ts` | the queue, the write, the idempotence |
| `prisma/schema/social.prisma` + `migrations/20261011120000_…` | `NoticeScore`, platform-only RLS |
| `src/app-layer/ai/platform-budget.ts` | `notice-score` joins `PLATFORM_AI_JOBS` |
| `src/lib/security/encrypted-fields.ts`, `src/lib/db/encryption-middleware.ts` | `rationale` encrypted under the global KEK |
| `tests/guards/notice-score-is-shadow-only.test.ts` | **the deliverable** — the source half of shadow mode |
| `tests/unit/notice-scorer.test.ts` | the budget gate stops the spend; usage is recorded anyway |
| `tests/integration/p5-5b-notice-score.test.ts` | idempotence, the anti-join, and the plaintext reaching the scorer |

## Decisions

- **The guard is the deliverable.** "AI scores reports in shadow mode only" is
  easy to satisfy on the day it ships and easy to violate later in a way that
  looks like an improvement. The matcher is coarse on purpose: a rule about
  `orderBy` passes a threshold filter, and a rule about thresholds passes a
  sort, so the property held is "exactly one writer, no readers". It strips
  comments first, or a file explaining why it must not read the score would be
  reported as reading it.

- **Two controls, two depths.** The migration gives `NoticeScore` only
  `superuser_bypass`, verified live: one policy (`ALL`), with RLS enabled and
  forced. A privileged platform route would still read those rows — which is
  the moderation console — so the source guard is not redundant.

- **A table, not a column.** `ContentReport`'s reporter-read arm is row-level,
  so any column on it is readable by the reporter. Settled by #1553 DECISION 3
  and reused here, as `ReportSnapshot` did.

- **A job, not the notice write path.** `POST /api/public/notices` is
  unauthenticated: a model call there lets anyone make the server do paid work
  and wait for it. Filing a notice is also a legal duty while scoring is an
  experiment, and separate paths means the experiment cannot affect the duty.

- **Raw anti-join, Prisma row read.** Bounded by `LIMIT` rather than by an
  ever-growing `notIn`, and still decrypted, because `detail` is encrypted and
  the extension is what decrypts it. Folding them together is the quiet failure
  the integration test is aimed at: the model would score ciphertext and return
  a confident number.

- **`recordPlatformAiUsage` runs before the output is parsed.** The tokens were
  spent whether or not the tool block validates. A ledger counting only
  successful parses under-counts exactly the calls worth noticing, and the
  ledger is what an operator reads to choose a cap.

- **The prompt asks for an assessment, never a recommendation**, and is told to
  be conservative: a terse, angry or second-language notice is not evidence of
  bad faith. `anonymous` is passed; the reporter's id is not.

- **`attempts: 1`.** Its neighbour `statement-dispatch` uses 1 so a retry
  cannot re-SEND; this uses 1 so a retry cannot re-SPEND.

## A duplicate caught before it shipped

I built a platform AI budget for this phase — the owner had chosen "build it
now" — and then found a peer had shipped exactly that hours earlier (#1423, PR
#1624, release 10.27.0) while P5.5a was in CI. Mine was discarded and this
builds on theirs.

Two of their choices are better than what I had written, and both are kept:
they ship with **no default cap**, so the ledger fills before anyone picks a
limit, where I had invented a 2,000,000-token default from a prompt-size
estimate with no measurement behind it; and a ledger read failure **allows** the
call, which is right for three advisory fail-safe callers where refusing on a
database hiccup would silently disable three features.

One gap noted rather than fixed: no caller passes `costMicros`, so that column
is uniformly 0 across all four jobs. Populating it for this job alone would make
a partially-filled column that under-states by whatever the other three spend,
which is worse than a uniformly empty one — so it wants fixing for all four at
once.
