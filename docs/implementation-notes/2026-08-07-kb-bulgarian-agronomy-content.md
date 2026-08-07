# 2026-08-07 — Bulgarian agronomy content + licensing tiers (PR 4 of 5)

**Commit:** see the PR history on `feat/kb-bulgarian-agronomy`.

## Design

This PR loads real content into the Knowledge Base built by PR 3
(`feat/kb-agronomy-structure` — crop/BBCH/region/language columns on
`KnowledgeArticle`/`KnowledgeChunk`). It carries a legal constraint that
shaped every other decision: **a dose rate, PHI (pre-harvest interval),
or re-entry interval may appear ONLY alongside a real БАБХ (Bulgarian
Food Safety Agency) registration number.** This product has no licensed
БАБХ registration dataset, so no content anywhere in this diff states a
dose, PHI, or re-entry interval — see `scripts/rag/dose-phi-guard.ts`.

```
scripts/rag/corpus.ts            scripts/import-knowledge.ts
  GLOBAL_CORPUS (34 entries)        GROWING_GUIDES (8 entries)
  tenantId = NULL                   tenantId = <tenant>
  wheat/barley/maize/sunflower      short crop overviews,
  BBCH + scouting + cultural +      one bg + one en per crop,
  nutrition + harvest, bg+en        point at the GLOBAL content
        │                                  │
        ├── assertLicensedSource() ────────┤ (shared allowlist +
        │   (Tier-1 allow / Tier-4 block)  │  Tier-4 hard-block)
        │                                  │
        └── assertNoUnregisteredRegulatedContent() ┘
            (scripts/rag/dose-phi-guard.ts — runs at
             INGEST TIME, not just as a CI text scan)
```

Both content-authoring surfaces route through the SAME two gates before
a row is ever written, so a future edit to either file — not just
today's — gets checked.

## Files

| File | Role |
|------|------|
| `scripts/rag/corpus.ts` | `LICENSED_SOURCES` gains `'Agri-SaaS agronomy desk (original)'`; `PROHIBITED_SOURCES` widens the Tier-4 hard-block (GlobalG.A.P. text preserved verbatim + AHDB/Canola Council/agri.bg/sinor.bg/vendor portals added); `SAMPLE_GLOBAL_CORPUS` renamed `GLOBAL_CORPUS` and replaced with 34 Bulgarian-first agronomy entries (wheat/barley/maize/sunflower × BBCH backbone/scouting/cultural+nutrition/harvest, bg+en, plus a shared "check the БАБХ register" entry); `CorpusEntry` gains `language`/`cropTags`/`regions`/`bbchStageMin`/`bbchStageMax`; `ingestGlobalCorpus` mirrors those fields onto the chunk and calls the new dose/PHI/REI gate |
| `scripts/rag/dose-phi-guard.ts` | new — the C6 structural gate: `scanForUnregisteredRegulatedContent` / `assertNoUnregisteredRegulatedContent`, covering bg+en and both unit systems (л/дка, ml/dka, l/ha, g/ha, % solutions), PHI (карантинен срок / PHI / days before harvest), REI (възстановителен / въстановителен / re-entry), gated on a БАБХ/generic registration-number marker that must contain a digit |
| `scripts/import-knowledge.ts` | `GROWING_GUIDES` replaced (OpenFarm vegetable guides → 8 Bulgarian arable-crop overviews, bg+en per crop); wires `assertNoUnregisteredRegulatedContent` before every write; `source`/`language`/`cropTags` now stamped from the guide |
| `scripts/rag/ingest-corpus.ts` | imports `GLOBAL_CORPUS` (renamed), updated doc comment |
| `THIRD_PARTY_NOTICES.md` | new "Agri-SaaS agronomy desk (original)" entry (original content, no third-party text); OpenFarm entry removed (superseded); KCC/FAIR-Forward/EU 2018/848/USDA 7 CFR 205 entries annotated as allowlisted-but-currently-unused; GlobalG.A.P. section widened to "Tier 4 — PROHIBITED" (message text preserved, four more entries added) |
| `tests/guardrails/dose-phi-rei-gate.test.ts` | new — structural scan of the real shipped content (`GLOBAL_CORPUS` + `GROWING_GUIDES`) plus the mutation-proof fixture suite (75 assertions: violating doses/PHI/REI in both languages+unit systems, the registered-product escape hatch, a false-escape-hatch regression, and false-positive guards against legitimate scouting/BBCH/moisture content) |
| `docs/implementation-notes/2026-08-07-kb-bulgarian-agronomy-content.md` | this file |

