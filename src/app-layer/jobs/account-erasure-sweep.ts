/**
 * Erase the accounts whose grace period has run out (P5.6b, #1597).
 *
 * Daily. The grace period is 30 days, so the cadence only decides how long past
 * day 30 an erasure waits — up to 24 hours, which is within any reasonable
 * reading of "after 30 days" and far cheaper than a tighter beat on a queue
 * that is empty almost always.
 *
 * ## A blocked erasure is a RETRY, not a partial success
 *
 * `eraseAccount` does all its work in one transaction, and Postgres aborts a
 * transaction on the first error — there are no savepoints in this codebase.
 * So an erasure that trips the last-OWNER trigger rolls back whole: the person
 * keeps their data and `pseudonymisedAt` stays NULL, which means the sweep
 * selects them again tomorrow.
 *
 * That is the right failure mode. The alternative — catching per statement and
 * continuing — would need a savepoint per model and would leave half-erased
 * accounts, which is the worst of both: data still present, and nothing left
 * saying it should go. A loud repeat is better than a quiet partial.
 *
 * An account that trips it every day needs a human: an organisation cannot be
 * left ownerless, so somebody has to transfer ownership before the erasure can
 * complete. The log line names the account for exactly that.
 */
import { randomUUID } from 'node:crypto';

import { logger } from '@/lib/observability/logger';
import { eraseAccount, findAccountsDueForErasure } from '@/app-layer/usecases/account-erasure';
import type { JobRunResult } from './types';

/**
 * How many per run.
 *
 * Small, because each erasure is a multi-table transaction and a long one holds
 * a pool connection — `PG_POOL_MAX` is 12. At one run a day this is far above
 * any plausible volume for this deployment, and an account not reached today is
 * reached tomorrow.
 */
const DEFAULT_BATCH = 25;

export interface AccountErasureSweepPayload {
    /** Cap for this run. Defaults to 25. */
    limit?: number;
}

export async function runAccountErasureSweep(
    payload: AccountErasureSweepPayload = {},
): Promise<{ result: JobRunResult }> {
    const jobRunId = `aes-${randomUUID()}`;
    const startedAt = new Date();
    const take = payload.limit ?? DEFAULT_BATCH;

    const due = await findAccountsDueForErasure(take);
    let erased = 0;
    let failed = 0;

    for (const userId of due) {
        try {
            const outcome = await eraseAccount(userId);
            if (outcome.applied) erased += 1;
            else failed += 1;  // Already erased, or gone — neither is an error.
        } catch (err) {
            // Rolled back whole. The account stays selectable, so tomorrow's
            // run tries again — and the name is logged because a repeat needs
            // a human (an organisation cannot be left ownerless).
            failed += 1;
            logger.error('account-erasure-sweep.blocked', {
                component: 'account-erasure-sweep',
                userId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const completedAt = new Date();
    return {
        result: {
            jobName: 'account-erasure-sweep',
            jobRunId,
            success: true,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
            itemsScanned: due.length,
            itemsActioned: erased,
            itemsSkipped: failed,
            // `success: true` with a non-zero skip count is the honest shape:
            // the RUN worked, and a blocked account is the finding. A failed
            // run would retry the whole batch and re-attempt accounts that
            // already succeeded.
            details: { blockedAfterRun: failed },
        },
    };
}
