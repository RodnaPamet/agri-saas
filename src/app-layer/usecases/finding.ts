import { RequestContext } from '../types';
import { FindingRepository } from '../repositories/FindingRepository';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { runInTenantContext, PrismaTx } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { FindingSeverity, FindingType, FindingStatus } from '@prisma/client';
import { z } from 'zod';
import { CreateFindingSchema, UpdateFindingSchema } from '@/lib/schemas';

/**
 * Validate that every referenced entity (assignee, control, compensating
 * control) belongs to the caller's tenant. Throws `badRequest` on any
 * miss — RLS already prevents cross-tenant WRITES, but this turns a
 * silent no-op into a clear 400 and stops a finding pointing at a
 * foreign id.
 */
async function validateFindingRefs(
    db: PrismaTx,
    ctx: RequestContext,
    refs: {
        assigneeUserId?: string | null;
        controlId?: string | null;
        compensatingControlId?: string | null;
    },
): Promise<void> {
    const { assigneeUserId, controlId, compensatingControlId } = refs;

    if (assigneeUserId) {
        const member = await db.tenantMembership.findFirst({
            where: { userId: assigneeUserId, tenantId: ctx.tenantId, status: 'ACTIVE' },
            select: { id: true },
        });
        if (!member) throw badRequest('INVALID_ASSIGNEE', 'Assignee is not an active member of this tenant');
    }

    // Validate both control refs in a single query (no N+1).
    const controlIds = [controlId, compensatingControlId].filter(
        (x): x is string => Boolean(x),
    );
    if (controlIds.length > 0) {
        const found = await db.control.findMany({
            where: { id: { in: [...new Set(controlIds)] }, tenantId: ctx.tenantId },
            select: { id: true },
        });
        const foundIds = new Set(found.map((c) => c.id));
        if (controlId && !foundIds.has(controlId)) {
            throw badRequest('INVALID_CONTROL', 'Linked control not found or belongs to a different tenant');
        }
        if (compensatingControlId && !foundIds.has(compensatingControlId)) {
            throw badRequest(
                'INVALID_COMPENSATING_CONTROL',
                'Compensating control not found or belongs to a different tenant',
            );
        }
    }
}

// Epic D.2 — sanitise optional free-text on UPDATE without disturbing
// the three-state contract: undefined → don't touch, null → SET NULL,
// string → sanitise + SET. The shared `sanitizePlainText` helper
// returns '' for null/undefined inputs, which would silently turn an
// "untouched" column into an empty-string write — hence this guard.
function sanitizeOptional(v: string | null | undefined): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return sanitizePlainText(v);
}

export async function listFindings(
    ctx: RequestContext,
    options: { take?: number } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        FindingRepository.list(db, ctx, options)
    );
}

export async function getFinding(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const finding = await FindingRepository.getById(db, ctx, id);
        if (!finding) throw notFound('Finding not found');
        return finding;
    });
}

