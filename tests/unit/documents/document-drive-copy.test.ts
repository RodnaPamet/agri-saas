/**
 * The Drive copy's REFUSALS and its idempotency guard (#2495 step 4).
 *
 * Prisma is mocked, so this proves the decisions rather than the storage: which
 * state refuses with which code, that `driveFileId` outranks the state, that a
 * STALE pending row is re-enqueueable while a fresh one is not, and that a
 * tenant-wide refusal marks rows FAILED rather than leaving them PENDING.
 *
 * The three 409s are asserted as a COMPARISON, not three separate cases. Three
 * independent `code` assertions all pass on the day somebody collapses two of
 * them and updates both expectations — #2564 is what that costs, and it cost it
 * on this same error surface three hours before this file was written.
 */
const tx = {
    farmDocument: { findFirst: jest.fn(), update: jest.fn() },
    integrationConnection: { findFirst: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(tx)),
    withTenantDb: jest.fn(async (_id: string, fn: (db: unknown) => unknown) => fn(tx)),
}));

const prismaMock = {
    farmDocument: { findMany: jest.fn(), updateMany: jest.fn() },
    tenantMembership: { findFirst: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock }));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/feature-flags', () => ({
    assertFeatureEnabled: jest.fn().mockResolvedValue(undefined),
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
}));

const errorLog = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { error: (...a: unknown[]) => errorLog(...a), warn: jest.fn(), info: jest.fn() },
}));

import { requeueDocumentDriveCopy, STALE_PENDING_MS } from '@/app-layer/usecases/document-drive-copy';
import { runDocumentDriveCopySweep } from '@/app-layer/jobs/document-drive-copy-sweep';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1' });
const NOW = new Date('2026-10-31T12:00:00.000Z');

function doc(over: Record<string, unknown> = {}) {
    return {
        id: 'doc-1',
        driveState: 'FAILED',
        driveFileId: null,
        purgedAt: null,
        // Old enough that a PENDING row would be re-enqueueable, so a test
        // asserting a refusal is asserting the STATE rather than the clock.
        updatedAt: new Date(NOW.getTime() - STALE_PENDING_MS - 1000),
        ...over,
    };
}

beforeEach(() => {
    tx.farmDocument.findFirst.mockReset();
    tx.farmDocument.update.mockReset().mockResolvedValue({});
    prismaMock.farmDocument.findMany.mockReset().mockResolvedValue([]);
    prismaMock.farmDocument.updateMany.mockReset().mockResolvedValue({ count: 0 });
    prismaMock.tenantMembership.findFirst.mockReset();
    errorLog.mockClear();
});

async function codeOf(run: () => Promise<unknown>): Promise<string> {
    try {
        await run();
    } catch (err) {
        const e = err as { code?: string; message?: string };
        // The MESSAGE when there is no code, because "NO_CODE" alone cannot
        // tell an uncoded refusal from the test's own setup throwing.
        return e.code ?? `NO_CODE: ${e.message ?? String(err)}`;
    }
    throw new Error('expected a refusal, got none — the probe proves nothing');
}

