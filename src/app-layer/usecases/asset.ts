import { RequestContext } from '../types';
import { AssetRepository, AssetListParams, AssetFilters } from '../repositories/AssetRepository';
import { WorkItemRepository } from '../repositories/WorkItemRepository';
import type { TaskLinkEntityType } from '@prisma/client';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { createAssignmentNotification } from '../notifications/assignment';
import { logger } from '@/lib/observability';

/**
 * Coerce a form `purchaseDate` into the shape Prisma's DateTime column
 * expects. `undefined` ⇒ leave untouched (partial update); `''`/null ⇒
 * clear; an ISO date string ⇒ a Date.
 */
function normalizePurchaseDate(value: unknown): Date | null | undefined {
    if (value === undefined) return undefined;
    if (!value) return null;
    return new Date(value as string);
}

export async function listAssets(ctx: RequestContext, filters?: AssetFilters) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await AssetRepository.list(db, ctx, filters);
        // B7 — attach unified linked-task counts (TaskLink ASSET) so the
        // list page can show a Tasks column, matching Practices.
        const counts = await WorkItemRepository.countLinkedToEntities(
            db,
            ctx,
            'ASSET' as TaskLinkEntityType,
            rows.map((r: { id: string }) => r.id),
        );
        return rows.map((r) => ({
            ...r,
            taskTotal: counts.get(r.id)?.total ?? 0,
            taskDone: counts.get(r.id)?.done ?? 0,
        }));
    });
}

export async function listAssetsPaginated(ctx: RequestContext, params: AssetListParams) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        AssetRepository.listPaginated(db, ctx, params)
    );
}

