/**
 * Roadmap-26 PR-A — ProcessMap repository.
 *
 * Persists the Process-Map graph (nodes + edges + edge-practices)
 * with a full-graph replace semantic. The usecase layer above
 * calls `replaceGraph(...)` on every save; this repo deletes the
 * existing graph children inside a transaction and recreates them
 * with the supplied payload, then bumps the parent map's
 * `version` + `updatedAt`.
 *
 * Why a transaction for the whole replace:
 *   The graph is conceptually one document. A partial replace
 *   would leave the canvas in a structurally broken state (e.g.
 *   edges referencing nodes that no longer exist). Wrapping
 *   delete+create in `db.$transaction` makes either all of it
 *   land or none of it.
 *
 * Why we don't diff before replacing:
 *   Per-row diff (node moved by 4px → UPDATE; new node added →
 *   INSERT; removed node → DELETE) is more efficient but adds
 *   complexity for negligible benefit at the bounded graph sizes
 *   the Processes page targets (dozens of nodes). The full
 *   replace keeps the repo's contract trivially auditable.
 */

import { PrismaTx } from '@/lib/db-context';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { staleData } from '@/lib/errors/types';
import type {
    ProcessNodeInput,
    ProcessEdgeInput,
    ProcessMapStatusValue,
} from '../schemas/process-map';

export interface ProcessMapListItem {
    id: string;
    name: string;
    description: string | null;
    status: ProcessMapStatusValue;
    version: number;
    canvasMode: 'DOCUMENT' | 'AUTOMATION';
    createdAt: Date;
    updatedAt: Date;
    nodeCount: number;
    edgeCount: number;
}

export interface ProcessMapWithGraph {
    id: string;
    name: string;
    description: string | null;
    status: ProcessMapStatusValue;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    nodes: Array<{
        nodeKey: string;
        nodeType: string;
        label: string;
        subtitle: string | null;
        posX: number;
        posY: number;
        parentNodeKey: string | null;
        dataJson: unknown;
    }>;
    edges: Array<{
        edgeKey: string;
        sourceKey: string;
        targetKey: string;
        edgeKind: string;
        labelOverride: string | null;
        dataJson: unknown;
        practices: Array<{
            practiceKey: string;
            label: string;
            dataJson: unknown;
        }>;
    }>;
}

