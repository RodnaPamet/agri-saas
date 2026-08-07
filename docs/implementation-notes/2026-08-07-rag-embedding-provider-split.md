# 2026-08-07 — RAG embedding provider split

**Commit:** `7f79e168 fix(rag): resolve the embedding provider independently of AI_BACKEND`

## Design

Production (`/opt/agrent/.env`) sets no `AI_*` vars at all —
`AI_BACKEND` is unset (so `getAiProvider()` never takes the
`AI_BACKEND === 'claude'` branch) and `AI_BASE_URL` falls back to the
schema default `http://localhost:11434/v1`. Nothing listens there in
the container, so every `getAiProvider().embed(...)` call in
`src/app-layer/ai/rag/retrieve.ts` failed with a connection error —
that is the live production defect. Separately,
`ClaudeProvider.embed()` (`src/app-layer/ai/provider/claude-provider.ts:243`)
throws unconditionally, because Anthropic exposes no embeddings
endpoint — a real latent bug for anyone who *does* set
`AI_BACKEND=claude`, but not what breaks prod today.

Both share one root cause: the completion role and the embedding role
were conflated behind a single `getAiProvider()` factory keyed off one
`AI_BACKEND` var. Fix: split them.

```
getAiProvider()          — COMPLETIONS. AI_BACKEND selects the
                            backend, including the native ClaudeProvider.
                            Unchanged. Still used by rag.ts's complete()
                            call, routing.ts, field-briefing.ts (which
                            bypasses the factory entirely and always
                            talks to Anthropic directly — untouched).

getEmbeddingProvider()   — EMBEDDINGS. NEVER returns ClaudeProvider —
                            always an OpenAiCompatibleProvider. Resolved
                            from AI_EMBED_BACKEND / AI_EMBED_BASE_URL /
                            AI_EMBED_API_KEY, each optional and each
                            falling back to the completion-path
                            equivalent (AI_BASE_URL / AI_API_KEY) when
                            unset — so local dev's Ollama-serves-both
                            default keeps working with zero extra
                            config, and AI_BACKEND=claude can no longer
                            silently take embeddings down with it.
```

`retrieve()` and the `embed-chunks` ingestion job both now call
`getEmbeddingProvider()` instead of `getAiProvider()`. `retrieve()`
additionally wraps the embed call in try/catch: on failure (unset/
unreachable embedding backend) it logs a `logger.warn` and degrades to
the keyword-only branch instead of throwing — `safety/advisor.ts`
already renders the calibrated "not in my sources" answer on empty
retrieval, so a keyword-only (or empty) result stays safe, just less
accurate. `embed-chunks` deliberately does NOT degrade — a failed
ingestion batch should fail the BullMQ job loudly (visible, retried)
rather than silently leaving chunks permanently un-embedded.

Deployment answer (Option B, over an in-VM embedding service — Option
A — which was rejected: a 768-dim model alongside the other 7 compose
services on one box is a memory risk, re-embedding load is bursty, and
the VM runs no AI infrastructure today): point `AI_EMBED_BACKEND` /
`AI_EMBED_BASE_URL` / `AI_EMBED_API_KEY` at a hosted, OpenAI-compatible
embedding API. Left unset, retrieval degrades to keyword-only by
design — documented in `deploy/env.prod.example`, which previously
declared zero `AI_*` keys at all (the actual reason the localhost
fallback applied silently in prod).

## Files

| File | Role |
| --- | --- |
| `src/env.ts` | Adds `AI_EMBED_BACKEND` / `AI_EMBED_BASE_URL` / `AI_EMBED_API_KEY` (all optional) |
| `src/app-layer/ai/provider/index.ts` | Adds `getEmbeddingProvider()`, resolved independently of `AI_BACKEND` |
| `src/app-layer/ai/rag/retrieve.ts` | Calls `getEmbeddingProvider()`; degrades to keyword-only on embed failure instead of throwing |
| `src/app-layer/jobs/embed-chunks.ts` | Calls `getEmbeddingProvider()` (ingestion — still throws on failure) |
| `deploy/env.prod.example` | Documents the new `AI_EMBED_*` keys + `ANTHROPIC_API_KEY` (previously undocumented despite being set in prod) |
| `tests/unit/ai-provider.test.ts` | New `getEmbeddingProvider` describe block — resolves independently of `AI_BACKEND=claude` |
| `tests/unit/rag-retrieve.test.ts` | Mock renamed to `getEmbeddingProvider`; new degrade-to-keyword-only tests |
| `tests/unit/jobs-cron-fanout-wave-7.test.ts` | Mock renamed to `getEmbeddingProvider` for the `embed-chunks` job test |

## Decisions

- **`getEmbeddingProvider()` never has a `claude` branch.** Anthropic
  has no embeddings endpoint, so unlike `getAiProvider()` there is
  nothing to branch to — it always constructs an
  `OpenAiCompatibleProvider`. This keeps the seam simple and makes
  "embeddings can never accidentally route to Claude" true by
  construction, not by a runtime check.
- **Fallback direction: embed vars default to the completion vars,
  never the reverse.** `AI_EMBED_BASE_URL ?? AI_BASE_URL` (not the
  other way around) preserves today's zero-config local-dev behaviour
  (Ollama serves both) while giving prod an escape hatch that doesn't
  require re-plumbing `AI_BASE_URL` semantics.
- **`retrieve()` degrades; `embed-chunks` does not.** A read path
  serving a live user request should never 500 when a cheap fallback
  (keyword search) exists. A background ingestion job has no such
  fallback — silently swallowing the error would leave chunks
  perpetually un-embedded with no signal; throwing lets BullMQ's
  retry/alerting do its job.
- **`ClaudeProvider.embed()` stays throwing.** That is correct
  behaviour for a provider with no embeddings endpoint — fixing the
  production defect meant routing embeddings around it, not making it
  pretend to support embeddings.
