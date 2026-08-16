import { RequestContext } from '../types';
import { AssetMaintenanceRepository } from '../repositories/AssetMaintenanceRepository';
import { AssetRepository } from '../repositories/AssetRepository';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { AssetMaintenanceKind } from '@prisma/client';

/**
 * Maintenance records for a machine.
 *
 * `AssetStatus.IN_MAINTENANCE` was a status with nothing behind it — no
 * record of what was done, when, at what meter reading, or what it cost.
 * These usecases are that record.
 *
 * Two status couplings, both deliberately ADVISORY rather than
 * automatic — the caller decides, we only report what is now true:
 *
 *   - Opening a record on an ACTIVE asset returns
 *     `suggestStatus: 'IN_MAINTENANCE'`.
 *   - Closing the LAST open record returns `suggestStatus: 'ACTIVE'`.
 *
 * Silently flipping an asset's status as a side effect of logging an
 * oil change would surprise an operator who is recording history after
 * the fact; the UI prompts instead.
 */

/** Free text that will be decrypted and re-rendered downstream. */
function clean(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return sanitizePlainText(value);
}

export interface CreateMaintenanceInput {
    kind: AssetMaintenanceKind;
    openedAt?: Date | string | null;
    closedAt?: Date | string | null;
    meterAtService?: number | null;
    description?: string | null;
    cost?: number | null;
    nextDueAt?: Date | string | null;
    nextDueMeter?: number | null;
}

function toDate(value: Date | string | null | undefined): Date | null | undefined {
    if (value === undefined) return undefined;
    if (!value) return null;
    return value instanceof Date ? value : new Date(value);
}

export async function listAssetMaintenance(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const asset = await AssetRepository.getById(db, ctx, assetId);
        if (!asset) throw notFound('Asset not found');
        return AssetMaintenanceRepository.listForAsset(db, ctx, assetId);
    });
}

export async function createAssetMaintenance(
    ctx: RequestContext,
    assetId: string,
    input: CreateMaintenanceInput,
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const asset = await AssetRepository.getById(db, ctx, assetId);
        if (!asset) throw notFound('Asset not found');

        const record = await AssetMaintenanceRepository.create(db, ctx, {
            assetId,
            kind: input.kind,
            openedAt: toDate(input.openedAt) ?? new Date(),
            closedAt: toDate(input.closedAt) ?? null,
            meterAtService: input.meterAtService ?? null,
            description: clean(input.description) ?? null,
            cost: input.cost ?? null,
            nextDueAt: toDate(input.nextDueAt) ?? null,
            nextDueMeter: input.nextDueMeter ?? null,
            createdByUserId: ctx.userId ?? null,
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'AssetMaintenance',
            entityId: record.id,
            details: `Opened ${input.kind} record on asset: ${asset.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AssetMaintenance',
                operation: 'created',
                after: { kind: input.kind, assetId },
                summary: `Opened ${input.kind} record on asset: ${asset.name}`,
            },
        });

        // Advisory only — see the module docstring.
        const suggestStatus =
            !record.closedAt && asset.status === 'ACTIVE' ? 'IN_MAINTENANCE' : null;

        return { record, suggestStatus };
    });
}

export async function closeAssetMaintenance(
    ctx: RequestContext,
    assetId: string,
    maintenanceId: string,
    closedAt?: Date | string | null,
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await AssetMaintenanceRepository.getById(db, ctx, maintenanceId);
        if (!existing || existing.assetId !== assetId) throw notFound('Maintenance record not found');
        if (existing.closedAt) throw badRequest('Maintenance record is already closed');

        const record = await AssetMaintenanceRepository.update(db, ctx, maintenanceId, {
            closedAt: toDate(closedAt) ?? new Date(),
        });

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'AssetMaintenance',
            entityId: maintenanceId,
            details: `Closed ${existing.kind} record`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AssetMaintenance',
                operation: 'updated',
                after: { closedAt: record?.closedAt ?? null },
                summary: `Closed ${existing.kind} record`,
            },
        });

        // Was this the last one open? Only then is "back to ACTIVE" the
        // right suggestion — a machine with two open repairs is not fixed
        // because one of them finished.
        const stillOpen = await AssetMaintenanceRepository.listOpenForAsset(db, ctx, assetId);
        const asset = await AssetRepository.getById(db, ctx, assetId);
        const suggestStatus =
            stillOpen.length === 0 && asset?.status === 'IN_MAINTENANCE' ? 'ACTIVE' : null;

        return { record, suggestStatus, openCount: stillOpen.length };
    });
}

export async function deleteAssetMaintenance(
    ctx: RequestContext,
    assetId: string,
    maintenanceId: string,
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await AssetMaintenanceRepository.getById(db, ctx, maintenanceId);
        if (!existing || existing.assetId !== assetId) throw notFound('Maintenance record not found');

        await AssetMaintenanceRepository.delete(db, ctx, maintenanceId);
        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'AssetMaintenance',
            entityId: maintenanceId,
            details: `Deleted ${existing.kind} record`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AssetMaintenance',
                operation: 'deleted',
                before: { kind: existing.kind, assetId },
                summary: `Deleted ${existing.kind} record`,
            },
        });
        return true;
    });
}
