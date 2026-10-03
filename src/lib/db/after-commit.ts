/**
 * Side effects that must not happen until the OUTERMOST transaction commits.
 *
 * ## The defect this exists for
 *
 * `notifyOtherParty` (exchange-messaging.ts) wrote bell rows, published SSE
 * events and enqueued mail from INSIDE the sender's still-open
 * `runInTenantContext`. Three consequences, all measured rather than inferred:
 *
 *   1. **It notified about writes that did not happen.** The bell rows and the
 *      outbox row were written in a DIFFERENT transaction (a nested
 *      `withTenantDb` on the same client is an independent transaction, not a
 *      savepoint), so they COMMITTED while the sender's transaction was still
 *      open. A sender transaction that then rolled back left the other party
 *      a notification, an SSE push and an email for a message that does not
 *      exist. The publish is worse than the row: it is unrecallable.
 *
 *   2. **It held two connections per send.** Production pgbouncer runs
 *      `pool_mode = transaction` with `default_pool_size = 25`
 *      (`deploy/docker-compose.vm.yml`), so a server connection is bound for
 *      the whole of a transaction. A notify nested inside the sender's
 *      transaction needs a SECOND pool client while holding the first, and a
 *      transaction holding one of `max` while waiting for another cannot make
 *      progress. Measured 2026-10-01 on the two OTHER in-transaction users of a
 *      second connection — `encryption-middleware`'s cold-tenant DEK read and
 *      `appendAuditEntry`'s own `$transaction` — the cliff is exactly at `max`:
 *      11 concurrent succeed, 12 all fail. It surfaces as P2028 (transaction
 *      already closed, or unable to start one in time), never as anything
 *      naming a pool, which is why it reads as a Prisma bug. See
 *      `docs/implementation-notes/2026-10-01-p0-8-after-commit-notifications.md`.
 *
 *   3. **It made the notification latency part of the transaction's
 *      lifetime**, against a 5s default timeout.
 *
 * ## Why a collector and not "just move the call after the closure"
 *
 * Because the caller does not know whether it is the outermost transaction.
 * `runInTenantContext` IS a `$transaction`, usecases call usecases, and a
 * helper that moved its own notify one level out would still be inside
 * somebody else's. "After the commit" is only well defined at the OUTERMOST
 * boundary, so that is where the drain lives and the queue is addressed by
 * async context rather than by argument.
 *
 * ## Why AsyncLocalStorage, and a note on where this reasoning should have gone
 *
 * A module-level stack is actively WRONG for this job: under concurrent
 * requests the top of a shared stack is whichever request pushed last, so
 * effects would drain against another request's transaction. Not theoretical —
 * the hardening test for this change runs eleven sends at once.
 *
 * This paragraph used to justify the choice by CONTRAST, saying
 * `audit-context.ts` documented its own reason for a stack: that Prisma's
 * query extensions run in a detached async context which loses ALS. Two things
 * about that are worth keeping:
 *
 *   - **The premise was false by Prisma 7.** `$use` was removed, the live path
 *     is an async `$extends({ query })` handler, and such a handler DOES see
 *     the ALS store — measured by
 *     `tests/integration/prisma-extension-als-reachability.test.ts`.
 *   - **The argument above applies verbatim to audit-context, and nobody
 *     carried it across.** "The top of a shared stack is whichever request
 *     pushed last" is exactly #1259: that context picks the per-tenant DEK, so
 *     7 of 8 concurrent writes were encrypted under the wrong tenant's key.
 *     The correct analysis was sitting in this file the whole time.
 *
 * `audit-context.ts` is ALS now too, so there is no contrast left to draw.
 *
 * ## What a rollback does
 *
 * Discards the queue. Nothing fires. That is the entire point, and it is why a
 * failed effect must never be allowed to look like a failed transaction (see
 * `drain`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@/lib/observability/logger';

interface QueuedEffect {
    /** Names the effect in logs. A failed effect is otherwise anonymous. */
    name: string;
    run: () => Promise<unknown> | unknown;
}

interface AfterCommitScope {
    /**
     * How many transaction frames are open on top of this scope. Only the
     * frame that CREATED the scope drains it, so this is diagnostic — but it
     * is the thing that makes "am I nested?" answerable in a test.
     */
    depth: number;
    queue: QueuedEffect[];
}

