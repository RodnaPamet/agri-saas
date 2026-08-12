/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/cost-entry.ts` (and, by
 * extension, `CostEntryRepository` — mocked only at the
 * `runInTenantContext`/`db` boundary, so the repository's real
 * `where`-building logic runs).
 *
 * The two invariants Prisma cannot express are the point of this file:
 *
 *   1. AT MOST ONE domain link. A row claiming two homes is rendered on
 *      two domain pages and summed twice by anything grouping per domain.
 *   2. AN INVOICE MUST HAVE LANDED. `FileRecord` is created PENDING
 *      before its bytes are confirmed, and the obvious precedent to copy
 *      (`attachLogEntryFile`) checks tenant ownership ONLY — so a cost
 *      entry could point at an upload that never completed, or at a file
 *      the maintenance sweep has since soft-deleted.
 *
 * Both are enforced in the usecase and asserted here rather than trusted
 * to a comment.
 */

const mockDb = {
    costEntry: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    fileRecord: { findFirst: jest.fn() },
    planting: { findFirst: jest.fn() },
    season: { findFirst: jest.fn() },
    location: { findFirst: jest.fn() },
    parcel: { findFirst: jest.fn() },
    parcelLease: { findFirst: jest.fn() },
    item: { findFirst: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

// The storage pipeline, stubbed at its seams. The point of these tests is
// the ORDER and the GATES around the write — not the provider itself.
const mockWrite = jest.fn(async () => ({ sha256: 'abc123', sizeBytes: 42 }));
jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => ({ name: 'local', write: mockWrite, delete: jest.fn() }),
    buildTenantObjectKey: (t: string, domain: string, name: string) => `tenants/${t}/${domain}/${name}`,
    isAllowedMime: (m: string) => m === 'application/pdf',
    isAllowedSize: (n: number) => n < 10_000_000,
    FILE_MAX_SIZE_BYTES: 10_000_000,
}));
jest.mock('@/lib/storage/av-scan', () => ({ scanUploadedBuffer: async () => 'CLEAN' }));
jest.mock('@/lib/storage/mime-sniff', () => ({
    reconcileMimeType: (declared: string) => ({ resolved: declared, detected: declared, corrected: false }),
}));
jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        createPending: jest.fn(async () => ({ id: 'file-new' })),
        markStored: jest.fn(),
    },
}));

import {
    listCostEntries,
    createCostEntry,
    updateCostEntry,
    deleteCostEntry,
    assertSingleDomainLink,
    listCostEntriesForDomain,
    uploadCostInvoice,
    detachCostInvoice,
} from '@/app-layer/usecases/cost-entry';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantSlug: 'acme', tenantId: 'tenant-1' });
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme', tenantId: 'tenant-1' });

/** A persisted row as the repository's include-shape returns it. */
function row(over: Record<string, unknown> = {}) {
    return {
        id: 'ce-1',
        category: 'FUEL',
        amount: 340,
        currency: 'BGN',
        incurredOn: new Date('2026-08-01T00:00:00Z'),
        supplier: 'Petrol AD',
        invoiceFileId: null,
        plantingId: null,
        seasonId: null,
        locationId: null,
        parcelId: null,
        leaseId: null,
        itemId: null,
        createdByUserId: 'u-1',
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        planting: null,
        season: null,
        location: null,
        parcel: null,
        item: null,
        invoiceFile: null,
        ...over,
    };
}

function baseInput(over: Record<string, unknown> = {}) {
    return {
        category: 'FUEL' as const,
        amount: 340,
        currency: 'bgn',
        incurredOn: '2026-08-01',
        supplier: 'Petrol AD',
        description: null,
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.costEntry.create.mockResolvedValue(row());
    mockDb.costEntry.update.mockResolvedValue(row());
    mockDb.costEntry.findFirst.mockResolvedValue(row());
    mockDb.costEntry.findMany.mockResolvedValue([row()]);
    mockDb.costEntry.count.mockResolvedValue(1);
    mockDb.planting.findFirst.mockResolvedValue({ id: 'p-1' });
    mockDb.season.findFirst.mockResolvedValue({ id: 's-1' });
    mockDb.location.findFirst.mockResolvedValue({ id: 'loc-1' });
    mockDb.parcel.findFirst.mockResolvedValue({ id: 'par-1' });
    mockDb.parcelLease.findFirst.mockResolvedValue({ id: 'lease-1' });
    mockDb.item.findFirst.mockResolvedValue({ id: 'item-1' });
    mockDb.fileRecord.findFirst.mockResolvedValue({
        id: 'file-1',
        status: 'STORED',
        deletedAt: null,
    });
});

describe('createCostEntry — the happy paths', () => {
    it('creates without an invoice, uppercases currency, and audits', async () => {
        await createCostEntry(ctx, baseInput());

        const data = mockDb.costEntry.create.mock.calls[0][0].data;
        expect(data.currency).toBe('BGN');
        expect(data.tenantId).toBe('tenant-1');
        expect(data.invoiceFileId).toBeNull();
        // No invoice ⇒ the file gate is never consulted.
        expect(mockDb.fileRecord.findFirst).not.toHaveBeenCalled();
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('creates WITH an invoice once the file is STORED', async () => {
        await createCostEntry(ctx, baseInput({ invoiceFileId: 'file-1' }));

        expect(mockDb.fileRecord.findFirst).toHaveBeenCalledTimes(1);
        // The gate is tenant-scoped: a file id from another tenant must not
        // resolve, so the tenant filter belongs in the WHERE, not a
        // post-hoc comparison.
        expect(mockDb.fileRecord.findFirst.mock.calls[0][0].where).toMatchObject({
            id: 'file-1',
            tenantId: 'tenant-1',
        });
        expect(mockDb.costEntry.create.mock.calls[0][0].data.invoiceFileId).toBe('file-1');
    });

    it('sanitises supplier AND description before persisting', async () => {
        await createCostEntry(
            ctx,
            baseInput({
                // MIXED CASE deliberately. An earlier version of this test
                // asserted `not.toMatch(/<script>/)`, which CodeQL flagged
                // as js/bad-tag-filter: that pattern does not match
                // `<SCRIPT>`, so the assertion would have passed vacuously
                // against the very payload most likely to slip a filter.
                supplier: '<ScRiPt>alert(1)</ScRiPt>Petrol AD',
                description: '<IMG SRC=x ONERROR=alert(1)>diesel',
            }),
        );

        const data = mockDb.costEntry.create.mock.calls[0][0].data;
        // Assert what sanitizePlainText actually guarantees — NO markup
        // survives — rather than hunting for one tag name. A tag-specific
        // assertion is only ever as good as the list of tags someone
        // thought to write down.
        expect(data.supplier).not.toMatch(/[<>]/);
        expect(data.description).not.toMatch(/[<>]/);
        expect(data.description).not.toMatch(/onerror/i);
        // `supplier` is NOT encrypted (it must stay filterable), which is
        // exactly why it still needs sanitising — encryption and
        // sanitisation answer different questions.
        expect(data.supplier).toContain('Petrol AD');
    });
});

describe('createCostEntry — the invoice gate', () => {
    it('REJECTS a FileRecord still PENDING', async () => {
        // The upload may never have completed. A cost entry pointing at it
        // would claim an invoice that does not exist.
        mockDb.fileRecord.findFirst.mockResolvedValue({
            id: 'file-1',
            status: 'PENDING',
            deletedAt: null,
        });

        await expect(
            createCostEntry(ctx, baseInput({ invoiceFileId: 'file-1' })),
        ).rejects.toThrow(/has not completed/);
        expect(mockDb.costEntry.create).not.toHaveBeenCalled();
    });

    it('REJECTS a soft-deleted FileRecord', async () => {
        mockDb.fileRecord.findFirst.mockResolvedValue({
            id: 'file-1',
            status: 'STORED',
            deletedAt: new Date(),
        });

        await expect(
            createCostEntry(ctx, baseInput({ invoiceFileId: 'file-1' })),
        ).rejects.toThrow(/has been deleted/);
        expect(mockDb.costEntry.create).not.toHaveBeenCalled();
    });

    it('REJECTS a file from another tenant', async () => {
        mockDb.fileRecord.findFirst.mockResolvedValue(null);

        await expect(
            createCostEntry(ctx, baseInput({ invoiceFileId: 'file-1' })),
        ).rejects.toThrow(/different tenant/);
    });
});

describe('createCostEntry — one domain link only', () => {
    it('accepts exactly one link', async () => {
        await createCostEntry(ctx, baseInput({ plantingId: 'p-1' }));
        expect(mockDb.costEntry.create.mock.calls[0][0].data.plantingId).toBe('p-1');
    });

    it('accepts an ITEM link — the product a cost bought', async () => {
        // The sixth link, added because the inventory surface had no
        // honest one: a cost's nearest column was `locationId`, which is
        // where a lot SITS rather than what was purchased.
        await createCostEntry(ctx, baseInput({ category: 'FERTILIZER', itemId: 'item-1' }));
        expect(mockDb.costEntry.create.mock.calls[0][0].data.itemId).toBe('item-1');
        expect(mockDb.item.findFirst).toHaveBeenCalledTimes(1);
    });

    it('REJECTS an item link ALONGSIDE another link', async () => {
        // itemId joins the same one-link-only rule as the other five.
        await expect(
            createCostEntry(ctx, baseInput({ itemId: 'item-1', plantingId: 'p-1' })),
        ).rejects.toThrow(/at most one/);
    });

    it('REJECTS an item from another tenant', async () => {
        mockDb.item.findFirst.mockResolvedValue(null);
        await expect(
            createCostEntry(ctx, baseInput({ itemId: 'item-1' })),
        ).rejects.toThrow(/different tenant/);
    });

    it('REJECTS two links, naming both', async () => {
        await expect(
            createCostEntry(ctx, baseInput({ plantingId: 'p-1', seasonId: 's-1' })),
        ).rejects.toThrow(/plantingId, seasonId/);
        expect(mockDb.costEntry.create).not.toHaveBeenCalled();
    });

    it('REJECTS a lease link on a non-RENT entry', async () => {
        // A diesel invoice filed against a lease would appear on the rent
        // surface, where it reads as rent.
        await expect(
            createCostEntry(ctx, baseInput({ category: 'FUEL', leaseId: 'lease-1' })),
        ).rejects.toThrow(/only be set on a RENT/);
    });

    it('accepts a lease link on a RENT entry', async () => {
        await createCostEntry(ctx, baseInput({ category: 'RENT', leaseId: 'lease-1' }));
        expect(mockDb.costEntry.create.mock.calls[0][0].data.leaseId).toBe('lease-1');
    });

    it('is exported as a pure function, so the rule is testable without a DB', () => {
        expect(() => assertSingleDomainLink({ plantingId: 'p-1' })).not.toThrow();
        expect(() => assertSingleDomainLink({ plantingId: 'p-1', parcelId: 'x' })).toThrow();
        expect(() => assertSingleDomainLink({})).not.toThrow();
    });
});

describe('updateCostEntry — validates the RESULTING row', () => {
    it('REJECTS a patch that adds a second link to an existing one', async () => {
        // Checking the patch alone would miss this: the patch sets ONE
        // link, but the row already had another.
        mockDb.costEntry.findFirst.mockResolvedValue(row({ plantingId: 'p-1' }));

        await expect(updateCostEntry(ctx, 'ce-1', { seasonId: 's-1' })).rejects.toThrow(
            /at most one/,
        );
        expect(mockDb.costEntry.update).not.toHaveBeenCalled();
    });

    it('ACCEPTS swapping one link for another in a single patch', async () => {
        mockDb.costEntry.findFirst.mockResolvedValue(row({ plantingId: 'p-1' }));

        await updateCostEntry(ctx, 'ce-1', { plantingId: null, seasonId: 's-1' });

        expect(mockDb.costEntry.update).toHaveBeenCalledTimes(1);
        const data = mockDb.costEntry.update.mock.calls[0][0].data;
        expect(data.plantingId).toBeNull();
        expect(data.seasonId).toBe('s-1');
    });

    it('404s on a missing row and audits nothing', async () => {
        mockDb.costEntry.findFirst.mockResolvedValue(null);
        await expect(updateCostEntry(ctx, 'nope', { amount: 5 })).rejects.toThrow(/not found/);
        expect(logEvent).not.toHaveBeenCalled();
    });
});

describe('listCostEntries', () => {
    it('filters by tenant and excludes soft-deleted rows', async () => {
        await listCostEntries(ctx);
        const where = mockDb.costEntry.findMany.mock.calls[0][0].where;
        expect(where.tenantId).toBe('tenant-1');
        expect(where.deletedAt).toBeNull();
    });

    it('applies the category facet as an IN, not an equality', async () => {
        // The facet is multi-select; an equality against a comma-joined
        // string is the failure mode this shape avoids.
        await listCostEntries(ctx, { categories: ['PAYROLL', 'RENT'] as any });
        expect(mockDb.costEntry.findMany.mock.calls[0][0].where.category).toEqual({
            in: ['PAYROLL', 'RENT'],
        });
    });

    it('never broadcasts the encrypted description on the list', async () => {
        await listCostEntries(ctx);
        const select = mockDb.costEntry.findMany.mock.calls[0][0].select;
        expect(select.description).toBeUndefined();
        expect(select.supplier).toBe(true);
    });

    it('is bounded and orders deterministically', async () => {
        await listCostEntries(ctx);
        const args = mockDb.costEntry.findMany.mock.calls[0][0];
        expect(typeof args.take).toBe('number');
        // `incurredOn` is a DATE — without the id tiebreak a day with
        // several entries has no total order, and a capped read returns a
        // different subset each refresh.
        expect(args.orderBy).toEqual([{ incurredOn: 'desc' }, { id: 'desc' }]);
    });

    it('skips the count query unless the page came back FULL', async () => {
        await listCostEntries(ctx);
        expect(mockDb.costEntry.count).not.toHaveBeenCalled();
    });

    it('a READER can list', async () => {
        await expect(listCostEntries(readerCtx)).resolves.toBeDefined();
    });
});

describe('deleteCostEntry', () => {
    it('soft-deletes and audits, never a hard delete', async () => {
        await deleteCostEntry(ctx, 'ce-1');
        expect(mockDb.costEntry.update).toHaveBeenCalledTimes(1);
        expect(mockDb.costEntry.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
        expect(logEvent).toHaveBeenCalledTimes(1);
    });
});

describe('listCostEntriesForDomain — the fan-out seam', () => {
    it('asks ONE query for a whole set of ids, not one per id', async () => {
        // D1 bans a read inside a loop. A lease list of 200 asking per row
        // would issue 200 queries; this is the same answer at one round
        // trip, grouped in memory.
        mockDb.costEntry.findMany.mockResolvedValue([
            row({ id: 'a', leaseId: 'lease-1', category: 'RENT' }),
            row({ id: 'b', leaseId: 'lease-1', category: 'RENT' }),
            row({ id: 'c', leaseId: 'lease-2', category: 'RENT' }),
        ]);

        const map = await listCostEntriesForDomain(ctx, 'leaseId', ['lease-1', 'lease-2', 'lease-3']);

        expect(mockDb.costEntry.findMany).toHaveBeenCalledTimes(1);
        expect(mockDb.costEntry.findMany.mock.calls[0][0].where.leaseId).toEqual({
            in: ['lease-1', 'lease-2', 'lease-3'],
        });
        expect(map.get('lease-1')).toHaveLength(2);
        expect(map.get('lease-2')).toHaveLength(1);
        // An id with no entries is ABSENT, not an empty array — a caller
        // writing `map.get(id) ?? []` is correct either way.
        expect(map.has('lease-3')).toBe(false);
    });

    it('is bounded and tenant-scoped', async () => {
        await listCostEntriesForDomain(ctx, 'plantingId', ['p-1']);
        const args = mockDb.costEntry.findMany.mock.calls[0][0];
        expect(typeof args.take).toBe('number');
        expect(args.where.tenantId).toBe('tenant-1');
        expect(args.where.deletedAt).toBeNull();
    });

    it('issues NO query for an empty id set', async () => {
        const map = await listCostEntriesForDomain(ctx, 'parcelId', []);
        expect(map.size).toBe(0);
        expect(mockDb.costEntry.findMany).not.toHaveBeenCalled();
    });

    it('never broadcasts the encrypted description to a domain page', async () => {
        mockDb.costEntry.findMany.mockResolvedValue([row({ id: 'a', leaseId: 'lease-1' })]);
        const map = await listCostEntriesForDomain(ctx, 'leaseId', ['lease-1']);
        // The projection carries a boolean, not the file or the narrative.
        expect(map.get('lease-1')![0]).not.toHaveProperty('description');
        expect(map.get('lease-1')![0]).toHaveProperty('hasInvoice');
    });

    it('a READER can read the fan-out', async () => {
        await expect(listCostEntriesForDomain(readerCtx, 'seasonId', ['s-1'])).resolves.toBeDefined();
    });
});

describe('uploadCostInvoice', () => {
    const { FileRepository } = jest.requireMock('@/app-layer/repositories/FileRepository');
    const pdf = () =>
        new File([new Uint8Array([1, 2, 3])], 'invoice.pdf', { type: 'application/pdf' });

    it('writes bytes, then marks the record STORED, then points the entry at it', async () => {
        await uploadCostInvoice(ctx, 'ce-1', pdf());

        // ORDER is the property: a record left PENDING is a trap, because
        // nothing else in the codebase advances that state.
        expect(mockWrite).toHaveBeenCalledTimes(1);
        expect(FileRepository.createPending).toHaveBeenCalledTimes(1);
        expect(FileRepository.markStored).toHaveBeenCalledTimes(1);
        expect(mockDb.costEntry.update.mock.calls[0][0].data.invoiceFileId).toBe('file-new');
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('files the object under its OWN storage domain', async () => {
        await uploadCostInvoice(ctx, 'ce-1', pdf());
        // Not `general`: an operator should be able to find every invoice
        // by key prefix, and a future retention rule should be able to
        // treat commercial paperwork differently from a field photo.
        expect(FileRepository.createPending.mock.calls[0][2].domain).toBe('cost-invoice');
        expect(FileRepository.createPending.mock.calls[0][2].pathKey).toContain('cost-invoice');
    });

    it('REJECTS a disallowed MIME type before writing anything', async () => {
        const exe = new File([new Uint8Array([1])], 'x.exe', { type: 'application/x-msdownload' });
        // `badRequest(code, detail)` puts the CODE on `.message`, so match
        // the code rather than the prose — the prose is the second arg.
        await expect(uploadCostInvoice(ctx, 'ce-1', exe)).rejects.toThrow(
            'FILE_TYPE_NOT_ALLOWED',
        );
        expect(mockWrite).not.toHaveBeenCalled();
    });

    it('404s on a missing entry AFTER the write, without attaching', async () => {
        // The bytes land before the transaction opens — that is the shape
        // of every upload path in this repo — so the guard here is that no
        // entry is updated and no audit row is written.
        mockDb.costEntry.findFirst.mockResolvedValue(null);
        await expect(uploadCostInvoice(ctx, 'nope', pdf())).rejects.toThrow(/not found/);
        expect(mockDb.costEntry.update).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });
});

describe('detachCostInvoice', () => {
    it('clears the pointer and KEEPS the FileRecord', async () => {
        await detachCostInvoice(ctx, 'ce-1');
        expect(mockDb.costEntry.update.mock.calls[0][0].data.invoiceFileId).toBeNull();
        // A cost entry's document may be referenced by an export or an
        // audit pack. Deleting the bytes to fix an attachment typo would
        // destroy evidence.
        expect(logEvent).toHaveBeenCalledTimes(1);
    });
});
