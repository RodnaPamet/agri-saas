/**
 * The retention sweep (#2495 step 5).
 *
 * Prisma is mocked, so this proves the SELECTION, the tombstone shape, the
 * deferral and the ordering of the two writes. It says nothing about RLS or
 * about the CHECK constraints — those are the database's, and step 1 already
 * covers them in `farm-document-rls`.
 *
 * What it does cover that an integration test would struggle to: the
 * `today` seam. The sweep's whole correctness is a comparison against the
 * farm's calendar day, and a test that cannot move that day can assert the
 * shape of the query and nothing about its verdict.
 */
const tx = {
    farmDocument: { update: jest.fn() },
    fileRecord: { update: jest.fn() },
};
const db = {
    farmDocument: { findMany: jest.fn() },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: db }));

const del = jest.fn();
jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => ({ delete: del }),
}));

const warn = jest.fn();
const error = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => warn(...a), error: (...a: unknown[]) => error(...a), info: jest.fn() },
}));

import { runDocumentRetentionSweep } from '@/app-layer/jobs/document-retention-sweep';

const TODAY = '2026-10-31';

function doc(over: Record<string, unknown> = {}) {
    return {
        id: 'doc-1',
        tenantId: 'tenant-1',
        driveState: 'OFF',
        expiresOn: '2026-10-30',
        fileRecordId: 'file-1',
        fileRecord: { pathKey: 'tenants/tenant-1/documents/x.pdf', status: 'STORED' },
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    db.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    db.farmDocument.findMany.mockResolvedValue([]);
});

