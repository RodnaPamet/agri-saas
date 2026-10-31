# 2026-06-20 — Production AI inference + task routing (Claude)

> **The Copilot SSE route described below was RETIRED on 2026-10-31 (#2578).**
> `src/app/api/t/[tenantSlug]/ai/copilot/route.ts` no longer exists and
> `/api/t/{tenantSlug}/ai/copilot` is `status: "retired"` in
> `src/generated/route-inventory.json`. It never had a caller on either client,
> and the assistant surface (#2578, agrent-ios#483) is its governed successor.
> Everything else in this note — the routing table, the tier gate, the failover
> and the provider layer — is live and unaffected; `completeWithRouting` is
> reached today by `knowledge/ask`, the scheduled AI jobs and the RAG path.

**Commit:** `<pending> feat(ai): native Claude provider + task-routing policy + copilot SSE`

## Design

Production inference behind the existing `AiProvider` interface, with
Claude as the load-bearing reasoning backend.

```
AiTask ── routeTask() ──▶ AiRoute { tier, backend, model, maxTokens,
                                    timeoutMs, retries, failover[] }
                              │
completeWithRouting(ctx,task) │  1. assertAiTierAllowed(ctx, tier)   (403 if denied)
                              │  2. try primary  (+retries on transient)
                              │  3. failover[]   (cross-provider)
                              ▼
                   providerForTarget(target)
                        ├─ 'claude'  → ClaudeProvider (Anthropic Messages API)
                        └─ else      → OpenAiCompatibleProvider (OpenRouter/Groq/…)
```

- **ClaudeProvider** is a NATIVE adapter over `@anthropic-ai/sdk`'s
  Messages API (not the OpenAI-compat shim) so prompt caching, tool-use,
  and native streaming are first-class. Same `AiProvider` contract as
  `OpenAiCompatibleProvider`.
  - Structured output → a single FORCED tool whose `input_schema` is the
    Zod schema as JSON-Schema; tool input is Zod-validated, with one
    repair re-prompt, then `AiProviderError` (same shape as the
    OpenAI-compat validate/repair path).
  - System messages → top-level `system` param with `cache_control`
    (prompt caching on the stable prefix). `tool` role → `tool_result`
    block. Streaming assembles `text_delta` + `input_json_delta` events.
  - `embed()` throws — Anthropic has no embeddings endpoint; RAG stays
    on the OpenAI-compatible/Ollama path. `health()` probes models.list,
    never throws.
- **Routing** maps tasks → tiers: Haiku/Groq for cheap/bulk, Sonnet for
  standard chat, Opus for dosage/regulatory/long-horizon. Every tier has
  an ordered cross-provider failover (Claude → OpenRouter, Groq →
  OpenRouter). Timeout via AbortController (linked to the caller signal),
  same-target retries on transient (timeout/abort/429/5xx), failover on
  hard failure. Caller abort short-circuits.
- **Entitlements** add an AI-tier ceiling: FREE → `cheap` only;
  TRIAL/PRO/ENTERPRISE → `premium`. `assertAiTierAllowed(ctx, tier)`
  throws `forbidden('ai_tier_not_allowed: …')` (403).
- **Copilot SSE route** (`/api/t/[tenantSlug]/ai/copilot`, POST): SSE by
  default (mirrors notifications/stream — heartbeat, abort cleanup,
  `data:` lines), `stream:false` → single-JSON fallback. Client abort →
  `req.signal` cancels the upstream provider stream. Routed through
  `completeWithRouting`; tier gate enforced inside routing.

## Files

| File | Role |
|---|---|
| `src/app-layer/ai/provider/claude-provider.ts` | Native Anthropic Messages-API `AiProvider` |
| `src/app-layer/ai/provider/types.ts` | `+ 'claude'` backend, `+ signal?` on options |
| `src/app-layer/ai/provider/openai-compatible-provider.ts` | `claude` CAPABILITIES entry; threaded `signal` |
| `src/app-layer/ai/provider/index.ts` | Factory returns ClaudeProvider when `AI_BACKEND=claude` |
| `src/app-layer/ai/routing.ts` | `AiTask` → tier table, `completeWithRouting`, failover |
| `src/lib/billing/entitlements.ts` | `AiTier`, plan→tier ceiling, `assertAiTierAllowed` |
| `src/app/api/t/[tenantSlug]/ai/copilot/route.ts` | Copilot SSE + non-stream fallback |
| `src/env.ts` | `AI_BACKEND='claude'`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` |

## Decisions

- **Native adapter, not OpenAI-compat shim** — prompt caching /
  extended-thinking / tool-use are provider-specific; the shim would
  flatten them. The `claude` CAPABILITIES entry exists only to satisfy
  the exhaustive `Record<AiBackend,…>`; ClaudeProvider never reads it
  (structured output is forced tool-use, not `response_format`).
- **Routing is provider-agnostic** — a route entry names backend+model;
  `providerForTarget` constructs the right provider. Failover chains
  cross provider boundaries so a single-provider outage degrades.
- **Signal threading end-to-end** — `AiCompleteOptions.signal` flows to
  both SDKs' request options, so a client disconnect actually cancels
  the upstream generation rather than orphaning it. Routing links the
  caller signal to a per-attempt timeout AbortController.
- **Copilot route auth** — `ai/` is not a privileged admin root (per
  `api-permission-coverage`), so it authorises via `getTenantCtx`
  (membership + slug gate) like sibling AI routes; the model-cost gate
  is the tier entitlement check inside routing.
- **OpenRouter = default/failover, Groq = cheap-bulk** — wired via env +
  the routing table, no code fork; the capability map already
  distinguishes the OpenAI-compatible hosts.
