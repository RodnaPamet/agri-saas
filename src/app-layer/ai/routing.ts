/**
 * AI task-routing policy (feat/ai-prod-routing).
 *
 * Maps a high-level TASK to a concrete MODEL TIER — which backend,
 * which model, the token budget, timeout, retry count, and an ordered
 * failover chain. This is the single place that decides "what does
 * `copilot-chat` run on?" so call sites stay declarative: they name a
 * task, not a model.
 *
 * Tiering philosophy:
 *   - Cheap, high-volume, low-stakes tasks (bulk classification, quick
 *     explanations) run on Groq (fast/cheap) or Claude Haiku.
 *   - Load-bearing reasoning (dosage calc, regulatory, long-horizon
 *     planning) runs on Claude Sonnet/Opus — correctness over cost.
 *   - Every tier has an ordered `failover` chain: if the primary
 *     backend hard-fails, `completeWithRouting` retries on the next
 *     entry. The chains cross provider boundaries (Claude → OpenRouter,
 *     Groq → OpenRouter) so a single-provider outage degrades rather
 *     than fails.
 *
 * Provider-agnostic: a route entry names a `backend` + `model`, and
 * `completeWithRouting` constructs the matching provider. It works
 * whether the entry is `claude` or any OpenAI-compatible backend.
 *
 * Entitlement gating: each tier carries an `AiTier`; before any model
 * call, `completeWithRouting` runs `assertAiTierAllowed(ctx, tier)`
 * so a FREE tenant cannot reach a premium-tier model even by naming a
 * premium task.
 */
import { createHash } from 'node:crypto';
import type { RequestContext } from '@/app-layer/types';
import { logger } from '@/lib/observability/logger';
import { traceOperation } from '@/lib/observability';
import { assertAiTierAllowed, type AiTier } from '@/lib/billing/entitlements';
import { assertAiBudget } from './budget';
import { recordAiUsage } from './usage';
import { estimateCostMicros } from './cost';
import { recordAiCompletion } from '@/lib/observability/ai-metrics';
import { assertAiRateLimit } from '@/lib/rate-limit/aiRateLimit';
import { logEvent } from '@/app-layer/events/audit';
import { runInTenantContext } from '@/lib/db-context';
import {
    redactForExternal,
    rehydrate,
    isExternalBackend,
    type RedactionMap,
} from '@/lib/security/ai-redaction';
import {
    getCachedCompletion,
    setCachedCompletion,
    isCacheableCompletion,
    normalizeText,
} from '@/lib/cache/ai-cache';
import { AiProviderError } from './provider/openai-compatible-provider';
import { httpStatusOf, isProviderRejection } from './provider/error-status';
import { ClaudeProvider } from './provider/claude-provider';
import { OpenAiCompatibleProvider } from './provider/openai-compatible-provider';
import { inferBackend } from './provider/index';
import type {
    AiBackend,
    AiCompleteOptions,
    AiCompletion,
    AiProvider,
    AiUsage,
} from './provider/types';
import { env } from '@/env';

// ─── Task taxonomy ───────────────────────────────────────────────

/**
 * The set of routable tasks. Each maps to a tier in `TASK_TIER`.
 *
 *   copilot-chat      — interactive assistant chat (default reasoning).
 *   spray-explanation — explain a spray/treatment recommendation.
 *   dosage-calc       — compute a chemical dosage (load-bearing: wrong
 *                       numbers are dangerous → premium tier).
 *   regulatory        — regulatory / compliance reasoning (premium).
 *   long-horizon      — multi-step planning over a season (premium).
 *   cheap-bulk        — high-volume, low-stakes classification/tagging.
 */
export type AiTask =
    | 'copilot-chat'
    | 'spray-explanation'
    | 'dosage-calc'
    | 'regulatory'
    | 'long-horizon'
    | 'cheap-bulk';

/** One backend+model target in a route's primary/failover chain. */
export interface AiRouteTarget {
    backend: AiBackend;
    model: string;
}

