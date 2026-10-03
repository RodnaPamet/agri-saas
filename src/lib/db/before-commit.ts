/**
 * Audit rows written on the CALLER'S transaction, collected before COMMIT.
 *
 * ## The defect this exists for (#1223)
 *
 * `appendAuditEntry` opens its own `$transaction` on the global client, so an
 * audited write needs a SECOND pool connection. At `PG_POOL_MAX` it cannot get
 * one and the row is lost while the business write commits. Measured at
 * exactly `max`: 12 writes, 11 audit rows — all of them `actorType: SYSTEM`,
 * i.e. the ones the Prisma audit EXTENSION writes.
 *
 * #1271 fixed the compliance-critical half by routing `logEvent` onto the
 * caller's transaction, which it already received and discarded. That could not
 * reach the extension: a `$extends({ query })` handler is given `model`,
 * `operation`, `args` and `query` — never the transaction client. So the path
 * that actually loses rows had no way to write on the open transaction.
 *
 * ## The shape, and why it mirrors `after-commit.ts`
 *
 * The extension ENQUEUES its audit payload into an AsyncLocalStorage-scoped
 * queue; the transaction helpers in `db-context.ts` — which DO hold `tx` —
 * drain it onto that transaction after the callback body and before COMMIT.
 * It is the exact mirror of `afterCommit`, which drains AFTER commit, and the
 * same reasoning applies to the store: the top of a module-level stack under
 * concurrent requests is whichever request pushed last, so a shared queue
 * would drain one request's audit rows into another's transaction. That is
 * #1259, and it is why this is ALS and not an array. (#1275 made
 * `audit-context.ts` ALS for the same reason; this module was only buildable
 * cleanly afterwards.)
 *
 * ## Three consequences, all deliberate
 *
 *   - **No second connection, at either tier.** The deadlock goes for every
 *     audited write, not just the seventeen fail-closed entities.
 *   - **Audit rows are now ATOMIC with the write they describe.** A rolled-back
 *     write no longer leaves a row asserting it happened — which it did before,
 *     and which is the wrong direction for a tamper-evident chain. #1271's
 *     assertion that a best-effort row SURVIVES a rollback is updated in the
 *     same change, because it pinned the old behaviour.
 *   - **One advisory lock per transaction instead of one per row.**
 *     `pg_advisory_xact_lock(hashtext(tenantId))` is transaction-scoped, so a
 *     batch of queued entries flushed together acquires it once.
 *
 * ## Why the flush is sequential
 *
 * The chain reads the previous entry's `entryHash` to compute the next, so
 * order is the content. Savepoints also do not nest in parallel on one
 * connection. A `Promise.all` here would corrupt the chain and the savepoints
 * at once.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from '@/lib/observability/logger';
import { recordAuditWriteFailure } from '@/lib/observability/metrics';

/** One queued chain append. `input` is the writer's `AppendAuditInput`. */
export interface PendingAudit {
    input: Record<string, unknown>;
    /** Fail-closed entries abort the caller's write; best-effort are isolated. */
    failClosed: boolean;
    /** Carried for the loss report, so a gap names what it was. */
    model: string;
    operation: string;
}

interface AuditQueueScope {
    queue: PendingAudit[];
}

