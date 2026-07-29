/**
 * Coverage wave 22 — `FileRepository`.
 *
 * 12 uncovered functions at 20% (19.23% lines). This repository owns two
 * invariants that are load-bearing beyond the usual tenant filter:
 *
 *   1. the AV scan lifecycle — a freshly stored file must land as
 *      `scanStatus: PENDING`, and the scan sweep must only ever pick up
 *      rows that are `STORED` and `PENDING`;
 *   2. the SHA-256 dedup lookup must only match a `STORED` row, because
 *      returning a `PENDING`/`FAILED` twin hands a caller a path key with
 *      no bytes behind it.
 *
 * Both are query-shape contracts, so they are asserted on the emitted
 * `where` rather than inferred from a return value. `db` is a recording
 * double.
 */
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { makeRequestContext } from '../../helpers/make-context';
import type { PrismaTx } from '@/lib/db-context';

const ctx = makeRequestContext('EDITOR'); // tenantId: 'tenant-1', userId: 'user-1'
const OTHER_TENANT = makeRequestContext('EDITOR', { tenantId: 'tenant-2' });

function makeDb() {
    const model = () => ({
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'created' }),
        update: jest.fn().mockResolvedValue({ id: 'updated' }),
    });
    return { fileRecord: model(), evidence: model() };
}

type FakeDb = ReturnType<typeof makeDb>;
const asTx = (db: FakeDb) => db as unknown as PrismaTx;

const argOf = (fn: jest.Mock) => fn.mock.calls[0][0];
const whereOf = (fn: jest.Mock) => fn.mock.calls[0][0].where;
const dataOf = (fn: jest.Mock) => fn.mock.calls[0][0].data;

const PENDING_INPUT = {
    pathKey: 'tenant-1/general/abc.pdf',
    originalName: 'audit-report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
};

let db: FakeDb;
beforeEach(() => {
    db = makeDb();
});

describe('FileRepository.createPending', () => {
    it('stamps the calling tenant and uploader, and starts life as PENDING', async () => {
        // Break: taking the tenant from the caller-supplied data object.
        // The upload route parses `data` from a multipart request, so the
        // repository is the last place the tenant can be pinned honestly.
        await FileRepository.createPending(asTx(db), ctx, PENDING_INPUT);

        expect(dataOf(db.fileRecord.create)).toMatchObject({
            tenantId: 'tenant-1',
            uploadedByUserId: 'user-1',
            status: 'PENDING',
            pathKey: PENDING_INPUT.pathKey,
            sha256: PENDING_INPUT.sha256,
        });
    });

    it('follows the caller when a different tenant uploads', async () => {
        await FileRepository.createPending(asTx(db), OTHER_TENANT, PENDING_INPUT);

        expect(dataOf(db.fileRecord.create).tenantId).toBe('tenant-2');
    });

    it('falls back to the configured storage provider and the general domain', async () => {
        // Break: defaulting `domain` to undefined would drop every upload
        // into the column default, breaking the domain-prefixed path keys
        // the storage layer's `assertTenantKey` relies on.
        const previous = process.env.STORAGE_PROVIDER;
        process.env.STORAGE_PROVIDER = 's3';
        try {
            await FileRepository.createPending(asTx(db), ctx, PENDING_INPUT);

            expect(dataOf(db.fileRecord.create)).toMatchObject({
                storageProvider: 's3',
                bucket: null,
                domain: 'general',
            });
        } finally {
            if (previous === undefined) delete process.env.STORAGE_PROVIDER;
            else process.env.STORAGE_PROVIDER = previous;
        }
    });

    it('honours an explicit provider, bucket and domain', async () => {
        await FileRepository.createPending(asTx(db), ctx, {
            ...PENDING_INPUT,
            storageProvider: 'local',
            bucket: 'evidence-eu',
            domain: 'evidence',
        });

        expect(dataOf(db.fileRecord.create)).toMatchObject({
            storageProvider: 'local',
            bucket: 'evidence-eu',
            domain: 'evidence',
        });
    });
});

