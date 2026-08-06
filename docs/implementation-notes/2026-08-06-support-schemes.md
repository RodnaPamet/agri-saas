# 2026-08-06 — Government support schemes, as a consumer of the pipeline that already exists

**Commit:** `feat(support-schemes): government measures a farm applies for, from one extraction pipeline`

Two decisions had to be made before any code: what this object *is*, and where
its data comes from. Both were prescribed, and one of them turned out to be
already half-answered in the repo.

## Design

### It is not a certification scheme

`/schemes` is CERTIFICATION: voluntary standards a farm is **audited against**,
modelled as `Framework{kind:'AG_SCHEME'}` with requirements, controls and
evidence. A government support scheme is something a farm **applies for** — it
has an application window, eligibility criteria and a payment, and there is no
checklist behind it.

Modelling one as a `Framework` would put "apply by 30 Sep" rows next to
"control point CB.7.1" in the same table. Separate entity, separate page,
separate nav entry — sitting beside News and Trends rather than beside Schemes,
because that is the company it keeps.

They cross-link where genuinely related (organic certification is a
precondition for some organic payments); they are not merged.

### The pipeline already existed — this is its second consumer

The prompt warned against a third parallel AI-news pipeline and named two
existing claimants. Checking before building found that the second is **already
shipped**: `NewsDerivedEvent` + the daily `news-event-extraction` job, with
exactly the prescribed shape — PROPOSED status, platform-admin approval,
confidence, a verbatim `sourceExcerpt`, denormalised provenance, an idempotency
key, no `tenantId`.

So the decision is: **one pipeline, several typed consumers.** This is the
second consumer, not a second pipeline. It reads the same input (policy-category
`MarketNewsItem` rows since the last run), through the same safety helpers, and
lands in the same PROPOSED-until-approved model. What differs is the output
shape — a calendar event is a date; a support scheme is a window plus
eligibility plus money.

The alternative, extending `NewsDerivedEvent` with `authority`, `measureCode`,
`budgetAmount` and two dates, would have made a date-point row and a scheme row
share one table with half its columns null in each case.

### Official sources first; AI is the supplement

dfz.bg and mzh.government.bg publish announcements, and an official feed needs
no hallucination guard for its dates. `source` is `'curated' | 'official-feed' |
'ai-news'`, defaulting to `curated`, and the UI renders the three differently.
AI-over-news fills the gap between an announcement being made and it being
ingested — it is not the primary input, and a row it produces can never look
like an official one.

### Never present a guess as a deadline

This is the whole risk. A farmer who misses a real ДФЗ application window
because an extracted date was three days off suffers **direct financial harm**.

Five backstops, in ascending order of how much they are trusted:

1. **The verbatim excerpt.** The model must return the exact sentence each date
   came from, and we re-verify it is an actual substring of the text we
   supplied. A model that paraphrases has failed the check even when the date is
   right — because then we cannot show a reviewer what it read.
2. **Date bounds** — `[today, today + 18 months]`. A window three years out is a
   misread of a year. A window that closes before it opens is two dates read in
   the wrong order.
3. **A confidence floor** (0.7, higher than the calendar extractor's 0.6 —
   there is more to get wrong in a window than in a point).
4. **A per-run cap.** A model that starts hallucinating tends to hallucinate
   volume.
5. **PROPOSED + human approval.** This is the one that actually holds. The other
   four only reduce how much a reviewer has to reject. Nothing reaches a tenant
   without a platform admin having looked at it, and the tenant-facing read
   filters `reviewStatus: 'APPROVED'` so an unreviewed row is unreachable by
   construction rather than by convention.

Every news item passes through `sanitizeUntrusted()` before entering the
prompt, and each is delimited as UNTRUSTED CONTENT with an explicit instruction
that anything inside reading like a command is inert article text. RSS bodies
are attacker-influenceable; a hostile feed could otherwise inject a fabricated
scheme with a fabricated deadline.

### The extraction call

