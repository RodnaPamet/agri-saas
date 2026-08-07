# 2026-08-07 — Knowledge CRUD defects (five fixes on `/knowledge`)

**Commit:** see the PR history on `fix/knowledge-crud-defects`.

## Design

`/knowledge` is where a farm's SOPs live. Production currently has zero
articles, so nothing is broken for a real user yet — the bar for this
pass is "make it safe before it carries real procedures," not "patch a
live wound." Five independent defects, fixed together because they all
touch the same lifecycle:

```
  createArticle ──▶ DRAFT (+ v1, currentVersionId set for preview)
        │  createArticleVersion ──▶ vN+1 (PUBLISHED article keeps serving
        │                           currentVersion — no DRAFT rollback)
        ▼  publishArticle(versionId) ──▶ PUBLISHED, currentVersionId=vN,
        │                                lifecycleVersion++
        ▼  archiveArticle ──▶ ARCHIVED (status only — currentVersionId AND
        │                     lifecycleVersion untouched)
        ▼  unarchiveArticle ──▶ PUBLISHED if lifecycleVersion > 1,
                                 else DRAFT
```

**1. Multi-select filters → 500 → false "empty" state.** `filter-defs.ts`
declares `multiple: true` on `status`/`category`; the enterprise filter
system comma-joins a multi-select into one URL param
(`?status=DRAFT,PUBLISHED`). The route handed that literal string to
Prisma as an enum equality, which threw — and the list page rendered the
resulting 500 as "no results," a confident wrong answer instead of an
error. Fixed with the repo's standard helpers: `parseCsvEnumParam`
(status, validated against `KnowledgeArticleStatus`) and `parseCsvIdParam`
(category, free-text) from `@/lib/validation/query-params`, `{ in: [...] }`
in the repository, guarded on `.length` so a cleared facet omits the
filter instead of emitting `{ in: [] }` (which matches nothing).