/** The resolved policy for a task. */
export interface AiRoute {
    /** Capability/entitlement tier — gated against the tenant's plan. */
    tier: AiTier;
    /** Primary backend to try first. */
    backend: AiBackend;
    /** Primary model id. */
    model: string;
    /** Token budget for the completion. */
    maxTokens: number;
    /** Per-attempt timeout in ms (AbortController). */
    timeoutMs: number;
    /** Transient-failure retries on the SAME target before failover. */
    retries: number;
    /**
     * Ordered failover chain tried after the primary (and its retries)
     * hard-fail. Each entry is a distinct backend/model.
     */
    failover: AiRouteTarget[];
}

// ─── Tier model targets ──────────────────────────────────────────
//
// Models per tier. Claude tiers use the canonical Anthropic ids.
// OpenAI-compatible failover uses OpenRouter (broad model catalogue)
// and Groq (cheap/fast) — the model strings are illustrative slugs
// resolved by those backends at request time.

const CLAUDE_HAIKU = 'claude-haiku-4-5';
const CLAUDE_SONNET = 'claude-sonnet-4-6';
const CLAUDE_OPUS = 'claude-opus-4-8';

// OpenRouter / Groq failover model slugs.
const OPENROUTER_SONNET = 'anthropic/claude-sonnet-4-6';
const OPENROUTER_HAIKU = 'anthropic/claude-haiku-4-5';
const GROQ_FAST = 'llama-3.3-70b-versatile';

/**
 * The route table. The primary target on the premium/standard tiers is
 * native Claude (prompt caching + tool-use); the cheap tier defaults to
 * Groq for high-volume throughput. Every tier fails over across
 * provider boundaries.
 */
const ROUTES: Record<AiTask, AiRoute> = {
    // Interactive chat — standard reasoning on Sonnet, fail over to
    // OpenRouter's Sonnet, then Haiku.
    'copilot-chat': {
        tier: 'standard',
        backend: 'claude',
        model: CLAUDE_SONNET,
        maxTokens: 4096,
        timeoutMs: 60_000,
        retries: 1,
        failover: [
            { backend: 'openrouter', model: OPENROUTER_SONNET },
            { backend: 'claude', model: CLAUDE_HAIKU },
        ],
    },
    // Spray explanation — cheap/standard; Haiku is plenty, fail over to
    // OpenRouter Haiku.
    'spray-explanation': {
        tier: 'standard',
        backend: 'claude',
        model: CLAUDE_HAIKU,
        maxTokens: 2048,
        timeoutMs: 45_000,
        retries: 1,
        failover: [{ backend: 'openrouter', model: OPENROUTER_HAIKU }],
    },
    // Dosage — premium; correctness critical → Opus, fail over to
    // Sonnet (still strong) then OpenRouter Sonnet.
    'dosage-calc': {
        tier: 'premium',
        backend: 'claude',
        model: CLAUDE_OPUS,
        maxTokens: 4096,
        timeoutMs: 90_000,
        retries: 2,
        failover: [
            { backend: 'claude', model: CLAUDE_SONNET },
            { backend: 'openrouter', model: OPENROUTER_SONNET },
        ],
    },
    // Regulatory — premium; same shape as dosage.
    regulatory: {
        tier: 'premium',
        backend: 'claude',
        model: CLAUDE_OPUS,
        maxTokens: 8192,
        timeoutMs: 120_000,
        retries: 2,
        failover: [
            { backend: 'claude', model: CLAUDE_SONNET },
            { backend: 'openrouter', model: OPENROUTER_SONNET },
        ],
    },
    // Long-horizon planning — premium; large token budget + long
    // timeout for multi-step reasoning.
    'long-horizon': {
        tier: 'premium',
        backend: 'claude',
        model: CLAUDE_OPUS,
        maxTokens: 16_384,
        timeoutMs: 180_000,
        retries: 1,
        failover: [{ backend: 'claude', model: CLAUDE_SONNET }],
    },
    // Cheap bulk — Groq for cheap/fast high volume, fail over to
    // OpenRouter Haiku.
    'cheap-bulk': {
        tier: 'cheap',
        backend: 'groq',
        model: GROQ_FAST,
        maxTokens: 1024,
        timeoutMs: 30_000,
        retries: 1,
        failover: [{ backend: 'openrouter', model: OPENROUTER_HAIKU }],
    },
};

/** Resolve the routing policy for a task. */
export function routeTask(task: AiTask): AiRoute {
    const route = ROUTES[task];
    if (!route) {
        throw new AiProviderError('openai-compatible', `No route configured for AI task "${task}".`);
    }
    return route;
}

