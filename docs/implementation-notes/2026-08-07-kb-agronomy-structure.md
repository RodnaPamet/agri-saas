# 2026-08-07 — KB agronomy structure + indexing job (PR 3 of 5)

**Commit:** see the PR history on `feat/kb-agronomy-structure`.

## Design

This PR gives the Knowledge Base a crop/BBCH-stage/region/language shape
and, critically, makes PUBLISHING AN ARTICLE ACTUALLY DO SOMETHING for
retrieval — before this PR, `KnowledgeChunk` rows for a tenant's own
articles were never created by any lifecycle event; only the standalone
`scripts/rag/ingest-tenant.ts` backfill script chunked published KB
content (as one whole-article chunk), and nothing chunked it in real
time or removed it on archive.

```
publishArticle ──▶ status=PUBLISHED, currentVersionId=vN  ──▶ enqueue
                                                               reindex-knowledge-article
archiveArticle ──▶ status=ARCHIVED                          ──▶ enqueue
unarchiveArticle (→PUBLISHED only) ──▶ status=PUBLISHED      ──▶ enqueue
                                                                    │
                                                                    ▼
                                          runReindexKnowledgeArticle
                                          (re-reads CURRENT state)
                                    ┌───────────────┴───────────────┐
                          PUBLISHED + content              anything else
                          (paragraph-chunk, replace)        (remove chunks)
                                    │
                                    ▼
                          enqueue('embed-chunks', {tenantId})
                                    │
                                    ▼
                          retrieve() — keyword ∪ vector, now
                          Bulgarian-first ranked
```

Five pieces, in dependency order:

- **S1+S2 — schema.** `KnowledgeArticle` gains `cropTags String[]`,
  `regions String[]`, `bbchStageMin/Max Int?`. `KnowledgeChunk` mirrors
  all four plus `language String?` (which the chunk didn't otherwise
  carry) so retrieval filters a chunk directly with no join back to its
  article — consistent with the module's existing no-join query shape
  (keyword branch is a flat `findMany`, vector branch is raw SQL).
- **S3 — surfaced.** `cropTags`/`regions` are now create/PATCH-able
  fields (both modals), two new multi-select filter facets (`crop`/
  `region`, mirroring the existing `category` facet), and a `Crop`
  list column. BBCH is edit-only (a `Switch` + two `NumberStepper`
  controls, Epic 60) — not wired as a list filter (see Decisions).
- **S4+S5 — the reindex job.** New job `reindex-knowledge-article`,
  enqueued from `publishArticle`/`archiveArticle`/`unarchiveArticle`
  (never scheduled — purely event-triggered, same shape as
  `classify-photo`/`soil-fetch`). One decision point, made from the
  article's CURRENT state at run time (not the transition that
  triggered it): PUBLISHED-with-content → chunk + replace;
  everything else → remove. This is what makes archive mean
  something — an archived SOP stops being retrievable.
- **S6 — paragraph chunker.** New `ai/rag/chunk.ts`
  (`chunkHtmlByParagraph`) — there was no chunking helper anywhere in
  `src/` before this. Splits TipTap HTML on block-closing tags (`p`,
  `h1`-`h6`, `li`, `blockquote`, table cells), falls back to one
  bounded chunk when no block tags are found. Idempotent by
  construction: the job does delete-then-insert inside one tenant
  transaction, not append.
- **S7 — language-aware retrieval.** `retrieve()` now ranks a chunk
  whose stamped `language` matches the caller's preferred language
  (default `'bg'`) with a small score bonus — a PREFERENCE, not a
  WHERE filter, so a query with no Bulgarian match still returns the
  best available result instead of nothing. Both existing branches
  (keyword + vector) and the PR-#496 embedding-degrade try/catch are
  unchanged.

## Files