describe('FileRepository — status transitions', () => {
    it('arms the AV scan when a file becomes STORED', async () => {
        // Break: dropping `scanStatus: 'PENDING'`. The scan sweep selects
        // on that column, so an unscanned file would never be queued and
        // would sit in the tenant's evidence library forever un-scanned —
        // a green "STORED" badge on a file nothing ever looked at.
        await FileRepository.markStored(asTx(db), ctx, 'f-1');

        expect(argOf(db.fileRecord.update).where).toEqual({ id: 'f-1' });
        expect(dataOf(db.fileRecord.update)).toMatchObject({
            status: 'STORED',
            scanStatus: 'PENDING',
        });
        expect(dataOf(db.fileRecord.update).storedAt).toBeInstanceOf(Date);
    });

    it('marks a failed upload without touching the scan lifecycle', async () => {
        await FileRepository.markFailed(asTx(db), ctx, 'f-1');

        expect(dataOf(db.fileRecord.update)).toEqual({ status: 'FAILED' });
    });

    it('soft-deletes by status rather than removing the row', async () => {
        // Break: switching to a hard `delete`. FileRecord rows are
        // referenced by evidence links and the audit trail; erasing one
        // orphans both.
        await FileRepository.markDeleted(asTx(db), ctx, 'f-1');

        expect(dataOf(db.fileRecord.update)).toEqual({ status: 'DELETED' });
        expect(db.fileRecord.update).toHaveBeenCalledTimes(1);
    });
});

describe('FileRepository — reads', () => {
    it('requires both id and tenant to fetch a file', async () => {
        // Break: `findUnique({ where: { id } })`. File ids appear in
        // download URLs, so an id-only lookup is a cross-tenant read of
        // whatever was uploaded.
        await FileRepository.getById(asTx(db), ctx, 'f-1');

        expect(whereOf(db.fileRecord.findFirst)).toEqual({ id: 'f-1', tenantId: 'tenant-1' });
    });

    it('scopes the explicit-tenant read to the tenant it was handed', async () => {
        // The background scan worker has no RequestContext; it passes the
        // tenant explicitly. Break: ignoring the argument.
        await FileRepository.getByIdForTenant(asTx(db), 'tenant-2', 'f-1');

        expect(whereOf(db.fileRecord.findFirst)).toEqual({ id: 'f-1', tenantId: 'tenant-2' });
    });

    it('always scopes the list to the tenant and caps it', async () => {
        // Break: dropping the default `take`. The evidence library is
        // unpaginated, so an uncapped findMany streams every file row a
        // tenant has ever uploaded into memory.
        await FileRepository.listByTenant(asTx(db), ctx);

        expect(whereOf(db.fileRecord.findMany)).toEqual({ tenantId: 'tenant-1' });
        expect(argOf(db.fileRecord.findMany).take).toBe(200);
        expect(argOf(db.fileRecord.findMany).orderBy).toEqual({ createdAt: 'desc' });
    });

    it('layers status, domain and name-prefix filters on top of the tenant', async () => {
        await FileRepository.listByTenant(asTx(db), ctx, {
            status: 'STORED',
            domain: 'evidence',
            originalNamePrefix: 'Q1-',
            take: 5,
        });

        expect(whereOf(db.fileRecord.findMany)).toEqual({
            tenantId: 'tenant-1',
            status: 'STORED',
            domain: 'evidence',
            originalName: { startsWith: 'Q1-' },
        });
        expect(argOf(db.fileRecord.findMany).take).toBe(5);
    });

    it('dedups only against a STORED twin', async () => {
        // Break: matching on (tenantId, sha256) alone. A PENDING row is a
        // record of an upload that never finished — reusing its pathKey
        // hands the caller a storage key with no bytes behind it, and the
        // resulting evidence download 404s.
        await FileRepository.findBySha256(asTx(db), 'tenant-1', 'b'.repeat(64));

        expect(whereOf(db.fileRecord.findFirst)).toEqual({
            tenantId: 'tenant-1',
            sha256: 'b'.repeat(64),
            status: 'STORED',
        });
    });

    it('finds abandoned PENDING rows strictly older than the cutoff', async () => {
        // Break: `lte` instead of `lt`, or omitting the PENDING filter —
        // the cleanup job would start reaping successfully STORED files.
        const cutoff = new Date('2026-01-01T00:00:00.000Z');

        await FileRepository.findPendingOlderThan(asTx(db), 'tenant-1', cutoff);

        expect(whereOf(db.fileRecord.findMany)).toEqual({
            tenantId: 'tenant-1',
            status: 'PENDING',
            createdAt: { lt: cutoff },
        });
    });

    it('looks a file up by path key WITHOUT a tenant filter', async () => {
        // Pinned deliberately: this lookup is global. The tenant lives
        // inside the key itself (see `assertTenantKey` / `parseTenantKey`
        // in src/lib/storage), so any future caller MUST validate the key
        // before trusting the row. A change that starts filtering here is
        // fine; a change that adds a caller without that validation is not.
        await FileRepository.getByPathKey(asTx(db), 'tenant-1/general/abc.pdf');

        expect(whereOf(db.fileRecord.findFirst)).toEqual({
            pathKey: 'tenant-1/general/abc.pdf',
        });
    });
});

