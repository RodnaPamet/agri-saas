import { RequestContext } from '../../types';
import { PracticeRepository } from '../../repositories/PracticeRepository';
import {
    assertCanCreatePractice, assertCanUpdatePractice,
    assertCanSetApplicability,
} from '../../policies/practice.policies';
import { logEvent } from '../../events/audit';
import { notFound, forbidden, badRequest } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { computeNextDueAt } from '../../utils/cadence';
import { restoreEntity, purgeEntity } from '../soft-delete-operations';
import { assertCanAdmin } from '../../policies/common';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { emitAutomationEvent } from '../../automation';
import { assertWithinLimit } from '@/lib/billing/entitlements';
import { createAssignmentNotification } from '../../notifications/assignment';
import { logger } from '@/lib/observability/logger';

// ─── Create / Update ───

export async function createPractice(ctx: RequestContext, data: {
    code?: string | null;
    name: string;
    description?: string | null;
    category?: string | null;
    status?: string;
    frequency?: string | null;
    ownerUserId?: string | null;
    evidenceSource?: string | null;
    automationKey?: string | null;
    mitigationType?: string | null;
    intent?: string | null;
    isCustom?: boolean;
}) {
    assertCanCreatePractice(ctx);
    // GAP-18 — plan-limit gate. SaaS FREE tenants cap at 10 practices;
    // self-hosted is always unlimited (entitlements module resolves
    // ENTERPRISE when STRIPE_SECRET_KEY is unset). Throws
    // `forbidden('plan_limit_exceeded: …')` at the cap, surfacing
    // as 403 to the client.
    await assertWithinLimit(ctx, 'practice');

    const created = await runInTenantContext(ctx, async (db) => {
        // Mint a per-tenant `CTL-N` code for custom-practice creates
        // that don't supply their own code. Mirrors
        // `assetKeySequence` / `riskKeySequence` — the upsert
        // compiles to a native `INSERT … ON CONFLICT DO UPDATE`,
        // race-free under concurrent imports. Framework-installed
        // practices always carry their own `code` from the catalogue
        // and bypass this branch.
        const isCustom = data.isCustom ?? true;
        let code = data.code || null;
        if (!code && isCustom) {
            const seq = await db.practiceKeySequence.upsert({
                where: { tenantId: ctx.tenantId },
                create: { tenantId: ctx.tenantId, lastValue: 1 },
                update: { lastValue: { increment: 1 } },
            });
            code = `CTL-${seq.lastValue}`;
        }
        const practice = await PracticeRepository.create(db, ctx, {
            code,
            name: data.name,
            description: data.description || null,
            intent: data.intent || null,
            category: data.category || null,
            status: (data.status as 'NOT_STARTED') || 'NOT_STARTED',
            frequency: (data.frequency as 'MONTHLY') || null,
            ownerUserId: data.ownerUserId || null,
            createdByUserId: ctx.userId,
            evidenceSource: (data.evidenceSource as 'MANUAL') || null,
            automationKey: data.automationKey || null,
            isCustom,
        });

        await logEvent(db, ctx, {
            action: 'CONTROL_CREATED',
            entityType: 'Practice',
            entityId: practice.id,
            details: `Created practice: ${practice.code || practice.name}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Practice', operation: 'created', after: { code: practice.code, name: practice.name }, summary: `Created practice: ${practice.code || practice.name}` },
        });

        return practice;
    });
    await bumpEntityCacheVersion(ctx, 'practice');
    return created;
}

export async function updatePractice(ctx: RequestContext, id: string, data: {
    name?: string;
    description?: string | null;
    category?: string | null;
    code?: string | null;
    frequency?: string | null;
    evidenceSource?: string | null;
    automationKey?: string | null;
    mitigationType?: string | null;
    intent?: string | null;
}) {
    assertCanUpdatePractice(ctx);

    const updated = await runInTenantContext(ctx, async (db) => {
        const practice = await PracticeRepository.update(db, ctx, id, {
            ...(data.name !== undefined && { name: data.name }),
            ...(data.description !== undefined && { description: data.description }),
            ...(data.category !== undefined && { category: data.category }),
            ...(data.code !== undefined && { code: data.code }),
            ...(data.frequency !== undefined && { frequency: data.frequency as 'MONTHLY' | null }),
            ...(data.evidenceSource !== undefined && { evidenceSource: data.evidenceSource as 'MANUAL' | null }),
            ...(data.automationKey !== undefined && { automationKey: data.automationKey }),
            ...(data.mitigationType !== undefined && { mitigationType: data.mitigationType as 'PREVENTIVE' | null }),
            ...(data.intent !== undefined && { intent: data.intent }),
        });

        if (!practice) {
            const existingAny = await PracticeRepository.getById(db, ctx, id);
            if (existingAny) throw forbidden('Cannot modify global library practices');
            throw notFound('Practice not found');
        }

        await logEvent(db, ctx, {
            action: 'CONTROL_UPDATED',
            entityType: 'Practice',
            entityId: id,
            details: JSON.stringify(data),
            detailsJson: { category: 'entity_lifecycle', entityName: 'Practice', operation: 'updated', changedFields: Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined), summary: 'Practice updated' },
        });

        return practice;
    });
    await bumpEntityCacheVersion(ctx, 'practice');
    return updated;
}

// ─── Status ───

export async function setPracticeStatus(ctx: RequestContext, id: string, status: string) {
    assertCanUpdatePractice(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const existing = await PracticeRepository.getById(db, ctx, id);
        if (!existing) throw notFound('Practice not found');
        if (!existing.tenantId) throw forbidden('Cannot change status of global library practices');

        const oldStatus = existing.status;
        const practice = await PracticeRepository.update(db, ctx, id, { status: status as 'NOT_STARTED' });
        if (!practice) throw notFound('Practice not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_STATUS_CHANGED',
            entityType: 'Practice',
            entityId: id,
            details: `Status changed: ${oldStatus} → ${status}`,
            detailsJson: { category: 'status_change', entityName: 'Practice', fromStatus: oldStatus, toStatus: status },
        });
        // Domain-emit (cycle-2 follow-up) — let automation rules react to practice
        // lifecycle moves. Best-effort: a bus hiccup must not fail the write.
        await emitAutomationEvent(ctx, {
            event: 'CONTROL_STATUS_CHANGED',
            entityType: 'Practice',
            entityId: id,
            actorUserId: ctx.userId,
            data: { fromStatus: oldStatus, toStatus: status },
        }).catch(() => {});
        return practice;
    });
    await bumpEntityCacheVersion(ctx, 'practice');
    return result;
}

// ─── Applicability ───

export async function setPracticeApplicability(
    ctx: RequestContext,
    practiceId: string,
    applicability: 'APPLICABLE' | 'NOT_APPLICABLE',
    justification: string | null
) {
    assertCanSetApplicability(ctx);

    if (applicability === 'NOT_APPLICABLE' && !justification) {
        throw badRequest('Justification is required when marking a practice as NOT_APPLICABLE');
    }

    const result = await runInTenantContext(ctx, async (db) => {
        const existing = await PracticeRepository.getById(db, ctx, practiceId);
        if (!existing) throw notFound('Practice not found');
        if (!existing.tenantId) throw forbidden('Cannot change applicability of global library practices');

        const oldApplicability = existing.applicability;
        const updated = await PracticeRepository.setApplicability(db, ctx, practiceId, applicability, justification);
        if (!updated) throw notFound('Practice not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_APPLICABILITY_CHANGED',
            entityType: 'Practice',
            entityId: practiceId,
            details: `Applicability changed: ${oldApplicability} → ${applicability}`,
            detailsJson: { category: 'status_change', entityName: 'Practice', fromStatus: oldApplicability || 'APPLICABLE', toStatus: applicability, reason: justification || undefined },
            metadata: { oldApplicability, newApplicability: applicability, justification },
        });

        return updated;
    });
    await bumpEntityCacheVersion(ctx, 'practice');
    return result;
}

// ─── Owner ───

export async function setPracticeOwner(ctx: RequestContext, id: string, ownerUserId: string | null) {
    assertCanUpdatePractice(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        // Validate the user exists before updating
        if (ownerUserId) {
            const userExists = await db.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT id FROM "User" WHERE id = $1 LIMIT 1`, ownerUserId
            );
            if (!userExists || userExists.length === 0) {
                throw badRequest(`User "${ownerUserId}" not found. Please enter a valid user ID.`);
            }
        }
        const practice = await PracticeRepository.setOwner(db, ctx, id, ownerUserId);
        if (!practice) throw notFound('Practice not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_OWNER_CHANGED',
            entityType: 'Practice',
            entityId: id,
            details: `Owner set to: ${ownerUserId || 'none'}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Practice', operation: 'updated', changedFields: ['ownerUserId'], after: { ownerUserId }, summary: `Owner set to: ${ownerUserId || 'none'}` },
        });
        return practice;
    });
    await bumpEntityCacheVersion(ctx, 'practice');

    // PR-A 2026-05-27 — in-app CONTROL_ASSIGNED bell notification
    // for the new owner. Pre-PR-A the ownership transfer wrote
    // only an audit row; the new owner had no in-product alert.
    //
    // Runs AFTER the parent transaction commits, in its own short
    // `runInTenantContext` — a notification write must never roll
    // back the ownership change. Idempotent via the
    // `(tenantId, CONTROL_ASSIGNED, practiceId, userId, date)`
    // dedupeKey so rapid re-assigns within one day collapse to a
    // single bell entry. Fire-and-forget — logged + swallowed on
    // failure, never surfaces to the caller.
    if (ownerUserId && ctx.tenantSlug) {
        const tenantSlug = ctx.tenantSlug;
        try {
            await runInTenantContext(ctx, (db) =>
                createAssignmentNotification(db, 'CONTROL_ASSIGNED', {
                    tenantId: ctx.tenantId,
                    assigneeUserId: ownerUserId,
                    entityId: id,
                    entityLabel: result.name ?? '(untitled)',
                    entityKey: result.code ?? null,
                    tenantSlug,
                }),
            );
        } catch (err) {
            logger.warn('failed to create practice-assigned notification', {
                component: 'notifications',
                practiceId: id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return result;
}

// ─── Cadence: Mark Test Completed ───

export async function markPracticeTestCompleted(ctx: RequestContext, practiceId: string) {
    assertCanUpdatePractice(ctx);

    const result = await runInTenantContext(ctx, async (db) => {
        const existing = await PracticeRepository.getById(db, ctx, practiceId);
        if (!existing) throw notFound('Practice not found');
        if (!existing.tenantId) throw forbidden('Cannot modify global library practices');
        if (existing.applicability === 'NOT_APPLICABLE') {
            throw badRequest('Cannot mark test completed for NOT_APPLICABLE practices');
        }

        const now = new Date();
        const nextDue = computeNextDueAt(existing.frequency, now);

        const updated = await PracticeRepository.update(db, ctx, practiceId, {
            nextDueAt: nextDue,
        });

        await logEvent(db, ctx, {
            action: 'CONTROL_TEST_COMPLETED',
            entityType: 'Practice',
            entityId: practiceId,
            details: `Test completed. Next due: ${nextDue ? nextDue.toISOString().slice(0, 10) : 'N/A (ad hoc)'}`,
            detailsJson: { category: 'custom', event: 'test_completed', lastTested: now.toISOString(), nextDueAt: nextDue?.toISOString() ?? null },
            metadata: { lastTested: now.toISOString(), nextDueAt: nextDue?.toISOString() ?? null },
        });

        return updated;
    });
    await bumpEntityCacheVersion(ctx, 'practice');
    return result;
}

// ─── Soft Delete / Restore / Purge ───

export async function deletePractice(ctx: RequestContext, id: string) {
    assertCanAdmin(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const practice = await PracticeRepository.getById(db, ctx, id);
        if (!practice) throw notFound('Practice not found');
        if (!practice.tenantId) throw forbidden('Cannot delete global library practices');

        await db.practice.delete({ where: { id } });

        await logEvent(db, ctx, {
            action: 'SOFT_DELETE',
            entityType: 'Practice',
            entityId: id,
            details: `Practice soft-deleted: ${practice.code || practice.name}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Practice', operation: 'deleted', summary: `Practice soft-deleted: ${practice.code || practice.name}` },
        });
        return { success: true };
    });
    await bumpEntityCacheVersion(ctx, 'practice');
    return result;
}