describe('what the sweep selects', () => {
    it('asks for expired, not-yet-purged documents, oldest first', async () => {
        await runDocumentRetentionSweep({ today: TODAY });
        const args = db.farmDocument.findMany.mock.calls[0][0];
        expect(args.where.purgedAt).toBeNull();
        expect(args.where.expiresOn).toMatchObject({ lte: TODAY });
        expect(args.orderBy).toEqual({ expiresOn: 'asc' });
    });

    it('excludes «Без срок» explicitly, not just by SQL accident', async () => {
        // A `lte` over a nullable column already excludes NULL, because a
        // comparison against NULL is never true. The filter says so anyway:
        // this is the one place where a reader must not have to work out that
        // null means NEVER rather than the beginning of time, and a nullable
        // column under a `lte` is exactly where that goes wrong.
        await runDocumentRetentionSweep({ today: TODAY });
        expect(db.farmDocument.findMany.mock.calls[0][0].where.expiresOn.not).toBeNull();
    });

    it('is bounded, and the bound is overridable', async () => {
        await runDocumentRetentionSweep({ today: TODAY });
        expect(db.farmDocument.findMany.mock.calls[0][0].take).toBe(200);
        await runDocumentRetentionSweep({ today: TODAY, limit: 7 });
        expect(db.farmDocument.findMany.mock.calls[1][0].take).toBe(7);
    });

    it('uses the farm day when no override is given', async () => {
        // The seam must not change the DEFAULT. A sweep that only ever ran
        // against an injected day would pass every test and purge nothing in
        // production.
        await runDocumentRetentionSweep({});
        const used = db.farmDocument.findMany.mock.calls[0][0].where.expiresOn.lte;
        expect(used).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe('the EXPIRED tombstone', () => {
    it('stamps purgeReason EXPIRED with NO person, and does not touch the name', async () => {
        db.farmDocument.findMany.mockResolvedValue([doc()]);
        await runDocumentRetentionSweep({ today: TODAY });

        const data = tx.farmDocument.update.mock.calls[0][0].data;
        expect(data.purgeReason).toBe('EXPIRED');
        expect(data.purgedAt).toBeInstanceOf(Date);
        expect(data.purgedByUserId).toBeNull();
        // The owner ruling, and the half a reader is most likely to "tidy up"
        // into symmetry with the manual delete: an EXPIRED tombstone KEEPS its
        // name, because expiry is policy and the farm's index of what it held
        // is the point.
        expect(data).not.toHaveProperty('name');
    });

    it('moves the FileRecord to DELETED in the SAME transaction', async () => {
        // A document marked purged whose record still reads STORED is a state
        // the download gate would serve from — and the gate asks the record.
        db.farmDocument.findMany.mockResolvedValue([doc()]);
        await runDocumentRetentionSweep({ today: TODAY });
        expect(db.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.fileRecord.update).toHaveBeenCalledWith({
            where: { id: 'file-1' },
            data: { status: 'DELETED' },
        });
    });

    it('deletes the bytes AFTER the tombstone commits', async () => {
        const order: string[] = [];
        db.farmDocument.findMany.mockResolvedValue([doc()]);
        db.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => {
            order.push('tombstone');
            return fn(tx);
        });
        del.mockImplementation(async () => { order.push('bytes'); });
        await runDocumentRetentionSweep({ today: TODAY });
        expect(order).toEqual(['tombstone', 'bytes']);
    });

    it('a failed byte deletion does NOT undo the tombstone, and says so', async () => {
        db.farmDocument.findMany.mockResolvedValue([doc()]);
        del.mockRejectedValue(new Error('object store unreachable'));
        const { result } = await runDocumentRetentionSweep({ today: TODAY });
        expect(result.itemsActioned).toBe(1);
        expect(error).toHaveBeenCalledWith(
            'document-retention-sweep.bytes_survived_tombstone',
            expect.objectContaining({ documentId: 'doc-1' }),
        );
    });

    it('a failed tombstone leaves the bytes alone', async () => {
        // The ordering matters in the other direction too: nothing was
        // stamped, so the document is still live and tomorrow selects it
        // again. Deleting its bytes now would destroy a document the database
        // says exists.
        db.farmDocument.findMany.mockResolvedValue([doc()]);
        db.$transaction.mockRejectedValue(new Error('deadlock'));
        const { result } = await runDocumentRetentionSweep({ today: TODAY });
        expect(del).not.toHaveBeenCalled();
        expect(result.itemsActioned).toBe(0);
        expect(result.details).toMatchObject({ failed: 1 });
    });
});

describe('the in-flight Drive copy is deferred, and counted', () => {
    it('skips a PENDING copy without purging or deleting anything', async () => {
        db.farmDocument.findMany.mockResolvedValue([doc({ driveState: 'PENDING' })]);
        const { result } = await runDocumentRetentionSweep({ today: TODAY });
        expect(tx.farmDocument.update).not.toHaveBeenCalled();
        expect(del).not.toHaveBeenCalled();
        expect(result.details).toMatchObject({ deferredForDriveCopy: 1 });
    });

    it.each([['OFF'], ['COPIED'], ['FAILED']])('purges a %s copy', async (state) => {
        // The other three states are all terminal, and Decision 2 destroys the
        // bytes in every one of them — COPIED keeps only the Drive copy, which
        // is not ours to delete.
        db.farmDocument.findMany.mockResolvedValue([doc({ driveState: state })]);
        const { result } = await runDocumentRetentionSweep({ today: TODAY });
        expect(result.itemsActioned).toBe(1);
        expect(result.details).toMatchObject({ deferredForDriveCopy: 0 });
    });

    it('never writes driveState — that column is step 4’s', async () => {
        db.farmDocument.findMany.mockResolvedValue([doc({ driveState: 'FAILED' })]);
        await runDocumentRetentionSweep({ today: TODAY });
        expect(tx.farmDocument.update.mock.calls[0][0].data).not.toHaveProperty('driveState');
    });

    it('WARNS on a deferral, because the expected count is zero', async () => {
        // The window is an admin retry landing on an expiry day, so a standing
        // non-zero count means step 4's ceiling is not ending at FAILED and
        // documents are being kept past their retention. Silence would make
        // that indistinguishable from a quiet day.
        db.farmDocument.findMany.mockResolvedValue([doc({ driveState: 'PENDING' })]);
        await runDocumentRetentionSweep({ today: TODAY });
        expect(warn).toHaveBeenCalledWith(
            'document-retention-sweep.deferred_for_drive_copy',
            expect.objectContaining({ count: 1, today: TODAY }),
        );
    });

    it('does NOT warn when nothing was deferred', async () => {
        db.farmDocument.findMany.mockResolvedValue([doc()]);
        await runDocumentRetentionSweep({ today: TODAY });
        expect(warn).not.toHaveBeenCalled();
    });

    it('reports deferrals and failures SEPARATELY', async () => {
        // They mean opposite things: one is a document being protected, the
        // other is a document that should have been destroyed and was not. A
        // single `itemsSkipped` would collapse them.
        db.farmDocument.findMany.mockResolvedValue([
            doc({ id: 'a', driveState: 'PENDING' }),
            doc({ id: 'b' }),
            doc({ id: 'c' }),
        ]);
        let n = 0;
        db.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => {
            n += 1;
            if (n === 2) throw new Error('deadlock');
            return fn(tx);
        });
        const { result } = await runDocumentRetentionSweep({ today: TODAY });
        expect(result.details).toMatchObject({ deferredForDriveCopy: 1, failed: 1 });
        expect(result.itemsActioned).toBe(1);
        expect(result.itemsSkipped).toBe(2);
    });
});

describe('the run verdict', () => {
    it('a run with findings is still a SUCCESSFUL run', async () => {
        // `success: false` would retry the whole batch and re-attempt
        // documents already purged. The RUN worked; a deferral is the finding.
        db.farmDocument.findMany.mockResolvedValue([doc({ driveState: 'PENDING' })]);
        const { result } = await runDocumentRetentionSweep({ today: TODAY });
        expect(result.success).toBe(true);
        expect(result.jobName).toBe('document-retention-sweep');
    });

    it('reports the day it judged against', async () => {
        const { result } = await runDocumentRetentionSweep({ today: TODAY });
        expect(result.details).toMatchObject({ today: TODAY });
    });
});