## Decisions

- **C3 — chunks-only-no-article for the GLOBAL catalog.** `KnowledgeArticle.tenantId`
  is NOT nullable (unlike `KnowledgeChunk.tenantId`, which already carries
  the proven asymmetric RLS policy `USING (tenantId IS NULL OR own) WITH
  CHECK (own)` from the `feat/ai-rag` migration). Three options existed: (a)
  a reserved platform `Tenant` row, (b) make `KnowledgeArticle.tenantId`
  nullable with a matching asymmetric RLS policy, (c) GLOBAL content as
  `KnowledgeChunk` rows with no backing `KnowledgeArticle` — exactly the
  shape `SAMPLE_GLOBAL_CORPUS`/`ingestGlobalCorpus` already used before this
  PR. Chose (c). A platform-tenant row (a) would need every tenant's read
  path to cross a tenant boundary to see "global" content, which RLS is
  deliberately built to prevent — that is either a bypass of the isolation
  model or a special-cased read path that has to be re-justified at every
  call site. Option (b) is schema surgery (a new migration + a new RLS
  policy) with **zero integration-test coverage available in this
  environment** (local PgBouncer is down — see Verification) to prove the
  policy shape is correct before it ships; option (c) needed no schema
  change at all and reuses a policy already proven by `UserSession` and
  `KnowledgeChunk` itself. `retrieve()` already filters/ranks chunks
  directly with no join back to `KnowledgeArticle` (PR 3's own design
  note), so a GLOBAL article row would have added a table nothing reads.
  Net effect on isolation: **none** — no RLS policy changed, tenant reads
  of their own `KnowledgeArticle` rows are untouched, and GLOBAL chunks are
  read exactly as they were before this PR (the asymmetric policy already
  shipped). The per-tenant demo overviews in `GROWING_GUIDES` still create
  real `KnowledgeArticle` rows — that mechanism was untouched, only its
  content changed.
