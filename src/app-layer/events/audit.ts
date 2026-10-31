import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { appendAuditEntry } from '@/lib/audit';
// Imported DIRECTLY, not through `@/lib/audit`, and that is load-bearing:
// seven unit suites `jest.mock('@/lib/audit', …)` with a partial factory that
// supplies only `appendAuditEntry`, so anything else reached through that
// barrel resolves to `undefined` and throws
// "isFailClosedAuditEntity is not a function" at the first audited write.
// This module is pure and dependency-free, so a direct import is also the
// honest shape. Do not "tidy" it back to the barrel.
import { shouldFailClosed } from '@/lib/audit/fail-closed-entities';
import { reportLostAuditRow } from '@/lib/db/before-commit';
import { validateAuditDetailsJson, type AuditDetailsJson } from '../schemas/json-columns.schemas';
import { shadowParseAuditDetails } from './audit-details-shadow';

export interface AuditEventPayload {
    action: string;
    entityType: string;
    entityId: string;
    details?: string;
    /**
     * Structured event payload — source of truth for machine-readable audit.
     *
     * Typed as `AuditDetailsJson` and NOT `Record<string, unknown>`, because
     * `validateAuditDetailsJson` below REFUSES a payload with no `category`
     * discriminator and `logEvent` is on the caller's transaction — so a
     * missing `category` is not a lint nit, it is a 400 (or, for a
     * fail-closed entity, an aborted business write). Ten live write paths
     * shipped without one: «Документи» upload / settings / purge, the Drive
     * copy and requeue, four automation-rule verbs and the SLA breach.
     *
     * The old type admitted every one of them. `.passthrough()` on the schema
     * is what keeps this usable — a bespoke domain payload may still carry
     * whatever fields it likes alongside the discriminator, so the narrowing
     * costs call sites nothing except the field they were already required to
     * send.
     */
    detailsJson?: AuditDetailsJson;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata?: Record<string, any>; // Must be safe/non-secret
}

/**
 * Centralized audit event writer.
 * Routes through appendAuditEntry() for hash-chained, per-tenant audit logging.
 *
 * NOTE: The `db` parameter is accepted for API compatibility but the actual
 * insert uses the global prisma client via appendAuditEntry() to ensure
 * advisory lock isolation. This is safe because audit inserts are idempotent
 * side-effects that don't depend on the caller's transaction state.
 */
export async function logEvent(db: PrismaTx, ctx: RequestContext, payload: AuditEventPayload): Promise<void> {
    // #1223 — `db` was `_db` and discarded: every one of the 222 call sites
    // already hands this function the caller's transaction, and it opened its
    // own anyway. For compliance-critical entities the row now goes on the
    // caller's transaction, which removes the second pool connection and makes
    // the row atomic with the write it describes. Everything else keeps the
    // best-effort behaviour, because on the caller's transaction a tolerated
    // failure would abort it — see `fail-closed-entities.ts`.
    const failClosed = shouldFailClosed(payload.entityType);
    // Sanitize metadata to avoid accidental secret leak
    const safeMetadata = payload.metadata ? JSON.parse(JSON.stringify(payload.metadata)) : undefined;

    // Build combined details for backward compat
    const standardContext = { requestId: ctx.requestId, ...safeMetadata };
    let combinedDetails = payload.details ? payload.details + '\n\n' : '';
    combinedDetails += `Context: ${JSON.stringify(standardContext)}`;

    // #2109 — report payloads the CANONICAL schema would refuse, and refuse
    // nothing. A statement rather than an expression inside the literal
    // below: the write path is `validateAuditDetailsJson`, the permissive one,
    // and nothing about that should be easy to misread.
    shadowParseAuditDetails(payload.detailsJson, payload.action, payload.entityType);

    const entry = {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'USER',
            entity: payload.entityType,
            entityId: payload.entityId,
            action: payload.action,
            details: combinedDetails,
            detailsJson: validateAuditDetailsJson(payload.detailsJson),
            requestId: ctx.requestId,
            metadataJson: safeMetadata,
    };

    // #1223 — EVERY entry now goes on the caller's transaction; only the cost
    // of a failure differs.
    //
    // FAIL-CLOSED: the error propagates and the caller's write aborts. That is
    // the point of the tier.
    //
    // BEST-EFFORT: the writer rolls the insert back to a SAVEPOINT, so the
    // transaction is usable, and the error is swallowed HERE after being
    // reported. That is a real behaviour change worth naming: before #1223 an
    // explicit `logEvent` failure propagated and failed the usecase, despite
    // the documented "best-effort, never breaks the original write" contract.
    // It now honours it — and the gap is visible, which is what #1269 added.
    try {
        await appendAuditEntry(entry, db as never, {
            onCallerTransaction: true,
            isolateFailure: !failClosed,
        });
    } catch (err) {
        if (failClosed) throw err;
        reportLostAuditRow({
            tenantId: ctx.tenantId,
            requestId: ctx.requestId,
            model: payload.entityType,
            operation: payload.action,
            error: err,
            stage: 'log-event-best-effort',
        });
    }
}