export class ProcessMapRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
    ): Promise<ProcessMapListItem[]> {
        const rows = await db.processMap.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null },
            orderBy: [{ updatedAt: 'desc' }],
            select: {
                id: true,
                name: true,
                description: true,
                status: true,
                version: true,
                canvasMode: true,
                createdAt: true,
                updatedAt: true,
                _count: { select: { nodes: true, edges: true } },
            },
        });
        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            status: r.status,
            version: r.version,
            canvasMode: r.canvasMode,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            nodeCount: r._count.nodes,
            edgeCount: r._count.edges,
        }));
    }

    static async getByIdWithGraph(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
    ): Promise<ProcessMapWithGraph | null> {
        const map = await db.processMap.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: {
                nodes: {
                    orderBy: { nodeKey: 'asc' },
                    select: {
                        nodeKey: true,
                        nodeType: true,
                        label: true,
                        subtitle: true,
                        posX: true,
                        posY: true,
                        parentNodeKey: true,
                        dataJson: true,
                    },
                },
                edges: {
                    orderBy: { edgeKey: 'asc' },
                    select: {
                        edgeKey: true,
                        sourceKey: true,
                        targetKey: true,
                        edgeKind: true,
                        labelOverride: true,
                        dataJson: true,
                        practices: {
                            orderBy: { practiceKey: 'asc' },
                            select: {
                                practiceKey: true,
                                label: true,
                                dataJson: true,
                            },
                        },
                    },
                },
            },
        });
        if (!map) return null;
        return {
            id: map.id,
            name: map.name,
            description: map.description,
            status: map.status,
            version: map.version,
            createdAt: map.createdAt,
            updatedAt: map.updatedAt,
            nodes: map.nodes,
            edges: map.edges,
        };
    }

    /**
     * VR / PR-B follow-up — flip a map's canvasMode (DOCUMENT ⇄ AUTOMATION)
     * without touching the graph. Returns false if no row matched.
     */
    static async setCanvasMode(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        canvasMode: 'DOCUMENT' | 'AUTOMATION',
    ): Promise<boolean> {
        const res = await db.processMap.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            data: { canvasMode },
        });
        return res.count > 0;
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        input: {
            name: string;
            description?: string | null;
            status?: ProcessMapStatusValue;
            canvasMode?: 'DOCUMENT' | 'AUTOMATION';
            createdByUserId: string;
        },
    ): Promise<ProcessMapWithGraph> {
        const created = await db.processMap.create({
            data: {
                tenantId: ctx.tenantId,
                name: input.name,
                description: input.description ?? null,
                status: input.status ?? 'DRAFT',
                canvasMode: input.canvasMode ?? 'DOCUMENT',
                createdByUserId: input.createdByUserId,
            },
        });
        return {
            id: created.id,
            name: created.name,
            description: created.description,
            status: created.status,
            version: created.version,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
            nodes: [],
            edges: [],
        };
    }

    /**
     * Replace the graph atomically.
     *
     * Steps:
     *   1. Verify the map exists + belongs to the tenant.
     *   2. Validate that every edge's source/target key references
     *      a node key in the supplied node set (cheap structural
     *      guard; the DB has no FK to enforce this since nodeKey
     *      is per-map, not globally unique).
     *   3. Transactionally:
     *      a. Delete all existing nodes + edges for the map.
     *         Cascading FK takes care of edge-practices.
     *      b. Insert the new node set.
     *      c. Insert the new edge set.
     *      d. Insert each edge's practices.
     *      e. Bump version + apply metadata edits.
     */
    static async replaceGraph(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        input: {
            name?: string;
            description?: string | null;
            status?: ProcessMapStatusValue;
            nodes: ProcessNodeInput[];
            edges: ProcessEdgeInput[];
            /**
             * Epic P1 — optimistic-concurrency guard. When set, the
             * repo refuses the write if the server's current
             * `version` doesn't match. Surfaces as
             * `staleData(...)` → HTTP 409 + `{ code: 'STALE_DATA',
             * details: { currentVersion } }`.
             *
             * Omit for last-write-wins semantics (older clients) —
             * the canvas always sends it now.
             */
            expectedVersion?: number;
        },
    ): Promise<ProcessMapWithGraph | null> {
        // Structural validation — fail fast before opening a tx.
        const nodeKeys = new Set(input.nodes.map((n) => n.nodeKey));
        for (const e of input.edges) {
            if (!nodeKeys.has(e.sourceKey)) {
                throw new Error(
                    `Edge ${e.edgeKey} references unknown source nodeKey ${e.sourceKey}`,
                );
            }
            if (!nodeKeys.has(e.targetKey)) {
                throw new Error(
                    `Edge ${e.edgeKey} references unknown target nodeKey ${e.targetKey}`,
                );
            }
        }
        // R30 — parent-reference integrity. A `parentNodeKey` must
        // point to another node in the SAME save payload. Self-
        // references are rejected. Nested groups (a group whose
        // parent is itself a group) are allowed today — xyflow
        // supports the recursion and the save shape is otherwise
        // identical.
        for (const n of input.nodes) {
            if (n.parentNodeKey == null) continue;
            if (n.parentNodeKey === n.nodeKey) {
                throw new Error(
                    `Node ${n.nodeKey} references itself as parentNodeKey`,
                );
            }
            if (!nodeKeys.has(n.parentNodeKey)) {
                throw new Error(
                    `Node ${n.nodeKey} references unknown parentNodeKey ${n.parentNodeKey}`,
                );
            }
        }

        const existing = await db.processMap.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, version: true },
        });
        if (!existing) return null;

        // Epic P1 — optimistic concurrency. Refuse the write if the
        // client's `expectedVersion` doesn't match the server's
        // current version. Doing the check up-front skips the
        // destructive delete-and-insert when we already know the
        // conditional commit at the end would lose the race; the
        // conditional `updateMany` below is the second line of
        // defence catching any concurrent commit that lands BETWEEN
        // the check and the version bump.
        //
        // Callers who omit `expectedVersion` are accepting last-
        // write-wins by omission. The canvas client always sends it
        // now; the omission path keeps the migration door open for
        // older bundles still in browser caches.
        if (
            input.expectedVersion !== undefined &&
            existing.version !== input.expectedVersion
        ) {
            throw staleData(
                'This process map was modified by another user. Reload to see the latest version.',
                { currentVersion: existing.version },
            );
        }

        // The repo is invoked from the usecase via `runInTenantContext`
        // which already opens a Prisma `$transaction` and binds the
        // tenant-scoping session variable. We MUST NOT open a nested
        // transaction here — `PrismaTx` is the inner-tx type and
        // intentionally omits `$transaction` to enforce that
        // invariant. The sequential operations below are atomic for
        // free because they share the outer tx.

        // Cascading FK on ProcessNode / ProcessEdge → ProcessMap
        // would let us drop+recreate the parent, but that would
        // lose `createdAt` / `createdByUserId`. Cleaner to keep
        // the parent intact and delete just the children.
        await db.processEdge.deleteMany({
            where: { processMapId: id, tenantId: ctx.tenantId },
        });
        await db.processNode.deleteMany({
            where: { processMapId: id, tenantId: ctx.tenantId },
        });

        if (input.nodes.length > 0) {
            await db.processNode.createMany({
                data: input.nodes.map((n) => ({
                    tenantId: ctx.tenantId,
                    processMapId: id,
                    nodeKey: n.nodeKey,
                    nodeType: n.nodeType,
                    label: n.label,
                    subtitle: n.subtitle ?? null,
                    posX: n.posX,
                    posY: n.posY,
                    parentNodeKey: n.parentNodeKey ?? null,
                    dataJson:
                        n.dataJson === undefined
                            ? Prisma.JsonNull
                            : (n.dataJson as Prisma.InputJsonValue | null) ??
                              Prisma.JsonNull,
                })),
            });
        }

        // Edges and their practices. Need each edge's row id back
        // to wire its practices, so we create one edge at a time
        // (createMany doesn't return ids in Postgres). At the
        // bounded graph sizes the Processes page targets the
        // per-edge round trip is fine.
        for (const e of input.edges) {
            const edge = await db.processEdge.create({
                data: {
                    tenantId: ctx.tenantId,
                    processMapId: id,
                    edgeKey: e.edgeKey,
                    sourceKey: e.sourceKey,
                    targetKey: e.targetKey,
                    edgeKind: e.edgeKind,
                    labelOverride: e.labelOverride ?? null,
                    dataJson:
                        e.dataJson === undefined
                            ? Prisma.JsonNull
                            : (e.dataJson as Prisma.InputJsonValue | null) ??
                              Prisma.JsonNull,
                },
            });
            if (e.practices.length > 0) {
                await db.processEdgePractice.createMany({
                    data: e.practices.map((c) => ({
                        tenantId: ctx.tenantId,
                        processMapId: id,
                        edgeId: edge.id,
                        practiceKey: c.practiceKey,
                        label: c.label,
                        dataJson:
                            c.dataJson === undefined
                                ? Prisma.JsonNull
                                : (c.dataJson as
                                      | Prisma.InputJsonValue
                                      | null) ?? Prisma.JsonNull,
                    })),
                });
            }
        }

        // Conditional version bump — the SECOND line of defence
        // for optimistic concurrency. A concurrent save that landed
        // between the up-front check and here would fail with
        // `count === 0`; the outer tx then rolls back the
        // delete-and-insert, leaving the previous graph intact.
        //
        // When `expectedVersion` is omitted (last-write-wins
        // callers), the `version` predicate is omitted too — the
        // bump happens unconditionally, matching the pre-Epic-P1
        // behaviour.
        const updated = await db.processMap.updateMany({
            where: {
                id,
                tenantId: ctx.tenantId,
                ...(input.expectedVersion !== undefined
                    ? { version: input.expectedVersion }
                    : {}),
            },
            data: {
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.description !== undefined
                    ? { description: input.description }
                    : {}),
                ...(input.status !== undefined
                    ? { status: input.status }
                    : {}),
                version: { increment: 1 },
            },
        });
        if (updated.count === 0) {
            // Only reachable when `expectedVersion` is set and lost
            // a race with another commit between the up-front check
            // and the bump. Refresh the current version so the
            // client gets the post-race value, not the pre-race
            // value we read at the top of this method.
            const current = await db.processMap.findFirst({
                where: { id, tenantId: ctx.tenantId },
                select: { version: true },
            });
            throw staleData(
                'This process map was modified by another user. Reload to see the latest version.',
                { currentVersion: current?.version ?? existing.version },
            );
        }

        // Epic P5-PR-A — archive the just-committed graph as a
        // snapshot. Writes inside the same outer tx as the version
        // bump so either both land or neither does.
        const newVersion = (existing.version ?? 0) + 1;
        const graphJsonPayload = {
            version: newVersion,
            nodes: input.nodes.map((n) => ({
                nodeKey: n.nodeKey,
                nodeType: n.nodeType,
                label: n.label,
                subtitle: n.subtitle ?? null,
                posX: n.posX,
                posY: n.posY,
                parentNodeKey: n.parentNodeKey ?? null,
                dataJson: n.dataJson ?? null,
            })),
            edges: input.edges.map((e) => ({
                edgeKey: e.edgeKey,
                sourceKey: e.sourceKey,
                targetKey: e.targetKey,
                edgeKind: e.edgeKind,
                labelOverride: e.labelOverride ?? null,
                dataJson: e.dataJson ?? null,
                practices: e.practices.map((c) => ({
                    practiceKey: c.practiceKey,
                    label: c.label,
                    dataJson: c.dataJson ?? null,
                })),
            })),
        };
        await db.processMapSnapshot.create({
            data: {
                tenantId: ctx.tenantId,
                processMapId: id,
                version: newVersion,
                graphJson: graphJsonPayload as Prisma.InputJsonValue,
                createdByUserId: ctx.userId,
            },
        });

        return ProcessMapRepository.getByIdWithGraph(db, ctx, id);
    }

    /**
     * Epic P5-PR-A — list snapshots for a process map (descending
     * by version). The sidebar reads this to render the version
     * timeline. Capped at 200 — older snapshots roll off the
     * sidebar; future P5 work can add pagination if needed.
     */
    static async listSnapshots(
        db: PrismaTx,
        ctx: RequestContext,
        mapId: string,
    ): Promise<
        Array<{
            id: string;
            version: number;
            createdAt: Date;
            createdByUserId: string;
            createdByName: string | null;
        }>
    > {
        const rows = await db.processMapSnapshot.findMany({
            where: { tenantId: ctx.tenantId, processMapId: mapId },
            orderBy: { version: 'desc' },
            take: 200,
            select: {
                id: true,
                version: true,
                createdAt: true,
                createdByUserId: true,
                createdBy: { select: { name: true } },
            },
        });
        return rows.map((r) => ({
            id: r.id,
            version: r.version,
            createdAt: r.createdAt,
            createdByUserId: r.createdByUserId,
            createdByName: r.createdBy?.name ?? null,
        }));
    }

    /**
     * Epic P5-PR-B — fetch a single snapshot's full graphJson for
     * the "View version N" overlay + visual diff. Capped read; one
     * row by `(processMapId, version)` unique. Returns null when
     * the version isn't found.
     */
    static async getSnapshotByVersion(
        db: PrismaTx,
        ctx: RequestContext,
        mapId: string,
        version: number,
    ): Promise<{
        id: string;
        version: number;
        graphJson: unknown;
        createdAt: Date;
        createdByName: string | null;
    } | null> {
        const row = await db.processMapSnapshot.findFirst({
            where: {
                tenantId: ctx.tenantId,
                processMapId: mapId,
                version,
            },
            select: {
                id: true,
                version: true,
                graphJson: true,
                createdAt: true,
                createdBy: { select: { name: true } },
            },
        });
        if (!row) return null;
        return {
            id: row.id,
            version: row.version,
            graphJson: row.graphJson,
            createdAt: row.createdAt,
            createdByName: row.createdBy?.name ?? null,
        };
    }

    static async softDelete(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        userId: string,
    ): Promise<boolean> {
        const res = await db.processMap.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            data: { deletedAt: new Date(), deletedByUserId: userId },
        });
        return res.count > 0;
    }
}
