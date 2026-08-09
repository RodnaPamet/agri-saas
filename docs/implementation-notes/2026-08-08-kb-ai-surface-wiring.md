# 2026-08-08 — wiring the knowledge base into the AI surfaces (PR 5/5)

**Commit:** `6452afe7 feat(knowledge): wire the knowledge base into the AI surfaces (PR 5/5)`

## Design

Four PRs built a knowledge base almost nothing read: `retrieve()`,
`askKnowledgeBase`, `buildContext`, and `safety/advisor.ts` all existed
and worked, but `askKnowledgeBase`'s only caller was the `classify-photo`
job, and `field-briefing.ts` performed no retrieval at all. This PR
wires the existing machinery into three user-facing surfaces without
rebuilding any of it, under one constraint that shaped every decision:
**production retrieval is keyword-only** (no `AI_EMBED_BASE_URL` is
configured on the VM), so every surface had to stay honest and useful
in that degraded state.

**W1/#89 — field briefing.** `satellite-briefing.ts` now runs ONE
bounded `retrieve()` call (`FIELD_BRIEFING_RAG_TOP_K = 3`), keyed off
the farm's own primary crop tag (the first non-empty `cropTags` value
across its mapped fields — a deterministic, cheap choice, not a loop
over every crop). The retrieved chunks are handed to
`generateFieldBriefing` as a new `knowledgeContext` field, rendered as a
labelled, non-authoritative "Knowledge base notes" section in the user
prompt, with an explicit system-prompt instruction to use them only
where relevant and to never state a dose/PHI/REI figure even if one
seems implied — reinforcing the hard rule defensively, on top of the
fact that no such figure can exist in the corpus in the first place
(the ingestion gate refuses it). Retrieval failure degrades to "no
additional grounding" (never sinks the briefing), matching every other
fail-safe branch already in this usecase. The whole call sits behind
the existing 6h per-tenant Redis cache, so cost is already amortised
before the topK bound even matters.

**W2/#90 — citations.** `FieldBriefingPayload` gained a `sources`
field (deduplicated `{ source, sourceType }` pairs). `FieldBriefingCard`
renders a footer line naming them, but only when non-empty — a grounded
answer with invisible sources is indistinguishable from an ungrounded
one, so the whole point is to make the grounding visible, not to
fabricate a footer when there was none.

**W3/#91 — the ask route.** `POST /api/t/[tenantSlug]/knowledge/ask` is
a thin HTTP boundary over the EXISTING `askKnowledgeBase` usecase — no
new usecase file, so it doesn't trip `usecase-test-coverage`. Gated by
a new granular `knowledge.view` permission (added to `PermissionSet`
because no domain existed for the knowledge base at all — every role
but `MECHANISATOR` holds it, matching the "everyone can read the KB"
posture the article list already has), rate-limited by a new
`KNOWLEDGE_ASK_LIMIT` preset (10/min per IP+user — an LLM completion
per request is the same cost/abuse class as `EXCHANGE_INQUIRY_LIMIT`),
and the query is run through `sanitizeUntrusted` (the same
prompt-injection pre-filter `askAgronomyAdvisor` applies to retrieved
chunks) before it reaches the grounding prompt.

**W4/#92 — the ask box.** `KnowledgeAskModal` on `/knowledge` renders
exactly one of three states, kept strictly apart: a real request
failure (network/403/429/400 → an error banner), a successful response
with zero sources (→ an honest `EmptyState variant="no-results"` —
`askKnowledgeBase` already returns the fixed "not in my sources" text
without calling the model when retrieval is empty, so this is a truthful
negative result, not a failure), or a successful response with sources
(→ the answer plus its citation list). Conflating the first two is
exactly the bug PR #497 fixed elsewhere on this page (a 500 rendered as
a confident empty state) — the module doc comment on both the route and
the modal calls this out explicitly so it doesn't regress in a new
shape.

