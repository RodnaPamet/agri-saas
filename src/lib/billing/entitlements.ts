/**
 * GAP-18 — Plan-entitlement evaluation and enforcement.
 *
 * The full operator + developer runbook is in `docs/billing.md`.
 * This docblock is the inline summary; deviations from it should
 * be reflected in both places.
 *
 * Two responsibilities:
 *
 *   1. Decide what plan a tenant is currently entitled to. The
 *      decision branches on billing mode:
 *
 *        • SAAS mode      — STRIPE_SECRET_KEY is configured, so
 *                            the deployment is the hosted product.
 *                            The effective plan is read from
 *                            `BillingAccount.plan` (FREE/TRIAL/PRO/
 *                            ENTERPRISE). A tenant with no
 *                            BillingAccount row is treated as FREE
 *                            — that's the safe default for a SaaS
 *                            tenant that hasn't started a subscription.
 *
 *        • SELFHOSTED mode — STRIPE_SECRET_KEY is NOT configured,
 *                            so the deployment is on-prem / OSS.
 *                            Every tenant resolves to ENTERPRISE
 *                            (unlimited). Self-hosted customers
 *                            paid for the right to run the software;
 *                            they did not buy a SaaS subscription.
 *
 *      The mode decision is deterministic per process — read once
 *      at module load, no per-request env scan. There is no
 *      runtime flip; restart the process to change modes.
 *
 *   2. Enforce per-plan resource limits at the mutation boundary.
 *      `assertWithinLimit(ctx, resource)` throws a typed
 *      `forbidden(...)` error when the tenant has reached the
 *      cap for `resource` under its effective plan. Reusable —
 *      adding a new gated resource is one entry in `PLAN_LIMITS`,
 *      one `switch` arm in `getCurrentCount`, and one
 *      `assertWithinLimit` call at the create site.
 *
 * NON-GOALS in this module:
 *   • UI gating — the UI is welcome to render upgrade CTAs derived
 *     from the same evaluation, but enforcement must live behind
 *     the API. The UI is advisory; this layer is authoritative.
 *   • Stripe checkout / portal logic — that lives in `src/lib/stripe.ts`.
 *   • Subscription lifecycle hooks — those live in the webhook
 *     handler and write `BillingAccount.plan`. This module READS
 *     that value; it does not write it. Status (CANCELED, PAST_DUE,
 *     …) is also intentionally NOT factored in here — second-
 *     guessing the webhook would race with it and produce confusing
 *     user-facing failures.
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';

/**
 * Run `cb` inside the caller's OPEN transaction when it supplied one, else
 * open a fresh tenant-bound transaction.
 *
 * The `tx` path exists so a create-site can put the quota COUNT and the
 * INSERT in a single transaction. Without it the count committed and released
 * before the insert began, so two concurrent creates on a tenant sitting at
 * limit-1 both read `current = limit - 1`, both passed, and both wrote — the
 * cap was advisory under exactly the concurrency it is meant to stop. Passing
 * the caller's `tx` also avoids the second, nested pool checkout that calling
 * `runInTenantContext` from inside a transaction would cause.
 */
function runIn<T>(
    ctx: RequestContext,
    tx: PrismaTx | undefined,
    cb: (db: PrismaTx) => Promise<T>,
): Promise<T> {
    return tx ? cb(tx) : runInTenantContext(ctx, cb);
}

// ─── Types ───────────────────────────────────────────────────────

/**
 * The four plans recognised by the codebase. Mirrors the Prisma
 * `BillingPlan` enum but expressed as a TypeScript string union so
 * the entitlement code does not need a runtime dependency on the
 * generated Prisma client (lets unit tests run without Prisma init).
 */
export type Plan = 'FREE' | 'TRIAL' | 'PRO' | 'ENTERPRISE';

/**
 * Operating modes — derived from environment, not stored.
 */
export type BillingMode = 'SAAS' | 'SELFHOSTED';

/**
 * Resources that have a per-plan numeric cap. Adding a new entry
 * here implies (a) updating PLAN_LIMITS and (b) calling
 * `assertWithinLimit(ctx, '<resource>')` at the resource's create
 * site.
 */
export type GatedResource =
    | 'user'
    | 'location'
    | 'ai_tokens'
    | 'exchange_listing';

/**
 * Numeric cap by (plan, resource). `null` means unlimited.
 *
 * Re-keyed for the agriculture product: the two resources that
 * meaningfully separate a startup farmer (FREE / "simple mode") from a
 * large grain producer (ENTERPRISE) are TEAM SIZE (`user`) and the
 * number of FARMS/FIELDS (`location`). FREE gets a single-operator,
 * few-fields budget; the working tiers lift it; ENTERPRISE is
 * unlimited.
 *
 * TRIAL inherits PRO — a paying-customer-on-trial gets the full
 * working surface, not an artificially constrained one.
 */
