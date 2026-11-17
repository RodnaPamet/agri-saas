# 2026-11-17 — which decisions produced no statement of reasons (#2996)

**Commit:** `b8670b9c0 feat(moderation): answer which decisions produced no statement of reasons`

Carved out of #2955. The mirror of `listUndeliveredStatements`: that view
ranges over `StatementOfReasons`, so it structurally cannot see a decision
that produced none.

## Design

```
ACCOUNT_ACTION_KINDS ──┐
                       ├──► expectsStatement(actionKind, subjectKind)   one row
STATEMENT_RECIPIENT_   │
  KINDS ───────────────┴──► SQL anti-join under a LIMIT                 many rows
                                        │
                     ┌──────────────────┴──────────────────┐
         keyed door (scripts)                   session door (console)
  /api/admin/moderation/                /api/t/{slug}/admin/moderation/
        unexplained-decisions                 unexplained-decisions
```

The two constants feed BOTH spellings, and an integration test asserts the two
spellings agree over every `(ModerationActionKind × ReportSubjectKind)` pair —
42 today.

## Files

| file | role |
|---|---|
| `src/app-layer/usecases/moderation.ts` | `ACCOUNT_ACTION_KINDS`, `expectsStatement`, `listDecisionsWithoutStatement` |
| `src/app-layer/usecases/statement-queue.ts` | `STATEMENT_RECIPIENT_KINDS` — the arm set as data |
| `src/app/api/admin/moderation/unexplained-decisions/route.ts` | keyed door, rate limit enforced inline |
| `src/app/api/t/[tenantSlug]/admin/moderation/unexplained-decisions/route.ts` | session door |
| `src/lib/openapi/paths/moderation.paths.ts`, `…/moderation-console.paths.ts` | both documented; the statements description corrected |
| `tests/integration/unexplained-decisions.test.ts` | 8 cases, incl. the 42-pair agreement |
| `tests/unit/statement-recipient-kinds-match-the-arms.test.ts` | the constant against the real arms |
| `tests/unit/moderation-unexplained-decisions-route.test.ts` | 7 cases; proves the rate limit is not inert |

## Decisions

- **The filter is DERIVED, and from the right one of two coinciding lists.**
  #2996's own draft SQL hardcoded three action kinds — the drift it warns
  against. The obvious source is `REMOVABLE_SUBJECT_KINDS`, but the property
  that matters is *"has a recipient resolver arm"*: removable asks "can this be
  taken down", the arm set asks "is there anyone to tell". #2955's guard makes
  the first a **subset** of the second rather than equal to it, so a kind that
  gained an arm without becoming removable would be a gap the view stopped
  seeing. Hence `STATEMENT_RECIPIENT_KINDS`, with a test running the real
  resolver over all seven subject kinds — plus a control proving a missing ROW
  is also null, without which that test would pass only if the constant were
  empty.

- **`ACCOUNT_ACTION_KINDS` is extracted; the suspension branch is NOT
  converged.** The pair was spelled twice. One spelling asks "is the recipient
  supplied", the other "does this lock an account out" — two questions with the
  same answer today. Collapsing them is the `SESSION_MAX_AGE_DAYS` /
  `SESSION_IDLE_MAX_AGE_MINUTES` mistake, so the second site keeps its literals
  and carries a comment saying why.

- **Both doors, because #2996's premise was stale.** It says the session console
  is the natural human-facing home and that its second half "is not built yet".
  Measured 2026-11-17: all five of its views exist. Shipping only the keyed
  route would have left an auditor's question answerable by a script and not by
  the console where every other moderation view lives — #2844's shape.

- **Raw SQL, and `rationale` deliberately unselected.** There is no Prisma
  relation between the two models, so `none: {}` is unavailable, and collecting
  every statement's `actionId` into a `notIn` grows without bound —
  `notice-score`'s reasoning. `rationale` is encrypted and a raw read cannot
  decrypt, so selecting it would return a `v1:`/`v2:` envelope that looks like
  a value. A test asserts the exact returned key set.

- **Newest first**, unlike the sibling. The undelivered queue measures LAG so
  it reads oldest-first; an unexplained decision is an incident and the recent
  one is still answerable.

- **The keyed route enforces its rate limit INLINE.** Four of its neighbours
  declare `rateLimit: { config }` on a GET and enforce nothing, because
  `resolveRateLimitScope` returns null for non-mutation methods. Filed as
  **#3155**. A docblock claiming this route's limit runs, with nothing
  executing it, would have repeated that defect one route along — so a test
  drives the handler and asserts both that the limiter is called and that its
  refusal is returned. Mutation M8 reintroduces #3155's exact shape here and is
  caught.

- **Documented, not baselined.** Two new routes, zero new undocumented paths
  (287 documented / 200 undocumented, unchanged). That required correcting the
  statements spec, which said *"Nothing answers that; it is a separate gap"* —
  true when written, false now.

## Mutation proofs — 8 of 8

| mutation | caught by |
|---|---|
| SQL drops the `<> 'NONE'` clause | 2 |
| SQL drops the recipient-kind clause | 2 |
| `LEFT JOIN` condition never matches | 1 |
| account-kind clause removed | 2 |
| the encrypted `rationale` is selected | 1 |
| `STATEMENT_RECIPIENT_KINDS` loses an arm's kind | 3 |
| route discards the limiter's refusal | 1 |
| route declares the limit the inert way (#3155's defect) | 2 |
