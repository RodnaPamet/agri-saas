/**
 * Coverage wave 18 — `ProcessMapRepository`.
 *
 * 94 uncovered branches at 30.9%. Most of them live in `replaceGraph`,
 * which is destructive by construction: it deletes the map's entire
 * node and edge set and re-inserts it.
 *
 * That shape makes ORDER the thing worth testing. Every guard —
 * structural validation, the tenant/soft-delete lookup, and the
 * optimistic-concurrency check — must run BEFORE the first
 * `deleteMany`. A refactor that moves any of them after it turns a
 * rejected save into silent data loss: the graph is already gone by the
 * time the error is thrown, and the caller sees a 4xx while the map is
 * now empty.
 */
import { ProcessMapRepository } from '@/app-layer/repositories/ProcessMapRepository';
import { makeRequestContext } from '../../helpers/make-context';
import type { PrismaTx } from '@/lib/db-context';

const ctx = makeRequestContext('ADMIN'); // tenantId: 'tenant-1'

function makeDb() {
    const model = () => ({
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'created' }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({ id: 'updated' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue({ id: 'deleted' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    return {
        processMap: model(),
        processNode: model(),
        processEdge: model(),
        processEdgePractice: model(),
        // replaceGraph writes a version snapshot before returning.
        processMapSnapshot: model(),
    };
}

type FakeDb = ReturnType<typeof makeDb>;
const asTx = (db: FakeDb) => db as unknown as PrismaTx;

const argOf = (fn: jest.Mock) => fn.mock.calls[0][0];
const whereOf = (fn: jest.Mock) => argOf(fn).where;

const node = (nodeKey: string, extra: Record<string, unknown> = {}) => ({
    nodeKey,
    nodeType: 'processStep',
    label: `Step ${nodeKey}`,
    posX: 0,
    posY: 0,
    ...extra,
});
const edge = (edgeKey: string, sourceKey: string, targetKey: string) => ({
    edgeKey,
    sourceKey,
    targetKey,
    edgeKind: 'sequence',
    // Required: the snapshot payload maps over `practices` unguarded.
    practices: [],
});

/** No destructive write of any kind reached the database. */
function expectNoWrites(db: FakeDb) {
    expect(db.processEdge.deleteMany).not.toHaveBeenCalled();
    expect(db.processNode.deleteMany).not.toHaveBeenCalled();
    expect(db.processNode.createMany).not.toHaveBeenCalled();
    expect(db.processEdge.createMany).not.toHaveBeenCalled();
}

let db: FakeDb;
beforeEach(() => {
    db = makeDb();
    // A live, tenant-owned map at version 3 unless a test says otherwise.
    // Carries the full read shape too, because replaceGraph closes by
    // calling getByIdWithGraph through the same findFirst.
    db.processMap.findFirst.mockResolvedValue({
        id: 'm-1',
        name: 'Map',
        description: null,
        status: 'DRAFT',
        version: 3,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        nodes: [],
        edges: [],
    });
});

describe('ProcessMapRepository — replaceGraph rejects before it destroys', () => {
    it('rejects an edge whose source is not in the payload, touching nothing', async () => {
        // Break: moving validation below the deleteMany. The save is
        // still refused, but the map's existing graph is already gone —
        // a rejected request that silently empties the canvas.
        await expect(
            ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
                nodes: [node('a')],
                edges: [edge('e1', 'ghost', 'a')],
            } as never),
        ).rejects.toThrow(/unknown source nodeKey ghost/);

        expectNoWrites(db);
    });

    it('rejects an edge whose target is not in the payload', async () => {
        await expect(
            ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
                nodes: [node('a')],
                edges: [edge('e1', 'a', 'ghost')],
            } as never),
        ).rejects.toThrow(/unknown target nodeKey ghost/);

        expectNoWrites(db);
    });

    it('rejects a node that claims itself as its own parent', async () => {
        // Break: dropping the self-reference check produces a group
        // that contains itself — xyflow recurses forever on render.
        await expect(
            ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
                nodes: [node('a', { parentNodeKey: 'a' })],
                edges: [],
            } as never),
        ).rejects.toThrow(/references itself as parentNodeKey/);

        expectNoWrites(db);
    });

    it('rejects a node whose parent is not in the payload', async () => {
        // The DB cannot catch this: nodeKey is per-map, so there is no
        // FK to enforce it. This check is the only guard.
        await expect(
            ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
                nodes: [node('a', { parentNodeKey: 'ghost' })],
                edges: [],
            } as never),
        ).rejects.toThrow(/unknown parentNodeKey ghost/);

        expectNoWrites(db);
    });

    it('allows a nested group — a parent that is itself a child', async () => {
        // Break: over-strict validation banning recursion. Nested
        // groups are supported and save with an identical shape.
        await expect(
            ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
                nodes: [
                    node('outer'),
                    node('inner', { parentNodeKey: 'outer' }),
                    node('leaf', { parentNodeKey: 'inner' }),
                ],
                edges: [],
            } as never),
        ).resolves.not.toThrow();

        expect(db.processNode.createMany).toHaveBeenCalled();
    });

    it('allows a node with no parent at all', async () => {
        // Break: a null-unsafe check treating "no parent" as a missing
        // reference would reject every flat map.
        await expect(
            ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
                nodes: [node('a'), node('b')],
                edges: [edge('e1', 'a', 'b')],
            } as never),
        ).resolves.not.toThrow();
    });
});