//
// `ai_tokens` is a MONTHLY (current-UTC-month) cap on total AI tokens
// consumed across all completions — the abuse/cost guardrail. Unlike the
// other resources (pure row counts), it is a SUM over a time window. The
// caps are sized for a working farm: FREE is a "try it out" budget
// (~50k tokens ≈ a few dozen copilot turns), TRIAL/PRO get a generous
// working budget, ENTERPRISE is unlimited. Per-request size is separately
// capped by the route's `maxTokens`; this is the cumulative monthly cap.
// `exchange_listing` caps the number of ACTIVE marketplace listings a tenant
// may hold open at once. It is the real spam control for the Exchange, since
// the EXCHANGE module itself is available on the FREE plan (MODULE_MIN_PLAN):
// a small FREE budget keeps a single tenant from flooding the shared feed,
// while working tiers lift it and ENTERPRISE is unlimited.
const PLAN_LIMITS: Record<Plan, Record<GatedResource, number | null>> = {
    FREE: { user: 3, location: 5, ai_tokens: 50_000, exchange_listing: 5 },
    TRIAL: { user: 25, location: 50, ai_tokens: 1_000_000, exchange_listing: 50 },
    PRO: { user: 25, location: 50, ai_tokens: 5_000_000, exchange_listing: 50 },
    ENTERPRISE: { user: null, location: null, ai_tokens: null, exchange_listing: null },
};

// ─── Mode decision ───────────────────────────────────────────────

/**
 * Read once at module load — billing mode does not change at
 * runtime (you'd have to restart the process to flip it).
 */
const BILLING_MODE: BillingMode = process.env.STRIPE_SECRET_KEY
    ? 'SAAS'
    : 'SELFHOSTED';

export function getBillingMode(): BillingMode {
    return BILLING_MODE;
}

// ─── Plan resolution ─────────────────────────────────────────────

/**
 * The effective plan for a tenant. Always one of the Plan values
 * — never null, never undefined.
 *
 *   • SELFHOSTED → ENTERPRISE (unlimited).
 *   • SAAS without a BillingAccount row → FREE (the tenant exists
 *     but has not started a paid subscription).
 *   • SAAS with a BillingAccount row → row's `plan`.
 *
 * Status (CANCELED, PAST_DUE, …) is INTENTIONALLY NOT YET ENFORCED
 * here — a CANCELED PRO tenant still resolves to PRO until the
 * subscription end date. The webhook handler is responsible for
 * downgrading the row to FREE when the period ends. Trying to
 * second-guess that here would race with the webhook and produce
 * confusing user-facing failures.
 */
export async function getEffectivePlan(
    ctx: RequestContext,
    /** Reuse an OPEN transaction instead of opening a second one — see
     *  {@link assertWithinLimit}. */
    tx?: PrismaTx,
): Promise<Plan> {
    if (BILLING_MODE === 'SELFHOSTED') return 'ENTERPRISE';

    return runIn(ctx, tx, async (db) => {
        // BillingAccount is global (not RLS-scoped) so a runtime
        // tenant context is not strictly required — but using
        // runInTenantContext keeps the function signature uniform
        // with the rest of the data layer.

        const account = await db.billingAccount.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { plan: true },
        });
        return ((account?.plan ?? 'FREE') as Plan);
    });
}

// ─── AI model-tier gating ────────────────────────────────────────

/**
 * Ordered AI capability tiers, cheapest → most capable. The routing
 * policy (`src/app-layer/ai/routing.ts`) maps a TASK to one of these,
 * and `assertAiTierAllowed` gates the tier against the tenant's plan
 * so a FREE tenant cannot route a task to an Opus-class model.
 *
 * The order is load-bearing: `AI_TIER_ORDER.indexOf(tier)` is the
 * comparison key for the plan ceiling below.
 */
export type AiTier = 'cheap' | 'standard' | 'premium';

export const AI_TIER_ORDER: readonly AiTier[] = ['cheap', 'standard', 'premium'];

/**
 * The most capable AI tier each plan may use. FREE is capped at the
 * cheap/fast tier (Haiku / Groq); paid tiers unlock the premium
 * reasoning tier (Sonnet / Opus). TRIAL inherits PRO, mirroring the
 * resource-limit table.
 */
const PLAN_AI_TIER_CEILING: Record<Plan, AiTier> = {
    FREE: 'cheap',
    TRIAL: 'premium',
    PRO: 'premium',
    ENTERPRISE: 'premium',
};

export function getAiTierCeiling(plan: Plan): AiTier {
    return PLAN_AI_TIER_CEILING[plan];
}

/**
 * Throws `forbidden(...)` if the tenant's plan does not permit the
 * requested AI `tier`. Higher tiers require higher plans. The thrown
 * error embeds `ai_tier_not_allowed` + plan + tier so the surface can
 * render an upgrade CTA, consistent with `assertWithinLimit`.
 */
