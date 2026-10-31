/**
 * «Документи» step 2 — the gates and the rulings (#2495).
 *
 * This suite mocks Prisma, so it proves the POLICY logic and says nothing
 * about RLS. That boundary is stated rather than implied, because #1664 is
 * exactly what happens when a mocked suite is read as covering a seam: a
 * person-block guard was green while the policy selected from an empty view
 * for every pair. What is checked here is which refusal each situation
 * produces and which values are written; the database half belongs in an
 * integration test.
 */
const mockDb = {
    farmDocument: {},
    fileRecord: {},
} as unknown as Record<string, unknown>;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

const repo = {
    list: jest.fn(),
    getById: jest.fn(),
    create: jest.fn(),
    markPurged: jest.fn(),
    settings: jest.fn(),
    findByClientMutationId: jest.fn(),
};
jest.mock('@/app-layer/repositories/FarmDocumentRepository', () => ({
    FarmDocumentRepository: repo,
}));

const fileRepo = { createPending: jest.fn(), markStored: jest.fn() };
jest.mock('@/app-layer/repositories/FileRepository', () => ({ FileRepository: fileRepo }));

const mockIngest = jest.fn();
jest.mock('@/lib/upload/ingest', () => ({
    ingestUploadedFile: (...a: unknown[]) => mockIngest(...a),
}));

const mockDownloadAllowed = jest.fn();
jest.mock('@/lib/storage/av-scan', () => ({
    isDownloadAllowed: (...a: unknown[]) => mockDownloadAllowed(...a),
}));

const mockDelete = jest.fn();
const mockReadStream = jest.fn();
jest.mock('@/lib/storage', () => ({
    assertTenantKey: jest.fn(),
    getStorageProvider: () => ({ delete: mockDelete, readStream: mockReadStream }),
}));