Copied verbatim in *shape* from `field-briefing.ts`, the repo's fail-safe
template. It deliberately bypasses the AI router: `routing.ts` needs a tenant
`RequestContext` to resolve budget and model policy, and a GLOBAL job has no
tenant. So it gates on `env.ANTHROPIC_API_KEY` directly, uses forced
`tool_choice` rather than JSON reprompting, Zod-validates the tool input, pins
the output locale, and **returns null on every failure path** — a global job has
nothing to catch a throw.

### The weekly job

Weekly, not daily, because an application window is announced weeks or months
ahead: the subject does not change between Tuesday and Wednesday, and the daily
news-event job already covers the date-points that do. The lookback widens to 8
days so a single missed run is caught up.

Four edits, as the template requires:

| edit | why it is not optional |
|---|---|
| `JobPayloadMap` | the job name has to exist |
| `JOB_DEFAULTS` | **exhaustive over `JobName`** — omitting it does not "default", it fails to compile. This is the trap `calendar-deadlines` fell into, leaving unreachable dead code |
| `executor-registry` | dynamic-import shape, so the module is not loaded on every worker boot |
| `schedules` | **key-gated**, `...(env.ANTHROPIC_API_KEY ? [...] : [])`, exactly as Barchart does — a key-less deployment must never register a cron that can only no-op |

There is no `AiUsageEvent` ledger available: that table requires a non-null
`tenantId`. Token and cost accounting is an explicit `logger.info` line.

### The surface

`/support-schemes`: what is open now, what closes soon, who qualifies, and —
prominently — where each row came from. Filters by authority and status.

Window status is **derived from the dates**, not read from the stored column. A
stored status goes stale the moment a deadline passes, and nobody wants a farmer
reading "open" on 1 October about a window that shut in September. The stored
value is a fallback for curated rows that state a status without dates.

Bulgarian is written as Bulgarian, not transliterated: мярка, прием,
институция, ДФЗ. "Прием" is what a farmer calls an application window; "window"
transliterated is not.

Windows feed the calendar through the **existing** `subsidy-deadline` types
rather than a parallel concept — a subsidy deadline is a subsidy deadline
whether it came from a curated `AgriEvent`, a news-derived date-point, or a
scheme's window. A scheme yields up to two events (opens, closes), because both
are dates a farmer plans around.

## Files

| File | Role |
|---|---|
| `prisma/schema/agriculture.prisma` + `enums.prisma` + migration | `SupportScheme`, `SupportSchemeStatus` |
| `src/app-layer/schemas/support-scheme.schemas.ts` | value sets, `deriveWindowStatus`, write boundary |
| `src/app-layer/ai/support-scheme-extractor.ts` | the extraction call + the five backstops |
| `src/app-layer/jobs/support-scheme-extraction.ts` | the weekly job |
| `src/app-layer/jobs/{types,executor-registry,schedules}.ts` | the four wiring edits |
| `src/app-layer/usecases/support-schemes.ts` | APPROVED-only read; the platform review queue |
| `src/app/api/admin/support-schemes/**` | platform review + approve/reject |
| `src/app/api/t/…/support-schemes/route.ts` | tenant read (no write surface exists) |
| `src/app/t/…/support-schemes/**` | the page |
| `src/app-layer/usecases/compliance-calendar.ts` | windows as calendar deadlines |

## Decisions

- **A separate entity, not a `Framework`.** The two objects answer different
  questions and conflating them would degrade both surfaces.
- **A sibling extractor, not a bigger one.** Same pipeline, same safety, same
  approval; different output shape. Widening `NewsDerivedEvent` would have made
  every row half-empty.
- **The tenant read filters on APPROVED, rather than the UI hiding PROPOSED.**
  A filter in one query cannot be forgotten by a future page.
- **Weekly, and the prompt asked for it.** It also happens to be right: the
  subject does not move daily, and the daily sibling already covers what does.
- **Confidence floor above the calendar extractor's.** A window has two dates
  and an eligibility claim; there is more to read wrong than in a single date.
- **Derived window status.** A stored status is a fact about the past.
- **Reuse the existing calendar types.** Three features wanting the same
  upstream would otherwise have produced three ways of saying "deadline".