| File | Role |
|------|------|
| `prisma/schema/knowledge.prisma` | `cropTags`/`regions`/`bbchStageMin`/`bbchStageMax` on `KnowledgeArticle`; mirrored + `language` on `KnowledgeChunk`; new `[tenantId, language]` index |
| `prisma/migrations/20260807090000_kb_agronomy_structure/` | hand-authored (matches the repo's existing pgvector-migration style) — `ALTER TABLE` + one `CREATE INDEX`, no RLS change |
| `src/app-layer/repositories/KnowledgeRepository.ts` | `cropTags`/`regions` filters (`hasSome`), new columns in `articleListSelect`/`create`/`updateMetadata` |
| `src/app-layer/usecases/knowledge.ts` | `sanitizeTagArray` (trim/dedupe/cap), `assertValidBbchRange` (both-or-neither, 0-99, min<=max), `enqueueReindex` fired from publish/archive/unarchive-to-PUBLISHED |
| `src/app-layer/ai/rag/chunk.ts` | new — `chunkHtmlByParagraph`, pure function |
| `src/app-layer/jobs/reindex-knowledge-article.ts` | new — the job executor body |
| `src/app-layer/jobs/types.ts` | `ReindexKnowledgeArticlePayload`, `JobPayloadMap`/`JOB_DEFAULTS` entries (NOT added to `schedules.ts` — event-triggered only) |
| `src/app-layer/jobs/executor-registry.ts` | registers `reindex-knowledge-article` |
| `src/app-layer/ai/rag/retrieve.ts` | `language` option, `RetrievedChunk.language`, `LANGUAGE_MATCH_BONUS` ranking |
| `src/app-layer/usecases/rag.ts` | `askKnowledgeBase` forwards an optional `language` through to `retrieve()` |
| `src/app/api/t/[tenantSlug]/knowledge/route.ts` | POST body + GET `crop`/`region` CSV params (`parseCsvIdParam`) |
| `src/app/api/t/[tenantSlug]/knowledge/[id]/route.ts` | PATCH body gains the four agronomy fields |
| `src/app/t/[tenantSlug]/(app)/knowledge/AgronomyFieldsSection.tsx` | new — shared crop/region/BBCH form block for both modals |
| `src/app/t/[tenantSlug]/(app)/knowledge/{NewArticleModal,[id]/EditArticleModal}.tsx` | wire `AgronomyFieldsSection` |
| `src/app/t/[tenantSlug]/(app)/knowledge/filter-defs.ts` | `crop`/`region` filter facets, `cropOptionsFromArticles`/`regionOptionsFromArticles` |
| `src/app/t/[tenantSlug]/(app)/knowledge/KnowledgeClient.tsx` | `Crop` list column |
| `src/app/t/[tenantSlug]/(app)/knowledge/[id]/page.tsx` | Crop/BBCH meta-strip items, passes new fields to `EditArticleModal` |
| `messages/{en,bg}.json` | `knowledge.colCrop`, `knowledge.detail.metaCrop/metaBbch`, `knowledge.filters.crop*/region*`, new `knowledge.agronomyFields.*` namespace |
| `tests/unit/rag-chunk.test.ts` | new — the chunker, pure-function coverage |
| `tests/unit/reindex-knowledge-article-job.test.ts` | new — removal branch, index branch, embed-chunks trigger, idempotency |
| `tests/unit/knowledge-agronomy.test.ts` | new — tag sanitisation, BBCH validation, reindex-enqueue wiring + commit-then-enqueue ordering |
| `tests/unit/rag-retrieve.test.ts` | language-ranking cases added |
| `tests/unit/rag-context.test.ts`, `tests/unit/safety-advisor.test.ts` | `RetrievedChunk` fixtures updated for the new required `language` field |

## Decisions

- **`String[]` arrays, not join tables, for `cropTags`/`regions`.** A
  join table would need a canonical crop catalog to FK against, and
  that catalog would have to be GLOBAL — `KnowledgeChunk.tenantId` is
  nullable specifically because the GLOBAL licensed catalog has no
  owning tenant, so a per-tenant `CropType` table (crop-planning's
  model) can't be the FK target without reintroducing a tenant
  coupling the chunk model deliberately avoids. A free-text join table
  buys zero integrity over an array column while adding a join to a
  latency-sensitive, already-hybrid retrieval query. Empty array is
  the documented sentinel for "applies to every crop/region."
- **`bbchStageMin`/`Max` — a min/max Int pair, not an array of
  stages.** BBCH (00-99) is a continuous ordinal scale; SOPs apply to
  a *range* of stages ("stem elongation" = 30-39), not a discrete set.
  A pair is simpler, index-friendly, and matches the brief's own
  wording ("BBCH stage range").
- **BBCH validation lives in the usecase, not just the Zod schema.**
  `assertValidBbchRange` enforces both-or-neither + in-range + min<=max
  centrally for create AND PATCH; the route Zod schemas only bound the
  wire shape (int, 0-99, nullable) per field. Centralising the
  cross-field rule in one place means a future third write path (e.g.
  a bulk importer in PR 4) gets the same guarantee for free.
- **No GIN index on `cropTags`/`regions`.** The existing
  `KnowledgeChunk` guardrail entry already documents that a `String[]`
  containment predicate has no useful index in this codebase's other
  array column (`TenantModuleSettings.enabledModules`) and stays a
  bounded post-filter; I followed the same precedent rather than
  introducing `btree_gin`/`postgresqlExtensions` machinery for a
  facet that's always combined with a `take`-bounded, tenantId-scoped
  query. `language` DID get a real `[tenantId, language]` btree index
  — it's an equality predicate on the keyword-branch's hot
  `findMany`, unlike the array containment filters.
- **Reindex is event-triggered, not scheduled.** Chunking an
  article's content is a direct consequence of ONE article's
  publish/archive transition, not a periodic sweep — same shape as
  `classify-photo`/`soil-fetch`/`embed-chunks`, none of which appear
  in `schedules.ts`. This also means the job never touches the
  fragile "exactly 30 scheduled jobs" guardrail in
  `tests/regression/infrastructure-guards.test.ts`.
- **Single decision point, re-read at run time.** The job doesn't
  branch on WHICH usecase enqueued it — it re-reads the article's
  current status. This makes it correct even if publish/archive race
  (the last-committed state wins) and collapses `publishArticle` /
  `archiveArticle` / `unarchiveArticle` to the same one-line
  `enqueueReindex(ctx, articleId)` call.
- **Enqueue AFTER the transaction commits, not from inside the
  `runInTenantContext` callback.** Mirrors `journal.ts`'s
  `classify-photo` enqueue. Enqueueing inside the callback risks the
  BullMQ worker picking up the job before the Postgres transaction
  commits, reading the pre-publish row. Verified by a dedicated
  ordering test in `knowledge-agronomy.test.ts`.
- **Idempotent by delete-then-insert, not diffing.** Re-running for
  one article (two publishes of edited content, or a retried job)
  replaces the whole KB chunk set atomically inside the same tenant
  transaction — simpler and provably duplicate-free, at the cost of
  discarding embeddings on unchanged paragraphs (they get
  re-embedded via the trailing `embed-chunks` enqueue). Given KB
  articles are not high-frequency-edited, this trade favours
  correctness/simplicity over that avoided re-embed cost.
- **`embed-chunks` triggered automatically after a successful
  (re)index**, rather than left for an operator to run
  `ingest-tenant.ts` manually. `embed-chunks` has no schedule either,
  so without this the freshly-chunked, NULL-embedding rows would sit
  unembedded (findable by keyword search, invisible to the vector
  branch) until someone ran the script by hand. Fire-and-forget with
  the same log-don't-throw contract as the reindex enqueue itself.
- **Language ranking, not language filtering.** A hard `WHERE
  language = ?` would return nothing for a query whose only relevant
  content happens to be English (most of today's GLOBAL corpus has no
  `language` stamp at all) — exactly the "fall back to other
  languages rather than returning nothing" the brief asks for. The
  bonus (0.15) is small relative to vector similarity (0-1) so a
  strongly relevant other-language chunk still outranks a weak
  same-language match.
- **BBCH is not (yet) a list filter.** Crop/region are natural
  multi-select facets (small, enumerable value sets from loaded
  rows, same shape as the existing `category` facet). A BBCH-range
  filter is a different UI shape (a numeric range picker over a
  0-99 scale) that the enterprise filter system doesn't have a
  ready-made facet type for; scoped out rather than bolting on a
  one-off control. The field is fully create/edit-able and stored,
  so nothing about the schema/data blocks adding the filter later.
- **`scripts/rag/ingest-tenant.ts`'s KB block is untouched and now
  effectively superseded going forward.** It still chunks a whole
  published article as ONE chunk (`chunkIndex: 0`, `sourceRef:
  articleId`) for tenants doing a one-off bulk backfill; its
  idempotency check (skip if any chunk already exists for that
  `sourceRef`) means it will never duplicate against rows the new
  job wrote. Any article published after this PR ships gets the
  finer paragraph-level chunks from `reindex-knowledge-article`
  instead. Left the script alone — rewriting/removing its KB block
  was not in scope and it still serves tenants seeded with
  KB content published before this PR shipped its own reindex.

## Verification

- `npm run db:generate` — clean.
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` — zero
  errors touching this feature. Nine pre-existing errors remain from a
  stale, gitignored `.next-test/types/validator.ts` referencing routes
  that don't exist anywhere in the tree (`tasks/*`, `api/assets/*`,
  `agro/ndvi-config`, `controls/[controlId]/assets`) — unrelated to
  this PR and not reproducible without a full `NEXT_TEST_MODE` rebuild,
  which was out of scope to run here.
- `node scripts/i18n-diff.mjs --check` — 0 missing/orphan/drift/untranslated.
- `npx jest tests/guardrails tests/guards` — 629/629 suites, 8728
  passed, 14 skipped (pre-existing DB-gated skips), 0 failed.
- Targeted unit runs (chunker, reindex job, retrieve language-ranking,
  knowledge usecase agronomy/enqueue wiring, job-registry/scheduler
  regression suites) — all green.
- `npx eslint` on every changed file — 0 errors, 5 pre-existing
  warnings unrelated to this diff.
- **Not run:** DB-backed integration tests (`tests/integration/
  knowledge.test.ts` and friends) — local PgBouncer (:5433) is down in
  this environment. CI runs them.
