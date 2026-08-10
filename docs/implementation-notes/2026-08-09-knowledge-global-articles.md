# 2026-08-09 — GLOBAL KnowledgeArticle + `/knowledge/satellite` fold-in

**Commit:** see branch `feat/knowledge-global-articles`

## Design

Final task (W5) of the knowledge-base roadmap. `KnowledgeArticle.tenantId`
and `KnowledgeArticleVersion.tenantId` are now **nullable**. `NULL` =
GLOBAL, platform-authored content, readable by every tenant; non-null =
tenant-private, unchanged behaviour. This is the same asymmetric-RLS shape
already proven on `KnowledgeChunk` / `UserSession` /
`IntegrationWebhookEvent`:

```sql
CREATE POLICY tenant_isolation ON "KnowledgeArticle"
    USING ("tenantId" IS NULL OR "tenantId" = current_setting('app.tenant_id', true)::text)
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
```

**ONE policy, not a split read/insert pair.** Postgres RLS policies are
permissive — a sibling `tenant_isolation_insert FOR INSERT WITH CHECK
(own)` would OR with the read policy, and a permissive policy without its
own `WITH CHECK` implicitly grants `WITH CHECK (true)` on UPDATE for
visible rows. That would let `app_user` UPDATE a NULL-tenant GLOBAL row
to claim it for their own tenant. The single asymmetric policy (USING +
WITH CHECK on the SAME policy) is the only shape where "read global,
write only your own" actually holds — see the `UserSession` migration
(`20260423150000_epic_d1_user_session_rls`) for the long-form rationale
this migration mirrors.

**`KnowledgeAcknowledgement` is deliberately untouched.** It stays
NOT NULL tenantId on the canonical split-policy pair. Its composite FK
`(articleVersionId, tenantId) → KnowledgeArticleVersion(id, tenantId)`
requires an EXACT tenantId match, so acknowledging a GLOBAL article
version is structurally impossible at the DB layer (no
`KnowledgeArticleVersion` row ever has `tenantId = <a real tenant>` AND
`id = <a GLOBAL version's id>`). The usecase layer
(`assertTenantOwned` in `knowledge.ts`) rejects the same case first,
with a clear Forbidden error instead of a raw FK-violation message —
wired into every tenant-facing write usecase (`updateArticleMetadata`,
`createArticleVersion`, `publishArticle`, `archiveArticle`,
`unarchiveArticle`, `acknowledgeArticle`), called right after the
`notFound` check and before any repository write.