describe('FileRepository — AV scan lifecycle', () => {
    it('writes scan details only when there are details to write', async () => {
        // Break: `scanDetails: scanDetails` unconditionally. A CLEAN result
        // would then null out the message from a previous INFECTED verdict,
        // erasing the reason a quarantined file was quarantined.
        await FileRepository.updateScanStatus(asTx(db), 'f-1', 'CLEAN');

        expect(dataOf(db.fileRecord.update)).not.toHaveProperty('scanDetails');
        expect(dataOf(db.fileRecord.update).scanStatus).toBe('CLEAN');
        expect(dataOf(db.fileRecord.update).updatedAt).toBeInstanceOf(Date);
    });

    it('carries the detail string through when one is supplied', async () => {
        await FileRepository.updateScanStatus(asTx(db), 'f-1', 'INFECTED', 'EICAR-Test-Signature');

        expect(dataOf(db.fileRecord.update)).toMatchObject({
            scanStatus: 'INFECTED',
            scanDetails: 'EICAR-Test-Signature',
        });
    });

    it('records a clean verdict with no details', async () => {
        await FileRepository.markScanClean(asTx(db), 'f-1');

        expect(dataOf(db.fileRecord.update).scanStatus).toBe('CLEAN');
        expect(dataOf(db.fileRecord.update)).not.toHaveProperty('scanDetails');
    });

    it('records an infected verdict together with the engine’s reason', async () => {
        // Break: swapping the two verdict helpers, or passing the details
        // as the status. Either way an infected file would be recorded as
        // clean and stay downloadable.
        await FileRepository.markScanInfected(asTx(db), 'f-1', 'Trojan.Generic');

        expect(dataOf(db.fileRecord.update)).toMatchObject({
            scanStatus: 'INFECTED',
            scanDetails: 'Trojan.Generic',
        });
    });

    it('queues only STORED files awaiting a scan, oldest first, bounded', async () => {
        // Break: dropping `status: 'STORED'`. The sweep would pick up rows
        // whose bytes were never written, and every one of those scans
        // fails against a missing object.
        await FileRepository.findPendingScan(asTx(db));

        expect(whereOf(db.fileRecord.findMany)).toEqual({
            scanStatus: 'PENDING',
            status: 'STORED',
        });
        expect(argOf(db.fileRecord.findMany).orderBy).toEqual({ createdAt: 'asc' });
        expect(argOf(db.fileRecord.findMany).take).toBe(100);
    });

    it('narrows the scan queue to one tenant when asked', async () => {
        await FileRepository.findPendingScan(asTx(db), 'tenant-2');

        expect(whereOf(db.fileRecord.findMany)).toMatchObject({ tenantId: 'tenant-2' });
    });
});

describe('FileRepository.isFileOwnedByTenant', () => {
    it('accepts a legacy filename recorded on an Evidence row, without a second query', async () => {
        // Break: dropping the early return. Harmless functionally, but the
        // legacy download path calls this per request — the FileRecord
        // query is pure waste once ownership is already proven.
        db.evidence.findFirst.mockResolvedValue({ id: 'e-1' });

        expect(await FileRepository.isFileOwnedByTenant(asTx(db), ctx, 'report.pdf')).toBe(true);
        expect(whereOf(db.evidence.findFirst)).toEqual({
            tenantId: 'tenant-1',
            content: 'report.pdf',
        });
        expect(db.fileRecord.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to matching either the path key or the original name', async () => {
        // Break: matching `pathKey` only. Files uploaded through the newer
        // route are referenced by original name in older evidence rows, so
        // the OR arm is what keeps those downloads working.
        db.fileRecord.findFirst.mockResolvedValue({ id: 'f-1' });

        expect(await FileRepository.isFileOwnedByTenant(asTx(db), ctx, 'report.pdf')).toBe(true);
        expect(whereOf(db.fileRecord.findFirst)).toEqual({
            tenantId: 'tenant-1',
            OR: [{ pathKey: 'report.pdf' }, { originalName: 'report.pdf' }],
        });
    });

    it('denies a filename that belongs to no row of the calling tenant', async () => {
        // Break: returning the row object instead of a boolean, or `!row`
        // inverted. This value gates a raw file download — a truthy
        // default is a cross-tenant file read.
        expect(await FileRepository.isFileOwnedByTenant(asTx(db), ctx, 'someone-elses.pdf')).toBe(false);
    });

    it('asks both questions about the CALLING tenant, not a fixed one', async () => {
        await FileRepository.isFileOwnedByTenant(asTx(db), OTHER_TENANT, 'report.pdf');

        expect(whereOf(db.evidence.findFirst)).toMatchObject({ tenantId: 'tenant-2' });
        expect(whereOf(db.fileRecord.findFirst)).toMatchObject({ tenantId: 'tenant-2' });
    });
});
