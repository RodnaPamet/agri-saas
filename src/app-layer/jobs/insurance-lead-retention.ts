/**
 * Insurance-lead retention sweep.
 *
 * An `InsuranceLead` is a farmer's quote request: who asked (`inquirerUserId`),
 * which parcel, its satellite risk reading, the quote they were shown and the
 * message they wrote. It goes first to the operator, a registered insurance
 * agent, who passes it to the partner insurer (owner, 2026-11-20). Until this
 * job, nothing ever deleted one, so the privacy notice could state no period —
 * and the owner ruled the same window as offer requests: 24 months.
 *
 * ## One stage, where `promotion-lead-retention` has two
 *
 * That sweep soft-deletes first and purges after a grace because a soft-deleted
 * `PromotionLead` keeps holding `@@unique([promotionId, inquirerTenantId])`,
 * which is what stops one tenant spamming one promotion; a hard delete would
 * quietly re-open it. `InsuranceLead` has no such constraint — the owner made
 * repeat asks deliberate on 2026-09-24 — and no `deletedAt` column, so a grace
 * would protect nothing and would mean a migration plus a `deletedAt: null`
 * filter on every reader, any one of which forgotten would keep serving an
 * expired request. So a lead past the window is deleted outright. The only
 * unique index, `(inquirerTenantId, clientMutationId)`, is an idempotency key
 * for a retry seconds after the POST; deleting a two-year-old row cannot
 * collide with a live one.
 *
 * ## Keys and RLS
 *
 * Runs on the base client, i.e. as a non-`app_user` role, so it passes the
 * `superuser_bypass` policy — necessary, because leads span every tenant and no
 * single tenant context could see them all. It never reads `message` (which is
 * encrypted under the inquiring tenant's DEK), so it needs no key: the decision
 * is `createdAt` alone. That is why one global pass is possible.
 *
 * @module app-layer/jobs/insurance-lead-retention
 */
import { prisma as defaultPrisma } from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';

/**
 * How long an insurance quote request is kept: 730 days (24 months), the same
 * window as offer requests (owner, 2026-11-20).
 *
 * **This constant is the single source of truth.** The privacy notice renders
 * the period from it, so the page and the behaviour cannot drift apart.
 * Changing it changes what users are told.
 */
export const INSURANCE_LEAD_RETENTION_DAYS = 730;

const DAY_MS = 86_400_000;

export interface InsuranceLeadRetentionOptions {
    now?: Date;
    dryRun?: boolean;
    /** Injectable client for tests. */
    db?: typeof defaultPrisma;
    retentionDays?: number;
}

export interface InsuranceLeadRetentionResult {
    /** Leads past the window that were (or would be) deleted. */
    deleted: number;
    dryRun: boolean;
}

export async function runInsuranceLeadRetentionSweep(
    options: InsuranceLeadRetentionOptions = {},
): Promise<InsuranceLeadRetentionResult> {
    return runJob('insurance-lead-retention', async () => {
        const db = options.db ?? defaultPrisma;
        const now = options.now ?? new Date();
        const dryRun = options.dryRun ?? false;
        const retentionDays = options.retentionDays ?? INSURANCE_LEAD_RETENTION_DAYS;

        const deleteBefore = new Date(now.getTime() - retentionDays * DAY_MS);
        // `lt`, never `lte`: a lead exactly at the boundary is still inside
        // the window the notice promises.
        const where = { createdAt: { lt: deleteBefore } };

        if (dryRun) {
            const deleted = await db.insuranceLead.count({ where });
            logger.info('insurance-lead retention dry run', {
                component: 'job',
                deleted,
                retentionDays,
            });
            return { deleted, dryRun: true };
        }

        const result = await db.insuranceLead.deleteMany({ where });

        logger.info('insurance-lead retention sweep complete', {
            component: 'job',
            deleted: result.count,
            retentionDays,
        });

        return { deleted: result.count, dryRun: false };
    });
}