- **`GROWING_GUIDES` kept per-tenant, but small and pointing at the GLOBAL
  content.** The brief's "content goes in the GLOBAL catalogue, not copied
  per tenant" governs the BULK of the authored agronomy (BBCH backbone,
  scouting, cultural practice, nutrition, harvest — the 34-entry corpus,
  written once). The demo onboarding overview (8 short articles, existing
  mechanism, unrelated to this PR's architecture question) stays
  tenant-scoped by design — a new tenant gets *something* published in its
  own KB at signup — but each overview is now short and explicitly defers
  detail to the GLOBAL knowledge base rather than re-authoring it.
- **One new `LICENSED_SOURCES` entry, not several.** Considered also
  citing EU Directive 2009/128/EC (Sustainable Use of Pesticides — IPM
  principles) as a second licensed source, matching the existing `EU
  2018/848` precedent. Decided against it: none of this PR's content
  reproduces that directive's operative text, only its general IPM
  concepts in original prose, so no licensed-corpus entry is needed for
  it. Considered Bulgarian national extension sources (БАБХ's own site,
  Agricultural Academy publications) and did **not** add them — their
  licence terms were not verified in this session, and the brief is
  explicit: don't add a source you can't verify. `'Agri-SaaS agronomy desk
  (original)'` is the only addition; it needs no external licence because
  it is 100% original work (same precedent as the AI eval golden
  datasets already documented in `THIRD_PARTY_NOTICES.md`).
- **The dose/PHI/REI gate enforces at ingest time, not just in CI.**
  `assertNoUnregisteredRegulatedContent` is called from both
  `ingestGlobalCorpus` and `importKnowledge` — the same call sites that
  already ran `assertLicensedSource`. A future PR that adds a violating
  entry to either array fails at `npm run rag:ingest` /
  `npm run import:knowledge` time even if the CI guardrail were somehow
  skipped, not only via the structural test.
- **Two real detector bugs were found and fixed while verifying this PR's
  own content against the gate** (not left for a future incident):
  (1) JS `\b` is ASCII-word-boundary-only, so a trailing `\b` after a
  Cyrillic unit (`дка`, `ха`) never matched — it silently defeated every
  Cyrillic dose pattern. Removed the trailing `\b`.
  (2) The registration-number pattern's trailing token (`[\w./-]+`)
  matched *any* word, so prose like "...a registration number from the
  official register" (the word "number", no actual number) satisfied the
  escape hatch and would have let a real violation through if it
  happened to sit near that phrase. Fixed by requiring a digit in the
  token. Both are regression-locked in
  `tests/guardrails/dose-phi-rei-gate.test.ts`. This is why the brief's
  instruction to "build the gate so it would catch content you did not
  write" mattered in practice — running the detector against real,
  substantial content (not just hand-picked fixtures) is what surfaced
  both bugs.
- **Own content rewritten to avoid the trigger phrases when discussing
  the POLICY itself.** The register-check entry and every growing guide's
  closing paragraph explain that no dose/PHI/REI is stated — but the
  first draft used the literal trigger words ("карантинен срок", "PHI",
  "re-entry interval") to say so, which the gate (correctly, conservatively)
  flagged. Rephrased to describe the concepts ("waiting period before
  harvest", "before returning to the treated area") without the literal
  phrases, rather than weakening the detector to special-case
  meta-commentary — a weakened detector is a bigger risk than an
  occasional rewrite.
- **Four crops: wheat, barley, maize, sunflower.** Bulgaria's four
  dominant arable crops by cultivated area, matching `CROP_OPTIONS` in
  `src/lib/agriculture/crop-options.ts` (`Wheat`/`Barley`/`Maize`/
  `Sunflower`) so `cropTags` on every chunk/article lines up with the
  crop values used elsewhere in the app (Parcel.cropType, the knowledge
  filter facets).
- **No yield figures, no PHI/REI mentions at all in the authored
  agronomy.** Yield is conventionally reported as `kg/ha` / `t/ha` in
  agronomy writing — the same slash-unit shape as a dose rate. Rather
  than teach the detector to distinguish "4500 kg/ha yield" from "2 l/ha
  dose" (a genuinely hard, error-prone distinction), the content simply
  never states a yield-per-area figure. This keeps the detector simple
  and conservative instead of adding a carve-out that could itself be
  gamed by a future violation.
- **`полск*` avoided in favour of `земеделск*`** per the repo's own
  documented sweep (`docs/implementation-notes/2026-07-19-journal-auto-entry-audit.md`).
  One instance in the sunflower rotation copy was caught and fixed
  ("сред полските култури" → "сред земеделските култури").

## Verification

- `npm run db:generate` — clean (no schema changes in this PR; ran first
  per the brief since the branch stacks on PR 3's already-landed columns).
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` — the same 9
  pre-existing errors documented in PR 3's note (stale, gitignored
  `.next-test/types/validator.ts`), zero new errors.
- `node scripts/i18n-diff.mjs --check` — 0 missing/orphan/drift/untranslated
  (this PR adds no UI strings — article content is data, not a message key).
- `npx jest tests/guardrails tests/guards --testPathIgnorePatterns "/node_modules/" "/\.claude/"` —
  630/630 suites, 8803 passed, 14 skipped (pre-existing DB-gated skips), 0 failed.
- Targeted unit runs (`rag-retrieve`, `rag-context`, `rag-chunk`,
  `knowledge-agronomy`, `safety-advisor`, `reindex-knowledge-article-job`) —
  6/6 suites, 71/71 passed — confirms the new corpus/guide content doesn't
  regress anything reading `RetrievedChunk`/`KnowledgeChunk` shapes.
- `npx eslint` on every changed file — 0 errors (1 benign "no config for
  .md" warning on `THIRD_PARTY_NOTICES.md`).
- **Not run:** DB-backed integration tests — local PgBouncer (:5433) is
  down in this environment; this is also why option (b) in the C3
  decision (a new RLS policy) was rejected — it could not be proven
  locally. CI runs the DB-backed suite.
