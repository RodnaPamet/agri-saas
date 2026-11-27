/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Roadmap-26 PR-A — ProcessMap usecase tests.
 *
 * Pure-memory tests of create / list / get / save / delete:
 * Prisma and the audit emitter are mocked. The repo is mocked at
 * the boundary so each usecase's contract can be asserted without
 * needing a real DB.
 */

// VR-3 — save/get now probe canvasMode to gate the canvas↔rule sync.
// Default to a DOCUMENT map so the existing assertions (non-automation path)
// are unaffected.
const mockDb = {
    processMap: { findFirst: jest.fn().mockResolvedValue({ canvasMode: 'DOCUMENT' }) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: any, fn: (db: any) => any) => fn(mockDb),
    ),
}));

jest.mock('@/app-layer/repositories/ProcessMapRepository', () => ({
    ProcessMapRepository: {
        list: jest.fn(),
        getByIdWithGraph: jest.fn(),
        create: jest.fn(),
        replaceGraph: jest.fn(),
        softDelete: jest.fn(),
        setCanvasMode: jest.fn(),
    },
}));

/**
 * The CERTIFICATION gate (#3291) reads `TenantModuleSettings`, so the real
 * `assertModuleEnabled` needs a database this suite does not have — every
 * write failed with `Cannot read properties of undefined (reading
 * 'findUnique')` the moment the gate was added.
 *
 * Mocked as a SPY rather than stubbed away, so the cases below still prove
 * the gate is INVOKED on a write and NOT on a read. Without that the guard
 * `process-map-writes-are-module-gated` would be asserting the call exists in
 * the source while nothing executed it — which is the gap between a guard and
 * a behavioural test this repo keeps naming.
 */
