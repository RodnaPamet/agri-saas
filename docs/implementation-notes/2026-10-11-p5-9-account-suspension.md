# 2026-10-11 — P5.9: account suspension

**Commit:** `<pending>` P5.9: a suspension that actually suspends

## Design

```
POST /api/admin/moderation/notices   (actionKind: ACCOUNT_SUSPENDED + suspendUserId)
  └─ actOnNotice  ─ ONE interactive transaction ─┐
       ├─ ModerationAction.create                │
       ├─ ContentReport.update (ACTIONED)        │
       └─ suspendAccountOnTx(tx, …) ─────────────┤  same tx: no 2nd pool connection
            ├─ User.suspendedAt = now()          │
            ├─ User.sessionVersion++  (backstop) │
            ├─ UserSession.revokedAt  (live rows)│
            └─ afterCommit: invalidate cache, append to the `moderation` chain
                                                 ┘
POST/DELETE /api/admin/moderation/suspensions → suspendAccount / liftSuspension

every authenticated request
  └─ getSessionOrThrow()          ← all three ctx resolvers; auth() = cookie|bearer
       └─ isAccountSuspended(id)
            ├─ Redis GET  '0'|'1'           → answer, no query
            ├─ Redis error                  → fall THROUGH to Postgres
            ├─ Postgres  suspendedAt != null
            └─ Postgres error               → FAIL CLOSED
       └─ throw codedForbidden('ACCOUNT_SUSPENDED')
```

## Files

| File | Role |
|---|---|
| `prisma/schema/auth.prisma` + `migrations/20261011150000_…` | `User.suspendedAt`, a PARTIAL index, and two `PlatformAuditAction` values |
| `src/lib/auth/suspension.ts` | the per-request check, its cache, and the two fail directions |
| `src/lib/auth.ts` | the choke point — `getSessionOrThrow` |
| `src/app-layer/usecases/account-suspension.ts` | `suspendAccountOnTx` / `suspendAccount` / `liftSuspension` |
| `src/app-layer/usecases/moderation.ts` | `actOnNotice` performs the suspension it records |
| `src/lib/schemas/index.ts` | `suspendUserId`, required by refinement for the two access-withholding kinds |
| `src/app/api/admin/moderation/suspensions/route.ts` | suspend + lift, platform-gated |
| `src/lib/audit/platform-audit-writer.ts` | the `moderation` chain scope |
| `tests/integration/p5-9-suspension-takes-effect.test.ts` | measures the window |
| `tests/unit/suspension-cache.test.ts` | the cache, with Redis mocked |
| `tests/unit/account-suspension-wiring.test.ts` | that the post-commit effects are CALLED |

## Decisions

- **The enforcement point is `getSessionOrThrow`, not middleware.** Middleware is
  where "within one request" belongs — one reader of `token.error`, covering
  cookie and bearer — and it is impossible: it runs on the Edge, which has
  neither Prisma nor ioredis here, and Upstash is absent in production. Setting
  `token.error` from the `jwt` callback is the 5-minute lag by another name,
  because that callback runs on re-issue rather than per request.

- **The two fail directions are opposite.** Redis unreadable → fall through;
  Postgres unreadable → fail closed. The justification for the strict half is
  specifically that it is free: a request that cannot read `User.suspendedAt`
  cannot do its own work either, so no new outage mode is created. That is why
  `src/middleware.ts` can keep failing open on an unknown session answer, and
  the fail-open catch there was deliberately NOT changed — the docblock now says
  so, so nobody "fixes" it by reference to this issue.

- **Recording the outcome now requires performing it.** `ActOnNoticeSchema`
  refuses `ACCOUNT_SUSPENDED` / `ACCOUNT_TERMINATED` without `suspendUserId`.
  That is the structural fix for #1635 — a false Art 17 statement is not
  reachable by forgetting a second step.

- **`suspendUserId` is supplied, not derived.** A notice names content; a
  reported listing belongs to a farm with several members. The same reasoning
  already put `recipientUserId` on `QueueStatementSchema`.

- **`ACCOUNT_TERMINATED` suspends too.** It withholds access, so it withholds
  access today; the ERASURE half is P5.6, whose basis is now settled as Art
  17(3)(b). Better a terminated account locked out and not yet pseudonymised
  than announced and still reachable. **Open copy question, not changed here:**
  the statement for it says "we closed your account", which is true of access
  and not yet of the data.

- **A partial index.** The per-request read is by primary key, so only the
  console's "who is suspended" needs an index — and it wants the handful of SET
  rows rather than one entry per user. Prisma's DSL cannot express the
  predicate, so the schema's `@@index([suspendedAt])` is the closest
  declaration and the migration carries the real one.

## What mutation proof changed about this PR

Three mutations behaved as predicted; the fourth did not, and it is the reason
two of the three test files exist.

Dropping the `afterCommit` cache invalidation reddened **nothing**. There is no
`REDIS_URL` in `.env.test`, so `getRedis()` returns null and the whole cache
path is dead code in the integration suite — the test I had written as "a cached
NOT-suspended verdict cannot outlive the suspension" was vacuous. It now says
what it actually proves, and the cache is covered by two unit files with Redis
mocked: one for the helper, one for whether anybody calls it. Between them they
cover the seam; neither alone did.
