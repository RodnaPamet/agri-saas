# 2026-11-10 — P9.3d: auto-hide after three reports from verified farms

**Issue:** #2937 (the last of its four parts). **Owner rulings:** "built,
dormant, and visibly so" (2026-11-09) and "a statement, from an `auto:` actor"
(2026-11-10).

## Design

A 10-minute job groups OPEN (`RECEIVED`) `ContentReport` rows by channel post,
resolves which reporters belong to a VERIFIED farm, and hides a post once
**three DISTINCT verified farms** have reported it.

```
ContentReport(CHANNEL_POST, RECEIVED)
        │  one query, grouped in memory (no N+1 — D1 guardrail)
        ▼
  byPost: postId -> { reportIds[], reporters:Set }
        │  verifiedFarmMembers(allReporters)   ← two queries, not per-post
        ▼
  count = |reporters ∩ verified|  >= 3 ?
        │                              no -> skipped++
        ▼ yes, and not already hidden by any route
  ┌─ $transaction ────────────────────────────┐
  │ ChannelPost.autoHiddenAt = now            │
  │ ModerationAction(CONTENT_AUTO_HIDDEN,     │
  │                  auto:report-threshold)   │
  └───────────────────────────────────────────┘
        ▼ AFTER the commit (a second pool connection inside it is #1191)
  queueStatementForAction(...)  -> author's Art 17 statement
        │ failed? statementsUnqueued++ and its own printed line
        ▼
  logger.info('channel_auto_hide.reading', { … verifiedReporters, dormant })
```

**It is DORMANT in production and the reading says so.** One
`FarmIdentityClaim`, status PENDING — zero verified farms — so the threshold is
arithmetically unreachable. The owner chose to build it rather than defer it,
and chose that over lowering the bar to any reporter, because «verified» is
precisely what stops three throwaway accounts hiding a competitor's post.

So every run logs a denominator: `verifiedReporters` and a `dormant` flag are
what make `hidden: 0` legible, because zero verified reporters means the
threshold *cannot* be reached, which is a different fact from "nothing
warranted hiding".

**It is a structured log and NOT a `[tag]` console line**, and the first draft
got that wrong. The `[tag]` convention belongs to guards, whose output
`denominator-summary.cjs` collects out of a jest run — a scheduled job never
runs in CI, so a tagged line here would have been collected by nothing while
breaking the repo's no-`console` rule in server code. Three guards caught it
(`observability-foundation`, `logging-import-hygiene`, `observability-guards`),
which is the right number for a rule that matters. The siblings this job is
modelled on, `statement-dispatch` and `notice-score`, emit `logger.*` only.

## Files

| File | Role |
|---|---|
| `prisma/migrations/20261110090000_p9_3d_content_auto_hidden/migration.sql` | `ALTER TYPE … ADD VALUE 'CONTENT_AUTO_HIDDEN'` — additive, so no `.down.sql` |
| `prisma/schema/social.prisma` | the enum value, with why it is not `CONTENT_REMOVED` |
| `src/lib/farm-identity/verification-status.ts` | NEW `isPersonFromVerifiedFarm`, `verifiedFarmMembers` (two queries for N users) |
| `src/app-layer/jobs/channel-auto-hide.ts` | the job |
| `src/app-layer/jobs/{types,executor-registry,schedules}.ts` | payload, registration, `*/10 * * * *` |
| `messages/{en,bg}/app.json` | `statementOfReasons.action.CONTENT_AUTO_HIDDEN`; the dead `CONTENT_DEMOTED` line removed |
| `tests/guards/moderation-action-kinds-mirror.test.ts` | the copy assertion widened from one hardcoded kind to the derived enum, both directions, per locale |
| `tests/integration/p9-3d-channel-auto-hide.test.ts` | the mechanism, with its docblock saying it is not the reach |

## Decisions

- **Its own `actionKind`, not `CONTENT_REMOVED`.** It sets `autoHiddenAt`;
  a removal sets `removedByModerationAt`. Recorded as a removal, #2867's
  restore path would clear the wrong column, find it already null, and report
  `restored: false` — "already visible" — while the post sat there hidden.

- **`moderatorRef: 'auto:report-threshold'`.** No person decided, and the
  trail must not imply one did. That is also why a moderator may NOT send this
  kind on a notice decision: it would record a decision they *did* make as one
  nobody made. The entry is in `NOT_A_NOTICE_DECISION` with that reason.