const mockPastDue = jest.fn();
jest.mock('@/lib/billing/entitlements', () => ({
    assertNotPastDueRestricted: (...a: unknown[]) => mockPastDue(...a),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import {
    deleteFarmDocument,
    listFarmDocuments,
    readFarmDocumentContent,
    uploadFarmDocument,
    DEFAULT_DOCUMENT_SETTINGS,
} from '@/app-layer/usecases/farm-documents';
import { makeRequestContext } from '../../helpers/make-context';

const UPLOADER = 'user-uploader';

function docRow(over: Record<string, unknown> = {}) {
    return {
        id: 'doc-1',
        name: 'Договор.pdf',
        retention: 'P1Y',
        expiresOn: '2027-03-14',
        purgedAt: null,
        purgeReason: null,
        purgedByUserId: null,
        driveState: 'OFF',
        createdAt: new Date('2026-03-14T10:00:00Z'),
        uploadedByUserId: UPLOADER,
        fileRecordId: 'file-1',
        fileRecord: {
            mimeType: 'application/pdf',
            sizeBytes: 1234,
            pathKey: 'tenants/t1/documents/x.pdf',
            scanStatus: 'CLEAN',
            status: 'STORED',
            storageProvider: 'local',
            bucket: null,
        },
        uploadedBy: { id: UPLOADER, name: 'Иван', email: 'i@example.com' },
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDownloadAllowed.mockReturnValue(true);
    mockReadStream.mockReturnValue({ pipe: jest.fn() });
    repo.settings.mockResolvedValue(null);
    repo.findByClientMutationId.mockResolvedValue(null);
    mockIngest.mockResolvedValue({
        pathKey: 'tenants/t1/documents/x.pdf',
        originalName: 'Договор.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        sha256: 'a'.repeat(64),
        storageProvider: 'local',
        bucket: null,
        domain: 'documents',
        scanStatus: 'CLEAN',
        buffer: Buffer.from(''),
    });
    fileRepo.createPending.mockResolvedValue({ id: 'file-1' });
    repo.create.mockResolvedValue(docRow());
});

describe('the AV gate on /content', () => {
    it('refuses when isDownloadAllowed says no', async () => {
        repo.getById.mockResolvedValue(docRow({ fileRecord: { ...docRow().fileRecord, scanStatus: 'INFECTED' } }));
        mockDownloadAllowed.mockReturnValue(false);
        await expect(readFarmDocumentContent(makeRequestContext('EDITOR'), 'doc-1')).rejects.toThrow();
        // The verdict is DELEGATED, and the raw column value is what is asked
        // about — no default, because `isDownloadAllowed('SKIPPED')` is true in
        // every mode, so a default meaning "unscanned" also means
        // "downloadable".
        expect(mockDownloadAllowed).toHaveBeenCalledWith('INFECTED');
    });

    it('serves the bytes when the verdict allows it', async () => {
        repo.getById.mockResolvedValue(docRow());
        const out = await readFarmDocumentContent(makeRequestContext('READER'), 'doc-1');
        expect(out.contentType).toBe('application/pdf');
        expect(mockReadStream).toHaveBeenCalledWith('tenants/t1/documents/x.pdf');
    });

    it('asks the gate even when the scan status is null', async () => {
        // A null column must reach the helper rather than being coalesced to
        // something permissive on the way.
        repo.getById.mockResolvedValue(docRow({ fileRecord: { ...docRow().fileRecord, scanStatus: null } }));
        mockDownloadAllowed.mockReturnValue(false);
        await expect(readFarmDocumentContent(makeRequestContext('EDITOR'), 'doc-1')).rejects.toThrow();
        expect(mockDownloadAllowed).toHaveBeenCalledWith(null);
    });

    it('404s a tombstone instead of consulting the gate', async () => {
        repo.getById.mockResolvedValue(docRow({ purgedAt: new Date(), purgeReason: 'DELETED', name: null }));
        await expect(readFarmDocumentContent(makeRequestContext('EDITOR'), 'doc-1')).rejects.toThrow(/removed/i);
        expect(mockDownloadAllowed).not.toHaveBeenCalled();
    });
});

describe('upload', () => {
    it('asserts the past-due gate in THIS usecase, not only in the ingest pipeline', async () => {
        await uploadFarmDocument(makeRequestContext('EDITOR'), new File(['x'], 'd.pdf'), null);
        expect(mockPastDue).toHaveBeenCalledWith(expect.anything(), 'upload');
    });

    it('files the document under the farm’s CURRENT period, stored on the row', async () => {
        repo.settings.mockResolvedValue({ retention: 'P5Y', driveSync: false });
        await uploadFarmDocument(makeRequestContext('EDITOR'), new File(['x'], 'd.pdf'), null);
        const written = repo.create.mock.calls[0][2];
        expect(written.retention).toBe('P5Y');
        // Both are fixed AT UPLOAD: `expiresOn` alone would lose WHY that date
        // was given, and a later settings change must not reach back.
        expect(written.expiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('falls back to the column default when the farm has no settings row', async () => {
        repo.settings.mockResolvedValue(null);
        await uploadFarmDocument(makeRequestContext('EDITOR'), new File(['x'], 'd.pdf'), null);
        expect(repo.create.mock.calls[0][2].retention).toBe(DEFAULT_DOCUMENT_SETTINGS.retention);
    });

    it('«Без срок» stores a null expiry, not a far-future date', async () => {
        repo.settings.mockResolvedValue({ retention: 'NONE', driveSync: false });
        await uploadFarmDocument(makeRequestContext('EDITOR'), new File(['x'], 'd.pdf'), null);
        expect(repo.create.mock.calls[0][2].expiresOn).toBeNull();
    });

    it('passes the ingest pipeline’s TERMINAL scan status to markStored, unaltered', async () => {
        // PENDING specifically: the one a well-meaning default would replace.
        // `markStored` must receive what the scanner said, never a guess —
        // and never a default, since `isDownloadAllowed('SKIPPED')` is true in
        // every mode.
        mockIngest.mockResolvedValue({
            pathKey: 'tenants/t1/documents/x.pdf',
            originalName: 'd.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1,
            sha256: 'b'.repeat(64),
            storageProvider: 'local',
            bucket: null,
            domain: 'documents',
            scanStatus: 'PENDING',
            buffer: Buffer.from(''),
        });
        await uploadFarmDocument(makeRequestContext('EDITOR'), new File(['x'], 'd.pdf'), null);
        expect(fileRepo.markStored).toHaveBeenCalledWith(mockDb, expect.anything(), 'file-1', 'PENDING');
    });

    it('a replayed Idempotency-Key returns the ORIGINAL row and stores nothing', async () => {
        repo.findByClientMutationId.mockResolvedValue(docRow({ id: 'doc-original' }));
        const row = await uploadFarmDocument(makeRequestContext('EDITOR'), new File(['x'], 'd.pdf'), 'key-1');
        expect(row.id).toBe('doc-original');
        // Not merely "no second row": the bytes are never read either, which
        // is what makes a retry cheap on rural LTE.
        expect(mockIngest).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('an upload with no key does not consult the dedupe path at all', async () => {
        await uploadFarmDocument(makeRequestContext('EDITOR'), new File(['x'], 'd.pdf'), null);
        expect(repo.findByClientMutationId).not.toHaveBeenCalled();
        expect(repo.create.mock.calls[0][2].clientMutationId).toBeNull();
    });
});

describe('delete — the tombstone', () => {
    it('the uploader may delete, and the row is stamped DELETED', async () => {
        repo.getById.mockResolvedValue(docRow());
        repo.markPurged.mockResolvedValue(docRow({ purgedAt: new Date(), purgeReason: 'DELETED', name: null }));
        const ctx = makeRequestContext('EDITOR', { userId: UPLOADER });
        const row = await deleteFarmDocument(ctx, 'doc-1');
        expect(repo.markPurged).toHaveBeenCalledWith(mockDb, ctx, 'doc-1', 'DELETED');
        // The owner ruling: a DELETED tombstone carries a null name.
        expect(row.name).toBeNull();
        expect(row.purgeReason).toBe('DELETED');
    });

    it('refuses someone who neither uploaded it nor is an admin', async () => {
        repo.getById.mockResolvedValue(docRow());
        const ctx = makeRequestContext('EDITOR', { userId: 'someone-else' });
        await expect(deleteFarmDocument(ctx, 'doc-1')).rejects.toThrow(/uploaded this document, or an admin/i);
        expect(repo.markPurged).not.toHaveBeenCalled();
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('an admin may delete someone else’s document', async () => {
        repo.getById.mockResolvedValue(docRow());
        repo.markPurged.mockResolvedValue(docRow({ purgedAt: new Date(), purgeReason: 'DELETED', name: null }));
        await deleteFarmDocument(makeRequestContext('ADMIN', { userId: 'admin-1' }), 'doc-1');
        expect(repo.markPurged).toHaveBeenCalled();
    });

    it('`mayDelete` in the list agrees with who the server lets delete', async () => {
        // The same predicate on both sides. A flag computed one way and
        // enforced another is how a button appears that cannot work.
        repo.list.mockResolvedValue([docRow()]);
        const asUploader = await listFarmDocuments(makeRequestContext('EDITOR', { userId: UPLOADER }));
        const asStranger = await listFarmDocuments(makeRequestContext('EDITOR', { userId: 'someone-else' }));
        const asAdmin = await listFarmDocuments(makeRequestContext('ADMIN', { userId: 'admin-1' }));
        expect([asUploader.rows[0].mayDelete, asStranger.rows[0].mayDelete, asAdmin.rows[0].mayDelete])
            .toEqual([true, false, true]);
    });

    it('deleting an existing tombstone is idempotent and does NOT re-stamp purgedAt', async () => {
        const stamped = new Date('2026-03-01T00:00:00Z');
        repo.getById.mockResolvedValue(docRow({ purgedAt: stamped, purgeReason: 'DELETED', name: null }));
        const row = await deleteFarmDocument(makeRequestContext('ADMIN', { userId: 'admin-1' }), 'doc-1');
        expect(repo.markPurged).not.toHaveBeenCalled();
        expect(row.purgedAt).toBe(stamped.toISOString());
        // And no second attempt to remove bytes that have already gone.
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('a failed byte deletion does NOT undo the tombstone', async () => {
        // The tombstone is the record the farm reads. Rolling it back because
        // the object store blinked would leave a document the UI says is
        // deleted and the server still serves.
        repo.getById.mockResolvedValue(docRow());
        repo.markPurged.mockResolvedValue(docRow({ purgedAt: new Date(), purgeReason: 'DELETED', name: null }));
        mockDelete.mockRejectedValue(new Error('object store unreachable'));
        const row = await deleteFarmDocument(makeRequestContext('ADMIN', { userId: 'admin-1' }), 'doc-1');
        expect(row.purgeReason).toBe('DELETED');
    });
});

describe('list', () => {
    it('reports truncation rather than letting a short page read as complete', async () => {
        repo.list.mockResolvedValue(Array.from({ length: 3 }, (_, i) => docRow({ id: `d${i}` })));
        const out = await listFarmDocuments(makeRequestContext('READER'), { limit: 2 });
        expect(out.rows).toHaveLength(2);
        expect(out.truncated).toBe(true);
    });

    it('reports the RESOLVED content type and size, not a client claim', async () => {
        repo.list.mockResolvedValue([docRow()]);
        const out = await listFarmDocuments(makeRequestContext('READER'));
        expect(out.rows[0]).toMatchObject({ contentType: 'application/pdf', sizeBytes: 1234 });
    });
});
