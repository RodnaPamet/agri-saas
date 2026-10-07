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
 *   • HARD-STOP — `used >= limit` → throws `forbidden('ai_budget_exceeded…')`
 *     (same 403 shape + upgrade-hint contract as `assertWithinLimit`), so
 *     `withApiErrorHandling` surfaces it without new plumbing.
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
import { forbidden } from '@/lib/errors/types';
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
 * `forbidden('ai_budget_exceeded…')` on hard stop; otherwise returns the
 * status (so the caller can react to `softWarn`). Call BEFORE the model
 * call in `completeWithRouting`.
 */
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
    // The error is deliberately distinct from `ai_budget_exceeded`: the remedy
    // is "get your farm verified", not "upgrade", and a client that showed an
    // upgrade prompt here would send a farmer to buy capacity they already
    // have.
    if (mode === 'SAAS' && !(await isFarmVerified(ctx))) {
        // A bare ALL-CAPS CODE, with no English sentence beside it.
        //
        // `tests/guards/no-server-authored-user-copy.test.ts` holds thrown
        // prose on a downward ratchet, because a message argument to
        // `forbidden` reaches the client verbatim — `ApiClientError` preserves
        // it and the iOS app renders the envelope, English and all. For a
        // Bulgarian product that is untranslated copy escaping through the
        // error path, which is the one place every i18n guard used to miss.
        //
        // So the code is the contract and the Bulgarian wording belongs to the
        // client, keyed on it. The remedy here is "get your farm verified",
        // which is NOT what `ai_budget_exceeded` means — a client that showed
        // an upgrade prompt would send a farmer to buy capacity they already
        // have, so the two must be separately keyable.
        //
        // ALL-CAPS rather than matching the neighbouring lowercase
        // `ai_budget_exceeded` deliberately: that older message carries prose
        // and is one of the 502 the ratchet is draining. Draining it is a
        // welcome separate change; adding a 503rd is not.
        throw forbidden('AI_BUDGET_REQUIRES_VERIFIED_FARM');
    }

    // Unlimited (self-hosted / ENTERPRISE) — never block, never query usage.
    if (limit === null) {
        return { used: 0, limit: null, remaining: null, softWarn: false, mode };
    }

    const used = await getAiTokensUsedThisMonth(ctx);

    if (used >= limit) {
        throw forbidden(
            `ai_budget_exceeded: ${plan} plan allows ${limit} AI tokens per month; ` +
                `tenant has used ${used} this month. Upgrade for a higher budget.`,
        );
    }

    const remaining = Math.max(0, limit - used);
    const softWarn = used >= SOFT_WARN_RATIO * limit;
    return { used, limit, remaining, softWarn, mode };
}
