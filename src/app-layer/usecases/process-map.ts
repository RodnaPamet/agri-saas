/**
 * Roadmap-26 PR-A — Process Map usecases.
 *
 * Thin orchestration: auth → tenant context → repo → audit.
 */

import { RequestContext } from '../types';
import { ProcessMapRepository } from '../repositories/ProcessMapRepository';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import {
    syncCanvasToRules,
    hydrateCanvasFromRules,
} from '../services/canvas-rule-sync';
import type {
    CreateProcessMapInput,
    SaveProcessMapInput,
} from '../schemas/process-map';

export async function listProcessMaps(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ProcessMapRepository.list(db, ctx),
    );
}

export async function getProcessMap(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const map = await ProcessMapRepository.getByIdWithGraph(db, ctx, id);
        if (!map) throw notFound('Process map not found');
        // VR-3 — Rules → Canvas hydration: enrich automation nodes with live
        // rule status / executionCount / subtitle for display (AUTOMATION
        // maps only). Read-only; never persisted.
        const meta = await db.processMap.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: { canvasMode: true },
        });
        if (meta?.canvasMode === 'AUTOMATION') {
            return { ...map, nodes: await hydrateCanvasFromRules(db, ctx, map.nodes) };
        }
        return map;
    });
}

export async function createProcessMap(
    ctx: RequestContext,
    input: CreateProcessMapInput,
) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const map = await ProcessMapRepository.create(db, ctx, {
            name: input.name,
            description: input.description ?? null,
            status: input.status,
            canvasMode: input.canvasMode,
            createdByUserId: ctx.userId,
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'ProcessMap',
            entityId: map.id,
            details: `Created process map: ${map.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ProcessMap',
                operation: 'created',
                after: { name: map.name, status: map.status },
                summary: `Created process map: ${map.name}`,
            },
        });

        return map;
    });
}

export async function saveProcessMap(
    ctx: RequestContext,
    id: string,
    input: SaveProcessMapInput,
) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const map = await ProcessMapRepository.replaceGraph(db, ctx, id, {
            name: input.name,
            description: input.description ?? undefined,
            status: input.status,
            nodes: input.nodes,
            edges: input.edges,
            // Epic P1 — optimistic concurrency. Forward the
            // client's claimed version so the repo can refuse the
            // write on conflict (HTTP 409 / `STALE_DATA`).
            expectedVersion: input.expectedVersion,
        });
        if (!map) throw notFound('Process map not found');

        // VR-3 — Canvas → Rules sync (AUTOMATION maps only): create stub
        // rules for new action nodes + wire chain topology after the graph
        // is persisted.
        const meta = await db.processMap.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: { canvasMode: true },
        });
        if (meta?.canvasMode === 'AUTOMATION') {
            await syncCanvasToRules(db, ctx, id);
        }

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ProcessMap',
            entityId: id,
            details: `Saved process map: ${map.name} (v${map.version})`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ProcessMap',
                operation: 'updated',
                after: {
                    name: map.name,
                    status: map.status,
                    version: map.version,
                    nodeCount: map.nodes.length,
                    edgeCount: map.edges.length,
                },
                summary: `Saved process map: ${map.name} (v${map.version})`,
            },
        });

        return map;
    });
}

/**
 * VR / PR-B follow-up — switch an existing map between DOCUMENT (process map)
 * and AUTOMATION (visual rule editor) without a graph save. Gated on write.
 */
export async function setProcessMapCanvasMode(
    ctx: RequestContext,
    id: string,
    canvasMode: 'DOCUMENT' | 'AUTOMATION',
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const ok = await ProcessMapRepository.setCanvasMode(db, ctx, id, canvasMode);
        if (!ok) throw notFound('Process map not found');
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ProcessMap',
            entityId: id,
            details: `Set canvas mode: ${canvasMode}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ProcessMap',
                operation: 'updated',
                after: { canvasMode },
                summary: `Canvas mode → ${canvasMode}`,
            },
        });
        return { id, canvasMode };
    });
}

/**
 * Epic P5-PR-A — list snapshots for a process map. Read-only;
 * surfaces the version-history sidebar.
 */
export async function listProcessMapSnapshots(
    ctx: RequestContext,
    mapId: string,
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ProcessMapRepository.listSnapshots(db, ctx, mapId),
    );
}

/**
 * Epic P5-PR-B — fetch one snapshot's full graphJson by version.
 * Powers "View version N" + visual diff.
 */
export async function getProcessMapSnapshot(
    ctx: RequestContext,
    mapId: string,
    version: number,
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const snapshot = await ProcessMapRepository.getSnapshotByVersion(
            db,
            ctx,
            mapId,
            version,
        );
        if (!snapshot) throw notFound('Snapshot not found');
        return snapshot;
    });
}

/**
 * Epic P5-PR-B — restore a process map to an earlier snapshot.
 * Routes through `replaceGraph` so the restored state becomes its
 * own new snapshot (no history is lost — a "vN restored from vM"
 * row appears in the timeline). `expectedVersion` is forwarded
 * so the P1 optimistic-concurrency check still gates the write.
 */
export async function restoreProcessMapSnapshot(
    ctx: RequestContext,
    mapId: string,
    targetVersion: number,
    expectedVersion: number,
) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const snapshot = await ProcessMapRepository.getSnapshotByVersion(
            db,
            ctx,
            mapId,
            targetVersion,
        );
        if (!snapshot) throw notFound('Snapshot not found');

        const json = snapshot.graphJson as {
            nodes?: SaveProcessMapInput['nodes'];
            edges?: SaveProcessMapInput['edges'];
        };
        const map = await ProcessMapRepository.replaceGraph(db, ctx, mapId, {
            nodes: json.nodes ?? [],
            edges: json.edges ?? [],
            expectedVersion,
        });
        if (!map) throw notFound('Process map not found');

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ProcessMap',
            entityId: mapId,
            details: `Restored process map ${map.name} from v${targetVersion}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ProcessMap',
                operation: 'restored',
                summary: `Restored from v${targetVersion}`,
                after: {
                    name: map.name,
                    version: map.version,
                    restoredFromVersion: targetVersion,
                },
            },
        });

        return map;
    });
}

export async function deleteProcessMap(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const ok = await ProcessMapRepository.softDelete(db, ctx, id, ctx.userId);
        if (!ok) throw notFound('Process map not found');

        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'ProcessMap',
            entityId: id,
            details: `Deleted process map`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ProcessMap',
                operation: 'deleted',
                summary: `Deleted process map ${id}`,
            },
        });

        return { id };
    });
}