export async function getAsset(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const asset = await AssetRepository.getById(db, ctx, id);
        if (!asset) throw notFound('Asset not found');
        return asset;
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createAsset(ctx: RequestContext, data: any) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const asset = await AssetRepository.create(db, ctx, {
            name: data.name,
            type: data.type,
            ...(data.status ? { status: data.status } : {}),
            criticality: data.criticality ?? null,
            owner: data.owner,
            ownerUserId: data.ownerUserId || null,
            externalRef: data.externalRef ?? null,
            location: data.location,
            manufacturer: data.manufacturer,
            model: data.model,
            serialNumber: data.serialNumber,
            year: data.year ?? null,
            purchaseDate: normalizePurchaseDate(data.purchaseDate) ?? null,
            purchaseCost: data.purchaseCost ?? null,
            locationId: data.locationId ?? null,
            usefulLifeYears: data.usefulLifeYears ?? null,
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Asset',
            entityId: asset.id,
            details: `Created asset: ${asset.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Asset',
                operation: 'created',
                after: { name: asset.name, type: data.type },
                summary: `Created asset: ${asset.name}`,
            },
        });

        return asset;
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function updateAsset(ctx: RequestContext, id: string, data: any) {
    assertCanWrite(ctx);

    const { asset: updated, previousOwnerId } = await runInTenantContext(ctx, async (db) => {
        // Capture the prior assignee so the notification only fires on
        // an actual change, not on every unrelated asset edit.
        const before = await AssetRepository.getById(db, ctx, id);
        const previousOwnerId = before?.ownerUserId ?? null;

        const asset = await AssetRepository.update(db, ctx, id, {
            name: data.name,
            type: data.type,
            // Status edits were silently dropped before B7 — the form sends
            // it but it never reached the repo. undefined leaves it untouched.
            status: data.status,
            criticality: data.criticality,
            owner: data.owner,
            // "Assigned to" — undefined leaves it untouched; '' or null
            // clears (an empty string would be an invalid FK).
            ownerUserId:
                data.ownerUserId === undefined
                    ? undefined
                    : data.ownerUserId || null,
            externalRef: data.externalRef,
            location: data.location,
            manufacturer: data.manufacturer,
            model: data.model,
            serialNumber: data.serialNumber,
            year: data.year,
            purchaseDate: normalizePurchaseDate(data.purchaseDate),
            purchaseCost: data.purchaseCost,
            // undefined leaves untouched (partial update); '' / null clears
            // — an empty string would be an invalid FK, same as ownerUserId.
            locationId:
                data.locationId === undefined ? undefined : data.locationId || null,
            usefulLifeYears:
                data.usefulLifeYears === undefined ? undefined : data.usefulLifeYears || null,
        });

        if (!asset) throw notFound('Asset not found');

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Asset',
            entityId: id,
            details: `Asset updated`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Asset',
                operation: 'updated',
                changedFields: Object.keys(data).filter(k => data[k] !== undefined),
                after: { name: data.name, type: data.type },
                summary: `Asset updated`,
            },
        });

        return { asset, previousOwnerId };
    });

    // In-app ASSET_ASSIGNED bell notification for the new owner — only
    // when the assignee actually changed to a real user. After-commit,
    // own short transaction, fire-and-forget, day-granular dedupe.
    const newOwnerId = updated.ownerUserId ?? null;
    if (newOwnerId && newOwnerId !== previousOwnerId && ctx.tenantSlug) {
        const tenantSlug = ctx.tenantSlug;
        try {
            await runInTenantContext(ctx, (db) =>
                createAssignmentNotification(db, 'ASSET_ASSIGNED', {
                    tenantId: ctx.tenantId,
                    assigneeUserId: newOwnerId,
                    entityId: id,
                    entityLabel: updated.name ?? '(untitled)',
                    entityKey: null,
                    tenantSlug,
                }),
            );
        } catch (err) {
            logger.warn('failed to create asset-assigned notification', {
                component: 'notifications',
                assetId: id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return updated;
}

export async function deleteAsset(ctx: RequestContext, id: string) {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const deleted = await AssetRepository.delete(db, ctx, id);
        if (!deleted) throw notFound('Asset not found');

        await logEvent(db, ctx, {
            action: 'SOFT_DELETE',
            entityType: 'Asset',
            entityId: id,
            details: 'Asset soft-deleted',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Asset',
                operation: 'deleted',
                summary: 'Asset soft-deleted',
            },
        });

        return { success: true };
    });
}

/**
 * Bulk soft-delete assets (the assets table action-row "Delete selected").
 * Mirrors {@link deleteAsset}: ADMIN-gated, tenant-scoped, one audit row per
 * deleted asset. `Asset` is a soft-delete model, so `deleteMany` sets
 * `deletedAt`; the `findMany` auto-filters already-deleted rows, so a
 * re-submit is idempotent. Returns the count actually deleted.
 */
export async function bulkDeleteAsset(
    ctx: RequestContext,
    assetIds: string[],
): Promise<{ deleted: number }> {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const rows = await db.asset.findMany({
            where: { id: { in: assetIds }, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (rows.length === 0) return { deleted: 0 };

        await db.asset.deleteMany({
            where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId },
        });

        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'SOFT_DELETE',
                entityType: 'Asset',
                entityId: r.id,
                details: 'Asset soft-deleted (bulk)',
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Asset',
                    operation: 'deleted',
                    summary: 'SOFT_DELETE',
                },
            });
        }

        return { deleted: rows.length };
    });
}

// ─── Restore / Purge / Include Deleted ───

import { restoreEntity, purgeEntity } from './soft-delete-operations';
import { withDeleted } from '@/lib/soft-delete';

export async function restoreAsset(ctx: RequestContext, id: string) {
    return restoreEntity(ctx, 'Asset', id);
}

export async function purgeAsset(ctx: RequestContext, id: string) {
    return purgeEntity(ctx, 'Asset', id);
}

export async function listAssetsWithDeleted(ctx: RequestContext) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, (db) =>
        db.asset.findMany(withDeleted({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' as const } }))
    );
}

/**
 * B6 — per-asset activity feed. The immutable, hash-chained audit trail
 * already records every asset lifecycle event (CREATE / UPDATE /
 * SOFT_DELETE / ENTITY_RESTORED / ENTITY_PURGED / evidence + link edits).
 * This is a bounded read-only view of it for the detail-page Activity tab,
 * mirroring `getPracticeActivity`. The hash chain is never touched.
 */
export async function getAssetActivity(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const asset = await AssetRepository.getById(db, ctx, assetId);
        if (!asset) throw notFound('Asset not found');
        return db.auditLog.findMany({
            where: { tenantId: ctx.tenantId, entity: 'Asset', entityId: assetId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { user: { select: { id: true, name: true } } },
        });
    });
}

// ─── Attached Evidence ───
//
// Evidence attached directly to an asset via `Evidence.assetId` — same
// pattern as Practice/Task/Risk. The asset Evidence tab renders this
// through the shared <EvidenceSubTable> ({ links, evidence } shape;
// `links` always empty). Distinct from the read-only INHERITED evidence
// (aggregated from the asset's mapped practices), shown in its own
// section.

/** Asset attached-evidence payload — `{ links, evidence }` for the shared sub-table. */
export async function getAssetEvidenceTab(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const asset = await db.asset.findFirst({
            where: { id: assetId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!asset) throw notFound('Asset not found');
        const evidence = await db.evidence.findMany({
            where: { assetId, tenantId: ctx.tenantId, deletedAt: null },
            orderBy: { createdAt: 'desc' },
        });
        return { links: [], evidence };
    });
}

/** Attach a URL as evidence on an asset (file uploads go through /evidence/uploads with an assetId). */
export async function linkAssetEvidence(
    ctx: RequestContext,
    assetId: string,
    data: { url: string; note?: string | null },
) {
    assertCanWrite(ctx);
    const url = data.url.trim();
    const note = data.note ? sanitizePlainText(data.note) : null;
    const result = await runInTenantContext(ctx, async (db) => {
        const asset = await db.asset.findFirst({
            where: { id: assetId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!asset) throw notFound('Asset not found');
        const evidence = await db.evidence.create({
            data: {
                tenantId: ctx.tenantId,
                assetId,
                type: 'LINK',
                title: note || url,
                content: url,
                status: 'DRAFT',
                ownerUserId: ctx.userId,
            },
        });
        await logEvent(db, ctx, {
            action: 'ASSET_EVIDENCE_LINKED',
            entityType: 'Asset',
            entityId: assetId,
            details: `Evidence linked: ${url}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Evidence', targetId: evidence.id, relation: 'LINK' },
        });
        return evidence;
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

/** Detach evidence from an asset — clears `Evidence.assetId`; the evidence survives in the library. */
export async function unlinkAssetEvidence(
    ctx: RequestContext,
    assetId: string,
    evidenceId: string,
) {
    assertCanWrite(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const evidence = await db.evidence.findFirst({
            where: { id: evidenceId, assetId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!evidence) throw notFound('Asset evidence not found');
        await db.evidence.update({
            where: { id: evidenceId },
            data: { assetId: null },
        });
        await logEvent(db, ctx, {
            action: 'ASSET_EVIDENCE_UNLINKED',
            entityType: 'Asset',
            entityId: assetId,
            details: `Evidence unlinked: ${evidenceId}`,
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Evidence', targetId: evidenceId },
        });
        return { success: true };
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return outcome;
}