export async function assertAiTierAllowed(
    ctx: RequestContext,
    tier: AiTier,
): Promise<void> {
    const plan = await getEffectivePlan(ctx);
    const ceiling = PLAN_AI_TIER_CEILING[plan];
    if (AI_TIER_ORDER.indexOf(tier) > AI_TIER_ORDER.indexOf(ceiling)) {
        throw forbidden(
            `ai_tier_not_allowed: ${plan} plan allows the "${ceiling}" AI tier at most; ` +
                `the "${tier}" tier requires a higher plan. Upgrade to use it.`,
        );
    }
}

// ─── Limit lookup ────────────────────────────────────────────────

export function getLimit(plan: Plan, resource: GatedResource): number | null {
    return PLAN_LIMITS[plan][resource];
}

/**
 * SUM of AI tokens this tenant has consumed in the current UTC month —
 * the windowed quantity behind the `ai_tokens` budget. Exported so the
 * AI budget helper (`src/app-layer/ai/budget.ts`) can report
 * used/remaining without duplicating the month-window aggregate.
 */
export async function getAiTokensUsedThisMonth(ctx: RequestContext): Promise<number> {
    return getCurrentCount(ctx, 'ai_tokens');
}

/**
 * The current count of `resource` for the tenant — used by the
 * limit assertion. Soft-deleted rows are excluded so a tenant that
 * deleted some locations can immediately create new ones again.
 */
async function getCurrentCount(
    ctx: RequestContext,
    resource: GatedResource,
    tx?: PrismaTx,
): Promise<number> {
    return runIn(ctx, tx, async (db) => {
        switch (resource) {
            case 'user':
                // Active team members (the seats the plan pays for).
                return db.tenantMembership.count({
                    where: { tenantId: ctx.tenantId, status: 'ACTIVE' },
                });
            case 'location':
                // ANY non-deleted Location row — farms/fields AND grain
                // bins/stores, which are the same table distinguished by
                // `kind`. Both creation paths (`createLocation`,
                // `createBin`) gate on this one cap, so the count and the
                // gate agree.
                return db.location.count({
                    where: { tenantId: ctx.tenantId, deletedAt: null },
                });
            case 'exchange_listing':
                // ACTIVE marketplace listings owned by this tenant.
                // ExchangeListing is a GLOBAL table (no tenantId / no RLS —
                // see prisma/schema/exchange.prisma), so scope explicitly by
                // sellerTenantId; only ACTIVE rows count against the quota
                // (WITHDRAWN / FULFILLED / EXPIRED free up the budget).
                return db.exchangeListing.count({
                    where: { sellerTenantId: ctx.tenantId, status: 'ACTIVE' },
                });
            case 'ai_tokens': {
                // SUM of total tokens consumed this calendar month (UTC).
                // Unlike the other resources this is a windowed aggregate,
                // not a row count — the AI budget resets monthly.
                const now = new Date();
                const monthStart = new Date(
                    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
                );
                const agg = await db.aiUsageEvent.aggregate({
                    _sum: { totalTokens: true },
                    where: {
                        tenantId: ctx.tenantId,
                        createdAt: { gte: monthStart },
                    },
                });
                return agg._sum.totalTokens ?? 0;
            }
            default: {
                // Exhaustive — TypeScript flags any new GatedResource
                // value that isn't handled above.
                const _exhaustive: never = resource;
                return _exhaustive;
            }
        }
    });
}

// ─── Enforcement ─────────────────────────────────────────────────

/**
 * Throws `forbidden(...)` if the tenant cannot create one more
 * `resource` under its effective plan. Call BEFORE the
 * `db.<resource>.create({...})` line.
 *
 * The thrown error is the same `ForbiddenError` shape used by the
 * rest of the codebase, so `withApiErrorHandling` surfaces it as a
 * 403 without any new error-type plumbing. The message body
 * embeds `plan_limit_exceeded` + plan + resource + limit + current
 * so the billing UI can parse it into an "Upgrade" CTA.
 *
 * Pass `tx` — the transaction the create itself runs in — to close the
 * check-then-act race. Read/write skew is still possible under READ COMMITTED
 * (Postgres' default), but the window shrinks from "two round trips and a
 * commit apart" to "the same statement sequence in one transaction", and a
 * caller that later needs a hard cap has somewhere to put a `SELECT … FOR
 * UPDATE`. Omitting `tx` keeps the old behaviour for the call sites that have
 * no transaction to share.
 */
export async function assertWithinLimit(
    ctx: RequestContext,
    resource: GatedResource,
    tx?: PrismaTx,
): Promise<void> {
    const plan = await getEffectivePlan(ctx, tx);
    const limit = getLimit(plan, resource);
    if (limit === null) return; // unlimited

    const current = await getCurrentCount(ctx, resource, tx);
    if (current >= limit) {
        // Surface as `forbidden` so `withApiErrorHandling` returns
        // 403. The message embeds plan + resource + limit so the
        // billing UI can parse it into an "Upgrade" CTA without
        // adding a new error type / shape to the API contract.
        throw forbidden(
            `plan_limit_exceeded: ${plan} plan allows ${limit} ${resource}(s); ` +
                `tenant currently has ${current}. Upgrade to add more.`,
        );
    }
}