describe('ProcessMapRepository — replaceGraph tenancy and concurrency', () => {
    it('returns null for a map outside the tenant without deleting anything', async () => {
        // Break: deleting first and checking ownership after would let
        // a foreign id wipe rows before the null is returned.
        db.processMap.findFirst.mockResolvedValue(null);

        const result = await ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-foreign', {
            nodes: [node('a')],
            edges: [],
        } as never);

        expect(result).toBeNull();
        expectNoWrites(db);
        expect(whereOf(db.processMap.findFirst)).toEqual({
            id: 'm-foreign',
            tenantId: 'tenant-1',
            deletedAt: null,
        });
    });

    it('refuses a stale write and reports the current version', async () => {
        // Break: skipping the up-front version check. The graph would
        // be deleted and re-inserted before the conditional commit at
        // the end noticed it lost the race — the loser's edit destroys
        // the winner's work.
        db.processMap.findFirst.mockResolvedValue({ id: 'm-1', version: 7 });

        await expect(
            ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
                nodes: [node('a')],
                edges: [],
                expectedVersion: 3,
            } as never),
        ).rejects.toMatchObject({
            details: { currentVersion: 7 },
        });

        expectNoWrites(db);
    });

    it('proceeds when the expected version matches', async () => {
        db.processMap.findFirst.mockResolvedValue({ id: 'm-1', version: 7 });

        await ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
            nodes: [node('a')],
            edges: [],
            expectedVersion: 7,
        } as never);

        expect(db.processNode.createMany).toHaveBeenCalled();
    });

    it('accepts last-write-wins when no expected version is supplied', async () => {
        // Break: making expectedVersion mandatory would 409 every
        // older client bundle still in a browser cache.
        db.processMap.findFirst.mockResolvedValue({ id: 'm-1', version: 7 });

        await ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
            nodes: [node('a')],
            edges: [],
        } as never);

        expect(db.processNode.createMany).toHaveBeenCalled();
    });
});