// ─── Provider construction per target ────────────────────────────

/**
 * Build the provider for a route target. Native Claude targets use
 * ClaudeProvider (ANTHROPIC_API_KEY); every OpenAI-compatible target
 * uses OpenAiCompatibleProvider configured for that backend.
 *
 * Backend → base URL / key mapping is read from env. OpenRouter and
 * Groq are the documented prod failover hosts; their keys live in
 * AI_API_KEY (single configured OpenAI-compatible key) unless the
 * target's host already matches the configured AI_BASE_URL.
 */
export function providerForTarget(target: AiRouteTarget): AiProvider {
    if (target.backend === 'claude') {
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new AiProviderError('claude', 'Claude route target requires ANTHROPIC_API_KEY.');
        }
        return new ClaudeProvider({
            apiKey,
            model: target.model,
            baseURL: env.ANTHROPIC_BASE_URL,
        });
    }

    const baseURL = baseUrlForBackend(target.backend);
    return new OpenAiCompatibleProvider({
        backend: target.backend,
        baseURL,
        apiKey: env.AI_API_KEY,
        model: target.model,
        embedModel: env.AI_EMBED_MODEL,
    });
}

/** Canonical base URL per OpenAI-compatible backend. */
function baseUrlForBackend(backend: AiBackend): string {
    switch (backend) {
        case 'openrouter':
            return 'https://openrouter.ai/api/v1';
        case 'groq':
            return 'https://api.groq.com/openai/v1';
        case 'together':
            return 'https://api.together.xyz/v1';
        case 'ollama':
        case 'openai-compatible':
        default:
            // Fall back to the configured base URL (local dev / generic).
            return env.AI_BASE_URL;
    }
}

// ─── Orchestrated completion ─────────────────────────────────────

/**
 * Whether an error is transient (worth a same-target retry) vs hard
 * (move to failover). Timeouts/aborts and 429/5xx-ish failures are
 * transient; everything else triggers failover.
 */
function isTransient(err: unknown): boolean {
    if (err instanceof Error) {
        const msg = err.message.toLowerCase();
        if (msg.includes('timeout') || msg.includes('aborted') || msg.includes('econnreset')) return true;
        // OpenAI/Anthropic SDK errors carry a numeric `status`. Read through
        // the shared helper so this and the halt-code decision in the stream
        // route cannot disagree about where the status lives (#2655).
        const status = httpStatusOf(err);
        if (status !== undefined && (status === 429 || status >= 500)) return true;
    }
    return false;
}

/**
 * Run a single completion against one target with a per-attempt
 * timeout. If the caller passed a `signal`, it is linked so a client
 * abort cancels the upstream request; the timeout fires its own abort.
 */
async function completeOnce<T>(
    provider: AiProvider,
    opts: AiCompleteOptions<T>,
    model: string,
    maxTokens: number,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
): Promise<AiCompletion<T>> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error('routing timeout')), timeoutMs);

    // Link the caller's signal so a client disconnect aborts too.
    const onCallerAbort = () => timeoutController.abort(new Error('aborted by caller'));
    if (callerSignal) {
        if (callerSignal.aborted) timeoutController.abort(new Error('aborted by caller'));
        else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
        return await provider.complete<T>({
            ...opts,
            model,
            maxTokens: opts.maxTokens ?? maxTokens,
            signal: timeoutController.signal,
        });
    } finally {
        clearTimeout(timer);
        if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    }
}

// ─── Guardrail helpers ───────────────────────────────────────────

/**
 * sha256 of the normalised prompt — the correlation key stored in the
 * usage ledger + the audit row. NEVER the raw prompt itself.
 */
function computePromptHash(opts: AiCompleteOptions<unknown>): string {
    const normalised = opts.messages
        .map((m) => `${m.role}:${normalizeText(m.content)}`)
        .join('\n');
    return createHash('sha256').update(normalised).digest('hex');
}

/** Whether a LOCAL (ollama) backend is configured + reachable per env. */
function localBackendConfigured(): boolean {
    // The single configured provider is local when AI_BACKEND is ollama or
    // the base URL infers to ollama (localhost). Best-effort — we don't
    // probe the socket here; an unreachable local backend fails over.
    return env.AI_BACKEND === 'ollama' || inferBackend(env.AI_BASE_URL) === 'ollama';
}

