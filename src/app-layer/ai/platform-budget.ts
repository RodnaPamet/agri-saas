/**
 * A ceiling on the platform's OWN AI spend (#1423).
 *
 * Three jobs talk to the Anthropic Messages API directly and deliberately
 * bypass `ai/routing.ts` — `field-briefing`, `news-event-extractor` and
 * `support-scheme-extractor`. That bypass is correct and must not be "fixed":
 * the router needs a tenant `RequestContext` to resolve budget and model
 * policy, and a GLOBAL job has none to supply. Gating them against a tenant
 * budget would charge an arbitrary farm for platform work.
 *
 * The consequence was that their spend had **no ceiling of any kind** — not a
 * per-tenant budget (correctly) and not a platform one either. The operator's
 * only lever was removing `ANTHROPIC_API_KEY`, which also disables every
 * tenant's AI.
 *
 * ## Recording is unconditional; CAPPING is opt-in
 *
 * `PLATFORM_AI_TOKENS_MONTHLY` unset means **no cap**, and that is deliberate
 * rather than lax.
 *
 * The var is not set in production. A gate that refused by default would
 * silently switch off three working features the moment this shipped — and
 * because all three are fail-safe, returning `null` or `[]` rather than
 * throwing, the refusal would be **invisible**: the dashboard briefing would
 * simply stop appearing, with nothing anywhere saying why. That is a worse
 * outcome than the uncapped spend this exists to bound.
 *
 * So the ledger fills from the moment it ships, giving the operator the number
 * BEFORE they have to choose a limit, and the limit binds only once they set
 * one. #1423's own framing is that this is a missing control rather than a live
 * cost incident; the control is the lever, not a default.
 *
 * ## Why not a cost cap
 *
 * `costMicros` is recorded but the cap is on TOKENS, mirroring the per-tenant
 * budget. A cost cap would be the more meaningful number and is also the one
 * that silently stops working: `costMicros` is 0 for un-priced models, so a
 * cost ceiling would never bind on a model whose price table entry is missing,
 * while a token ceiling binds on every model. Tokens are the quantity the
 * provider actually meters.
 *
 * @module app-layer/ai/platform-budget
 */
import prisma from '@/lib/prisma';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

const COMPONENT = 'ai.platform-budget';

/** Fraction of the limit at which the advisory warning trips — as the per-tenant gate. */
const SOFT_WARN_RATIO = 0.8;

/**
 * The platform jobs that spend without a tenant.
 *
 * Enumerated so the ledger's `job` column has a known vocabulary and a
 * per-job report is possible later. Adding a job here is a code change rather
 * than a migration, and `tests/guards/ai-spend-gate-covers-embeddings.test.ts`
 * is what keeps the set honest — it derives the population from the files that
 * reach an AI provider, so a fourth global job fails that guard until it is
 * gated.
 */
export const PLATFORM_AI_JOBS = [
    'field-briefing',
    'news-event-extraction',
    'support-scheme-extraction',
] as const;

export type PlatformAiJob = (typeof PLATFORM_AI_JOBS)[number];

export interface PlatformAiBudgetStatus {
    /** Tokens the platform's own jobs consumed this UTC month. */
    used: number;
    /** Monthly cap, or null when none is configured (see the module docblock). */
    limit: number | null;
    /** Tokens left before the hard stop; null when uncapped. */
    remaining: number | null;
    /** At or over 80% of the limit. Advisory, non-blocking. */
    softWarn: boolean;
}

/** Start of the current UTC month — the same window the per-tenant budget uses. */
function monthStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The configured cap, or null when there is none.
 *
 * A non-numeric or non-positive value is treated as NO cap and logged, rather
 * than as zero. Zero would refuse every call, which for a typo in a deploy
 * variable means three features silently stop — the same invisible failure the
 * module docblock rejects. An operator who means "off" removes the jobs' key or
 * the schedule, not the budget.
 */