describe('ProcessMapRepository — replaceGraph write shape', () => {
    it('deletes edges before nodes, both scoped to the tenant', async () => {
        // Break: deleting nodes first orphans edges against the FK and
        // the whole save fails. Order is load-bearing, not stylistic.
        await ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
            nodes: [node('a')],
            edges: [],
        } as never);

        const edgeDelete = db.processEdge.deleteMany.mock.invocationCallOrder[0];
        const nodeDelete = db.processNode.deleteMany.mock.invocationCallOrder[0];
        expect(edgeDelete).toBeLessThan(nodeDelete);

        expect(whereOf(db.processEdge.deleteMany)).toEqual({
            processMapId: 'm-1',
            tenantId: 'tenant-1',
        });
        expect(whereOf(db.processNode.deleteMany)).toEqual({
            processMapId: 'm-1',
            tenantId: 'tenant-1',
        });
    });

    it('clears the graph without inserting when handed an empty node set', async () => {
        // Break: calling createMany with [] — some drivers reject an
        // empty batch outright.
        await ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
            nodes: [],
            edges: [],
        } as never);

        expect(db.processNode.deleteMany).toHaveBeenCalled();
        expect(db.processNode.createMany).not.toHaveBeenCalled();
    });

    it('stamps tenant and map on every inserted node', async () => {
        // Break: an unstamped node row belongs to no tenant and is
        // invisible to RLS afterwards.
        await ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
            nodes: [node('a', { subtitle: 'sub' })],
            edges: [],
        } as never);

        expect(argOf(db.processNode.createMany).data[0]).toMatchObject({
            tenantId: 'tenant-1',
            processMapId: 'm-1',
            nodeKey: 'a',
            subtitle: 'sub',
        });
    });

    it('inserts a fully-populated edge with its practices attached', async () => {
        // Every other fixture here leaves edges bare, which never
        // exercises the practice-attachment arm. Break: dropping the
        // practices insert silently unlinks every practice from the
        // process map on the next save — the traceability panel goes
        // empty with no error anywhere.
        await ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
            nodes: [
                node('a', { dataJson: { kind: 'step' } }),
                node('b'),
            ],
            edges: [
                {
                    edgeKey: 'e1',
                    sourceKey: 'a',
                    targetKey: 'b',
                    edgeKind: 'sequence',
                    labelOverride: 'approves',
                    dataJson: { weight: 2 },
                    practices: [
                        { practiceKey: 'c1', label: 'AC-1' },
                    ],
                },
            ],
        } as never);

        // Edges are inserted one at a time rather than in a batch,
        // because each edge's generated id is needed to attach its
        // practices in the follow-up createMany.
        expect(argOf(db.processEdge.create).data).toMatchObject({
            tenantId: 'tenant-1',
            processMapId: 'm-1',
            edgeKey: 'e1',
            labelOverride: 'approves',
        });
        expect(argOf(db.processEdgePractice.createMany).data[0]).toMatchObject({
            tenantId: 'tenant-1',
            practiceKey: 'c1',
            label: 'AC-1',
        });
        // The snapshot payload carries the practices through verbatim.
        const snapshot = argOf(db.processMapSnapshot.create).data;
        expect(snapshot.graphJson.edges[0].practices).toEqual([
            { practiceKey: 'c1', label: 'AC-1', dataJson: null },
        ]);
    });

    it('null-coerces an absent subtitle and parent', async () => {
        // Break: writing undefined to a nullable column.
        await ProcessMapRepository.replaceGraph(asTx(db), ctx, 'm-1', {
            nodes: [node('a')],
            edges: [],
        } as never);

        const row = argOf(db.processNode.createMany).data[0];
        expect(row.subtitle).toBeNull();
        expect(row.parentNodeKey).toBeNull();
    });
});

describe('ProcessMapRepository — reads', () => {
    it('lists live maps only, flattening the relation counts', async () => {
        // Break: dropping `deletedAt: null` resurfaces deleted maps
        // into the picker.
        db.processMap.findMany.mockResolvedValue([
            {
                id: 'm-1',
                name: 'Onboarding',
                description: null,
                status: 'DRAFT',
                version: 2,
                canvasMode: 'DOCUMENT',
                createdAt: new Date(0),
                updatedAt: new Date(0),
                _count: { nodes: 4, edges: 3 },
            },
        ]);

        const rows = await ProcessMapRepository.list(asTx(db), ctx);

        expect(whereOf(db.processMap.findMany)).toEqual({
            tenantId: 'tenant-1',
            deletedAt: null,
        });
        expect(rows[0].nodeCount).toBe(4);
        expect(rows[0].edgeCount).toBe(3);
        expect(rows[0]).not.toHaveProperty('_count');
    });

    it('reads a single map scoped to tenant and not-deleted', async () => {
        db.processMap.findFirst.mockResolvedValue({
            id: 'm-1',
            name: 'x',
            description: null,
            status: 'DRAFT',
            version: 1,
            createdAt: new Date(0),
            updatedAt: new Date(0),
            nodes: [],
            edges: [],
        });

        await ProcessMapRepository.getByIdWithGraph(asTx(db), ctx, 'm-1');

        expect(whereOf(db.processMap.findFirst)).toEqual({
            id: 'm-1',
            tenantId: 'tenant-1',
            deletedAt: null,
        });
    });

    it('returns null rather than a partial object when the map is missing', async () => {
        // Break: dereferencing a null map to build the return shape.
        db.processMap.findFirst.mockResolvedValue(null);

        const result = await ProcessMapRepository.getByIdWithGraph(asTx(db), ctx, 'gone');

        expect(result).toBeNull();
    });
});