jest.mock('@/app-layer/usecases/modules', () => ({
    assertModuleEnabled: jest.fn(async () => undefined),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

import { ProcessMapRepository } from '@/app-layer/repositories/ProcessMapRepository';
import { logEvent } from '@/app-layer/events/audit';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import {
    listProcessMaps,
    getProcessMap,
    createProcessMap,
    saveProcessMap,
    setProcessMapCanvasMode,
    deleteProcessMap,
} from '@/app-layer/usecases/process-map';

function makeCtx(role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'READER'): RequestContext {
    return {
        requestId: `req-${role}`,
        userId: `user-${role.toLowerCase()}`,
        tenantId: 'tenant-1',
        role: role as any,
        permissions: {
            canRead: true,
            canWrite: role !== 'READER',
            canAdmin: role === 'OWNER' || role === 'ADMIN',
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole(role),
    };
}

const writerCtx = makeCtx('ADMIN');
const readerCtx = makeCtx('READER');

const SAMPLE_MAP = {
    id: 'pm-1',
    name: 'Order-to-cash',
    description: null,
    status: 'DRAFT' as const,
    version: 1,
    createdAt: new Date('2026-05-19T10:00:00Z'),
    updatedAt: new Date('2026-05-19T10:00:00Z'),
    nodes: [],
    edges: [],
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('listProcessMaps', () => {
    it('returns the repo output untouched', async () => {
        (ProcessMapRepository.list as jest.Mock).mockResolvedValue([
            { ...SAMPLE_MAP, nodeCount: 0, edgeCount: 0 },
        ]);

        const result = await listProcessMaps(writerCtx);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('pm-1');
        expect(ProcessMapRepository.list).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
        );
    });

    it('allows readers to list', async () => {
        (ProcessMapRepository.list as jest.Mock).mockResolvedValue([]);
        await expect(listProcessMaps(readerCtx)).resolves.toEqual([]);
    });
});

describe('getProcessMap', () => {
    it('returns the loaded map', async () => {
        (ProcessMapRepository.getByIdWithGraph as jest.Mock).mockResolvedValue(
            SAMPLE_MAP,
        );

        const result = await getProcessMap(writerCtx, 'pm-1');

        expect(result.id).toBe('pm-1');
        expect(ProcessMapRepository.getByIdWithGraph).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            'pm-1',
        );
    });

    it('throws notFound when the repo returns null', async () => {
        (ProcessMapRepository.getByIdWithGraph as jest.Mock).mockResolvedValue(
            null,
        );
        await expect(getProcessMap(writerCtx, 'missing')).rejects.toThrow(
            'Process map not found',
        );
    });
});

describe('createProcessMap', () => {
    it('creates the map and emits a lifecycle audit event', async () => {
        (ProcessMapRepository.create as jest.Mock).mockResolvedValue(SAMPLE_MAP);

        const result = await createProcessMap(writerCtx, {
            name: 'Order-to-cash',
        });

        expect(result.id).toBe('pm-1');
        expect(ProcessMapRepository.create).toHaveBeenCalledWith(mockDb, writerCtx, {
            name: 'Order-to-cash',
            description: null,
            status: undefined,
            createdByUserId: writerCtx.userId,
        });
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            expect.objectContaining({
                action: 'CREATE',
                entityType: 'ProcessMap',
                entityId: 'pm-1',
                detailsJson: expect.objectContaining({
                    operation: 'created',
                }),
            }),
        );
    });

    it('rejects readers', async () => {
        await expect(
            createProcessMap(readerCtx, { name: 'X' }),
        ).rejects.toThrow(/permission/i);
        expect(ProcessMapRepository.create).not.toHaveBeenCalled();
    });
});

describe('saveProcessMap', () => {
    it('replaces the graph and bumps version via the repo', async () => {
        (ProcessMapRepository.replaceGraph as jest.Mock).mockResolvedValue({
            ...SAMPLE_MAP,
            version: 2,
            nodes: [
                {
                    nodeKey: 'node-1',
                    nodeType: 'processStep',
                    label: 'Receive order',
                    subtitle: null,
                    posX: 0,
                    posY: 0,
                    dataJson: null,
                },
            ],
            edges: [],
        });

        const result = await saveProcessMap(writerCtx, 'pm-1', {
            nodes: [
                {
                    nodeKey: 'node-1',
                    nodeType: 'processStep',
                    label: 'Receive order',
                    posX: 0,
                    posY: 0,
                },
            ],
            edges: [],
        });

        expect(result.version).toBe(2);
        expect(result.nodes).toHaveLength(1);
        expect(ProcessMapRepository.replaceGraph).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            'pm-1',
            expect.objectContaining({
                nodes: expect.arrayContaining([
                    expect.objectContaining({ nodeKey: 'node-1' }),
                ]),
                edges: [],
            }),
        );
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            expect.objectContaining({
                action: 'UPDATE',
                entityType: 'ProcessMap',
                entityId: 'pm-1',
                detailsJson: expect.objectContaining({
                    operation: 'updated',
                    after: expect.objectContaining({ version: 2 }),
                }),
            }),
        );
    });

    it('throws notFound when the map does not exist', async () => {
        (ProcessMapRepository.replaceGraph as jest.Mock).mockResolvedValue(null);
        await expect(
            saveProcessMap(writerCtx, 'pm-missing', { nodes: [], edges: [] }),
        ).rejects.toThrow('Process map not found');
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('rejects readers', async () => {
        await expect(
            saveProcessMap(readerCtx, 'pm-1', { nodes: [], edges: [] }),
        ).rejects.toThrow(/permission/i);
    });

    it('forwards expectedVersion to the repo (Epic P1)', async () => {
        // The usecase is a thin orchestration layer — `expectedVersion`
        // arrives from the route's Zod-validated body and must flow to
        // the repo verbatim. Anchoring this here means a future
        // refactor that silently drops the field gets caught before
        // anyone notices the concurrency check stopped firing.
        (ProcessMapRepository.replaceGraph as jest.Mock).mockResolvedValue({
            ...SAMPLE_MAP,
            version: 3,
            nodes: [],
            edges: [],
        });

        await saveProcessMap(writerCtx, 'pm-1', {
            nodes: [],
            edges: [],
            expectedVersion: 2,
        });

        expect(ProcessMapRepository.replaceGraph).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            'pm-1',
            expect.objectContaining({ expectedVersion: 2 }),
        );
    });
});

describe('deleteProcessMap', () => {
    it('soft-deletes and emits an audit event', async () => {
        (ProcessMapRepository.softDelete as jest.Mock).mockResolvedValue(true);

        const result = await deleteProcessMap(writerCtx, 'pm-1');

        expect(result.id).toBe('pm-1');
        expect(ProcessMapRepository.softDelete).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            'pm-1',
            writerCtx.userId,
        );
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            expect.objectContaining({ action: 'DELETE', entityType: 'ProcessMap' }),
        );
    });

    it('throws notFound when the row was already gone', async () => {
        (ProcessMapRepository.softDelete as jest.Mock).mockResolvedValue(false);
        await expect(deleteProcessMap(writerCtx, 'pm-missing')).rejects.toThrow(
            'Process map not found',
        );
    });
});

