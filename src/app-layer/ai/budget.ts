/**
 * Per-tenant+plan AI token budget (feat/ai-guardrails).
 *
 * A MONTHLY (current-UTC-month) cap on total AI tokens, layered on top of
 * the existing entitlement machinery (`src/lib/billing/entitlements.ts`):
 *   • the limit comes from `PLAN_LIMITS[plan].ai_tokens`,
 *   • the used amount is the SUM of `AiUsageEvent.totalTokens` this month,
 *   • self-hosted / ENTERPRISE (null limit) never blocks.
 *
 * Two thresholds:
 *   • HARD-STOP — `used >= limit` → throws
 *     `codedForbidden('AI_BUDGET_EXCEEDED', …, { plan, limit, used })`, so
 *     `withApiErrorHandling` surfaces it without new plumbing and
 *     `localizeErrorPayload` replaces the message from `errors.
 *     AI_BUDGET_EXCEEDED` in the reader's own language.
 *
 *     This said `forbidden('ai_budget_exceeded…')` until 2026-10-31, which was
 *     the shape before #1645 coded it and is the shape a client reading this
 *     docblock would have built for: a `code` of `FORBIDDEN` with the real
 *     code buried in a message. agrent-ios built exactly that and asked for
 *     the coded form, which had already existed for weeks. A stale docblock
 *     about an ERROR SHAPE costs a client a wrong branch, so the line is
 *     corrected rather than deleted.
 *   • SOFT-WARN — `used >= 0.8 * limit` → does NOT block; returns
 *     `softWarn:true` so the caller can annotate the span / log / surface a
 *     "running low" hint.
 *
 * Per-REQUEST size is already capped by the route's `maxTokens`
 * (`completeWithRouting`); this is the cumulative monthly guard. The two
 * are complementary: maxTokens bounds one call, the budget bounds the month.
 *
 * ── what this gate does NOT cover (measured, see #1345) ──
 *
 * `assertAiBudget` is called from exactly one place, `ai/routing.ts`, and so
 * covers COMPLETIONS only. Embedding paths reach a provider directly and
 * bypass it entirely:
 *
 *   src/app-layer/jobs/embed-chunks.ts   getEmbeddingProvider().embed()
 *   src/app-layer/ai/rag/retrieve.ts     getAiProvider() — embeds the query
 *   src/app-layer/usecases/rag.ts        getAiProvider()
 *
 * That matters most for the P3.5f verification gate below: an unverified farm
 * cannot use the copilot, but RAG ingestion and query embedding still run, and
 * that is the cost which scales with how much a speculative signup uploads.
 * Stated here rather than left implied, because "zero AI budget until
 * verified" reads as a guarantee and this is not yet one. #1345 proposes the
 * shared choke point.
 */
import type { RequestContext } from '@/app-layer/types';
import { codedForbidden, forbidden } from '@/lib/errors/types';
import { isFarmVerified } from '@/lib/farm-identity/verification-status';
import {
    getEffectivePlan,
    getLimit,
    getAiTokensUsedThisMonth,
    getBillingMode,
    type BillingMode,
} from '@/lib/billing/entitlements';

/** Fraction of the limit at which the soft warning trips. */
const SOFT_WARN_RATIO = 0.8;

export interface AiBudgetStatus {
    /** Tokens consumed this UTC month. */
    used: number;
    /** Monthly cap (null = unlimited — self-hosted / ENTERPRISE). */
    limit: number | null;
    /** Tokens left before the hard stop (null when unlimited). */
    remaining: number | null;
    /** True when at/over 80% of the limit (advisory, non-blocking). */
    softWarn: boolean;
    /** Billing mode the status was evaluated under. */
    mode: BillingMode;
}

/**
 * Assert the tenant is within its monthly AI token budget. Throws a 403
 * `codedForbidden('AI_BUDGET_EXCEEDED', …)` on hard stop; otherwise returns
 * the status (so the caller can react to `softWarn`). Call BEFORE the model
 * call in `completeWithRouting`.
 */
/**
 * The single gate every AI spend path must pass — completions AND embeddings
 * (#1345).
 *
 * ## Why this exists beside `assertAiBudget` rather than replacing it
 *
 * `assertAiBudget` was called from exactly one file, `ai/routing.ts`. That is
 * a genuine choke point for COMPLETIONS, and not one for embeddings: three
 * paths reach a provider without going through routing at all —
 * `jobs/embed-chunks.ts`, `ai/rag/retrieve.ts` and `usecases/rag.ts`. So a
 * tenant at its hard stop could still drive embedding spend, and RAG
 * ingestion embeds per CHUNK.
 *
 * ## The part that is not a future problem
 *
 * `assertAiBudget` now carries P3.5f's unverified-farm gate — a SaaS tenant
 * whose farm is not verified has NO budget whatever its plan. That gate has
 * shipped, so "an unverified farm cannot spend" is a guarantee the product
 * makes TODAY, and the three bypasses above are exactly the cost that scales
 * with how much a speculative signup uploads. #1345 filed this as "becomes
 * material when P3.5f starts relying on the gate"; it already does.
 *
 * ## Why not gate inside the provider
 *
 * `AiProvider.embed()` is the point every embedding path reaches and would be
 * the better choke point — but `getEmbeddingProvider()` is synchronous and
 * takes no context, and `embed(opts)` has no tenant in its options. Gating
 * there means either an interface change across every provider and call site,
 * or reading the tenant from AsyncLocalStorage, where a missing context would
 * have to fail open or closed and both are wrong for different callers (a seed
 * script has no tenant; a request that lost its context must not be exempt).
 *
 * So the gate stays at the call sites and
 * `tests/guards/ai-spend-gate-covers-embeddings.test.ts` DERIVES the
 * population from the filesystem instead: any file reaching an embedding
 * provider must call this, so bypass number four fails CI rather than being
 * discovered later. That is the trade — N call sites with a derived guard,
 * against one choke point with a context problem.
 */
