# 2026-08-10 — Production seed path for knowledge-base + RAG content

**Commit:** `0a45bec6 feat(knowledge): make knowledge-base + RAG seeding runnable in production`

## Design

The production runtime image is dev-dependency-pruned (see the
Dockerfile's `npm prune --omit=dev`), so it carries no `tsx` and no
source `scripts/` tree. `npm run import:knowledge`, `npm run
rag:ingest:satellite`, and `npm run rag:ingest` — all `tsx
scripts/*.ts` — were the only way to seed the Knowledge Base and the
RAG corpus, and none of the three could run against the deployed
database. This was discovered on the live `agrent` VM, not assumed:
the only way to seed content had been copying a one-off applier
script into the container by hand.

`scripts/build-worker.mjs` had already solved exactly this problem
for the BullMQ worker + scheduler: esbuild-bundle a TypeScript
entrypoint — with every `src/`/`scripts/` import inlined, node_modules
left `external` — into a self-contained `dist/*.mjs`, which the
Dockerfile already builds (`npm run build:worker`) and ships (`COPY
--from=builder /app/dist ./dist`). This PR adds a second entrypoint to
that same pipe rather than inventing a new one.

```
scripts/seed.ts  (knowledge | satellite | corpus | all)
      │  imports the exact same exported functions the
      │  three tsx CLIs already call
      ▼
importKnowledge()          scripts/import-knowledge.ts
ingestSatelliteGuide()     scripts/rag/ingest-satellite-guide.ts
ingestGlobalCorpus()       scripts/rag/corpus.ts
      │
      ▼  npm run build:seed  (scripts/build-seed.mjs, esbuild)
dist/seed.mjs  ── COPY --from=builder .../dist ./dist ──▶  runtime image
      │
      ▼  operator, on the agrent VM
docker compose exec app node dist/seed.mjs <subcommand>
```

One entrypoint with subcommands, not three separate bundles — an
operator running this under pressure (a new tenant, a content
refresh) should not have to remember three filenames. Each subcommand
is caught and reported independently (`[name] OK — …` /
`[name] FAILED — …`) so `all` never lets one step's failure hide
another step's success, and the process exits non-zero if any step
failed.

Bundling surfaced two real bugs that had never mattered while these
files only ran as standalone `tsx` scripts:

1. **`require.main === module` throws under a real ESM bundle.**
   esbuild's `format: 'esm'` output has no `module` global — referencing
   the bare identifier is a `ReferenceError`, not `undefined`, unlike
   `typeof module`. All three CLI files' entry guard hit this the moment
   `scripts/seed.ts` imported their named exports (proved by an
   isolated esbuild + `node --check` + dynamic-`import()` repro before
   touching the real files). Fixed with `typeof module !== 'undefined'
   && require.main === module` — identical behaviour under `tsx` and
   `ts-jest` (both shim `require`/`module` as real CJS-interop globals),
   `false` (not a crash) inside the bundle. `require.main === module`
   can't be replaced with the more modern `import.meta.url` check
   because these files are also `require()`'d directly by Jest
   (`tests/guardrails/dose-phi-rei-gate.test.ts`), which transforms to
   CommonJS and does not support `import.meta`.

2. **`ingestGlobalCorpus` used the wrong AI provider seam.** #496
   (`docs/implementation-notes/2026-08-07-rag-embedding-provider-split.md`)
   introduced `getEmbeddingProvider()` — resolved independently of
   `AI_BACKEND`/`AI_BASE_URL` specifically so a missing embeddings
   config fails clearly instead of silently defaulting to the
   unreachable `http://localhost:11434/v1` — and migrated `retrieve()`
   and the `embed-chunks` job to it. `scripts/rag/corpus.ts` was the one
   caller that fix missed; it still called `getAiProvider()`. Fixed the
   call site AND added `assertEmbeddingBackendConfigured()`, run first
   inside `ingestGlobalCorpus`, before any Prisma read/write — it checks
   raw `process.env` (not the validated `env`, which always has a
   default value and so can't tell "operator set this" from "nothing
   configured") for `AI_EMBED_BASE_URL` + `AI_EMBED_API_KEY`, with an
   explicit `AI_BASE_URL` accepted as the fallback for a self-hosted
   Ollama-serves-both deploy, and throws a message naming exactly which
   var is missing.

## Files

| File | Role |
|---|---|
| `scripts/seed.ts` | New. The operator CLI — `knowledge`/`satellite`/`corpus`/`all` subcommands, per-step try/catch + tally, non-zero exit on any failure. |
| `scripts/build-seed.mjs` | New. esbuild bundler for `scripts/seed.ts` → `dist/seed.mjs`, mirrors `scripts/build-worker.mjs`'s config exactly. |
| `scripts/rag/corpus.ts` | `getAiProvider()` → `getEmbeddingProvider()` for the embed call; added `assertEmbeddingBackendConfigured()`, called first inside `ingestGlobalCorpus`. |
| `scripts/import-knowledge.ts`, `scripts/rag/ingest-satellite-guide.ts`, `scripts/rag/ingest-corpus.ts` | One-line entry-guard fix each (`typeof module !== 'undefined' &&`) so they can be imported into an ESM bundle without throwing. |
| `Dockerfile` | Added `RUN npm run build:seed` after `build:worker`, before the dev-dependency prune. No new `COPY` — the existing whole-directory `dist/` copy covers `dist/seed.mjs`. |
| `package.json` | New `build:seed` script; new `seed` script (`tsx scripts/seed.ts`) for local parity with the production invocation shape. |
| `tests/guards/seed-deployment.test.ts` | New. Structural ratchet mirroring `tests/guards/worker-deployment.test.ts` — entrypoint wiring, build script, Dockerfile ordering + COPY, with a mutation proof. |
| `tests/unit/rag-corpus-embedding-guard.test.ts` | New. Behavioural coverage for `assertEmbeddingBackendConfigured` and the `ingestGlobalCorpus` provider-selection fix (a structural guard alone would not have exercised either). |
| `docs/deployment.md` | New "Knowledge-base seeding (production)" section — the operator runbook. |
| `CLAUDE.md` | New "Knowledge-base / RAG seeding" subsection — states plainly that the three `tsx` scripts are dev-only and points at the production path. |

## Decisions

- **One CLI with subcommands, not three bundles.** Fewer filenames for
  an operator to remember under pressure; also means only one
  `entryPoints` line to keep alive in `build-seed.mjs`, which the new
  guard's mutation proof locks in.
- **`scripts/seed.ts` calls the existing exported functions rather than
  re-implementing or re-exporting the three CLIs' own `main()`.** Their
  `main()` functions still exist and still work for local `tsx` use
  (`npm run import:knowledge` etc., unchanged) — `scripts/seed.ts` is a
  second, independent caller of the same idempotent business logic, not
  a replacement for the originals.
- **The embeddings preflight runs unconditionally, even on a run that
  would end up being an all-skip.** A more "efficient" version that
  only checks when there is actually something new to embed would make
  the failure mode environment-dependent — crashing on a cold catalogue
  but not once everything happens to already exist — which is exactly
  the kind of inconsistency this preflight exists to remove. Verified
  by a dedicated test
  (`the embeddings preflight is unconditional — it fires even when
  every entry would ultimately skip`).
- **Raw `process.env` inside `assertEmbeddingBackendConfigured`, not
  the validated `env` from `src/env.ts`.** `env.AI_BASE_URL` always has
  a value (the zod schema default), so it structurally cannot
  distinguish "the operator configured this" from "nothing was
  configured, so it silently defaulted." This mirrors every other
  script in `scripts/rag/` and `scripts/`, which already read
  `process.env` directly — there is no Next.js boot to validate against
  out there.
- **Did not touch `scripts/rag/ingest-tenant.ts`.** Out of scope for
  this PR (per-tenant data indexing, a different content path from the
  three catalog-seeding scripts this PR covers) and not mentioned in
  the brief that started this work.
- **Verification gaps, stated plainly.** PgBouncer (`:5433`) is down in
  this local dev environment, so the seed CLI could not be run against
  a real database end-to-end. What WAS verified: the bundle builds, its
  syntax is valid (`node --check`), and running it (no DB reachable)
  proves the full import graph resolves without the `ReferenceError`
  bug above — `knowledge`/`satellite`/`all` fail with a Prisma
  connection error (expected, given no DB), and `corpus` fails with the
  new named-env-var message WITHOUT attempting a DB call at all,
  confirming the preflight guard runs before any I/O.