describe('requeueDocumentDriveCopy — three states, three codes', () => {
    it('refuses each state with its OWN code, and the three are distinct', async () => {
        tx.farmDocument.findFirst.mockResolvedValue(doc({ driveState: 'COPIED' }));
        const copied = await codeOf(() => requeueDocumentDriveCopy(ctx, 'doc-1', { now: NOW }));

        tx.farmDocument.findFirst.mockResolvedValue(doc({ driveState: 'OFF' }));
        const off = await codeOf(() => requeueDocumentDriveCopy(ctx, 'doc-1', { now: NOW }));

        tx.farmDocument.findFirst.mockResolvedValue(
            doc({ driveState: 'PENDING', updatedAt: new Date(NOW.getTime() - 1000) }),
        );
        const inflight = await codeOf(() => requeueDocumentDriveCopy(ctx, 'doc-1', { now: NOW }));

        expect(copied).toBe('DOCUMENT_DRIVE_ALREADY_COPIED');
        expect(off).toBe('DOCUMENT_DRIVE_SYNC_OFF');
        expect(inflight).toBe('DOCUMENT_DRIVE_COPY_IN_PROGRESS');
        // The comparison itself. A failure here reads as "two of these are the
        // same code" rather than as one wrong value.
        expect(new Set([copied, off, inflight]).size).toBe(3);
        // And nothing was written. A refusal that queued anyway would be the
        // worst of both: the client told no, the sweep told yes.
        expect(tx.farmDocument.update).not.toHaveBeenCalled();
    });

    it('lets `driveFileId` outrank the state — the id is the evidence', async () => {
        // The state says FAILED, so the naive check would re-enqueue; the id
        // says a file exists in Drive, and a second upload is one Drive is
        // happy to hold and nothing downstream would notice.
        tx.farmDocument.findFirst.mockResolvedValue(
            doc({ driveState: 'FAILED', driveFileId: 'drive-abc' }),
        );
        expect(await codeOf(() => requeueDocumentDriveCopy(ctx, 'doc-1', { now: NOW })))
            .toBe('DOCUMENT_DRIVE_ALREADY_COPIED');
    });

    it('re-enqueues a FAILED row, and a STALE pending one', async () => {
        tx.farmDocument.findFirst.mockResolvedValue(doc({ driveState: 'FAILED' }));
        await expect(requeueDocumentDriveCopy(ctx, 'doc-1', { now: NOW }))
            .resolves.toEqual({ documentId: 'doc-1', state: 'PENDING' });

        // PENDING is never terminal: a row left behind by a worker that died
        // is indistinguishable from one in flight, and refusing for ever would
        // strand the document — the retention sweep DEFERS pending, so its
        // bytes would never expire either.
        tx.farmDocument.update.mockClear();
        tx.farmDocument.findFirst.mockResolvedValue(
            doc({ driveState: 'PENDING', updatedAt: new Date(NOW.getTime() - STALE_PENDING_MS - 1) }),
        );
        await expect(requeueDocumentDriveCopy(ctx, 'doc-1', { now: NOW }))
            .resolves.toEqual({ documentId: 'doc-1', state: 'PENDING' });
        expect(tx.farmDocument.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { driveState: 'PENDING' } }),
        );
    });

    it('404s a tombstone — there are no bytes to copy', async () => {
        tx.farmDocument.findFirst.mockResolvedValue(doc({ purgedAt: NOW }));
        expect(await codeOf(() => requeueDocumentDriveCopy(ctx, 'doc-1', { now: NOW })))
            .toBe('DOCUMENT_PURGED');
    });
});

describe('the sweep marks rows FAILED rather than leaving them PENDING', () => {
    it('a farm with no active admin gets FAILED, not a silent skip', async () => {
        // The reason this matters is not the copy. A PENDING row is DEFERRED by
        // the retention sweep, so leaving it would mean the document neither
        // copies nor ever expires — and the farmer watches a spinner that can
        // never resolve.
        prismaMock.farmDocument.findMany.mockResolvedValue([
            { id: 'doc-1', tenantId: 'tenant-1' },
            { id: 'doc-2', tenantId: 'tenant-1' },
        ]);
        prismaMock.tenantMembership.findFirst.mockResolvedValue(null);
        prismaMock.farmDocument.updateMany.mockResolvedValue({ count: 2 });

        const { result } = await runDocumentDriveCopySweep({ now: NOW });

        expect(prismaMock.farmDocument.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ['doc-1', 'doc-2'] }, driveState: 'PENDING' },
            data: { driveState: 'FAILED' },
        });
        expect(result.itemsScanned).toBe(2);
        expect(result.itemsActioned).toBe(0);
        expect(result.itemsSkipped).toBe(2);
        // `success: true` with a non-zero skip count — the RUN worked and the
        // failure is the FINDING, the same shape step 5 reports.
        expect(result.success).toBe(true);
        expect(errorLog).toHaveBeenCalledWith(
            'documents.drive_copy_no_admin',
            expect.objectContaining({ tenantId: 'tenant-1', pending: 2 }),
        );
    });

    it('selects only PENDING rows that still have bytes', async () => {
        await runDocumentDriveCopySweep({ now: NOW });
        expect(prismaMock.farmDocument.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                // `purgedAt: null` because a tombstone is not a copy waiting to
                // happen — the retention sweep's own deferral is what lets a
                // document reach that state.
                where: { driveState: 'PENDING', purgedAt: null },
                orderBy: { updatedAt: 'asc' },
            }),
        );
    });
});
