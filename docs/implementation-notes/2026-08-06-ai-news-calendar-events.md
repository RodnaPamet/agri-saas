# 2026-08-06 — AI news-derived calendar events

**Commit range:** PR 3 of the 3-part calendar roadmap (`2026-08-05-calendar-consolidation.md`, `2026-08-06-calendar-agriculture-sources.md`)

## Design

Once a day, a job reads the policy-category slice of the already-ingested
`MarketNewsItem` cache (Trends → News), asks Claude Haiku to extract
concrete, dated events ("ДФЗ subsidy window opens 15 Sep", "regulation
effective 1 Oct"), and proposes them onto the farm calendar. Nothing here
is ever auto-published — every proposal is a human decision.

```
MarketNewsItem            news-event-extraction (daily job)      NewsDerivedEvent
(category: 'policy')  ──▶  Claude Haiku, forced tool use     ──▶  status: PROPOSED
                            + 3 anti-hallucination backstops

NewsDerivedEvent                 platform admin                       calendar
status: PROPOSED  ────▶  POST .../[id]/approve|reject  ────▶  status: APPROVED
                                                                       │
                                                          loadNewsDerivedEventEvents
                                                          (status: 'APPROVED' only)
                                                                       ▼
                                                          every tenant's calendar,
                                                          category: 'ai-news',
                                                          provenance: 'ai-news'
```

## Decisions

**Storage fork: a NEW `NewsDerivedEvent` table, not an extended
`AgriEvent`.** The brief offered both. `AgriEvent` already has almost the
right shape (title/category/date/url, GLOBAL, platform-admin-curated), so
extending it was the more "obvious" option — but it would have meant
adding `source`/`status`/`confidence`/`reviewedAt`/`reviewedBy` columns to
an existing, larger production table (with a backfill default for every
existing curated row), and retrofitting `listUpcomingAgriEvents` +
`loadAgriEventEvents` + the seed script + the existing admin routes with a
visibility gate they don't need today. This session could not reach the
dev database (PgBouncer down) to verify a migration against real data, so
minimising the blast radius of an unverifiable schema change on an
existing, working table was the deciding factor — a new, empty,
additive-only table carries none of that risk. The new table also keeps
the two provenance stories cleanly separated: `AgriEvent` is a curator's
direct assertion (always live), `NewsDerivedEvent` is a machine guess that
starts invisible. Modelled on `AgroSignal` per the brief's own precedent:
`@@unique([sourceNewsItemId, kind])` is the idempotency key, mirroring
AgroSignal's `@@unique([tenantId, locationId, kind, signalDate])`, and a
`status` enum stands in for AgroSignal's `notified` boolean because this
job needs a full PROPOSED → APPROVED/REJECTED lifecycle, not a one-shot
flag.

**No Prisma `@relation` from `NewsDerivedEvent.sourceNewsItemId` to
`MarketNewsItem`.** `MarketNewsItem` is pruned after 60 days
(`market-news-pull`'s retention sweep) but a subsidy deadline can be 18
months out. A hard FK would either dangle under `SetNull` (losing the
dedupe key on the very column that carries it) or block the prune under
`Restrict` (Prisma's default) the first time an old article's derived
event was still relevant. `sourceUrl`/`sourceTitle` are denormalised
snapshots taken at extraction time instead, so the calendar's "Source:"
citation keeps working long after the source article is gone.

**Approval is a platform-admin API action, not a UI page.** Mirrors
`agri-events.ts`'s curation model exactly: `PLATFORM_ADMIN_API_KEY`-gated
routes, no `RequestContext`, no `AuditLog` row (same structural reason
`agri-events.ts` documents — a global table has no tenant to hang a
hash-chained row on), a structured `logger.info` line as the audit trail
instead. `POST /api/admin/news-derived-events/[id]/approve|reject` are
the ONLY two writes to `status`; the extraction job only ever creates
PROPOSED rows. There is no admin UI page (matching the precedent — the
agri-events catalogue has none either); review happens through the API
directly, same operational shape as the rest of the platform-admin
surface today.

**`provenance` is an OPTIONAL marker, not a two-value enum on every
event.** The brief described `source: ('curated' | 'ai-news')`. Making
every one of the other 17 loaders explicitly stamp `provenance: 'curated'`
would have touched every existing source for no behavioural gain — the
DTO already has this shape (`external?: boolean`, `end?`, `detail?` are
all "absent = the base case" fields). `CalendarEvent.provenance` is
`'ai-news' | undefined`; its ABSENCE is the "this is a database fact"
signal every pre-existing event already carries for free, and its
PRESENCE is what a renderer keys the distinct treatment off. `confidence`
and `sourceUrl` are set only alongside it.

**Locale is hardcoded to `'bg'`, not per-request.** `withLocaleInstruction`
normally pins output to the VIEWING USER's locale, but this is a
tenant-less global job with no viewer in scope. The source feeds are
Bulgarian-market agricultural policy (the `categorize.ts` policy stems are
BG-first), so the extraction output is pinned to Bulgarian — the same
implicit choice `AgriEvent`'s curated titles already make (entered in
Bulgarian, rendered verbatim via the `raw` passthrough key regardless of
viewer locale).

**"lastRunAt" is a rolling lookback window (36h), not a persisted
cursor.** The brief's pseudocode reads `publishedAt > lastRunAt`. There is
no per-job execution ledger in this codebase to hang a true watermark off
(BullMQ's repeatable-job bookkeeping isn't queryable from inside an
executor), so `news-event-extraction.ts` uses `now - 36h` instead — enough
overlap that a single missed daily run is still caught up, at the cost of
silently dropping the oldest items if an outage runs longer than that. The
`@@unique([sourceNewsItemId, kind])` claim (`createMany({ skipDuplicates:
true })`, the same pattern `agro-signals.ts` uses for `AgroSignal`) absorbs
the resulting overlap for free — re-extracting an already-processed
article on the next run is an accepted, sub-cent cost rather than a
correctness problem.

**Three anti-hallucination backstops beyond the Zod shape.** A calendar
entry reads as a commitment, unlike an advisory briefing card — a farmer
who misses a real ДФЗ deadline because a hallucinated one sat three days
off has suffered real harm. `news-event-extractor.ts` therefore verifies,
in application code, what a JSON schema alone cannot express: (1)
`sourceNewsItemId` must be one of the ids actually supplied in that call;
(2) `sourceExcerpt` must be a VERBATIM, normalised substring of the
source item's own (sanitised) title + summary — not merely present, but
literally contained in the real text, which closes the gap a "please
cite your source" instruction alone leaves open (a hostile injected
instruction cannot also fabricate a matching citation that is
substring-contained in a real headline); (3) `eventDate` must fall in
`[today, today + 18 months]` and `confidence` must clear `MIN_CONFIDENCE
(0.6)`. `sanitizeUntrusted()` runs over every title/summary before it
enters the prompt, and each item is wrapped in an explicit
`UNTRUSTED NEWS ITEM` delimiter.

**Token/cost accounting is a `logger.info` line, not `AiUsageEvent`.**
`AiUsageEvent.tenantId` is non-nullable and this is a GLOBAL job with no
tenant — the same reason `agri-events.ts` can't write to `AuditLog`. The
job logs `promptTokens`/`completionTokens`/`costMicros` (via the existing
`estimateCostMicros` helper) on every run instead, so spend stays visible
without inventing a second ledger.

## Files

| File | Role |
|---|---|
| `prisma/schema/enums.prisma` | `NewsDerivedEventStatus` enum |
| `prisma/schema/agriculture.prisma` | `NewsDerivedEvent` model, beside `AgriEvent` |
| `prisma/migrations/20260806100000_add_news_derived_event/` | Hand-authored migration (could not run `prisma migrate dev` — the dev DB was unreachable this session; the SQL mirrors the schema and Prisma's own `CREATE TYPE`/`CREATE TABLE` conventions, but has NOT been applied or tested against a live Postgres) |
| `src/app-layer/schemas/news-derived-event.schemas.ts` | `NEWS_DERIVED_EVENT_KINDS`, status enum, list-query schema, admin DTO |
| `src/app-layer/ai/news-event-extractor.ts` | The Claude Haiku extractor + the three anti-hallucination backstops |
| `src/app-layer/jobs/news-event-extraction.ts` | The daily job — policy-only query, lookback window, idempotent `createMany` |
| `src/app-layer/usecases/news-derived-events.ts` | Platform-admin review surface (list/approve/reject) |
| `src/app/api/admin/news-derived-events/**` | GET (review queue), POST `.../approve`, POST `.../reject` — `PLATFORM_ADMIN_API_KEY`-gated |
| `src/app-layer/jobs/types.ts`, `executor-registry.ts`, `schedules.ts` | Job wiring — scheduled at `06:15 UTC`, ONLY when `ANTHROPIC_API_KEY` is set |
| `src/app-layer/schemas/calendar.schemas.ts` | `ai-news` category + two types, `NEWS_DERIVED_EVENT` entityType, `provenance`/`confidence`/`sourceUrl` on `CalendarEvent` |
| `src/app-layer/usecases/compliance-calendar.ts` | `loadNewsDerivedEventEvents` — the 18th fan-out source, `status: 'APPROVED'` only |
| `src/lib/design/status-tone.ts` | `ai-news` category tone (info family) |
| `src/components/ui/CalendarMonth.tsx` | Hollow, dashed-ring dot for `provenance: 'ai-news'` events — a shape difference, not just a colour |
| `src/app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx` | Side panel: distinct dashed card, confidence badge, mandatory "Source:" citation link, disclaimer |
| `messages/en.json`, `messages/bg.json` | New category/event/`aiNews.*` keys, real Bulgarian translations |
| `tests/unit/news-event-extractor.test.ts` | Extractor validation-bounds + backstop tests |
| `tests/unit/jobs/news-event-extraction.test.ts` | Job lookback window, no-op gate, idempotent dedup |
| `tests/unit/news-derived-events.test.ts` | Usecase state-machine tests |
| `tests/unit/compliance-calendar.test.ts` | New loader's mapping + the "no tenantId predicate" exclusion |

## Verification gap

This session could not reach the local database (PgBouncer on :5433 was
down), so the migration above was hand-written to match the schema and
the repo's existing migration conventions, but **was never applied or
run against a live Postgres**. `npx prisma validate` and `npm run
db:generate` both succeeded against the schema files. Before this ships,
someone with DB access should run `npx prisma migrate dev` (or `deploy`)
against a real database and confirm the migration applies cleanly and
`tests/guardrails/rls-coverage.test.ts` / `schema-index-coverage.test.ts`
still pass DB-backed (both should be no-ops here since `NewsDerivedEvent`
has no `tenantId`, but that is an assertion, not a verified fact).
