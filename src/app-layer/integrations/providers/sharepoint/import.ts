/**
 * SP-3 — SharePoint → evidence import.
 *
 * Two flows, both file-oriented (download → uploadEvidenceFile + a sync mapping)
 * rather than the field-mapper BaseSyncOrchestrator (which fits SP-4's
 * bidirectional content sync, not file import):
 *   - `importSharePointItems` — manual: import the files picked in the UI.
 *   - `runSharePointDeltaSync` — scheduled: Graph delta tokens detect changed
 *     files in mapped drives and re-import / mark stale automatically.
 *
 * @module integrations/providers/sharepoint/import
 */
import type { RequestContext } from '../../../types';
import { runInTenantContext } from '@/lib/db-context';
import { Prisma } from '@prisma/client';
import { uploadEvidenceFile } from '../../../usecases/evidence';
import { edgeLogger } from '@/lib/observability/edge-logger';
import { getSharePointClient } from './service';
import { encodeRemoteId } from './client';
import type { SharePointClient } from './client';

export const SP_IMPORT_MAX_ITEMS = 20;

export interface SpImportInput {
    connectionId: string;
    items: Array<{ driveId: string; itemId: string; name?: string }>;
    practiceId?: string;
    category?: string;
}
export interface SpImportResult {
    imported: number;
    failed: number;
    evidenceIds: string[];
    errors: Array<{ itemId: string; message: string }>;
}

/** Download one DriveItem + create an Evidence row + the sync mapping. */
async function importOne(
    ctx: RequestContext,
    client: SharePointClient,
    connectionId: string,
    sel: { driveId: string; itemId: string; name?: string },
    target: { practiceId?: string; category?: string },
): Promise<string> {
    const item = await client.getItem(sel.driveId, sel.itemId);
    const name = sel.name ?? item.name ?? 'sharepoint-file';
    const mimeType = item.file?.mimeType ?? 'application/octet-stream';
    const ab = await client.downloadItemContent(sel.driveId, sel.itemId);
    const file = new File([ab], name, { type: mimeType });

    const evidence = await uploadEvidenceFile(ctx, file, {
        title: name,
        practiceId: target.practiceId ?? null,
        category: target.category ?? null,
    });

    await upsertEvidenceMapping(ctx, {
        connectionId,
        evidenceId: evidence.id,
        driveId: sel.driveId,
        itemId: sel.itemId,
        eTag: item.eTag,
        cTag: item.cTag,
        webUrl: item.webUrl,
        remoteUpdatedAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : null,
    });
    return evidence.id;
}

/** Create/refresh the Evidence ↔ DriveItem sync mapping (keyed on the remote id). */
async function upsertEvidenceMapping(
    ctx: RequestContext,
    m: {
        connectionId: string;
        evidenceId: string;
        driveId: string;
        itemId: string;
        eTag?: string;
        cTag?: string;
        webUrl?: string;
        remoteUpdatedAt: Date | null;
    },
): Promise<void> {
    const remoteEntityId = encodeRemoteId(m.driveId, m.itemId);
    const remoteDataJson = { eTag: m.eTag, cTag: m.cTag, driveId: m.driveId, itemId: m.itemId } as Prisma.InputJsonValue;
    await runInTenantContext(ctx, (db) =>
        db.integrationSyncMapping.upsert({
            where: {
                tenantId_provider_remoteEntityType_remoteEntityId: {
                    tenantId: ctx.tenantId,
                    provider: 'sharepoint',
                    remoteEntityType: 'DriveItem',
                    remoteEntityId,
                },
            },
            create: {
                tenantId: ctx.tenantId,
                provider: 'sharepoint',
                connectionId: m.connectionId,
                localEntityType: 'Evidence',
                localEntityId: m.evidenceId,
                remoteEntityType: 'DriveItem',
                remoteEntityId,
                syncStatus: 'SYNCED',
                lastSyncDirection: 'PULL',
                remoteDataJson,
                sourceUrl: m.webUrl ?? null,
                remoteUpdatedAt: m.remoteUpdatedAt,
                lastSyncedAt: new Date(),
            },
            update: {
                localEntityId: m.evidenceId,
                connectionId: m.connectionId,
                syncStatus: 'SYNCED',
                lastSyncDirection: 'PULL',
                remoteDataJson,
                sourceUrl: m.webUrl ?? null,
                remoteUpdatedAt: m.remoteUpdatedAt,
                lastSyncedAt: new Date(),
                version: { increment: 1 },
                errorMessage: null,
            },
        }),
    );
}