/**
 * Order the route targets, applying the "prefer local for sensitive
 * content" policy: when the request is sensitive (caller-flagged OR PII
 * was detected) AND a local backend is configured, a local target is
 * tried FIRST — data stays on the box. Precedence:
 *   1. sensitive + local configured  → local target leads, then the
 *      route's own chain (failover preserved).
 *   2. otherwise                      → the route's natural order.
 * Best-effort: if the local target hard-fails, the existing failover
 * chain still runs, so this never breaks resilience.
 */
function orderTargets(route: AiRoute, preferLocal: boolean): AiRouteTarget[] {
    const natural: AiRouteTarget[] = [
        { backend: route.backend, model: route.model },
        ...route.failover,
    ];
    if (!preferLocal) return natural;
    const localTarget: AiRouteTarget = { backend: 'ollama', model: env.AI_MODEL };
    // Local first, then the natural chain (deduped against the local one).
    return [
        localTarget,
        ...natural.filter((t) => t.backend !== 'ollama'),
    ];
}

/**
 * Route a task to its tier and run the completion with the full guardrail
 * pipeline: rate-limit + budget gate, PII redaction for external calls,
 * response caching, per-attempt timeout, transient-retry + cross-provider
 * failover, then usage-ledger + cost + OTel span/metrics + immutable audit.
 *
 * Order of operations:
 *   1. Rate-limit the (tenant, user) — throws 429 if exceeded.
 *   2. Resolve the route + gate the tier against the plan (403 if denied).
 *   3. Assert the monthly token budget (403 hard-stop; soft-warn annotated).
 *   4. Response-cache lookup (deterministic, non-streaming, non-tool calls).
 *   5. Walk the (optionally local-preferred) target chain. For EXTERNAL
 *      targets, redact PII before the call + rehydrate the response after.
 *   6. On success: cache, record usage + cost, emit span/metrics, write the
 *      immutable AI_COMPLETION audit entry (promptHash only — never the
 *      prompt). On total failure, throw the last error.
 *
 * Backward compatible — the required signature is unchanged; all new
 * behaviour is driven by route config + the optional opts fields.
 */
