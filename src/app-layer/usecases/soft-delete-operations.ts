/**
 * Shared Soft-Delete Operations Module
 *
 * Provides generic restoreEntity, purgeEntity functions for all soft-deletable models.
 * Avoids duplication across entity-specific usecase files.
 */
import { RequestContext } from '../types';
import { purgeEvidenceBytes } from './evidence-bytes';
import { assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { withDeleted } from '@/lib/soft-delete';
import {
    getRestoreValidator,
    type RestorableModel,
} from '../domain/restore-validators';

/** Minimal delegate interface for dynamic model access by string key */
interface ModelDelegate {
    findFirst(args: object): Promise<{ id: string; tenantId: string; deletedAt: Date | null } | null>;
    update(args: object): Promise<unknown>;
}

type SoftDeletableModel =
    | 'Asset' | 'Risk' | 'Practice' | 'Evidence' | 'Policy'
    | 'Vendor' | 'FileRecord' | 'Task' | 'Finding'
    | 'Audit' | 'AuditCycle' | 'AuditPack';

/**
 * Restore a soft-deleted entity (set deletedAt = null).
 * ADMIN only.
 */
export async function restoreEntity(
    ctx: RequestContext,
    model: SoftDeletableModel,
    id: string,
) {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        // We need to find the record including deleted ones
        const delegate = (db as unknown as Record<string, ModelDelegate>)[model.charAt(0).toLowerCase() + model.slice(1)];

        // Find the record (including deleted, using withDeleted pattern)
        const record = await delegate.findFirst(withDeleted({
            where: { id, tenantId: ctx.tenantId },
        }));
        if (!record) throw notFound(`${model} not found`);
        if (!record.deletedAt) throw notFound(`${model} is not deleted`);

        // Audit Coherence S10 (2026-05-24) — entity-specific
        // precondition gate. Refuses restore that would create an
        // orphan (parent deleted) or violate an immutability
        // contract (e.g. AuditPack under a CLOSED cycle).
        const validator = getRestoreValidator(model as RestorableModel);
        await validator(ctx, db, record);

        // Restore: set deletedAt and deletedByUserId to null
        const restored = await delegate.update({
            where: { id },
            data: { deletedAt: null, deletedByUserId: null },
        });

        await logEvent(db, ctx, {
            action: 'ENTITY_RESTORED',
            entityType: model,
            entityId: id,
            details: `${model} restored from soft-delete`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: model,
                operation: 'restored',
                before: { deletedAt: record.deletedAt.toISOString() },
                summary: `${model} restored from soft-delete`,
            },
            metadata: { previousDeletedAt: record.deletedAt },
        });

        return restored;
    });
}

/**
 * Permanently purge a soft-deleted entity (hard delete).
 * ADMIN only. Record must already be soft-deleted before purge.
 */
export async function purgeEntity(
    ctx: RequestContext,
    model: SoftDeletableModel,
    id: string,
) {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const delegate = (db as unknown as Record<string, ModelDelegate>)[model.charAt(0).toLowerCase() + model.slice(1)];

        // Find the record (including deleted)
        const record = await delegate.findFirst(withDeleted({
            where: { id, tenantId: ctx.tenantId },
        }));
        if (!record) throw notFound(`${model} not found`);
        if (!record.deletedAt) {
            throw notFound(`${model} must be soft-deleted before purging`);
        }

        // Evidence carries BYTES. Release the stored object before the row —
        // deleting the row first loses the only pointer to the file, leaving
        // it readable on disk while the product reports it purged.
        if (model === 'Evidence') {
            await purgeEvidenceBytes(db, ctx.tenantId, [id]);
        }

        // Hard delete: use $executeRawUnsafe to bypass the soft-delete middleware
        await db.$executeRawUnsafe(
            `DELETE FROM "${model}" WHERE "id" = $1 AND "tenantId" = $2`,
            id,
            ctx.tenantId,
        );

        await logEvent(db, ctx, {
            action: 'ENTITY_PURGED',
            entityType: model,
            entityId: id,
            details: `${model} permanently purged`,
            detailsJson: {
                category: 'data_lifecycle',
                operation: 'purged',
                model,
                reason: 'Manual purge via admin action',
            },
        });

        return { success: true, purged: true };
    });
}
