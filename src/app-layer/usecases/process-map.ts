/**
 * Roadmap-26 PR-A — Process Map usecases.
 *
 * Thin orchestration: auth → module → tenant context → repo → audit.
 *
 * ## The CERTIFICATION gate lives HERE, not on the routes (#3291)
 *
 * It used to sit on `processes/route.ts` alone, which covered 2 of the
 * surface's 12 operations. The other ten are reachable by id and were
 * ungated — including `DELETE` and snapshot `restore` — so a farm with the
 * module off could not see the index and could still destroy a map. The
 * usecases are the one layer every operation passes through, so the gate is
 * placed here and a new route inherits it (owner ruling 2026-11-27).
 *
 * ## WRITES are gated; READS stay open
 *
 * Owner ruling, same date: a farm keeps access to work it already did and to
 * its PDF history, and simply cannot add to it. That is #1655's deletion
 * freeze applied to an entitlement — "no new content" and "nothing visible"
 * are different decisions, and hiding a season's compliance maps because a
 * plan lapsed is the worse one.
 *
 * So `getProcessMap`, `listProcessMapSnapshots` and `getProcessMapSnapshot`
 * carry NO module assertion, deliberately.
 *
 * ## One asymmetry, which is a decision rather than an oversight
 *
 * `listProcessMaps` IS gated, even though it is a read — the collection gate
 * predates this change and the ruling kept it, so the index is the one
 * read-side restriction. A farm with the module off can therefore open a map
 * it has an id for and cannot browse to it. Written down because it looks
 * exactly like the bug this change fixes.
 */

import { RequestContext } from '../types';
import { ProcessMapRepository } from '../repositories/ProcessMapRepository';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { assertModuleEnabled } from './modules';
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
    // Already gated on the route; asserted here too so the usecase does not
    // depend on its caller remembering (#3291).
    await assertModuleEnabled(ctx, 'CERTIFICATION');

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
    // #3291 — CERTIFICATION gates the WRITES on this surface. See the
    // module docblock: reads stay open so a farm keeps what it made.
    await assertModuleEnabled(ctx, 'CERTIFICATION');

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
    // #3291 — CERTIFICATION gates the WRITES on this surface. See the
    // module docblock: reads stay open so a farm keeps what it made.
    await assertModuleEnabled(ctx, 'CERTIFICATION');
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
    // #3291 — CERTIFICATION gates the WRITES on this surface. See the
    // module docblock: reads stay open so a farm keeps what it made.
    await assertModuleEnabled(ctx, 'CERTIFICATION');

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
    // #3291 — CERTIFICATION gates the WRITES on this surface. See the
    // module docblock: reads stay open so a farm keeps what it made.
    await assertModuleEnabled(ctx, 'CERTIFICATION');

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
