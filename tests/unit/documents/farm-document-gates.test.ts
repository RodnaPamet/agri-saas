/**
 * The two gates the document library cannot ship without (#2495 step 2).
 *
 * **The AV egress gate.** `ingestUploadedFile` writes bytes BEFORE the scan
 * resolves, and the argument that makes that safe is that every read asks
 * `isDownloadAllowed` first. For this feature the only reader is
 * `downloadFarmDocument`. A missing gate here would not leak one file — it
 * would retroactively remove the reason uploads are allowed to hit disk
 * unscanned, which is why `download-route-gate-reachability` lists this
 * function in `USECASE_SEAMS`.
 *
 * **The delete authorisation.** `mayDelete` on a list row promises "uploader
 * or admin", and a route cannot enforce it: a path regex does not know who
 * uploaded a document. So the usecase is the only place that check exists,
 * and these tests are the only thing holding it.
 *
 * `isDownloadAllowed` is NOT mocked. It is the subject: a double would
 * answer whatever the test wanted and could not report that the real policy
 * admits a status this code treats as refused.
 */
import type { RequestContext } from '@/app-layer/types';

const storageDelete = jest.fn().mockResolvedValue(undefined);
const readStream = jest.fn(() => ({ on: jest.fn(), destroy: jest.fn() }));
const assertTenantKeyMock = jest.fn();

jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => ({ readStream, delete: storageDelete }),
    assertTenantKey: (...args: unknown[]) => assertTenantKeyMock(...args),
}));

const ingestMock = jest.fn();
jest.mock('@/lib/upload/ingest', () => ({
    ingestUploadedFile: (...args: unknown[]) => ingestMock(...args),
}));

const db = {
    farmDocument: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    tenantDocumentSettings: { findUnique: jest.fn() },
    fileRecord: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));

const getByIdForTenant = jest.fn();
const markDeleted = jest.fn();
const markStored = jest.fn();
const createPending = jest.fn();
jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        getByIdForTenant: (...a: unknown[]) => getByIdForTenant(...a),
        markDeleted: (...a: unknown[]) => markDeleted(...a),
        markStored: (...a: unknown[]) => markStored(...a),
        createPending: (...a: unknown[]) => createPending(...a),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { isDownloadAllowed } from '@/lib/storage/av-scan';

import {
    deleteFarmDocument,
    downloadFarmDocument,
    uploadFarmDocument,
} from '@/app-layer/usecases/farm-documents';
import { makeRequestContext } from '../../helpers/make-context';

const UPLOADER = 'user-uploader';

function ctxFor(role: 'ADMIN' | 'EDITOR', userId: string): RequestContext {
    return makeRequestContext(role, { tenantId: 'tenant-1', tenantSlug: 'acme', userId });
}

/** A stored, clean file record for the document under test. */
function cleanFile(over: Record<string, unknown> = {}) {
    return {
        id: 'file-1',
        status: 'STORED',
        scanStatus: 'CLEAN',
        pathKey: 'tenants/tenant-1/documents/2026/10/0f0f9ee8-aaaa-bbbb-cccc-0123456789ab.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
        ...over,
    };
}

function docRow(over: Record<string, unknown> = {}) {
    return {
        id: 'doc-1',
        name: 'Договор.pdf',
        purgedAt: null,
        fileRecordId: 'file-1',
        uploadedByUserId: UPLOADER,
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    assertTenantKeyMock.mockReset();
    readStream.mockReturnValue({ on: jest.fn(), destroy: jest.fn() } as never);
    storageDelete.mockResolvedValue(undefined);
});