export async function createFinding(ctx: RequestContext, data: z.infer<typeof CreateFindingSchema>) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        await validateFindingRefs(db, ctx, {
            assigneeUserId: data.assigneeUserId,
            controlId: data.controlId,
            compensatingControlId: data.compensatingControlId,
        });

        const finding = await FindingRepository.create(db, ctx, {
            auditId: data.auditId || null,
            severity: data.severity as FindingSeverity,
            type: data.type as FindingType,
            // Epic D.2 — sanitise free-text before persistence. Encryption
            // protects confidentiality at rest; sanitisation protects
            // every downstream renderer (UI, PDF, audit-pack, SDK) that
            // reads the row verbatim.
            title: sanitizePlainText(data.title),
            description: data.description ? sanitizePlainText(data.description) : '',
            rootCause: data.rootCause ? sanitizePlainText(data.rootCause) : data.rootCause,
            correctiveAction: data.correctiveAction
                ? sanitizePlainText(data.correctiveAction)
                : data.correctiveAction,
            analysis: data.analysis ? sanitizePlainText(data.analysis) : data.analysis,
            owner: data.owner ? sanitizePlainText(data.owner) : data.owner,
            assigneeUserId: data.assigneeUserId || null,
            controlId: data.controlId || null,
            compensatingControlId: data.compensatingControlId || null,
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            status: 'OPEN',
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Finding',
            entityId: finding.id,
            details: `Created finding: ${finding.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Finding',
                operation: 'created',
                after: { title: finding.title, severity: data.severity, type: data.type },
                summary: `Created finding: ${finding.title}`,
            },
        });

        return finding;
    });
}

export async function updateFinding(ctx: RequestContext, id: string, data: z.infer<typeof UpdateFindingSchema>) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const oldFinding = await FindingRepository.getById(db, ctx, id);
        if (!oldFinding) throw notFound('Finding not found');

        await validateFindingRefs(db, ctx, {
            assigneeUserId: data.assigneeUserId,
            controlId: data.controlId,
            compensatingControlId: data.compensatingControlId,
        });

        const finding = await FindingRepository.update(db, ctx, id, {
            severity: data.severity as FindingSeverity | undefined,
            type: data.type as FindingType | undefined,
            // Epic D.2 — sanitise on update only when the field is
            // actually being written (preserves "don't touch" semantics).
            title: sanitizeOptional(data.title) ?? undefined,
            description: sanitizeOptional(data.description) ?? undefined,
            rootCause: sanitizeOptional(data.rootCause) ?? undefined,
            correctiveAction: sanitizeOptional(data.correctiveAction) ?? undefined,
            analysis: sanitizeOptional(data.analysis) ?? undefined,
            owner: sanitizeOptional(data.owner) ?? undefined,
            // Three-state for the relation FKs: undefined → don't touch,
            // null → clear, string → set.
            assigneeUserId: data.assigneeUserId === undefined ? undefined : data.assigneeUserId,
            controlId: data.controlId === undefined ? undefined : data.controlId,
            compensatingControlId:
                data.compensatingControlId === undefined ? undefined : data.compensatingControlId,
            dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
            status: data.status as FindingStatus | undefined,
            verificationNotes: sanitizeOptional(data.verificationNotes) ?? undefined,
            verifiedBy: data.status === 'CLOSED' ? ctx.userId : undefined,
            verifiedAt: data.status === 'CLOSED' ? new Date() : undefined,
        });

        if (!finding) throw notFound('Finding not found');

        if (data.status && data.status !== oldFinding.status) {
            await logEvent(db, ctx, {
                action: 'STATUS_CHANGE',
                entityType: 'Finding',
                entityId: id,
                details: `${oldFinding.status} → ${data.status}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Finding',
                    fromStatus: oldFinding.status,
                    toStatus: data.status,
                    reason: data.verificationNotes || undefined,
                },
            });
        } else {
            await logEvent(db, ctx, {
                action: 'UPDATE',
                entityType: 'Finding',
                entityId: id,
                details: `Finding updated`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Finding',
                    operation: 'updated',
                    changedFields: Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined),
                    after: { title: data.title, severity: data.severity, owner: data.owner },
                    summary: 'Finding updated',
                },
            });
        }

        return finding;
    });
}

/**
 * Bulk soft-delete findings — the findings table selection action-row's
 * "Delete selected". ADMIN-gated, tenant-scoped, one audit row per deleted
 * finding. `Finding` is a soft-delete model, so `deleteMany` sets
 * `deletedAt`; the `findMany` auto-filters already-deleted rows, so a
 * re-submit is idempotent. Returns the count actually deleted.
 */
export async function bulkDeleteFinding(
    ctx: RequestContext,
    findingIds: string[],
): Promise<{ deleted: number }> {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const rows = await db.finding.findMany({
            where: { id: { in: findingIds }, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (rows.length === 0) return { deleted: 0 };

        await db.finding.deleteMany({
            where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId },
        });

        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'SOFT_DELETE',
                entityType: 'Finding',
                entityId: r.id,
                details: 'Finding soft-deleted (bulk)',
                detailsJson: { category: 'entity_lifecycle', entityName: 'Finding', operation: 'deleted', summary: 'SOFT_DELETE' },
            });
        }

        return { deleted: rows.length };
    });
}
