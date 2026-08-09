/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/finding.ts`.
 *
 * Roadmap Q3 — Work items (Supporting tier, 42% statements, +28 to
 * floor). Mocks FindingRepository + Prisma db + audit emitter +
 * sanitisation helper.
 *
 * Covers:
 *   - validateFindingRefs — tenant-isolation validator for assignee,
 *     control, compensatingControl. Each error path has its own
 *     assertion.
 *   - listFindings / getFinding — read paths.
 *   - createFinding — Epic D.2 sanitisation across every free-text
 *     column, audit shape.
 *   - updateFinding — three-state sanitiseOptional contract for free-
 *     text, three-state on FK relations (assigneeUserId / controlId /
 *     compensatingControlId)
 *     (undefined = no touch, [] = clear all, [...] = replace),
 *     verifiedAt + verifiedBy auto-population on CLOSED, status-change
 *     vs entity-lifecycle audit branch.
 */

const mockDb = {
    tenantMembership: { findFirst: jest.fn() },
    control: { findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/FindingRepository', () => ({
    FindingRepository: {
        list: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
}));

import { FindingRepository } from '@/app-layer/repositories/FindingRepository';
import { logEvent } from '@/app-layer/events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    listFindings,
    getFinding,
    createFinding,
    updateFinding,
} from '@/app-layer/usecases/finding';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
    (sanitizePlainText as jest.Mock).mockImplementation((s: string) => `SAN::${s}`);
});

const editorCtx = makeRequestContext('EDITOR', { userId: 'user-editor' });
const readerCtx = makeRequestContext('READER');

// ─── listFindings / getFinding ─────────────────────────────────────

describe('listFindings', () => {
    it('delegates under the read gate', async () => {
        (FindingRepository.list as jest.Mock).mockResolvedValue([{ id: 'f-1' }]);
        const rows = await listFindings(readerCtx);
        expect(rows).toEqual([{ id: 'f-1' }]);
        expect(FindingRepository.list).toHaveBeenCalledWith(mockDb, readerCtx, {});
    });

    it('forwards take option to the repository', async () => {
        (FindingRepository.list as jest.Mock).mockResolvedValue([]);
        await listFindings(readerCtx, { take: 25 });
        expect(FindingRepository.list).toHaveBeenCalledWith(mockDb, readerCtx, { take: 25 });
    });
});

describe('getFinding', () => {
    it('returns the row on hit', async () => {
        (FindingRepository.getById as jest.Mock).mockResolvedValue({ id: 'f-1' });
        await expect(getFinding(readerCtx, 'f-1')).resolves.toEqual({ id: 'f-1' });
    });

    it('throws notFound on miss', async () => {
        (FindingRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getFinding(readerCtx, 'missing')).rejects.toThrow(/Finding not found/i);
    });
});

// ─── createFinding — validation + sanitisation ─────────────────────

describe('createFinding — reference validation', () => {
    it('rejects an inactive/foreign assigneeUserId (INVALID_ASSIGNEE)', async () => {
        (mockDb.tenantMembership.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(createFinding(editorCtx, {
            title: 'F', severity: 'HIGH', type: 'GAP', assigneeUserId: 'foreign-user',
        } as any)).rejects.toThrow(/INVALID_ASSIGNEE/);
    });

    it('rejects an inaccessible controlId (INVALID_CONTROL)', async () => {
        (mockDb.control.findMany as jest.Mock).mockResolvedValue([]);
        await expect(createFinding(editorCtx, {
            title: 'F', severity: 'HIGH', type: 'GAP', controlId: 'foreign-control',
        } as any)).rejects.toThrow(/INVALID_CONTROL/);
    });

    it('rejects an inaccessible compensatingControlId (INVALID_COMPENSATING_CONTROL)', async () => {
        (mockDb.control.findMany as jest.Mock).mockResolvedValue([{ id: 'c-1' }]); // only one of two matches
        await expect(createFinding(editorCtx, {
            title: 'F', severity: 'HIGH', type: 'GAP', controlId: 'c-1', compensatingControlId: 'c-ghost',
        } as any)).rejects.toThrow(/INVALID_COMPENSATING_CONTROL/);
    });


});

describe('createFinding — sanitisation + audit', () => {
    it('sanitises every free-text column', async () => {
        (FindingRepository.create as jest.Mock).mockResolvedValue({ id: 'f-1', title: 'SAN::F' });

        await createFinding(editorCtx, {
            title: 'F', severity: 'HIGH', type: 'GAP',
            description: 'd', rootCause: 'rc', correctiveAction: 'ca', analysis: 'a', owner: 'o',
        } as any);

        const createArgs = (FindingRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.title).toBe('SAN::F');
        expect(createArgs.description).toBe('SAN::d');
        expect(createArgs.rootCause).toBe('SAN::rc');
        expect(createArgs.correctiveAction).toBe('SAN::ca');
        expect(createArgs.analysis).toBe('SAN::a');
        expect(createArgs.owner).toBe('SAN::o');
    });

    it('preserves OPEN as the starting status', async () => {
        (FindingRepository.create as jest.Mock).mockResolvedValue({ id: 'f-1', title: 'X' });
        await createFinding(editorCtx, { title: 'F', severity: 'HIGH', type: 'GAP' } as any);
        const createArgs = (FindingRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.status).toBe('OPEN');
    });

    it('emits a CREATE audit', async () => {
        (FindingRepository.create as jest.Mock).mockResolvedValue({ id: 'f-1', title: 'X' });
        await createFinding(editorCtx, { title: 'F', severity: 'HIGH', type: 'GAP' } as any);
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CREATE');
    });

    it('rejects READER (write gate)', async () => {
        await expect(createFinding(readerCtx, { title: 'F', severity: 'HIGH', type: 'GAP' } as any))
            .rejects.toBeDefined();
        expect(FindingRepository.create).not.toHaveBeenCalled();
    });
});

// ─── updateFinding — three-state semantics ─────────────────────────

describe('updateFinding — three-state contract', () => {
    it('throws notFound when the finding does not exist', async () => {
        (FindingRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(updateFinding(editorCtx, 'missing', { title: 'X' } as any))
            .rejects.toThrow(/Finding not found/i);
    });

    it('omits free-text fields when undefined (no change)', async () => {
        (FindingRepository.getById as jest.Mock).mockResolvedValue({ id: 'f-1', status: 'OPEN' });
        (FindingRepository.update as jest.Mock).mockResolvedValue({ id: 'f-1' });

        await updateFinding(editorCtx, 'f-1', { severity: 'HIGH' } as any);

        const updateArgs = (FindingRepository.update as jest.Mock).mock.calls[0][3];
        // Sanitised value is `undefined` because input was undefined
        expect(updateArgs.title).toBeUndefined();
        expect(updateArgs.description).toBeUndefined();
    });

    it('forwards null FK relations as null (explicit clear)', async () => {
        (FindingRepository.getById as jest.Mock).mockResolvedValue({ id: 'f-1', status: 'OPEN' });
        (FindingRepository.update as jest.Mock).mockResolvedValue({ id: 'f-1' });

        await updateFinding(editorCtx, 'f-1', {
            assigneeUserId: null, controlId: null, compensatingControlId: null,
        } as any);

        const updateArgs = (FindingRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.assigneeUserId).toBeNull();
        expect(updateArgs.controlId).toBeNull();
        expect(updateArgs.compensatingControlId).toBeNull();
    });




    it('auto-populates verifiedBy + verifiedAt when status moves to CLOSED', async () => {
        (FindingRepository.getById as jest.Mock).mockResolvedValue({ id: 'f-1', status: 'OPEN' });
        (FindingRepository.update as jest.Mock).mockResolvedValue({ id: 'f-1' });

        await updateFinding(editorCtx, 'f-1', { status: 'CLOSED' } as any);

        const updateArgs = (FindingRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.verifiedBy).toBe(editorCtx.userId);
        expect(updateArgs.verifiedAt).toBeInstanceOf(Date);
    });

    it('does NOT populate verifiedBy on non-CLOSED status', async () => {
        (FindingRepository.getById as jest.Mock).mockResolvedValue({ id: 'f-1', status: 'OPEN' });
        (FindingRepository.update as jest.Mock).mockResolvedValue({ id: 'f-1' });

        await updateFinding(editorCtx, 'f-1', { status: 'IN_PROGRESS' } as any);

        const updateArgs = (FindingRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.verifiedBy).toBeUndefined();
        expect(updateArgs.verifiedAt).toBeUndefined();
    });
});

describe('updateFinding — audit branching', () => {
    it('emits STATUS_CHANGE when status changes', async () => {
        (FindingRepository.getById as jest.Mock).mockResolvedValue({ id: 'f-1', status: 'OPEN' });
        (FindingRepository.update as jest.Mock).mockResolvedValue({ id: 'f-1' });

        await updateFinding(editorCtx, 'f-1', { status: 'CLOSED' } as any);

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('STATUS_CHANGE');
        expect(payload.detailsJson.fromStatus).toBe('OPEN');
        expect(payload.detailsJson.toStatus).toBe('CLOSED');
    });

    it('emits UPDATE when status is unchanged', async () => {
        (FindingRepository.getById as jest.Mock).mockResolvedValue({ id: 'f-1', status: 'OPEN' });
        (FindingRepository.update as jest.Mock).mockResolvedValue({ id: 'f-1' });

        await updateFinding(editorCtx, 'f-1', { title: 'X' } as any);

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('UPDATE');
    });

    it('treats same-status update as UPDATE (not STATUS_CHANGE)', async () => {
        (FindingRepository.getById as jest.Mock).mockResolvedValue({ id: 'f-1', status: 'OPEN' });
        (FindingRepository.update as jest.Mock).mockResolvedValue({ id: 'f-1' });

        await updateFinding(editorCtx, 'f-1', { status: 'OPEN', title: 'X' } as any);

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('UPDATE');
    });
});