const scopeStorage = new AsyncLocalStorage<AfterCommitScope>();

/**
 * Queue `effect` to run after the OUTERMOST open transaction commits.
 *
 * With no transaction open, "after the commit" is NOW: the effect runs
 * immediately. That is deliberate rather than a throw — `afterCommit` is
 * called from usecase code that may or may not have been entered through a
 * transaction helper, and a helper that crashed on the non-transactional path
 * would push callers back to calling the side effect inline, which is the
 * defect. Either way the effect's own errors are contained: see `runEffect`.
 *
 * Returns nothing on purpose. A caller that awaited this would be back to
 * paying the side effect's latency inside the transaction.
 */
export function afterCommit(name: string, run: () => Promise<unknown> | unknown): void {
    const scope = scopeStorage.getStore();
    if (!scope) {
        // No transaction frame is open. Fire now, and do not leave an
        // unhandled rejection behind — `runEffect` never rejects.
        void runEffect({ name, run });
        return;
    }
    scope.queue.push({ name, run });
}

/**
 * Establish (or join) an after-commit scope around a transaction.
 *
 * The OUTERMOST call owns the scope and drains it once `body` has resolved —
 * which, for the transaction helpers in `db-context.ts`, is after COMMIT. A
 * nested call just runs `body`: its queued effects belong to the outermost
 * scope and fire with it. If `body` rejects, the queue is dropped unrun.
 *
 * Note what "outermost" means here. Prisma does not nest transactions: a
 * `$transaction` started inside another one on the same client is an
 * INDEPENDENT transaction on its own connection. So an inner transaction can
 * commit while the outer one later rolls back, and its queued effects will
 * still NOT fire. That asymmetry is the conservative direction and it is
 * chosen: an effect that announces work is safe to skip and unsafe to send.
 */
export async function runWithAfterCommit<T>(body: () => Promise<T>): Promise<T> {
    const existing = scopeStorage.getStore();
    if (existing) {
        existing.depth += 1;
        try {
            return await body();
        } finally {
            existing.depth -= 1;
        }
    }

    const scope: AfterCommitScope = { depth: 1, queue: [] };
    let result: T;
    try {
        result = await scopeStorage.run(scope, body);
    } catch (err) {
        // ROLLBACK (or a thrown callback). Drop every queued effect — this is
        // the branch the whole module exists for.
        const dropped = scope.queue.length;
        scope.queue.length = 0;
        if (dropped > 0) {
            logger.info('after_commit.discarded_on_rollback', {
                component: 'after-commit',
                dropped,
            });
        }
        throw err;
    }
    // Outside the ALS scope by now: the `await` above resumed in the parent
    // context, so an effect that itself opens a transaction gets a FRESH
    // scope instead of appending to a queue nobody will drain again.
    await drain(scope);
    return result;
}

/**
 * True when a transaction frame established by `runWithAfterCommit` is open.
 * Exposed so a caller can assert its own placement rather than assume it.
 */
export function isInsideTransaction(): boolean {
    return scopeStorage.getStore() !== undefined;
}

/** How many effects are waiting on the current scope's commit. 0 with no scope. */
export function pendingAfterCommitCount(): number {
    return scopeStorage.getStore()?.queue.length ?? 0;
}

/**
 * Run the queue in the order it was built, one at a time.
 *
 * SEQUENTIAL deliberately. Ordering is observable (the bell row before the
 * email that references it) and a `Promise.all` here would open one pool
 * client per effect — multiplying the connection cost this change exists to
 * remove.
 *
 * `splice` rather than iterate: an effect that queues another effect during
 * the drain must not mutate the array being walked.
 */
async function drain(scope: AfterCommitScope): Promise<void> {
    const queued = scope.queue.splice(0, scope.queue.length);
    for (const effect of queued) {
        await runEffect(effect);
    }
}

/**
 * Never rejects.
 *
 * The transaction has COMMITTED by the time an effect runs, so there is
 * nothing left to undo and nothing useful a caller could do with the error.
 * Letting it propagate would turn a delivered write into a 500 for the user
 * who made it — and, worse, would skip every effect queued after it.
 */
async function runEffect(effect: QueuedEffect): Promise<void> {
    try {
        await effect.run();
    } catch (err) {
        logger.warn('after_commit.effect_failed', {
            component: 'after-commit',
            effect: effect.name,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
