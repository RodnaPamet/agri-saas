# 2026-10-08 — PAST_DUE grace: 14 days, then a named capability freeze

**Issue:** #1325 (owner-ruled 2026-10-06, scope refined 2026-10-08)

## Design

Three things make this smaller than the issue expected.

**It is a capability list, not a downgrade to FREE.** #1325 opened as "degrade
to FREE after a grace period"; the owner's actual ruling is different in kind.
FREE is a set of COUNT limits (3 users, 5 locations, 5 listings). A tenant
pushed onto it would keep browsing the exchange and keep writing journal
entries while being told it has too many users — punishing the wrong thing, and
forcing a decision about the 4th user who already exists. What the owner asked
for is a growth freeze with two surfaces closed. So `plan` is never touched and
nothing is counted, deleted or reconciled. The rule is: read what you have, add
nothing new, and the two market surfaces close.

**There is no sweep.** The issue assumed a scheduled job and then named the
problem with one: a sweep must not race a `payment_succeeded` that re-activates
the account, or a customer who pays on day 6 of the grace is downgraded anyway.
Both dissolve if the restriction is COMPUTED at request time rather than
written. The webhook clears `pastDueSince`; the predicate stops answering true
on the very next request. No job, no idempotency key, no ordering. Items 2 and 3
of the issue are therefore not deferred — they are unnecessary.

**The restriction is on the unpaid tenant's own view only.** Their ACTIVE
listings stay visible to every other farm, contact still works, and inbound
threads keep arriving and remain answerable. The alternative — pulling their
listings — would break live negotiations with PAYING buyers, third parties who
did nothing wrong, and would need a suppressed-but-not-withdrawn state to
restore from. Nothing has to be restored when they pay, which is what makes the
narrow scope safe rather than merely lenient.

```
          day 0                      day 14
  ACTIVE ──┬── PAST_DUE, in grace ─────┬── PAST_DUE, restricted
           │   (warn on billing page)  │   exchange ✕  trends ✕
           │                           │   task.create ✕  upload ✕
           │                           │   journal.create ✕
           │                           │   …everything else, and every
           │                           │   OTHER farm's view, unchanged
           └── payment succeeds at any point ──→ pastDueSince = NULL,
               unrestricted on the next request
```

## Files

| file | role |
|---|---|
| `src/lib/billing/past-due.ts` | the whole policy: grace length, the capability union, `resolvePastDueState`, and `pastDueStatusPatch` |
| `src/lib/billing/entitlements.ts` | `assertNotPastDueRestricted` (ctx) and `assertTenantNotPastDueRestricted` (tenantId, for the upload choke point) + `getPastDueState` for pages |
| `src/lib/stripe.ts` | all five status writes now spread `pastDueStatusPatch` |
| `prisma/schema/auth.prisma` + `…_p1325_past_due_since` | `BillingAccount.pastDueSince`, additive and nullable |
| `src/app-layer/usecases/{exchange,farm-task,journal}.ts` | three gates |
| `src/lib/upload/ingest.ts` | the upload gate, one call covering every record-backed path |
| `src/app/api/t/[tenantSlug]/{trends/prices,trends/news,dashboard/trends}/route.ts` | trends gated at the route |
| `src/components/billing/PastDueRestricted.tsx` | the rendered restricted state |
| `src/app/t/[tenantSlug]/(app)/{exchange,trends}/page.tsx` | render it instead of the surface |

## Decisions

- **The clock is a column, not `currentPeriodEnd`.** That field needs no
  migration and for a past_due subscription IS the moment payment was due — but
  it is Stripe's, nullable, and advanced by events this codebase does not model.
  A fourteen-day countdown to a user-visible restriction should not depend on
  inferring intent from somebody else's column.

- **NULL is in-grace, never expired.** Every row already PAST_DUE gets NULL,
  because the column is new. Reading NULL as "expired long ago" would restrict
  every already-failing tenant on the first request after deploy, with no
  warning and none of the fourteen days. Backfilling `now()` in the migration
  was the alternative and is worse: a lie about when payment failed, written
  into the column a user-visible countdown is computed from.

- **One helper owns the clock, because five sites write the status.** Stripe
  fires `invoice.payment_failed` on EVERY smart retry. A site stamping `now()`
  each time pushes the deadline out roughly four times across the retry window
  and the restriction never fires — a fourteen-day grace that silently lasts for
  ever, with every "entering PAST_DUE sets the clock" test still passing. Five
  sites each remembering to maintain a second column is #1403's shape, so the
  status and the clock are returned together and cannot be written apart.

- **Trends is gated at the ROUTE, everything else at the usecase.**
  `getPriceTrends` / `getMarketNews` take no `RequestContext` and their payload
  is Redis-cached across every tenant: a gate inside them has no tenant to
  test, and one that did would be bypassed by the next cache hit.

- **Uploads are gated at `ingestUploadedFile`**, the choke point CLAUDE.md's
  upload convention already establishes. One call covers evidence, journal
  attachments, invoices and the importers; gating the routes would be N sites
  and a new one would escape silently.

- **Both write gates sit AFTER the idempotency replay check.** A task or
  journal entry created before the grace expired and replayed afterwards must
  return the ORIGINAL, not 403 — the same ordering argument the exchange block
  check makes. Telling a field client its write failed when the row is already
  in the list is worse than letting the replay through.

- **Rendered, not redirected.** `requireModule` — the other page gate on these
  same surfaces — redirects to the dashboard, which is right for a module the
  tenant switched off themselves. Here the owner's standing note is that
  "degrading silently is worse than not degrading": a farmer who used Борса
  every morning and finds it gone has been told nothing, and the one action that
  fixes it is invisible. The API refuses independently, so this is not a UI-only
  gate.

- **The refusal is `codedForbidden('PAST_DUE_RESTRICTED', …)`, not a prose
  `forbidden()`.** One sends the user to the billing PORTAL, `plan_limit_exceeded`
  to a plan picker; they are different destinations and a tenant sent to the
  wrong one cannot get out. It deliberately does not copy its sibling's English
  sentence: `no-server-authored-user-copy` is a downward ratchet and caught the
  first draft, which had authored one. The user-facing copy is in
  `billing.pastDue.*` in both locales, so the reader's language decides.

- **The exchange gate lands on BROWSE, not on custody.** The module gate's own
  comment already drew this line — "browsing is PARTICIPATION in the
  marketplace while `/exchange/my-listings` is CUSTODY of your own rows and
  must stay reachable" — and the owner's ruling falls on the same side. That
  agreement is why the scope is defensible rather than a guess.
