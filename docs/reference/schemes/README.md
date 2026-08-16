# Certification-scheme reference content

Two YAML files describing agricultural certification schemes. **They are
reference documents, not seed input.** Nothing in the application reads them and
there is no ingestion path — read "Why they are here and not wired up" below
before assuming otherwise.

| File | What it is |
|---|---|
| `bg-babh-plant-protection.yaml` | БАБХ plant-protection obligations — Bulgarian public law, paraphrased, legal basis cited. The only originally-authored content in the set. |
| `eu-organic-2018-848-demo.yaml` | EU organic regulation 2018/848. "EU 2018/848" is already in `LICENSED_SOURCES` (`scripts/rag/corpus.ts`), so it is safe to ingest if a path is ever built. |

## Why they are here and not wired up

They used to live in `prisma/catalogs/`, parsed by `prisma/catalog-loader.ts`
and written to the database by `prisma/catalog-applier.ts`. GRC teardown phase 3
dropped that applier's only three write targets — `Framework`,
`FrameworkRequirement`, `FrameworkPack` — so the applier was deleted and the
loader was left validating a shape no table accepts.

The loader and its test went too. That test never read a shipped file: it wrote
its own fixtures into a temp directory (`mkdtempSync`), which is why nothing
noticed that `iso27001-2022-demo.yaml` advertised `coverageNote: "8 of 93 Annex
A controls"` over a `requirements:` block containing **four**. A validator whose
only consumer is a test that supplies its own input is not testing anything about
the content.

Living under `prisma/` is what made these read as a seed input in the first
place, and is why a recon note once recorded them as "LIVE — do NOT delete".
They are moved here so that reading is no longer available.

## What was deleted, and why not these two

- `iso27001-2022-demo.yaml` — GRC, not agriculture. Self-describes as a fixture
  for a `framework:import` CLI that no longer exists, and shipped a false
  coverage claim.
- `globalgap-ifa-demo.yaml` — **the repo's own guards refuse this file.**
  `scripts/rag/corpus.ts` makes GlobalG.A.P. a Tier-4 hard block ("Never ingest
  GlobalG.A.P. text"), and `PHI_PATTERN` in `scripts/rag/dose-phi-guard.ts`
  matches "pre-harvest interval" at lines 71 and 74 with no registration number
  present. Keeping a file the ingestion guards would throw on — while it invented
  codes that looked like real IFA numbering — was the worst of both.

Recover any of it from git: the files and `prisma/catalog-loader.ts` are at the
commit before this one; `prisma/catalog-applier.ts` is at `5c1238e8`.

## If you build an ingestion path

`SupportScheme` is **not** the destination — it models subsidy measures, not
standards, and re-pointing an applier at it would be inventing behaviour rather
than restoring it.

Two shapes were considered and both remain open:

1. **A new agri-domain model** with the scheme → requirement tree these files
   already carry. Needs a user-facing surface to justify it; a model with no page
   is not an answer.
2. **Global `KnowledgeArticle` rows** (`tenantId: null`), seeded the way
   `scripts/rag/ingest-satellite-guide.ts` does it and shipped as a
   `dist/seed.mjs` subcommand. No schema, no migration, no RLS. This works in
   production — the Dockerfile copies the whole `prisma/` tree and `js-yaml` +
   `zod` are production dependencies — but note that `docs/` is **not** copied
   into the image, so moving these files here means a seeder would need its own
   COPY or the content inlined.

If you take route 2, pin `reindex-knowledge-article.ts`'s `{ id, tenantId }`
scope with a structural guard first: that predicate is the only thing keeping
GLOBAL articles out of `KnowledgeChunk`, and widening it later would walk this
content straight into the embedding path the licence block exists to prevent.

## Deliberately no tripwire

A guard over `prisma/schema` field names was considered and rejected. A regex for
`code` / `clauseRef` is evaded by naming the column something else, and a guard
that silently stops matching is precisely the "green is not the same as executed"
failure CLAUDE.md documents. Its nearest model,
`tests/guardrails/global-catalogue-models.test.ts`, is a curated allowlist that is
already missing `SupportScheme`. This file is the record instead.
