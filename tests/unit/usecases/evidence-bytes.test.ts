/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock
 * pattern; per-line typing has poor cost/benefit ratio. */

/**
 * `purgeEvidenceBytes` — releasing the stored object, not just the row.
 *
 * Two invariants carry the whole module, and each has a failure mode that is
 * silent in production:
 *
 *   - **Only on the last reference.** SHA-256 dedup lets several Evidence rows
 *     share one FileRecord. Deleting bytes when one of them is purged breaks
 *     every survivor — and breaks it invisibly, since the survivors' rows still
 *     look fine until someone clicks download.
 *   - **Bytes before pointer, and keep the pointer if the bytes won't go.** A
 *     FileRecord whose object failed to delete is the only handle a later sweep
 *     has on those bytes. Dropping it is how an unreachable object is made.
 */

const mockDb = {
    evidence: { findMany: jest.fn() },
    fileRecord: { findMany: jest.fn(), deleteMany: jest.fn() },
} as any;

const mockStorage: any = { name: 'local', delete: jest.fn() };

jest.mock('@/lib/storage', () => ({
    getStorageProvider: jest.fn(() => mockStorage),
    assertTenantKey: jest.fn((key: string, tenantId: string) => {
        if (!key.startsWith(`tenants/${tenantId}/`)) throw new Error('tenant key mismatch');
    }),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { purgeEvidenceBytes } from '@/app-layer/usecases/evidence-bytes';
import { assertTenantKey } from '@/lib/storage';

const TENANT = 'tenant-1';

/** Wire the two evidence reads: rows being purged, then surviving referents. */
function givenEvidence(purged: Array<{ fileRecordId: string | null }>, survivors: Array<{ fileRecordId: string }>) {
    mockDb.evidence.findMany
        .mockResolvedValueOnce(purged)
        .mockResolvedValueOnce(survivors);
}

function givenRecords(records: Array<{ id: string; pathKey: string }>) {
    mockDb.fileRecord.findMany.mockResolvedValue(records);
    mockDb.fileRecord.deleteMany.mockResolvedValue({ count: records.length });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.delete.mockResolvedValue(undefined);
});

describe('purgeEvidenceBytes — the happy path', () => {
    it('deletes the object then the pointer', async () => {
        givenEvidence([{ fileRecordId: 'f1' }], []);
        givenRecords([{ id: 'f1', pathKey: `tenants/${TENANT}/general/a.pdf` }]);

        const res = await purgeEvidenceBytes(mockDb, TENANT, ['e1']);

        expect(mockStorage.delete).toHaveBeenCalledWith(`tenants/${TENANT}/general/a.pdf`);
        expect(mockDb.fileRecord.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ['f1'] }, tenantId: TENANT },
        });
        expect(res).toMatchObject({ objectsDeleted: 1, recordsDeleted: 1, failed: 0 });
    });

    it('asserts the key belongs to the tenant before deleting it', async () => {
        givenEvidence([{ fileRecordId: 'f1' }], []);
        givenRecords([{ id: 'f1', pathKey: `tenants/${TENANT}/general/a.pdf` }]);

        await purgeEvidenceBytes(mockDb, TENANT, ['e1']);

        expect(assertTenantKey).toHaveBeenCalledWith(`tenants/${TENANT}/general/a.pdf`, TENANT);
    });

    it('deduplicates repeated fileRecordIds into one delete', async () => {
        // Two evidence rows, one shared record, both being purged: the object
        // goes exactly once, not once per row.
        givenEvidence([{ fileRecordId: 'f1' }, { fileRecordId: 'f1' }], []);
        givenRecords([{ id: 'f1', pathKey: `tenants/${TENANT}/general/a.pdf` }]);

        const res = await purgeEvidenceBytes(mockDb, TENANT, ['e1', 'e2']);

        expect(mockStorage.delete).toHaveBeenCalledTimes(1);
        expect(res.objectsDeleted).toBe(1);
    });
});