**Every read path widens to "own tenant OR GLOBAL"** via an explicit
`OR: [{ tenantId: ctx.tenantId }, { tenantId: null }]` (Prisma `in`
cannot carry NULL — same shape `ai/rag/retrieve.ts` already uses for
`KnowledgeChunk`). RLS permits GLOBAL rows regardless of the app-layer
filter, but the equality filter used everywhere else in this repo
(`tenantId: ctx.tenantId`) would silently EXCLUDE them — missing this on
any read path makes GLOBAL articles invisible on it, even though the DB
would have allowed the read. `KnowledgeRepository.list` composes every
filter (including the free-text search's own OR) as `AND` members so the
tenant-or-GLOBAL OR never gets clobbered by a second OR. Write methods
(`create`, `updateMetadata`, `updateStatus`, `setCurrentVersion`,
`softDelete`) and `getBySlug` (tenant's own slug-collision check only)
stay scoped to `tenantId: ctx.tenantId` — never widened.

**Slug uniqueness.** `@@unique([tenantId, slug])` no longer prevents two
GLOBAL articles sharing a slug — Postgres treats NULLs as distinct within
a unique index. A hand-authored partial unique index closes that gap:

```sql
CREATE UNIQUE INDEX "KnowledgeArticle_slug_global_key"
    ON "KnowledgeArticle"("slug") WHERE "tenantId" IS NULL;
```

Prisma's schema DSL has no `@@unique(..., where: ...)`, so this is
hand-authored SQL (like the `KnowledgeChunk` ivfflat vector index) and
not represented in `knowledge.prisma` — documented there instead.

**`/knowledge/satellite` fold-in.** The satellite-imagery guide page
used to be pure hardcoded i18n (deferred from an earlier PR precisely
because `tenantId` was NOT NULL). It now fetches GLOBAL articles from
`GET /knowledge/satellite-guide?lang=<locale>` and renders each
vegetation index's sanitised article HTML in place of the old blurb +
colour-reading text — **per-section**, not all-or-nothing. The i18n
copy in `messages/*.json` stays UNCHANGED as the fallback: the page
renders it immediately (no loading/blank state) and only swaps in the
article content once/if the fetch resolves with that index's row
present. A missing global article, a failed fetch, or a non-HTML
version all fall through to the untouched i18n text — this is the exact
regression ("silently empty the page for tenants without the seed run")
that caused the fold to be deferred in the first place, so it's handled
per-section rather than trusted to "the DB will always have the row."

**Platform authorship.** `KnowledgeArticleVersion.createdById` stays a
required FK to `User` even for GLOBAL rows (out of scope to make
nullable — the brief only nullable'd `tenantId`). A single designated
"platform author" User row (`knowledge-platform@agri-saas.internal`, no
password, cannot sign in) is upserted idempotently by
`scripts/rag/ingest-satellite-guide.ts`, mirroring how
`createTenantWithOwner` upserts a placeholder owner by `emailHash`. This
keeps "who authored this" a real, displayable answer everywhere the UI
already shows `createdBy.name` / `owner.name`, instead of introducing a
null-author special case throughout the detail page.

## Files

| File | Role |
|---|---|
| `prisma/schema/knowledge.prisma` | `tenantId` nullable on `KnowledgeArticle` / `KnowledgeArticleVersion`; relation fields optional; doc comments explain GLOBAL semantics + the partial-index/acknowledgement caveats |
| `prisma/migrations/20260809130000_knowledge_global_articles/migration.sql` | Hand-authored: drop NOT NULL, partial unique index on GLOBAL slugs, single asymmetric RLS policy on both tables |
| `src/app-layer/repositories/KnowledgeRepository.ts` | Reads widened to own-OR-GLOBAL; new `listGlobalByCategory` for the satellite-guide read; writes deliberately left tenant-only |
| `src/app-layer/usecases/knowledge.ts` | `assertTenantOwned` guard wired into every write usecase; new `getSatelliteGuideArticles` |
| `scripts/rag/ingest-satellite-guide.ts` | New — superuser-bypassed seed of the GLOBAL satellite guide (moved out of `scripts/import-knowledge.ts`), platform-author upsert, dose/PHI/REI gate |
| `scripts/import-knowledge.ts` | `SATELLITE_GUIDES` removed (promoted to GLOBAL); `ALL_SEED_ARTICLES` is now just `GROWING_GUIDES` |
| `src/app/api/t/[tenantSlug]/knowledge/satellite-guide/route.ts` | New GET route — GLOBAL "Satellite Imagery" articles for one language |
| `src/app/t/[tenantSlug]/(app)/knowledge/satellite/page.tsx` | Fetches the article model, per-section fallback to i18n; `dangerouslySetInnerHTML` on sanitised article HTML |
| `tests/guardrails/rls-coverage.test.ts` | `KnowledgeArticle` / `KnowledgeArticleVersion` added to `SINGLE_POLICY_EXCEPTIONS` |
| `tests/guards/csp-script-guardrails.test.ts` | Satellite page added to the `dangerouslySetInnerHTML` allowlist (defence-in-depth sanitise, same pattern as the knowledge/policy detail pages) |
| `tests/guardrails/dose-phi-rei-gate.test.ts` | Scans the new GLOBAL `SATELLITE_GUIDES` array too |
| `tests/unit/knowledge-agronomy.test.ts` | Executable coverage of `assertTenantOwned` rejecting every write usecase on a GLOBAL article, and `getSatelliteGuideArticles` |
| `tests/integration/knowledge-article-rls.test.ts` | New — DB-backed RLS behavioural tests (own-read, GLOBAL-read, cross-tenant-read-rejected, GLOBAL-INSERT-rejected, re-tenant-rejected, acknowledgement-FK-rejected) |
| `package.json` | `rag:ingest:satellite` script |

## Decisions

- **Acknowledgement is blocked on GLOBAL articles, not schema-widened to
  support it.** The alternative (dropping the composite FK so
  `KnowledgeAcknowledgement.tenantId` could differ from its version's
  tenantId) would have widened the change beyond the two models the
  brief scoped, and weakened a referential-integrity guarantee used
  nowhere else for this shape. Blocking is also the more conservative
  reading of "no tenant-facing route may create, edit, publish, archive,
  unarchive **or delete** an article with tenantId = NULL" — an
  acknowledgement row is a write that references the article.
- **A designated platform-author `User` row, not a nullable
  `createdById`.** Keeps the schema change minimal (exactly the two
  columns named in the brief) and keeps every existing `createdBy.name` /
  `owner.name` UI read working unmodified.
- **The satellite page's per-section fallback renders the i18n copy
  synchronously, not behind a loading state.** The whole point of this
  task was "don't repeat the silent-empty-page regression" — an
  immediately-correct fallback beats a technically-more-elegant
  loading/error state that could still race to blank.
- **`getBySlug` was NOT widened to include GLOBAL rows.** It exists
  solely to keep a new article's auto-generated slug unique WITHIN one
  tenant's own articles; a tenant's slug is allowed to collide with a
  GLOBAL article's slug (the partial unique index only constrains
  GLOBAL-vs-GLOBAL).
- **Not verified locally: the migration itself, and the DB-backed RLS
  integration test.** Local PgBouncer (`:5433`) is down in this
  sandbox, so `npm run db:migrate` / `db:push` could not be run and
  `tests/integration/knowledge-article-rls.test.ts` has not executed
  anywhere outside CI. Everything or by-DDL reasoning was cross-checked
  against the `UserSession` / `KnowledgeChunk` precedent migrations
  instead of an actual `psql` session.
