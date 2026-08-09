/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock
 * pattern; per-line typing has poor cost/benefit ratio. */

/**
 * "Which farm records back this scheme?"
 *
 * `Evidence.sourceLogEntryId` carries a schema comment naming this query and
 * an `@@index([tenantId, sourceLogEntryId])` built to serve it. Neither had a
 * caller: the index was maintained on every evidence write and read by
 * nothing.
 *
 * The tests that matter here are the ones about what the answer CONTAINS —
 * an auditor asking this question needs to know which of the records backing a
 * practice point nobody has approved yet, and collapsing those into a bare list
 * is how a traceability panel starts overstating a certification.
 */

const mockDb = {
    practiceRequirementLink: { findMany: jest.fn() },
    evidence: { findMany: jest.fn() },
    logEntry: { findMany: jest.fn() },
} as any;

const mockPrisma = {
    framework: { findFirst: jest.fn() },
    frameworkRequirement: { findMany: jest.fn() },
} as any;

jest.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));
jest.mock('@/app-layer/policies/framework.policies', () => ({
    assertCanViewFrameworks: jest.fn(),
}));
jest.mock('@/lib/observability', () => ({
    traceUsecase: jest.fn((_n: string, _c: any, fn: () => any) => fn()),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { listFarmRecordsBackingFramework } from '@/app-layer/usecases/farm-record-traceability';
import { assertCanViewFrameworks } from '@/app-layer/policies/framework.policies';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function givenFramework() {
    mockPrisma.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'GG', name: 'GlobalG.A.P.' });
    mockPrisma.frameworkRequirement.findMany.mockResolvedValue([
        { id: 'req-1', code: 'CB.7.6' },
        { id: 'req-2', code: 'CB.7.9' },
    ]);
}

beforeEach(() => {
    jest.clearAllMocks();
    givenFramework();
    mockDb.practiceRequirementLink.findMany.mockResolvedValue([
        { practiceId: 'ctrl-1', requirementId: 'req-1' },
        { practiceId: 'ctrl-1', requirementId: 'req-2' },
    ]);
    mockDb.evidence.findMany.mockResolvedValue([
        {
            id: 'ev-1', status: 'APPROVED', practiceId: 'ctrl-1', sourceLogEntryId: 'log-1',
            practice: { id: 'ctrl-1', code: 'C-1', name: 'Spray records kept' },
        },
    ]);
    mockDb.logEntry.findMany.mockResolvedValue([
        { id: 'log-1', title: 'Fungicide, block A', type: 'INPUT_APPLICATION', occurredAt: new Date('2026-05-02T08:00:00Z') },
    ]);
});

describe('listFarmRecordsBackingFramework — the answer', () => {
    it('returns the journal entry behind a scheme practice point', async () => {
        const res = await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(res.framework).toEqual({ key: 'GG', name: 'GlobalG.A.P.' });
        expect(res.records).toHaveLength(1);
        expect(res.records[0]).toMatchObject({
            logEntryId: 'log-1',
            title: 'Fungicide, block A',
            type: 'INPUT_APPLICATION',
            occurredAt: '2026-05-02T08:00:00.000Z',
        });
    });

    it('names every requirement the record backs, not just the practice', async () => {
        // One practice mapped to two practice points. An auditor asks about the
        // practice point, so the answer has to carry the codes.
        const res = await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(res.records[0].practices[0].requirementCodes.sort()).toEqual(['CB.7.6', 'CB.7.9']);
        expect(res.records[0].practices[0].practiceName).toBe('Spray records kept');
    });

    it('flags a record whose evidence nobody has approved', async () => {
        mockDb.evidence.findMany.mockResolvedValue([
            {
                id: 'ev-1', status: 'SUBMITTED', practiceId: 'ctrl-1', sourceLogEntryId: 'log-1',
                practice: { id: 'ctrl-1', code: 'C-1', name: 'Spray records kept' },
            },
        ]);
        const res = await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(res.records[0].awaitingReview).toBe(true);
        expect(res.records[0].practices[0].evidenceStatus).toBe('SUBMITTED');
    });

    it('does not flag a record whose evidence is approved', async () => {
        const res = await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(res.records[0].awaitingReview).toBe(false);
    });

    it('groups several practices under one record', async () => {
        mockDb.practiceRequirementLink.findMany.mockResolvedValue([
            { practiceId: 'ctrl-1', requirementId: 'req-1' },
            { practiceId: 'ctrl-2', requirementId: 'req-2' },
        ]);
        mockDb.evidence.findMany.mockResolvedValue([
            { id: 'ev-1', status: 'APPROVED', practiceId: 'ctrl-1', sourceLogEntryId: 'log-1', practice: { id: 'ctrl-1', code: 'C-1', name: 'A' } },
            { id: 'ev-2', status: 'SUBMITTED', practiceId: 'ctrl-2', sourceLogEntryId: 'log-1', practice: { id: 'ctrl-2', code: 'C-2', name: 'B' } },
        ]);
        const res = await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(res.records).toHaveLength(1);
        expect(res.records[0].practices).toHaveLength(2);
        // One unapproved among two is still "awaiting review".
        expect(res.records[0].awaitingReview).toBe(true);
    });
});

describe('listFarmRecordsBackingFramework — the empty answers', () => {
    it('is empty, not an error, when the tenant has not installed the scheme', async () => {
        mockDb.practiceRequirementLink.findMany.mockResolvedValue([]);
        const res = await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(res.records).toEqual([]);
        expect(res.totalRecords).toBe(0);
        expect(mockDb.evidence.findMany).not.toHaveBeenCalled();
    });

    it('is empty when the scheme has no requirements', async () => {
        mockPrisma.frameworkRequirement.findMany.mockResolvedValue([]);
        const res = await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(res.records).toEqual([]);
        expect(mockDb.practiceRequirementLink.findMany).not.toHaveBeenCalled();
    });

    it('is empty when no evidence is derived from a farm record', async () => {
        mockDb.evidence.findMany.mockResolvedValue([]);
        const res = await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(res.records).toEqual([]);
        expect(mockDb.logEntry.findMany).not.toHaveBeenCalled();
    });

    it('throws notFound for an unknown framework', async () => {
        mockPrisma.framework.findFirst.mockResolvedValue(null);
        await expect(listFarmRecordsBackingFramework(ctx, 'NOPE')).rejects.toThrow(/not found/i);
    });
});

describe('listFarmRecordsBackingFramework — query discipline', () => {
    it('checks permission before reading anything', async () => {
        await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(assertCanViewFrameworks).toHaveBeenCalledWith(ctx);
    });

    it('scopes every tenant read to the tenant', async () => {
        await listFarmRecordsBackingFramework(ctx, 'GG');
        for (const call of [
            mockDb.practiceRequirementLink.findMany.mock.calls[0],
            mockDb.evidence.findMany.mock.calls[0],
            mockDb.logEntry.findMany.mock.calls[0],
        ]) {
            expect(call[0].where.tenantId).toBe(ctx.tenantId);
        }
    });

    it('only considers evidence derived from a farm record', async () => {
        await listFarmRecordsBackingFramework(ctx, 'GG');
        const where = mockDb.evidence.findMany.mock.calls[0][0].where;
        expect(where.sourceLogEntryId).toEqual({ not: null });
        expect(where.deletedAt).toBeNull();
    });

    it('excludes soft-deleted journal entries', async () => {
        // A withdrawn record must not appear as backing anything.
        await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(mockDb.logEntry.findMany.mock.calls[0][0].where.deletedAt).toBeNull();
    });

    it('walks the graph in bulk queries, never per row', async () => {
        await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(mockDb.practiceRequirementLink.findMany).toHaveBeenCalledTimes(1);
        expect(mockDb.evidence.findMany).toHaveBeenCalledTimes(1);
        expect(mockDb.logEntry.findMany).toHaveBeenCalledTimes(1);
    });

    it('bounds both reads with take', async () => {
        await listFarmRecordsBackingFramework(ctx, 'GG');
        expect(mockDb.evidence.findMany.mock.calls[0][0].take).toBeGreaterThan(0);
        expect(mockDb.logEntry.findMany.mock.calls[0][0].take).toBeGreaterThan(0);
    });
});