describe('purgeEvidenceBytes — the refusals', () => {
    it('leaves a shared FileRecord alone while any evidence still points at it', async () => {
        // The dedup case. e1 is purged, e2 survives, both share f1.
        givenEvidence([{ fileRecordId: 'f1' }], [{ fileRecordId: 'f1' }]);

        const res = await purgeEvidenceBytes(mockDb, TENANT, ['e1']);

        expect(mockStorage.delete).not.toHaveBeenCalled();
        expect(mockDb.fileRecord.deleteMany).not.toHaveBeenCalled();
        expect(res).toMatchObject({ stillReferenced: 1, objectsDeleted: 0 });
    });

    it('excludes the rows being purged from the survivor count', async () => {
        // If the survivor query forgot `id: { notIn: purged }`, every record
        // would look referenced by its own dying row and nothing would ever
        // be released.
        givenEvidence([{ fileRecordId: 'f1' }], []);
        givenRecords([{ id: 'f1', pathKey: `tenants/${TENANT}/general/a.pdf` }]);

        await purgeEvidenceBytes(mockDb, TENANT, ['e1']);

        expect(mockDb.evidence.findMany).toHaveBeenNthCalledWith(2, {
            where: { tenantId: TENANT, fileRecordId: { in: ['f1'] }, id: { notIn: ['e1'] } },
            select: { fileRecordId: true },
        });
    });

    it('KEEPS the pointer when the storage delete fails', async () => {
        givenEvidence([{ fileRecordId: 'f1' }], []);
        givenRecords([{ id: 'f1', pathKey: `tenants/${TENANT}/general/a.pdf` }]);
        mockStorage.delete.mockRejectedValue(new Error('EACCES'));

        const res = await purgeEvidenceBytes(mockDb, TENANT, ['e1']);

        expect(mockDb.fileRecord.deleteMany).not.toHaveBeenCalled();
        expect(res).toMatchObject({ failed: 1, objectsDeleted: 0, recordsDeleted: 0 });
    });

    it('never throws — a partial failure must not abort the rest of the batch', async () => {
        givenEvidence([{ fileRecordId: 'f1' }, { fileRecordId: 'f2' }], []);
        mockDb.fileRecord.findMany.mockResolvedValue([
            { id: 'f1', pathKey: `tenants/${TENANT}/general/a.pdf` },
            { id: 'f2', pathKey: `tenants/${TENANT}/general/b.pdf` },
        ]);
        mockDb.fileRecord.deleteMany.mockResolvedValue({ count: 1 });
        mockStorage.delete.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValueOnce(undefined);

        const res = await purgeEvidenceBytes(mockDb, TENANT, ['e1', 'e2']);

        // f1 failed and kept its pointer; f2 still went.
        expect(res).toMatchObject({ failed: 1, objectsDeleted: 1, recordsDeleted: 1 });
        expect(mockDb.fileRecord.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ['f2'] }, tenantId: TENANT },
        });
    });

    it('refuses a pathKey outside the tenant prefix rather than deleting it', async () => {
        // Belt and braces: the record was tenant-filtered, but a destructive
        // op on a shared volume gets the prefix assertion anyway.
        givenEvidence([{ fileRecordId: 'f1' }], []);
        givenRecords([{ id: 'f1', pathKey: 'tenants/OTHER-TENANT/general/a.pdf' }]);

        const res = await purgeEvidenceBytes(mockDb, TENANT, ['e1']);

        expect(mockStorage.delete).not.toHaveBeenCalled();
        expect(res.failed).toBe(1);
    });

    it('does nothing for evidence with no file attached', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([]);
        const res = await purgeEvidenceBytes(mockDb, TENANT, ['e1']);
        expect(res).toEqual({ objectsDeleted: 0, recordsDeleted: 0, stillReferenced: 0, failed: 0 });
        expect(mockDb.fileRecord.findMany).not.toHaveBeenCalled();
    });

    it('short-circuits on an empty id list without querying', async () => {
        const res = await purgeEvidenceBytes(mockDb, TENANT, []);
        expect(res.objectsDeleted).toBe(0);
        expect(mockDb.evidence.findMany).not.toHaveBeenCalled();
    });
});

describe('purgeEvidenceBytes — query shape', () => {
    it('reads the batch in two queries, not one per row (no N+1)', async () => {
        givenEvidence(
            [{ fileRecordId: 'f1' }, { fileRecordId: 'f2' }, { fileRecordId: 'f3' }],
            [],
        );
        mockDb.fileRecord.findMany.mockResolvedValue([]);

        await purgeEvidenceBytes(mockDb, TENANT, ['e1', 'e2', 'e3']);

        expect(mockDb.evidence.findMany).toHaveBeenCalledTimes(2);
        expect(mockDb.fileRecord.findMany).toHaveBeenCalledTimes(1);
    });

    it('scopes every read and the delete to the tenant', async () => {
        givenEvidence([{ fileRecordId: 'f1' }], []);
        givenRecords([{ id: 'f1', pathKey: `tenants/${TENANT}/general/a.pdf` }]);

        await purgeEvidenceBytes(mockDb, TENANT, ['e1']);

        for (const call of mockDb.evidence.findMany.mock.calls) {
            expect(call[0].where.tenantId).toBe(TENANT);
        }
        expect(mockDb.fileRecord.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT);
        expect(mockDb.fileRecord.deleteMany.mock.calls[0][0].where.tenantId).toBe(TENANT);
    });
});