describe('downloadFarmDocument — the AV egress gate', () => {
    it('serves a CLEAN stored document, and checks the tenant key on the RESOLVED path', async () => {
        db.farmDocument.findFirst.mockResolvedValue(docRow());
        getByIdForTenant.mockResolvedValue(cleanFile());

        const out = await downloadFarmDocument(ctxFor('EDITOR', UPLOADER), 'doc-1');

        expect(out.contentType).toBe('application/pdf');
        // Asserting the mock was CALLED, not merely that nothing threw — a
        // guard that never ran and a guard that passed look identical.
        expect(assertTenantKeyMock).toHaveBeenCalledWith(cleanFile().pathKey, 'tenant-1');
        expect(readStream).toHaveBeenCalledWith(cleanFile().pathKey);
    });

    it('REFUSES an INFECTED file, and never opens a stream', async () => {
        db.farmDocument.findFirst.mockResolvedValue(docRow());
        getByIdForTenant.mockResolvedValue(cleanFile({ scanStatus: 'INFECTED' }));

        await expect(downloadFarmDocument(ctxFor('ADMIN', 'admin-1'), 'doc-1')).rejects.toThrow();
        expect(readStream).not.toHaveBeenCalled();
    });

    // PENDING is MODE-DEPENDENT, and the mode is not knowable here.
    //
    // `env.ts` declares `AV_SCAN_MODE` with `.default("strict")`, but
    // `jest.setup.js` sets `SKIP_ENV_VALIDATION=1`, and @t3-oss/env skips
    // zod entirely under that flag — so `env.AV_SCAN_MODE` is `undefined` in
    // every unit test and the declared default never applies. Measured:
    // `isDownloadAllowed('PENDING')` is `true` here, where strict mode would
    // make it `false`.
    //
    // So this asserts the property that is actually ours — the usecase
    // DEFERS to `isDownloadAllowed` — by deriving the expectation from the
    // policy rather than hardcoding a verdict the ambient config decides.
    // Hardcoding either answer would be a test that passes for a reason
    // unrelated to the code. See #2518.
    it.each(['PENDING', 'CLEAN', 'SKIPPED'] as const)(
        'defers to isDownloadAllowed for %s rather than deciding itself',
        async (scanStatus) => {
            db.farmDocument.findFirst.mockResolvedValue(docRow());
            getByIdForTenant.mockResolvedValue(cleanFile({ scanStatus }));
            const allowed = isDownloadAllowed(scanStatus);

            if (allowed) {
                await expect(
                    downloadFarmDocument(ctxFor('ADMIN', 'admin-1'), 'doc-1'),
                ).resolves.toBeTruthy();
                expect(readStream).toHaveBeenCalled();
            } else {
                await expect(
                    downloadFarmDocument(ctxFor('ADMIN', 'admin-1'), 'doc-1'),
                ).rejects.toThrow();
                expect(readStream).not.toHaveBeenCalled();
            }
        },
    );

    it('refuses INFECTED whatever the mode — the one mode-INDEPENDENT rule', () => {
        // `isDownloadAllowed` checks INFECTED ahead of the mode check, and
        // its docblock records why: the two were once the other way round, so
        // `disabled` mode served known malware. Pinning the invariant here
        // means a reordering fails on this surface too.
        expect(isDownloadAllowed('INFECTED')).toBe(false);
    });

    it('404s a tombstone rather than serving bytes that are gone', async () => {
        db.farmDocument.findFirst.mockResolvedValue(docRow({ purgedAt: new Date('2026-10-20T00:00:00Z') }));

        await expect(downloadFarmDocument(ctxFor('ADMIN', 'admin-1'), 'doc-1')).rejects.toThrow();
        // The tombstone short-circuits BEFORE the file record is read: the
        // row is the record that the document existed, and its bytes are not
        // there to be gated.
        expect(getByIdForTenant).not.toHaveBeenCalled();
        expect(readStream).not.toHaveBeenCalled();
    });

    it('refuses a file record that is not STORED', async () => {
        db.farmDocument.findFirst.mockResolvedValue(docRow());
        getByIdForTenant.mockResolvedValue(cleanFile({ status: 'PENDING' }));

        await expect(downloadFarmDocument(ctxFor('ADMIN', 'admin-1'), 'doc-1')).rejects.toThrow();
        expect(readStream).not.toHaveBeenCalled();
    });
});