/** The minimum of a transaction client this module hands to the writer. */
type TxClient = {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

const scopeStorage = new AsyncLocalStorage<AuditQueueScope>();

/**
 * Establish a queue for `body` and, if this frame OWNS it, drain it onto `tx`
 * before returning.
 *
 * The scope and the drain are deliberately the same call. A NESTED frame joins
 * the outer scope and does NOT drain, because "before the commit" is only well
 * defined at the outermost transaction — exactly as `runWithAfterCommit` does
 * it. `runInTenantContext` IS a `$transaction` and usecases call usecases, so
 * an inner frame that drained would write the OUTER transaction's queued rows
 * onto its own `tx`. Splitting this into "open a scope" and "flush it" is what
 * made that bug available, so the two are one function.
 *
 * A body that THROWS is not drained. The caller's transaction is about to roll
 * back and the rows describe writes that will not exist — the same reason
 * `after-commit.ts` discards its queue on rollback.
 */
export async function runWithAuditQueue<T>(tx: TxClient, body: () => Promise<T>): Promise<T> {
    if (scopeStorage.getStore()) return body();
    const scope: AuditQueueScope = { queue: [] };
    const result = await scopeStorage.run(scope, body);
    await drain(scope, tx);
    return result;
}

/**
 * Queue a chain append for the open transaction.
 *
 * Returns false when there is NO scope, and the caller must then fall back to
 * its own transaction — a Prisma write outside `withTenantDb` /
 * `runInTenantContext` is legitimate (jobs, scripts, the staging seed) and
 * must still be audited. Returning false rather than throwing is what keeps
 * those paths working.
 */
export function enqueueAuditEntry(entry: PendingAudit): boolean {
    const scope = scopeStorage.getStore();
    if (!scope) return false;
    scope.queue.push(entry);
    return true;
}

/** Queued-but-unflushed count. Diagnostic; used by the tests. */
export function pendingAuditCount(): number {
    return scopeStorage.getStore()?.queue.length ?? 0;
}

/** Is there an open queue — i.e. are we inside a collected transaction? */
export function isInsideAuditQueue(): boolean {
    return scopeStorage.getStore() !== undefined;
}

/**
 * Write every queued entry on `tx`, in order, before the caller commits.
 *
 * Private: only `runWithAuditQueue` may call this, and only for a scope it
 * owns. The queue is DRAINED by splice before writing, so a re-entrant drain
 * cannot write the same row twice — the same reason `after-commit.ts` walks a
 * copy.
 *
 * A fail-closed entry that throws is rethrown: aborting the caller's write is
 * the point of that tier. A best-effort entry is already rolled back to its
 * savepoint by the writer, so the transaction is usable and the loss is
 * REPORTED here rather than swallowed — the log line and counter #1269 added
 * live at the write, and the write moved.
 */
async function drain(scope: AuditQueueScope, tx: TxClient): Promise<void> {
    if (scope.queue.length === 0) return;
    const pending = scope.queue.splice(0, scope.queue.length);

    // Lazy require: `audit-writer` reaches `@/lib/prisma`, which imports this
    // module. The cycle is already documented in audit-writer's ARCHITECTURE
    // NOTE and this is the convention it established.
    const { appendAuditEntry } = require('../audit/audit-writer') as {
        appendAuditEntry: (
            input: unknown,
            client?: unknown,
            opts?: { onCallerTransaction?: boolean; isolateFailure?: boolean },
        ) => Promise<unknown>;
    };

    for (const entry of pending) {
        try {
            await appendAuditEntry(entry.input, tx, {
                onCallerTransaction: true,
                isolateFailure: !entry.failClosed,
            });
        } catch (err) {
            if (entry.failClosed) throw err;
            // Best-effort: the savepoint restored the transaction. Report the
            // gap with the same event name and metric #1269 established, so
            // anything watching either keeps working after the write moved.
            reportLostAuditRow({
                tenantId: entry.input.tenantId,
                requestId: entry.input.requestId,
                model: entry.model,
                operation: entry.operation,
                error: err,
                stage: 'before-commit-drain',
            });
        }
    }
}

/**
 * Report a hash-chained audit row that was not written.
 *
 * Shared, because the report has to follow the write and the write now happens
 * in three places: the extension's own-transaction fallback (#1269's catch in
 * `prisma.ts`), this drain, and `logEvent`'s best-effort path. One event name
 * and one metric across all three, or anything watching either breaks the day
 * a write moves.
 *
 * Nothing here may throw: a failure to REPORT a lost row must not become a
 * failure of a write that is about to commit. Each reporter is guarded
 * separately so a broken logger does not also cost the metric.
 */
export function reportLostAuditRow(ctx: {
    tenantId?: unknown;
    requestId?: unknown;
    model: string;
    operation: string;
    error: unknown;
    stage: string;
}): void {
    try {
        logger.error('audit.write_failed', {
            // Deliberately the SAME component and event name #1269
            // established. The write moved; the signal a human or an alert
            // watches must not. `stage` says where it failed without
            // splitting the identity.
            component: 'audit-middleware',
            stage: ctx.stage,
            tenantId: ctx.tenantId,
            requestId: ctx.requestId,
            model: ctx.model,
            operation: ctx.operation,
            error: ctx.error instanceof Error ? ctx.error.message : String(ctx.error),
        });
    } catch {
        // A broken logger must not break a write that is about to commit.
    }
    try {
        recordAuditWriteFailure({ model: ctx.model, action: ctx.operation.toUpperCase() });
    } catch {
        // A broken meter must not break a write that is about to commit.
    }
}