/** Manual import of the files selected in the picker. */
export async function importSharePointItems(
    ctx: RequestContext,
    input: SpImportInput,
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<SpImportResult> {
    if (input.items.length === 0) return { imported: 0, failed: 0, evidenceIds: [], errors: [] };
    if (input.items.length > SP_IMPORT_MAX_ITEMS) {
        throw new Error(`Too many items — import at most ${SP_IMPORT_MAX_ITEMS} at a time`);
    }
    const client = await getSharePointClient(ctx, input.connectionId, deps);
    const evidenceIds: string[] = [];
    const errors: SpImportResult['errors'] = [];
    for (const sel of input.items) {
        try {
            evidenceIds.push(
                await importOne(ctx, client, input.connectionId, sel, {
                    practiceId: input.practiceId,
                    category: input.category,
                }),
            );
        } catch (err) {
            errors.push({ itemId: sel.itemId, message: err instanceof Error ? err.message : String(err) });
        }
    }
    return { imported: evidenceIds.length, failed: errors.length, evidenceIds, errors };
}

export interface SpDeltaSyncResult {
    drivesSynced: number;
    reimported: number;
    staled: number;
}

/**
 * Scheduled delta sync: for every drive with mapped evidence, walk the Graph
 * delta from the stored token; re-import changed files and mark deleted ones
 * STALE. Persists the new delta token per drive on the connection config.
 */
export async function runSharePointDeltaSync(
    ctx: RequestContext,
    connectionId: string,
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<SpDeltaSyncResult> {
    const client = await getSharePointClient(ctx, connectionId, deps);

    // Mappings for this connection, indexed by remote id (driveId:itemId).
    const mappings = await runInTenantContext(ctx, (db) =>
        db.integrationSyncMapping.findMany({
            where: { tenantId: ctx.tenantId, provider: 'sharepoint', connectionId, remoteEntityType: 'DriveItem' },
            select: { id: true, remoteEntityId: true, remoteDataJson: true, localEntityId: true },
            take: 5000,
        }),
    );
    const byRemoteId = new Map(mappings.map((m) => [m.remoteEntityId, m]));
    const driveIds = new Set(mappings.map((m) => m.remoteEntityId.split(':')[0]));

    const tokens = await readDeltaTokens(ctx, connectionId);
    let reimported = 0;
    let staled = 0;

    for (const driveId of driveIds) {
        const delta = await client.getDelta(driveId, tokens[driveId]);
        for (const it of delta.items) {
            const remoteId = encodeRemoteId(driveId, it.id);
            const mapping = byRemoteId.get(remoteId);
            if (!mapping) continue; // only items IC already tracks

            if (it.deleted) {
                await runInTenantContext(ctx, (db) =>
                    db.integrationSyncMapping.update({
                        where: { id: mapping.id },
                        data: { syncStatus: 'STALE', lastSyncedAt: new Date() },
                    }),
                );
                staled++;
                continue;
            }
            // Detect changes by cTag (content tag) — eTag also bumps on
            // metadata-only touches, which would cause spurious re-imports.
            // Fall back to eTag when cTag is absent.
            const prev = mapping.remoteDataJson as { cTag?: string; eTag?: string } | null;
            const prevTag = prev?.cTag ?? prev?.eTag;
            const curTag = it.cTag ?? it.eTag;
            if (curTag && curTag !== prevTag) {
                try {
                    await importOne(ctx, client, connectionId, { driveId, itemId: it.id }, {});
                    reimported++;
                } catch (err) {
                    edgeLogger.error('SharePoint delta re-import failed', {
                        component: 'sharepoint',
                        remoteId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        }
        if (delta.deltaToken) tokens[driveId] = delta.deltaToken;
    }

    await writeDeltaTokens(ctx, connectionId, tokens);
    return { drivesSynced: driveIds.size, reimported, staled };
}

async function readDeltaTokens(ctx: RequestContext, connectionId: string): Promise<Record<string, string>> {
    const conn = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: { configJson: true },
        }),
    );
    const cfg = (conn?.configJson ?? {}) as { deltaTokens?: Record<string, string> };
    return { ...(cfg.deltaTokens ?? {}) };
}

async function writeDeltaTokens(ctx: RequestContext, connectionId: string, tokens: Record<string, string>): Promise<void> {
    await runInTenantContext(ctx, async (db) => {
        const conn = await db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: { configJson: true },
        });
        const cfg = (conn?.configJson ?? {}) as Record<string, unknown>;
        await db.integrationConnection.update({
            where: { id: connectionId },
            data: { configJson: { ...cfg, deltaTokens: tokens } as Prisma.InputJsonValue },
        });
    });
}