**2. Readers could see a DRAFT presented as "Current."** Two-part fix:
`listArticles` now forces `status: ['PUBLISHED']` whenever
`ctx.permissions.canWrite` is false — this OVERRIDES whatever the caller
asked for, including a hand-crafted `?status=DRAFT`, rather than merely
defaulting it. And the detail page dropped its
`article.currentVersion || article.versions?.[0]` fallback: with no
published version, the Current tab now shows the "not yet published"
empty state, never the newest draft. (Out of scope, noted for
transparency: `getArticle` itself is not floored, so a reader with the
direct article URL can still expand a draft version's content under the
Versions tab's "Show content" `<details>`. The two invariants explicitly
asked for — the list floor and the Current-tab fallback — are both
closed; widening `getArticle` itself is a separate, larger change this
pass didn't take.)

**3. Editing retracted the live SOP.** `createArticleVersion` used to
flip PUBLISHED → DRAFT on every new version (mirroring
`createPolicyVersion`). For an SOP surface that's actively harmful —
starting to draft an edit would unpublish the procedure a worker is
currently following. Removed entirely: a PUBLISHED article now keeps
serving `currentVersion` while newer versions pile up as drafts
underneath it. **Publish is the only thing that moves
`currentVersionId`** (archive/unarchive don't touch it either). The
detail header now shows an "Unpublished versions" count so pending
drafts don't go unnoticed, and the Versions tab explicitly badges every
non-current version "Draft" (previously it showed no badge at all for a
superseded/pending version, which read as "nothing to see here" rather
than "this hasn't shipped").

**4. Articles could never be edited or deleted.**
`KnowledgeRepository.updateMetadata` / `softDelete` existed with zero
callers — dead code, no route. Added `PATCH /knowledge/[id]`
(title/summary/category/owner/language, `canWrite`, sanitised via
`sanitizePlainText` per Epic C.5, audited as
`KNOWLEDGE_ARTICLE_UPDATED`) and `POST /knowledge/[id]/unarchive`
(`canAdmin`, mirrors `evidence/[id]/unarchive`'s shape: idempotent no-op
if not ARCHIVED). `softDelete` remains unwired — the brief scoped this
defect to "edit + reverse an archive," not hard delete, and there's no
route or UI need for it yet.

  **The unarchive status-restoration bug (caught by the integration
  test, not by review).** The first implementation derived the restored
  status from `currentVersionId != null ? 'PUBLISHED' : 'DRAFT'`. That's
  wrong: `createArticle` sets `currentVersionId` at CREATE time too (for
  preview), independent of ever calling `publishArticle`. Under that
  heuristic, archiving-then-unarchiving a DRAFT article that merely had
  initial content would silently promote it to PUBLISHED — reintroducing
  defect #2/#3's exact failure mode (an unreviewed draft presented as
  approved) through a third path nobody had named. Fixed by deriving the
  restored status from `lifecycleVersion > 1` instead — that field only
  increments inside `publishArticle` (`setCurrentVersion(...,
  bumpLifecycle: true)`), so it's a reliable "has this ever been through
  the admin-gated publish step" signal, and archiving never touches it.

**5. Hardcoded English labels.** `KNOWLEDGE_STATUS_LABELS` and the filter
facet labels/descriptions in `filter-defs.ts` were English string
literals baked into a `.ts` config module — invisible to Bulgarian
users regardless of their locale. Moved to `messages/{en,bg}.json` under
`knowledge.status.*` (enum member labels — same keys the list-page badge,
the filter picker, AND the Versions-tab "Draft"/"Published" badges could
all resolve through, so they can't drift into disagreeing translations)
and `knowledge.filters.*` (facet label/description). `filter-defs.ts`
now exports `buildKnowledgeFilters(t, tStatus, articles)` — two
translators, mirroring `grain/contracts/filter-defs.ts`'s
`buildContractFilters` — instead of baking English into the static defs.
The `CONFIG_PROP_BASELINE` ratchet in
`tests/guards/no-hardcoded-ui-strings.test.ts` moved 391 → 380 (the 4
literals removed from `filter-defs.ts`).

## Files

| File | Role |
|------|------|
| `src/app-layer/repositories/KnowledgeRepository.ts` | `KnowledgeFilters.status`/`.category` now arrays; `where` uses `{ in: [...] }` guarded on `.length` |
| `src/app-layer/usecases/knowledge.ts` | status floor in `listArticles`; removed PUBLISHED→DRAFT rollback in `createArticleVersion`; added `updateArticleMetadata` + `unarchiveArticle` |
| `src/app/api/t/[tenantSlug]/knowledge/route.ts` | GET parses `status`/`category` via `parseCsvEnumParam`/`parseCsvIdParam` |
| `src/app/api/t/[tenantSlug]/knowledge/[id]/route.ts` | added `PATCH` (metadata update) |
| `src/app/api/t/[tenantSlug]/knowledge/[id]/unarchive/route.ts` | new — `POST`, mirrors `evidence/[id]/unarchive` |
| `src/app/t/[tenantSlug]/(app)/knowledge/filter-defs.ts` | labels/descriptions moved to i18n; `buildKnowledgeFilters` takes two translators |
| `src/app/t/[tenantSlug]/(app)/knowledge/KnowledgeClient.tsx` | status badge label + filter build call use translators, not `KNOWLEDGE_STATUS_LABELS` |
| `src/app/t/[tenantSlug]/(app)/knowledge/[id]/page.tsx` | dropped the draft-as-current fallback; added Edit/Unarchive actions + unpublished-count meta item + Draft badge in Versions tab |
| `src/app/t/[tenantSlug]/(app)/knowledge/[id]/EditArticleModal.tsx` | new — metadata edit modal, mirrors `EditEvidenceModal` |
| `messages/en.json`, `messages/bg.json` | `knowledge.status.*`, `knowledge.filters.*`, `knowledge.editModal.*`, plus new `knowledge.detail` keys |
| `tests/guards/no-hardcoded-ui-strings.test.ts` | `CONFIG_PROP_BASELINE` 391 → 380 |
| `tests/guardrails/knowledge-status-floor.test.ts` | new — structural ratchet + mutation regression proof for the status floor and the no-draft-as-current fallback |
| `tests/integration/knowledge.test.ts` | rewrote the "rolls back to DRAFT" test for the new publish semantics; added reader-floor, metadata-update, and archive/unarchive round-trip coverage |

## Decisions

- **Override, not default, the reader floor.** `listArticles` replaces
  the caller's `status` filter entirely for a non-`canWrite` context
  rather than intersecting it — a reader who hand-crafts
  `?status=DRAFT,PUBLISHED` still gets PUBLISHED-only, not DRAFT+PUBLISHED.
  A floor that can be widened by asking nicely isn't a floor.
- **`category` uses the non-enum CSV parser.** `category` is a free-text
  column, not a Prisma enum, so `parseCsvEnumParam` doesn't apply.
  `parseCsvIdParam` doesn't actually require "ID" semantics — it's a
  structural (non-empty, bounded length/count) validator usable for any
  multi-select string facet, per its own doc comment.
- **No content-visibility floor on `getArticle`.** Scoped this pass to
  exactly the two invariants named (list floor, Current-tab fallback).
  A reader who already has an article's URL can still open the Versions
  tab and expand a draft's raw content — flagged in the Design section
  above and in the report, not silently left undocumented, but not
  fixed here; it's a materially bigger change (getArticle would need to
  either strip non-published version content or gate the whole endpoint
  by status) and wasn't in the requested scope.
- **`lifecycleVersion`, not `currentVersionId`, decides unarchive's
  restored status.** See the Design section — this was a real bug
  caught only by the new integration test, not by review. Worth calling
  out as the reason `unarchiveArticle` doesn't just do the "obvious"
  `currentVersionId ? PUBLISHED : DRAFT` thing.
- **`softDelete` stays dead code.** The defect brief's "edited or
  deleted" maps to "edit metadata" + "reverse an archive" (archive is
  this app's soft-delete-equivalent, and it was previously one-way).
  Wiring the separate `deletedAt` hard-soft-delete path wasn't asked for
  and has no route or UI demand yet.
- **`softDelete`/`updateMetadata` on the repository already existed
  pre-change** — only `updateMetadata` gained a caller in this pass.
- **Filter i18n mirrors `grain/contracts`, not a placeholder-in-STATIC_DEFS
  pattern.** Several other `filter-defs.ts` files in the repo (contracts,
  farm-tasks, planning) keep real English strings in `STATIC_DEFS` as
  "typed placeholders," accepted as pre-existing debt under
  `CONFIG_PROP_BASELINE`. This file's `STATIC_DEFS` uses empty-string
  placeholders instead (`label: ''`), so it contributes zero new debt
  rather than perpetuating the pattern.

## Also found, not fixed (out of scope per instruction)

The multi-select-filter-500 defect (#1 above) is NOT unique to
`/knowledge` — the brief asked to verify planning / inventory /
farm-tasks:

- **`farm-tasks`** — safe. Its `status` facet (`multiple: true`) is
  filtered CLIENT-SIDE over an already-loaded bounded queue (see the
  comment in `farm-tasks/filter-defs.ts`); the value never reaches the
  API as a CSV query param.
- **`inventory`** — safe (trivially). `InventoryClient.tsx` has no
  `FilterToolbar`/multi-select filtering wired up at all yet.
- **`planning` (crop plans) — NOT fixed, still live.**
  `planning/filter-defs.ts` declares `status: { multiple: true, … }`,
  and `CropPlansClient.tsx` sends it through `toApiSearchParams` to
  `GET /api/t/:slug/planning/crop-plans`. That route's `QuerySchema`
  types `status: z.string().optional()` and passes it straight through;
  `listCropPlans` in `src/app-layer/usecases/crop-planning.ts:421`
  assigns it directly to a Prisma enum filter
  (`filters.status as Prisma.EnumCropPlanStatusFilter['equals']`) — the
  exact same defect shape. Selecting two crop-plan statuses in the UI
  today throws a 500 that renders as an empty table. Left unfixed here
  — explicitly out of scope for this PR — but it's a live bug, not a
  historical one.