**W5/#93 — folding the satellite guide.** `/knowledge/satellite` was a
standalone, i18n-only page outside the article model. Its content now
also exists as 10 new `GLOBAL_CORPUS` entries (5 vegetation indices ×
bg/en) in `scripts/rag/corpus.ts` — retrievable by every tenant with
zero setup, since GLOBAL chunks need no per-tenant seeding — and as 10
new `KnowledgeArticle` seeds (`SATELLITE_GUIDES` in
`scripts/import-knowledge.ts`, category "Satellite Imagery") for
tenants that run `npm run import:knowledge`, making the content
versioned and searchable in the `/knowledge` list. What did **not**
fold: the page itself. `KnowledgeArticle.tenantId` is a required
(non-nullable) column — unlike `KnowledgeChunk`, there is no GLOBAL
Article row, so there is no way for one Article to serve every tenant.
Switching the live page to read from the Article model would mean
either a cross-cutting schema change (out of scope) or the guide going
silently blank for every tenant that hasn't run the seed script — the
exact "drop content silently" outcome this PR was told to avoid. The
page keeps rendering from i18n as before, with a new link pointing a
reader at the searchable article-model copy.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/ai/field-briefing.ts` | W1 — `BriefingKnowledgeSnippet` + `knowledgeContext` input, system-prompt grounding instructions incl. the dose/PHI/REI guard |
| `src/app-layer/usecases/satellite-briefing.ts` | W1/W2 — bounded `retrieve()` call keyed off primary crop, `sources` on `FieldBriefingPayload` |
| `src/app/t/[tenantSlug]/(app)/dashboard/FieldBriefingCard.tsx` | W2 — renders the sources footer (defensive `?? []` for pre-deploy cached payloads) |
| `src/app/api/t/[tenantSlug]/knowledge/ask/route.ts` | W3 — new route: `requirePermission('knowledge.view')`, `KNOWLEDGE_ASK_LIMIT`, `sanitizeUntrusted` |
| `src/lib/permissions.ts` | W3 — new `knowledge: { view }` `PermissionSet` domain, granted to every role but `MECHANISATOR` |
| `src/lib/security/rate-limit.ts` / `rate-limit-middleware.ts` | W3 — `KNOWLEDGE_ASK_LIMIT` preset + re-export |
| `src/lib/security/route-permissions.ts` | W3 — `knowledge/ask` rule (`knowledge.view`) |
| `tests/guardrails/api-permission-coverage.test.ts` | W3 — `knowledge/ask` added to `PRIVILEGED_ROOTS` |
| `src/app/t/[tenantSlug]/(app)/knowledge/KnowledgeAskModal.tsx` | W4 — new self-contained ask modal (error / no-results / answer states) |
| `src/app/t/[tenantSlug]/(app)/knowledge/KnowledgeClient.tsx` | W4 — wires the ask trigger into the list-page header actions |
| `scripts/rag/corpus.ts` | W5 — 10 new GLOBAL vegetation-index corpus entries |
| `scripts/import-knowledge.ts` | W5 — `SATELLITE_GUIDES` + `ALL_SEED_ARTICLES` |
| `src/app/t/[tenantSlug]/(app)/knowledge/satellite/page.tsx` | W5 — doc comment on the fold decision + a link into the searchable KB |
| `tests/guardrails/dose-phi-rei-gate.test.ts` | W5 — scans `ALL_SEED_ARTICLES` (was `GROWING_GUIDES` only) |
| `messages/en.json`, `messages/bg.json` | i18n for every new string above, real Bulgarian throughout |
| `tests/unit/satellite-briefing.test.ts` | Mocks `retrieve()`, asserts the new grounding + sources plumbing |
| `tests/unit/sync-{orchestrator,concurrency-failure,conflict-deep}.test.ts` | Hand-built `PermissionSet` fixtures updated with the new `knowledge` domain (TS would otherwise fail to compile them) |

## Decisions

- **`knowledge.view` is one flag, not view+ask.** The ask endpoint reads
  the same corpus the article list already shows; splitting "view
  articles" from "ask questions about them" would be a permission split
  with no product meaning yet. If a future surface needs to distinguish
  them, add the second action then.
- **Retrieval query is the crop name, not a sentence.** `retrieve()`'s
  keyword branch is a single `contains` substring match, not a
  tokenised OR — a multi-word query like "wheat barley agronomy" would
  match nothing. Using the bare crop tag (already the literal English
  string the GLOBAL corpus's EN entries contain) is what makes the
  keyword-only production path actually return something today; once
  an embedding endpoint is configured, the vector branch's semantic
  match stops caring about this limitation.
- **BG-only keyword match is a known, documented gap.** The field
  briefing's crop-name query matches the EN mirror of the (Bulgarian-
  authored) corpus content under keyword-only search, not the BG
  original, because `Parcel.cropType` stores the English canonical
  value ("Wheat"). Flagged rather than silently accepted; resolved
  automatically once vector search is live.
- **The satellite page's live rendering was NOT switched to the Article
  model.** See the Design section — `KnowledgeArticle.tenantId` is
  non-nullable, so no Article row can serve every tenant the way a
  GLOBAL `KnowledgeChunk` can. Parallel authoring (corpus + seed
  articles) plus a link, not a replacement, was the only option that
  didn't regress the page for tenants that never run the seed script.
- **No new usecase file for the ask route.** `askKnowledgeBase` already
  existed; the route calls it directly. Adding a wrapper usecase purely
  to satisfy convention would have been ceremony with no behavioural
  difference.