function configuredLimit(): number | null {
    const raw = env.PLATFORM_AI_TOKENS_MONTHLY;
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        logger.warn('platform AI budget: cap is set but unusable; treating as uncapped', {
            component: COMPONENT,
            // The VALUE, not a redaction: this is an operator-set numeric
            // config variable with no secret in it, and "unusable" is
            // unactionable without saying what was read.
            configured: String(raw),
        });
        return null;
    }
    return Math.floor(n);
}

/** Tokens the platform's own jobs have consumed this UTC month. */
export async function getPlatformAiTokensUsedThisMonth(): Promise<number> {
    const agg = await prisma.platformAiUsageEvent.aggregate({
        _sum: { totalTokens: true },
        where: { createdAt: { gte: monthStart() } },
    });
    return agg._sum.totalTokens ?? 0;
}

/** The platform's AI budget position this month. */
export async function getPlatformAiBudgetStatus(): Promise<PlatformAiBudgetStatus> {
    const limit = configuredLimit();
    const used = await getPlatformAiTokensUsedThisMonth();
    return {
        used,
        limit,
        remaining: limit == null ? null : Math.max(0, limit - used),
        softWarn: limit != null && used >= limit * SOFT_WARN_RATIO,
    };
}

/**
 * True when a platform job may spend. NEVER throws.
 *
 * Returning a boolean rather than throwing, which is the opposite of
 * `assertAiSpendAllowed`'s shape and is deliberate. Every caller here is a
 * fail-safe helper that returns `null` or `[]` on any problem, so a thrown
 * refusal would be caught by the caller's own `catch` and become
 * indistinguishable from a provider outage — the cap would be invisible in the
 * logs of the thing it refused. A boolean makes the caller say "refused by the
 * platform budget" in its own words.
 *
 * A DATABASE failure here returns `true`. The ledger is a cost control, not a
 * safety one: letting an advisory job run because the count could not be read
 * is the lesser error against silently disabling three features whenever the
 * database hiccups. It is logged at `warn` so it is visible rather than
 * assumed.
 */
export async function isPlatformAiSpendAllowed(job: PlatformAiJob): Promise<boolean> {
    const limit = configuredLimit();
    if (limit == null) return true;

    let used: number;
    try {
        used = await getPlatformAiTokensUsedThisMonth();
    } catch (err) {
        logger.warn('platform AI budget: could not read usage; allowing the call', {
            component: COMPONENT,
            job,
            error: err instanceof Error ? err.message : String(err),
        });
        return true;
    }

    if (used >= limit) {
        logger.warn('platform AI budget EXCEEDED; refusing the call', {
            component: COMPONENT,
            job,
            used,
            limit,
        });
        return false;
    }

    if (used >= limit * SOFT_WARN_RATIO) {
        logger.info('platform AI budget is near its cap', {
            component: COMPONENT,
            job,
            used,
            limit,
        });
    }
    return true;
}

/**
 * Record what a platform job spent. NEVER throws.
 *
 * Unconditional — it runs whether or not a cap is configured, because the
 * number is what lets an operator choose one. A failure to record is logged and
 * swallowed: losing a ledger row is better than failing the advisory job that
 * produced the work, and these callers would swallow the throw anyway and
 * report "no briefing today" for a bookkeeping problem.
 *
 * The consequence is that the ledger is a FLOOR, not an exact total. Said here
 * because a cap compared against a floor under-counts, so a long run of write
 * failures would let spend drift above the limit — visible in the logs as
 * repeated warnings, which is the signal to look.
 */
export async function recordPlatformAiUsage(input: {
    job: PlatformAiJob;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costMicros?: number;
}): Promise<void> {
    try {
        await prisma.platformAiUsageEvent.create({
            data: {
                job: input.job,
                model: input.model,
                promptTokens: input.promptTokens,
                completionTokens: input.completionTokens,
                totalTokens: input.promptTokens + input.completionTokens,
                costMicros: input.costMicros ?? 0,
            },
        });
    } catch (err) {
        logger.warn('platform AI budget: failed to record usage', {
            component: COMPONENT,
            job: input.job,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