/**
 * Bulk soft-delete practices — the practices table selection action-row.
 * Mirrors {@link deletePractice}: ADMIN-gated, soft-delete (Practice ∈
 * SOFT_DELETE_MODELS). The `tenantId: ctx.tenantId` filter both scopes to the
 * tenant AND excludes global library practices (null tenantId) — so they can
 * never be bulk-deleted, matching the single-delete's guard. Idempotent.
 */
export async function bulkDeletePractice(
    ctx: RequestContext,
    practiceIds: string[],
): Promise<{ deleted: number }> {
    assertCanAdmin(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const rows = await db.practice.findMany({
            where: { id: { in: practiceIds }, tenantId: ctx.tenantId },
            select: { id: true, code: true, name: true },
        });
        if (rows.length === 0) return { deleted: 0 };

        await db.practice.deleteMany({
            where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId },
        });

        for (const c of rows) {
            await logEvent(db, ctx, {
                action: 'SOFT_DELETE',
                entityType: 'Practice',
                entityId: c.id,
                details: `Practice soft-deleted (bulk): ${c.code || c.name}`,
                detailsJson: { category: 'entity_lifecycle', entityName: 'Practice', operation: 'deleted', summary: `Practice soft-deleted: ${c.code || c.name}` },
            });
        }
        return { deleted: rows.length };
    });
    await bumpEntityCacheVersion(ctx, 'practice');
    return result;
}

export async function restorePractice(ctx: RequestContext, id: string) {
    const result = await restoreEntity(ctx, 'Practice', id);
    await bumpEntityCacheVersion(ctx, 'practice');
    return result;
}

export async function purgePractice(ctx: RequestContext, id: string) {
    const result = await purgeEntity(ctx, 'Practice', id);
    await bumpEntityCacheVersion(ctx, 'practice');
    return result;
}