export async function completeWithRouting<T = unknown>(
    ctx: RequestContext,
    task: AiTask,
    opts: AiCompleteOptions<T>,
): Promise<AiCompletion<T>> {
    // 1. Rate limit (no-op when bypassed / fails open on limiter outage).
    await assertAiRateLimit(ctx);

    const route = routeTask(task);

    // 2. Entitlement tier gate — cheap denial before any model call.
    await assertAiTierAllowed(ctx, route.tier);

    // 3. Monthly token budget — hard-stop at limit, soft-warn near it.
    const budget = await assertAiBudget(ctx);
    if (budget.softWarn) {
        logger.warn('ai budget soft-warn: tenant nearing monthly token cap', {
            component: 'ai',
            task,
            used: budget.used,
            limit: budget.limit ?? undefined,
        });
    }

    const promptHash = computePromptHash(opts);
    // Clamp the caller's maxTokens to the route ceiling (per-request guard).
    const clampedOpts: AiCompleteOptions<T> = {
        ...opts,
        maxTokens: Math.min(opts.maxTokens ?? route.maxTokens, route.maxTokens),
    };

    const started = Date.now();

    return traceOperation(
        'ai.completion',
        {
            'ai.task': task,
            'ai.tier': route.tier,
            'ai.model': route.model,
            'ai.backend': route.backend,
            'ai.budget.soft_warn': budget.softWarn,
        },
        async () => {
            // 4. Response cache (model-keyed; primary route model). Only for
            //    deterministic, non-streaming, non-tool calls.
            const primaryModel = route.model;
            if (isCacheableCompletion(clampedOpts)) {
                const cached = await getCachedCompletion<T>(ctx.tenantId, primaryModel, task, clampedOpts);
                if (cached) {
                    await finishCompletion(ctx, {
                        task,
                        tier: route.tier,
                        model: primaryModel,
                        backend: route.backend,
                        usage: cached.usage,
                        latencyMs: Date.now() - started,
                        cacheHit: true,
                        promptHash,
                        citations: clampedOpts.citations,
                    });
                    return cached;
                }
            }

            // Decide local-preference up front: caller-flagged sensitive OR
            // PII detected in any message (probe with a throwaway redaction).
            const probe = redactForExternal(clampedOpts.messages, {
                sensitiveTerms: clampedOpts.sensitiveTerms,
            });
            const piiDetected = Object.keys(probe.map).length > 0;
            const preferLocal =
                (clampedOpts.sensitive === true || piiDetected) && localBackendConfigured();

            const targets = orderTargets(route, preferLocal);
            let lastError: unknown;
            /**
             * The most DIAGNOSTIC failure, which is not the most recent one
             * (#2655).
             *
             * `lastError` is overwritten on every attempt, so the error that
             * escapes is whichever target happened to be tried LAST. During the
             * #2654 outage that masked the cause: claude refused with a 400
             * naming a malformed message history, then `ollama` and
             * `openrouter` were tried and failed to connect — because this
             * deployment runs no ollama container and holds no openrouter key —
             * so the error that reached the stream route was a connection
             * failure, and the farmer was told the model could not be reached.
             *
             * A 4xx means a provider was REACHED and rejected what we sent, so
             * it is about OUR request and survives. A connection failure to a
             * target that may not be configured at all is about the
             * deployment's shape and says nothing about the question.
             *
             * The FIRST rejection wins rather than the last, so the primary
             * target's verdict is not overwritten by a fallback complaining
             * about a request shape it never supported.
             *
             * The tradeoff, stated because it is real: if the primary fails 5xx
             * and a fallback then rejects with 4xx, the fallback's complaint is
             * what gets reported. That is still a true statement about a
             * request we sent, and the alternative — reporting the connection
             * failure — is the behaviour this exists to fix.
             */
            let rejectionError: unknown;
            const noteFailure = (err: unknown) => {
                lastError = err;
                if (rejectionError === undefined && isProviderRejection(err)) rejectionError = err;
            };

            for (let t = 0; t < targets.length; t++) {
                const target = targets[t];
                let provider: AiProvider;
                try {
                    provider = providerForTarget(target);
                } catch (err) {
                    noteFailure(err);
                    logger.warn('ai routing target unavailable, trying next', {
                        component: 'ai',
                        task,
                        backend: target.backend,
                        model: target.model,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue;
                }

                // PII redaction — only for EXTERNAL backends; local keeps
                // data on the box (skip). Rehydrate the response after.
                const external = isExternalBackend(target.backend);
                let callOpts = clampedOpts;
                let map: RedactionMap = {};
                if (external) {
                    const red = redactForExternal(clampedOpts.messages, {
                        sensitiveTerms: clampedOpts.sensitiveTerms,
                    });
                    map = red.map;
                    callOpts = { ...clampedOpts, messages: red.messages };
                }

                for (let attempt = 0; attempt <= route.retries; attempt++) {
                    try {
                        const raw = await completeOnce<T>(
                            provider,
                            callOpts,
                            target.model,
                            route.maxTokens,
                            route.timeoutMs,
                            opts.signal,
                        );

                        // Rehydrate placeholders in the response for external calls.
                        const result = external ? rehydrateCompletion(raw, map) : raw;

                        // Cache (best-effort; keyed on the PRIMARY route model so
                        // a failover answer still primes the canonical key).
                        await setCachedCompletion(ctx.tenantId, primaryModel, task, clampedOpts, result);

                        await finishCompletion(ctx, {
                            task,
                            tier: route.tier,
                            model: target.model,
                            backend: target.backend,
                            usage: result.usage,
                            latencyMs: Date.now() - started,
                            cacheHit: false,
                            promptHash,
                            citations: clampedOpts.citations,
                        });

                        return result;
                    } catch (err) {
                        noteFailure(err);
                        const transient = isTransient(err);
                        const moreRetries = attempt < route.retries;
                        const moreTargets = t < targets.length - 1;

                        logger.warn('ai routing attempt failed', {
                            component: 'ai',
                            task,
                            backend: target.backend,
                            model: target.model,
                            attempt,
                            transient,
                            willRetry: transient && moreRetries,
                            willFailover: (!transient || !moreRetries) && moreTargets,
                            error: err instanceof Error ? err.message : String(err),
                        });

                        if (opts.signal?.aborted) throw err;
                        if (transient && moreRetries) continue;
                        break;
                    }
                }
            }

            // All targets failed — record the failure metric, then throw.
            recordAiCompletion({
                task,
                model: route.model,
                backend: route.backend,
                costMicros: 0,
                latencyMs: Date.now() - started,
                cacheHit: false,
                outcome: 'error',
            });

            // The rejection if there was one, else the most recent failure.
            const reported = rejectionError ?? lastError;
            throw reported instanceof Error
                ? reported
                : new AiProviderError(route.backend, `All routing targets failed for task "${task}".`);
        },
    );
}

/** Rehydrate PII placeholders in a completion's text + parsed JSON. */
function rehydrateCompletion<T>(completion: AiCompletion<T>, map: RedactionMap): AiCompletion<T> {
    if (Object.keys(map).length === 0) return completion;
    const text = rehydrate(completion.text, map);
    const result: AiCompletion<T> = { ...completion, text };
    // `parsed` is structured output — restore placeholders inside it by
    // round-tripping its JSON string form.
    if (completion.parsed !== undefined) {
        try {
            const restored = rehydrate(JSON.stringify(completion.parsed), map);
            result.parsed = JSON.parse(restored) as T;
        } catch {
            // Non-serialisable parsed value — leave as-is (text is rehydrated).
        }
    }
    return result;
}

interface FinishInput {
    task: AiTask;
    tier: AiTier;
    model: string;
    backend: AiBackend;
    usage: AiUsage | undefined;
    latencyMs: number;
    cacheHit: boolean;
    promptHash: string;
    citations?: unknown;
}

/**
 * Post-success pipeline: cost estimate, span attributes, metrics, usage
 * ledger, immutable audit. Best-effort for the side-channels — a failed
 * ledger/audit write must NOT fail the user's already-computed completion.
 */
async function finishCompletion(ctx: RequestContext, input: FinishInput): Promise<void> {
    const usage = input.usage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimated: true,
    };
    // Cache hits cost nothing NEW (the original answer was already paid for).
    const costMicros = input.cacheHit ? 0 : estimateCostMicros(input.model, usage);

    // Span attributes on the active ai.completion span.
    try {
        const { trace } = await import('@opentelemetry/api');
        trace.getActiveSpan()?.setAttributes({
            'ai.model': input.model,
            'ai.backend': input.backend,
            'ai.tokens.prompt': usage.promptTokens,
            'ai.tokens.completion': usage.completionTokens,
            'ai.tokens.total': usage.totalTokens,
            'ai.cost_micros': costMicros,
            'ai.latency_ms': input.latencyMs,
            'ai.cache_hit': input.cacheHit,
        });
    } catch {
        // OTel absent — span attrs are best-effort.
    }

    // Metrics.
    recordAiCompletion({
        task: input.task,
        model: input.model,
        backend: input.backend,
        usage,
        costMicros,
        latencyMs: input.latencyMs,
        cacheHit: input.cacheHit,
        outcome: 'success',
    });

    // Usage ledger (RLS-scoped insert) — best-effort.
    try {
        await recordAiUsage(ctx, {
            task: input.task,
            model: input.model,
            backend: input.backend,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            costMicros,
            cacheHit: input.cacheHit,
            promptHash: input.promptHash,
        });
    } catch (err) {
        logger.error('ai usage ledger write failed (non-fatal)', {
            component: 'ai',
            task: input.task,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Immutable audit — promptHash ONLY, never the raw prompt/PII.
    try {
        const data: Record<string, unknown> = {
            model: input.model,
            task: input.task,
            backend: input.backend,
            tier: input.tier,
            promptHash: input.promptHash,
            totalTokens: usage.totalTokens,
            costMicros,
            cacheHit: input.cacheHit,
        };
        if (input.citations !== undefined) data.citations = input.citations;
        await runInTenantContext(ctx, (db) =>
            logEvent(db, ctx, {
                action: 'AI_COMPLETION',
                entityType: 'AiCall',
                entityId: input.promptHash,
                detailsJson: { category: 'custom', action: 'AI_COMPLETION', data },
            }),
        );
    } catch (err) {
        logger.error('ai completion audit write failed (non-fatal)', {
            component: 'ai',
            task: input.task,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