export async function assertAiSpendAllowed(ctx: RequestContext): Promise<AiBudgetStatus> {
    // Deliberately a thin delegation today. It exists as its own name because
    // the two call-site populations are different — `routing.ts` for
    // completions, the embedding paths for the rest — and because a future
    // embedding-specific rule (a separate cap, a cheaper tier) belongs here
    // rather than inside the monthly-cap function.
    return assertAiBudget(ctx);
}

export async function assertAiBudget(ctx: RequestContext): Promise<AiBudgetStatus> {
    const mode = getBillingMode();
    const plan = await getEffectivePlan(ctx);
    const limit = getLimit(plan, 'ai_tokens');

    // ── P3.5f: an unverified farm has NO budget, whatever its plan ──
    //
    // Placed BEFORE the `limit === null` early return on purpose. An
    // ENTERPRISE SaaS tenant resolves to an unlimited budget, and an
    // unverified ENTERPRISE tenant is precisely the expensive case this is
    // for — gating after the early return would exempt it.
    //
    // And scoped to SAAS on purpose, which is the half that is easy to get
    // wrong: `getBillingMode()` returns SELFHOSTED whenever there is no
    // STRIPE_SECRET_KEY, and a self-hosted deployment resolves to ENTERPRISE.
    // Those installs have no staff verification console to verify a farm WITH,
    // so an unscoped gate would not tighten anything — it would brick AI
    // outright on every self-hosted install, permanently, with no action the
    // operator could take.
    //
    // The error is deliberately distinct from `AI_BUDGET_EXCEEDED`: the remedy
    // is "get your farm verified", not "upgrade", and a client that showed an
    // upgrade prompt here would send a farmer to buy capacity they already
    // have.
    if (mode === 'SAAS' && !(await isFarmVerified(ctx))) {
        // The code is the contract and the Bulgarian wording belongs to the
        // client, keyed on it. The remedy here is "get your farm verified",
        // which is NOT what `AI_BUDGET_EXCEEDED` means — a client that showed
        // an upgrade prompt would send a farmer to buy capacity they already
        // have, so the two must be separately keyable.
        //
        // This paragraph used to justify ALL-CAPS by CONTRAST: "rather than
        // matching the neighbouring lowercase `ai_budget_exceeded`, which
        // carries prose and is one of the 502 the ratchet is draining".
        //
        // That argument is spent, because the neighbour was drained. The hard
        // stop below now throws `codedForbidden('AI_BUDGET_EXCEEDED', …)`, so
        // the two refusals on this path are CONSISTENT rather than one being
        // an exception to the other — and the reason for the shape is now
        // simply that a code is what a client switches on. Kept rather than
        // deleted because the history is the lesson: a justification by
        // contrast goes false when the thing it contrasts with changes, and
        // nothing fails when it does.
        //
        // This was `forbidden('AI_BUDGET_REQUIRES_VERIFIED_FARM')` until #1645,
        // under a comment that opened "a bare ALL-CAPS CODE, with no English
        // sentence beside it" and justified the omission by the copy ratchet.
        // `forbidden` takes a MESSAGE, so what that achieved was a code in the
        // message field and a generic `error.code` — nothing to switch on, and
        // a farmer who could be shown the token itself. `codedForbidden` puts
        // the code where a client reads it and the ratchet exempts the coded
        // throw, so the English fallback costs nothing it was avoiding.
        throw codedForbidden(
            'AI_BUDGET_REQUIRES_VERIFIED_FARM',
            'This farm must be verified before it can use AI features.',
        );
    }

    // Unlimited (self-hosted / ENTERPRISE) — never block, never query usage.
    if (limit === null) {
        return { used: 0, limit: null, remaining: null, softWarn: false, mode };
    }

    const used = await getAiTokensUsedThisMonth(ctx);

    if (used >= limit) {
        throw codedForbidden(
            'AI_BUDGET_EXCEEDED',
            `${plan} plan allows ${limit} AI tokens per month; ` +
                `tenant has used ${used} this month.`,
            { plan, limit: String(limit), used: String(used) },
        );
    }

    const remaining = Math.max(0, limit - used);
    const softWarn = used >= SOFT_WARN_RATIO * limit;
    return { used, limit, remaining, softWarn, mode };
}