describe('ProcessMapRepository — snapshots', () => {
    it('lists a map\'s snapshots newest-version-first, scoped and bounded', async () => {
        // Break: an unscoped snapshot list leaks another tenant's
        // graph history, which contains the full map payload.
        db.processMapSnapshot.findMany.mockResolvedValue([
            { id: 's-1', version: 2, createdAt: new Date(0), createdBy: { name: 'Ivo' } },
        ]);

        const rows = await ProcessMapRepository.listSnapshots(asTx(db), ctx, 'm-1');

        const arg = argOf(db.processMapSnapshot.findMany);
        expect(arg.where).toEqual({ tenantId: 'tenant-1', processMapId: 'm-1' });
        expect(arg.orderBy).toEqual({ version: 'desc' });
        expect(arg.take).toBe(200);
        expect(rows[0].createdByName).toBe('Ivo');
    });

    it('reports a null author rather than throwing when the user is gone', async () => {
        // Break: `r.createdBy.name` without the optional chain — a
        // deleted author would crash the whole version timeline.
        db.processMapSnapshot.findMany.mockResolvedValue([
            { id: 's-1', version: 2, createdAt: new Date(0), createdBy: null },
        ]);

        const rows = await ProcessMapRepository.listSnapshots(asTx(db), ctx, 'm-1');

        expect(rows[0].createdByName).toBeNull();
    });

    it('pins a snapshot read to tenant, map AND version', async () => {
        // Break: dropping processMapId would let a version number from
        // one map return another map's snapshot.
        db.processMapSnapshot.findFirst.mockResolvedValue({
            id: 's-1',
            version: 2,
            graphJson: {},
            createdAt: new Date(0),
            createdBy: { name: 'Ivo' },
        });

        await ProcessMapRepository.getSnapshotByVersion(asTx(db), ctx, 'm-1', 2);

        expect(whereOf(db.processMapSnapshot.findFirst)).toEqual({
            tenantId: 'tenant-1',
            processMapId: 'm-1',
            version: 2,
        });
    });

    it('returns null for a version that does not exist', async () => {
        db.processMapSnapshot.findFirst.mockResolvedValue(null);

        const result = await ProcessMapRepository.getSnapshotByVersion(asTx(db), ctx, 'm-1', 99);

        expect(result).toBeNull();
    });
});

describe('ProcessMapRepository — soft delete', () => {
    it('stamps the deleter and only touches a live map in the tenant', async () => {
        // Break: omitting `deletedAt: null` lets an already-deleted map
        // be "deleted" again, overwriting who removed it originally.
        const before = Date.now();
        db.processMap.updateMany.mockResolvedValue({ count: 1 });

        const ok = await ProcessMapRepository.softDelete(asTx(db), ctx, 'm-1', 'user-9');

        expect(ok).toBe(true);
        const arg = argOf(db.processMap.updateMany);
        expect(arg.where).toEqual({
            id: 'm-1',
            tenantId: 'tenant-1',
            deletedAt: null,
        });
        expect(arg.data.deletedByUserId).toBe('user-9');
        expect((arg.data.deletedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('reports failure when no live map matched', async () => {
        db.processMap.updateMany.mockResolvedValue({ count: 0 });

        const ok = await ProcessMapRepository.softDelete(asTx(db), ctx, 'm-x', 'user-9');

        expect(ok).toBe(false);
    });

});

describe('ProcessMapRepository — canvas mode and create', () => {
    it('reports failure when no live map in the tenant matched', async () => {
        // Break: returning true unconditionally would tell the UI a
        // mode flip succeeded on a map the caller cannot even see.
        db.processMap.updateMany.mockResolvedValue({ count: 0 });

        const ok = await ProcessMapRepository.setCanvasMode(asTx(db), ctx, 'm-x', 'AUTOMATION');

        expect(ok).toBe(false);
        expect(whereOf(db.processMap.updateMany)).toEqual({
            id: 'm-x',
            tenantId: 'tenant-1',
            deletedAt: null,
        });
    });

    it('reports success when a row was updated', async () => {
        db.processMap.updateMany.mockResolvedValue({ count: 1 });

        const ok = await ProcessMapRepository.setCanvasMode(asTx(db), ctx, 'm-1', 'AUTOMATION');

        expect(ok).toBe(true);
    });

    it('creates with documented defaults and an empty graph', async () => {
        // Break: defaulting to PUBLISHED or AUTOMATION would put new
        // maps live, or into the wrong editor, on creation.
        db.processMap.create.mockResolvedValue({
            id: 'm-new',
            name: 'New map',
            description: null,
            status: 'DRAFT',
            version: 1,
            createdAt: new Date(0),
            updatedAt: new Date(0),
        });

        const result = await ProcessMapRepository.create(asTx(db), ctx, {
            name: 'New map',
            createdByUserId: 'user-1',
        } as never);

        expect(argOf(db.processMap.create).data).toMatchObject({
            tenantId: 'tenant-1',
            name: 'New map',
            description: null,
            status: 'DRAFT',
            canvasMode: 'DOCUMENT',
            createdByUserId: 'user-1',
        });
        expect(result.nodes).toEqual([]);
        expect(result.edges).toEqual([]);
    });
});