describe('setProcessMapCanvasMode', () => {
    it('switches mode + audits when the map exists', async () => {
        (ProcessMapRepository.setCanvasMode as jest.Mock).mockResolvedValue(true);
        const res = await setProcessMapCanvasMode(writerCtx, 'pm-1', 'AUTOMATION');
        expect(res).toEqual({ id: 'pm-1', canvasMode: 'AUTOMATION' });
        expect(ProcessMapRepository.setCanvasMode).toHaveBeenCalledWith(
            mockDb, writerCtx, 'pm-1', 'AUTOMATION',
        );
        expect(logEvent).toHaveBeenCalled();
    });

    it('throws notFound when no map matched', async () => {
        (ProcessMapRepository.setCanvasMode as jest.Mock).mockResolvedValue(false);
        await expect(
            setProcessMapCanvasMode(writerCtx, 'pm-missing', 'DOCUMENT'),
        ).rejects.toThrow('Process map not found');
    });

    it('rejects a reader (no write permission)', async () => {
        await expect(
            setProcessMapCanvasMode(makeCtx('READER'), 'pm-1', 'AUTOMATION'),
        ).rejects.toBeDefined();
    });
});

// ─── The CERTIFICATION gate is INVOKED, not merely present (#3291) ───

describe('CERTIFICATION gating', () => {
    beforeEach(() => {
        (assertModuleEnabled as jest.Mock).mockClear();
    });

    it('a WRITE asserts the module', async () => {
        (ProcessMapRepository.create as jest.Mock).mockResolvedValue({ id: 'pm-1' });
        await createProcessMap(writerCtx, { name: 'Map' } as never);
        expect(assertModuleEnabled).toHaveBeenCalledWith(
            expect.anything(),
            'CERTIFICATION',
        );
    });

    it('a READ does NOT — a farm keeps what it already made', async () => {
        // Owner ruling 2026-11-27: writes gated, reads open. Asserted as a
        // NEGATIVE so a later change that gates reads wholesale has to come
        // past this test rather than sliding in as tidying.
        (ProcessMapRepository.getByIdWithGraph as jest.Mock).mockResolvedValue({ id: 'pm-1' });
        await getProcessMap(writerCtx, 'pm-1');
        expect(assertModuleEnabled).not.toHaveBeenCalled();
    });

    it('the gate runs BEFORE the repository is touched', async () => {
        // Order matters: a disabled module must not reach the database at
        // all, or the refusal costs a query and any side effect before it.
        (assertModuleEnabled as jest.Mock).mockRejectedValueOnce(
            new Error('MODULE_DISABLED'),
        );
        (ProcessMapRepository.softDelete as jest.Mock).mockClear();
        await expect(deleteProcessMap(writerCtx, 'pm-1')).rejects.toThrow('MODULE_DISABLED');
        expect(ProcessMapRepository.softDelete).not.toHaveBeenCalled();
    });
});