- **The hide and the action are atomic; the statement is queued after.** A
  hidden post with no action row is content nobody can account for; an action
  row with nothing hidden is #2865's shape. The statement cannot join them:
  `queueStatementForAction` takes no `tx` and reads `User` through the global
  client, so calling it inside would take a second pool connection while the
  first is held — #1191's P0.8 deadlock. `actOnNotice` queues after its own
  transaction for the same reason.

  The window is real — hidden and recorded, then the queue fails and the author
  is not told. That is the residual of #2955 and the repo's existing posture.
  What this adds is that the failure is **counted and printed**: `actOnNotice`
  returns null and says nothing.

- **The notices stay `RECEIVED`.** A threshold is not a triage. The hide is
  provisional and a human still decides, so moving them to `ACTIONED` would
  take a decision nobody made and remove them from the one view showing work
  outstanding.

- **DISTINCT reporters, and an anonymous notice counts for nobody.** Three
  notices from one account is one opinion, and `@@unique` does not stop
  somebody filing twice. An Art 16 notice needs no account, so it has no
  reporter, cannot be attributed to a farm, and cannot be evidence of three
  farms agreeing — it still reaches a moderator.

- **`attempts: 1`, for a THIRD distinct reason.** `statement-dispatch` uses 1
  because a retry would re-SEND; `notice-score` because a retry would re-SPEND;
  this one because a retry would re-HIDE — the run's work is not idempotent at
  the batch level even though each post is.

- **«Verified» is imported, never redefined.** `verifiedFarmMembers` sits
  beside `isFarmVerified` in the one module that owns the notion. A second
  definition would drift the moment DISPUTED acquires a second meaning.

## What the test proves, and what it does not

It seeds VERIFIED claims and the threshold fires. **Production has none.** That
distinction is in the suite's own docblock, because a green run here is exactly
the evidence somebody would later cite as "auto-hide works".

Nine mutations, each killing exactly one assertion family: counting unverified
reporters, counting notices instead of farms, a threshold of two, writing the
human column, claiming a person decided, recording it as a removal, skipping the
statement, re-hiding on every run, and triaging the notices.

**One of them survived the first time**, and the fix is the finding worth
keeping: the unverified case filed three notices from ONE account, so the post
was skipped by the DISTINCT rule and the «verified» filter could be deleted with
all eight cases green. The case needs three distinct unverified accounts — which
is also the attack it describes.

## The copy axis — a fourth thing a kind can lack

`composeStatementBody` looks up `statementOfReasons.action.<KIND>`, and
`translateFor` is a plain interpolator with no ICU that **returns the key** when
it is missing. So this phase queued Art 17 statements whose action line read
`statementOfReasons.action.CONTENT_AUTO_HIDDEN`, and nothing failed:

- key parity compares the two catalogues to each other, and a key missing from
  BOTH is perfectly balanced;
- `moderation-action-kinds-mirror` asserted the copy for `CONTENT_RESTORED`
  alone, hardcoded — one of six kinds;
- and the counts matched. Six enum values, six catalogue keys — one of them
  `CONTENT_DEMOTED`, deleted from the enum by #2868, while the new kind was
  absent. A count check passes that exactly.

The guard now derives its population from the enum, in both directions, **per
locale**. The per-locale part is the strong half, measured: `translateFor` falls
back across locales, so removing the line from `bg` alone composes the notice in
English and the behavioural test still passes — a Bulgarian farmer receiving a
legal notice in English, and `bg` is the fallback for a recipient whose
preference never loaded, i.e. the common case.

So the three axes `moderation-action-kinds-mirror` already named — what a caller
may SEND, what the enum can HOLD, what the platform can DO — have a fourth
beside them: whether the outcome can be EXPLAINED. A kind can be holdable,
performable and unexplainable at once, and that failure is delivered rather than
raised.

**#2958 carries the general case**, which this PR does not fix: `translateFor`
returns the key with no throw, no log and no metric, and nothing checks the
other enum-keyed lookups. The five besides this one are covered today
(measured), so it is prevention — plus one false safety claim in
`digest-templates.ts`, which states that a new enum member "fails at the lookup"
when line 105 of `server-messages.ts` is `return key`.