describe('deleteFarmDocument — uploader or admin, and the tombstone', () => {
    it('lets the UPLOADER delete, drops the name, and records who and when', async () => {
        db.farmDocument.findFirst.mockResolvedValue(docRow());
        getByIdForTenant.mockResolvedValue(cleanFile());

        await deleteFarmDocument(ctxFor('EDITOR', UPLOADER), 'doc-1');

        const data = db.farmDocument.update.mock.calls[0][0].data;
        expect(data.name).toBeNull();
        expect(data.purgeReason).toBe('DELETED');
        expect(data.purgedByUserId).toBe(UPLOADER);
        expect(data.purgedAt).toBeInstanceOf(Date);
        expect(markDeleted).toHaveBeenCalled();
        // Bytes go after the commit, never inside the transaction — a
        // storage delete cannot be rolled back.
        expect(storageDelete).toHaveBeenCalledWith(cleanFile().pathKey);
    });

    it('lets an ADMIN delete somebody elses document', async () => {
        db.farmDocument.findFirst.mockResolvedValue(docRow());
        getByIdForTenant.mockResolvedValue(cleanFile());

        await deleteFarmDocument(ctxFor('ADMIN', 'admin-1'), 'doc-1');

        expect(db.farmDocument.update).toHaveBeenCalled();
    });

    it('REFUSES a writer who is neither the uploader nor an admin', async () => {
        db.farmDocument.findFirst.mockResolvedValue(docRow());

        await expect(deleteFarmDocument(ctxFor('EDITOR', 'someone-else'), 'doc-1')).rejects.toThrow();
        expect(db.farmDocument.update).not.toHaveBeenCalled();
        expect(storageDelete).not.toHaveBeenCalled();
    });

    it('is idempotent on an existing tombstone — it does not move purgedAt', async () => {
        const purgedAt = new Date('2026-10-20T00:00:00Z');
        db.farmDocument.findFirst.mockResolvedValue(docRow({ purgedAt, name: null }));

        await deleteFarmDocument(ctxFor('ADMIN', 'admin-1'), 'doc-1');

        // A second tap must not rewrite the date an audit reads.
        expect(db.farmDocument.update).not.toHaveBeenCalled();
        expect(storageDelete).not.toHaveBeenCalled();
    });
});

describe('uploadFarmDocument — idempotency', () => {
    it('answers a replay from the existing row WITHOUT spending the bytes again', async () => {
        db.farmDocument.findFirst.mockResolvedValue({
            id: 'doc-1',
            name: 'Договор.pdf',
            expiresOn: '2027-10-30',
            purgedAt: null,
            driveState: 'OFF',
            createdAt: new Date('2026-10-30T09:00:00Z'),
            uploadedByUserId: UPLOADER,
            uploadedBy: { id: UPLOADER, name: 'Иван' },
            fileRecord: { mimeType: 'application/pdf', sizeBytes: 4096 },
        });

        const file = new File([new Uint8Array([1, 2, 3])], 'Договор.pdf', { type: 'application/pdf' });
        const row = await uploadFarmDocument(ctxFor('EDITOR', UPLOADER), file, 'key-1');

        expect(row.id).toBe('doc-1');
        // The whole point: the pre-check runs BEFORE ingest, so a retry over
        // a bad connection does not re-upload and re-scan the bytes.
        expect(ingestMock).not.toHaveBeenCalled();
        expect(db.farmDocument.create).not.toHaveBeenCalled();
    });

    it('ingests normally when no key is supplied', async () => {
        db.farmDocument.findFirst.mockResolvedValue(null);
        db.tenantDocumentSettings.findUnique.mockResolvedValue({ retention: 'P1Y' });
        ingestMock.mockResolvedValue({
            pathKey: cleanFile().pathKey,
            originalName: 'Договор.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 4096,
            sha256: 'abc',
            storageProvider: 'local',
            bucket: null,
            domain: 'documents',
            scanStatus: 'CLEAN',
            buffer: Buffer.from([1, 2, 3]),
        });
        createPending.mockResolvedValue({ id: 'file-1' });
        db.farmDocument.create.mockResolvedValue({
            id: 'doc-new',
            name: 'Договор.pdf',
            expiresOn: '2027-10-30',
            purgedAt: null,
            driveState: 'OFF',
            createdAt: new Date('2026-10-30T09:00:00Z'),
            uploadedByUserId: UPLOADER,
            uploadedBy: { id: UPLOADER, name: 'Иван' },
            fileRecord: { mimeType: 'application/pdf', sizeBytes: 4096 },
        });

        const file = new File([new Uint8Array([1, 2, 3])], 'Договор.pdf', { type: 'application/pdf' });
        const row = await uploadFarmDocument(ctxFor('EDITOR', UPLOADER), file);

        expect(ingestMock).toHaveBeenCalled();
        expect(row.id).toBe('doc-new');
        // The TERMINAL outcome ingest reported is forwarded verbatim — never
        // a default, because `isDownloadAllowed('SKIPPED')` is true in every
        // scan mode.
        expect(markStored).toHaveBeenCalledWith(db, expect.anything(), 'file-1', 'CLEAN');
        // Step 2 always writes OFF; the Drive job is step 4.
        expect(db.farmDocument.create.mock.calls[0][0].data.driveState).toBe('OFF');
    });
});
