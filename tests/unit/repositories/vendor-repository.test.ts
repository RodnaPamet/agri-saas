/**
 * Coverage wave 16 — `VendorRepository` and its two satellites.
 *
 * The densest uncovered file in `src/app-layer/repositories`: 129
 * uncovered branches at 7.2%. Repositories are where the multi-tenant
 * isolation invariant actually lives ("every repository query must
 * filter by tenantId"), so an untested repository is an untested
 * security boundary.
 *
 * These assert the QUERY the repository emits, not Prisma's behaviour —
 * the boundary contract this code owns. `db` is a recording double;
 * the pagination helpers (`clampLimit`, `buildCursorWhere`,
 * `computePageInfo`) run for real, because their interaction with the
 * repository is part of what is under test.
 */
import {
    VendorRepository,
    VendorDocumentRepository,
    VendorLinkRepository,
} from '@/app-layer/repositories/VendorRepository';
import { makeRequestContext } from '../../helpers/make-context';
import { encodeCursor, MAX_LIMIT, DEFAULT_LIMIT } from '@/lib/pagination';
import { Prisma } from '@prisma/client';
import type { PrismaTx } from '@/lib/db-context';

const ctx = makeRequestContext('ADMIN'); // tenantId: 'tenant-1', userId: 'user-1'
const OTHER_TENANT = makeRequestContext('ADMIN', { tenantId: 'tenant-2' });

function makeDb() {
    const model = () => ({
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'created' }),
        update: jest.fn().mockResolvedValue({ id: 'updated' }),
        delete: jest.fn().mockResolvedValue({ id: 'deleted' }),
    });
    return {
        vendor: model(),
        vendorDocument: model(),
        vendorLink: model(),
    };
}

type FakeDb = ReturnType<typeof makeDb>;
const asTx = (db: FakeDb) => db as unknown as PrismaTx;

/** The `where` of the first findMany call. */
const whereOf = (fn: jest.Mock) => fn.mock.calls[0][0].where;
/** The `data` of the first create/update call. */
const dataOf = (fn: jest.Mock) => fn.mock.calls[0][0].data;

let db: FakeDb;
beforeEach(() => {
    db = makeDb();
});

describe('VendorRepository — tenant isolation', () => {
    it('scopes the list query to the calling tenant', async () => {
        // Break: dropping `tenantId` from _buildWhere returns every
        // tenant's vendors to whoever asks — the isolation invariant
        // the whole app rests on.
        await VendorRepository.list(asTx(db), ctx);

        expect(whereOf(db.vendor.findMany)).toMatchObject({ tenantId: 'tenant-1' });
    });

    it('scopes the list query to the OTHER tenant when that is the caller', async () => {
        // Break: hard-coding or caching a tenantId. Naming one tenant
        // in a single test cannot catch that; two can.
        await VendorRepository.list(asTx(db), OTHER_TENANT);

        expect(whereOf(db.vendor.findMany)).toMatchObject({ tenantId: 'tenant-2' });
    });

    it('requires both id and tenant to read a vendor by id', async () => {
        // Break: looking up by id alone makes every vendor readable
        // cross-tenant by guessing or leaking an id.
        await VendorRepository.getById(asTx(db), ctx, 'v-1');

        expect(db.vendor.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'v-1', tenantId: 'tenant-1' },
            }),
        );
    });

    it('refuses to update a vendor belonging to another tenant', async () => {
        // Break: dropping the tenant-scoped existence check. `update`
        // then writes by id ALONE, so a foreign id would be mutated.
        db.vendor.findFirst.mockResolvedValue(null);

        const result = await VendorRepository.update(asTx(db), ctx, 'v-foreign', {
            name: 'hijacked',
        });

        expect(result).toBeNull();
        expect(db.vendor.update).not.toHaveBeenCalled();
        // Assert the LOOKUP is tenant-scoped, not merely that a missing
        // row is refused: with findFirst mocked to null, the refusal
        // holds for any where-clause, so it alone would not notice the
        // tenant filter being dropped.
        expect(db.vendor.findFirst).toHaveBeenCalledWith({
            where: { id: 'v-foreign', tenantId: 'tenant-1' },
        });
    });

    it('refuses to change the status of a vendor belonging to another tenant', async () => {
        // Break: same missing guard on the status path.
        db.vendor.findFirst.mockResolvedValue(null);

        const result = await VendorRepository.setStatus(asTx(db), ctx, 'v-foreign', 'ACTIVE');

        expect(result).toBeNull();
        expect(db.vendor.update).not.toHaveBeenCalled();
        expect(db.vendor.findFirst).toHaveBeenCalledWith({
            where: { id: 'v-foreign', tenantId: 'tenant-1' },
        });
    });

    it('refuses to delete a document belonging to another tenant', async () => {
        // Break: `delete({ where: { id } })` runs unscoped, so without
        // the check any document id is deletable cross-tenant.
        db.vendorDocument.findFirst.mockResolvedValue(null);

        const result = await VendorDocumentRepository.deleteById(asTx(db), ctx, 'doc-foreign');

        expect(result).toBeNull();
        expect(db.vendorDocument.delete).not.toHaveBeenCalled();
        expect(db.vendorDocument.findFirst).toHaveBeenCalledWith({
            where: { id: 'doc-foreign', tenantId: 'tenant-1' },
        });
    });

    it('refuses to delete a link belonging to another tenant', async () => {
        // Break: same unscoped delete on the link path.
        db.vendorLink.findFirst.mockResolvedValue(null);

        const result = await VendorLinkRepository.deleteById(asTx(db), ctx, 'link-foreign');

        expect(result).toBeNull();
        expect(db.vendorLink.delete).not.toHaveBeenCalled();
        expect(db.vendorLink.findFirst).toHaveBeenCalledWith({
            where: { id: 'link-foreign', tenantId: 'tenant-1' },
        });
    });

    it('does change the status of a vendor inside the tenant', async () => {
        // Paired with the refusal test above on purpose: a refusal
        // assertion alone still passes if the method never does
        // anything at all. This pins the positive half.
        db.vendor.findFirst.mockResolvedValue({ id: 'v-1' });

        await VendorRepository.setStatus(asTx(db), ctx, 'v-1', 'ACTIVE');

        expect(db.vendor.update).toHaveBeenCalledWith({
            where: { id: 'v-1' },
            data: { status: 'ACTIVE' },
        });
    });

    it('does delete a document inside the tenant', async () => {
        // Positive half of the document guard.
        db.vendorDocument.findFirst.mockResolvedValue({ id: 'doc-1' });

        await VendorDocumentRepository.deleteById(asTx(db), ctx, 'doc-1');

        expect(db.vendorDocument.delete).toHaveBeenCalledWith({ where: { id: 'doc-1' } });
    });

    it('does delete a link inside the tenant', async () => {
        // Positive half of the link guard.
        db.vendorLink.findFirst.mockResolvedValue({ id: 'link-1' });

        await VendorLinkRepository.deleteById(asTx(db), ctx, 'link-1');

        expect(db.vendorLink.delete).toHaveBeenCalledWith({ where: { id: 'link-1' } });
    });

    it('scopes document and link listings to the tenant as well as the vendor', async () => {
        // Break: filtering by vendorId alone. Vendor ids are opaque but
        // not secret; the tenant filter is what actually isolates.
        await VendorDocumentRepository.listByVendor(asTx(db), ctx, 'v-1');
        await VendorLinkRepository.listByVendor(asTx(db), ctx, 'v-1');

        expect(whereOf(db.vendorDocument.findMany)).toEqual({
            tenantId: 'tenant-1',
            vendorId: 'v-1',
        });
        expect(whereOf(db.vendorLink.findMany)).toEqual({
            tenantId: 'tenant-1',
            vendorId: 'v-1',
        });
    });
});

describe('VendorRepository — filter translation', () => {
    it('emits nothing but the tenant filter when no filters are supplied', async () => {
        // Break: a stray default filter would silently hide rows.
        await VendorRepository.list(asTx(db), ctx);

        expect(whereOf(db.vendor.findMany)).toEqual({ tenantId: 'tenant-1' });
    });

    it('translates status and criticality straight through', async () => {
        // Break: mapping either to the wrong column.
        await VendorRepository.list(asTx(db), ctx, {
            status: 'ACTIVE',
            criticality: 'HIGH',
        });

        expect(whereOf(db.vendor.findMany)).toMatchObject({
            status: 'ACTIVE',
            criticality: 'HIGH',
        });
    });

    it('translates a risk rating into an assessment sub-query', async () => {
        // Break: applying riskRating to the Vendor row itself, where
        // the column does not exist — the filter would silently no-op
        // or throw at the database.
        await VendorRepository.list(asTx(db), ctx, { riskRating: 'HIGH' });

        expect(whereOf(db.vendor.findMany)).toMatchObject({
            assessments: { some: { riskRating: 'HIGH' } },
        });
    });

    it('searches name, legal name and domain case-insensitively', async () => {
        // Break: dropping a column from the OR, or losing the
        // insensitive mode — "acme" would stop matching "ACME Ltd".
        await VendorRepository.list(asTx(db), ctx, { q: 'acme' });

        expect(whereOf(db.vendor.findMany).OR).toEqual([
            { name: { contains: 'acme', mode: 'insensitive' } },
            { legalName: { contains: 'acme', mode: 'insensitive' } },
            { domain: { contains: 'acme', mode: 'insensitive' } },
        ]);
    });

    it('treats an overdue review as strictly in the past', async () => {
        // Break: using `gt`, which would list everything NOT overdue.
        const before = Date.now();
        await VendorRepository.list(asTx(db), ctx, { reviewDue: 'overdue' });
        const after = Date.now();

        const { nextReviewAt } = whereOf(db.vendor.findMany);
        expect(Object.keys(nextReviewAt)).toEqual(['lt']);
        expect(nextReviewAt.lt.getTime()).toBeGreaterThanOrEqual(before);
        expect(nextReviewAt.lt.getTime()).toBeLessThanOrEqual(after);
    });

    it('bounds a next-30-days review window at both ends', async () => {
        // Break: an open-ended `gte` would fold every future review
        // into the "due soon" bucket.
        const before = Date.now();
        await VendorRepository.list(asTx(db), ctx, { reviewDue: 'next30d' });

        const { nextReviewAt } = whereOf(db.vendor.findMany);
        expect(nextReviewAt.gte.getTime()).toBeGreaterThanOrEqual(before);
        const spanDays =
            (nextReviewAt.lte.getTime() - nextReviewAt.gte.getTime()) / 86_400_000;
        expect(spanDays).toBeCloseTo(30, 5);
    });

    it('applies an explicit take and omits it otherwise', async () => {
        // Break: a hard-coded take would silently truncate callers
        // that asked for everything.
        await VendorRepository.list(asTx(db), ctx, {}, { take: 5 });
        expect(db.vendor.findMany.mock.calls[0][0].take).toBe(5);

        db = makeDb();
        await VendorRepository.list(asTx(db), ctx);
        expect(db.vendor.findMany.mock.calls[0][0]).not.toHaveProperty('take');
    });
});

describe('VendorRepository — cursor pagination', () => {
    const row = (i: number) => ({
        id: `v-${i}`,
        createdAt: new Date(Date.UTC(2026, 0, i + 1)),
    });

    it('over-fetches by one and trims, reporting the next page', async () => {
        // Break: fetching exactly `limit` makes hasNextPage always
        // false — the UI stops paging one page early, permanently.
        db.vendor.findMany.mockResolvedValue([row(1), row(2), row(3)]);

        const result = await VendorRepository.listPaginated(asTx(db), ctx, { limit: 2 });

        expect(db.vendor.findMany.mock.calls[0][0].take).toBe(3);
        expect(result.items).toHaveLength(2);
        expect(result.pageInfo.hasNextPage).toBe(true);
        expect(result.pageInfo.nextCursor).toBeDefined();
    });

    it('reports no next page when the results fit', async () => {
        // Break: always advertising another page loops the client.
        db.vendor.findMany.mockResolvedValue([row(1)]);

        const result = await VendorRepository.listPaginated(asTx(db), ctx, { limit: 2 });

        expect(result.items).toHaveLength(1);
        expect(result.pageInfo.hasNextPage).toBe(false);
        expect(result.pageInfo.nextCursor).toBeUndefined();
    });

    it('clamps an oversized limit and defaults a missing one', async () => {
        // Break: honouring `limit=100000` hands a client the ability
        // to pull an entire tenant in one request.
        await VendorRepository.listPaginated(asTx(db), ctx, { limit: 10_000 });
        expect(db.vendor.findMany.mock.calls[0][0].take).toBe(MAX_LIMIT + 1);

        db = makeDb();
        await VendorRepository.listPaginated(asTx(db), ctx, {});
        expect(db.vendor.findMany.mock.calls[0][0].take).toBe(DEFAULT_LIMIT + 1);
    });

    it('adds the cursor predicate alongside the tenant filter, not instead of it', async () => {
        // Break: replacing `where` with the cursor predicate would
        // page across every tenant's vendors.
        const cursor = encodeCursor({
            createdAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
            id: 'v-5',
        });

        await VendorRepository.listPaginated(asTx(db), ctx, {
            cursor,
            filters: { status: 'ACTIVE' },
        });

        const where = whereOf(db.vendor.findMany);
        expect(where.tenantId).toBe('tenant-1');
        expect(where.status).toBe('ACTIVE');
        expect(where.AND).toHaveLength(1);
        expect(where.AND[0]).toHaveProperty('OR');
    });

    it('ignores an unparseable cursor rather than failing the query', async () => {
        // Break: throwing on a tampered or stale cursor turns a
        // bookmarked URL into a 500.
        await VendorRepository.listPaginated(asTx(db), ctx, { cursor: 'not-a-cursor' });

        expect(whereOf(db.vendor.findMany)).not.toHaveProperty('AND');
    });
});

describe('VendorRepository — create and update payloads', () => {
    it('stamps the tenant and applies documented defaults on create', async () => {
        // Break: a different default status/criticality silently
        // changes where new vendors land in the workflow.
        await VendorRepository.create(asTx(db), ctx, { name: 'Acme' });

        expect(dataOf(db.vendor.create)).toMatchObject({
            tenantId: 'tenant-1',
            name: 'Acme',
            status: 'ONBOARDING',
            criticality: 'MEDIUM',
            isSubprocessor: false,
            tags: Prisma.JsonNull,
        });
    });

    it('coerces blank optional strings to null and date strings to Date', async () => {
        // Break: persisting '' instead of null — every "is it set?"
        // check downstream reads empty string as present.
        await VendorRepository.create(asTx(db), ctx, {
            name: 'Acme',
            legalName: '',
            domain: '',
            nextReviewAt: '2026-03-01T00:00:00.000Z',
        });

        const data = dataOf(db.vendor.create);
        expect(data.legalName).toBeNull();
        expect(data.domain).toBeNull();
        expect(data.nextReviewAt).toBeInstanceOf(Date);
        expect((data.nextReviewAt as Date).toISOString()).toBe('2026-03-01T00:00:00.000Z');
        expect(data.contractRenewalAt).toBeNull();
    });

    it('sends only the fields the caller actually supplied on update', async () => {
        // Break: spreading undefined keys would null out every column
        // the caller did not mention — a rename wiping the record.
        db.vendor.findFirst.mockResolvedValue({ id: 'v-1' });

        await VendorRepository.update(asTx(db), ctx, 'v-1', { name: 'Renamed' });

        expect(dataOf(db.vendor.update)).toEqual({ name: 'Renamed' });
    });

    it('omits an untouched field entirely rather than sending it as undefined', async () => {
        // The test above supplies `name`, so it cannot distinguish a
        // conditional spread from an unconditional `name: data.name` —
        // both yield the same payload. This one changes a DIFFERENT
        // field, so an unconditional spread would surface `name` as an
        // undefined key. Break: Prisma treats a present-but-undefined
        // key as "no change" today, but the payload is also what audit
        // diffing and any future strict-mode client read.
        db.vendor.findFirst.mockResolvedValue({ id: 'v-1' });

        await VendorRepository.update(asTx(db), ctx, 'v-1', { status: 'ACTIVE' });

        const data = dataOf(db.vendor.update);
        expect(data).toEqual({ status: 'ACTIVE' });
        expect(Object.keys(data)).toEqual(['status']);
        expect(data).not.toHaveProperty('name');
    });

    it('distinguishes an explicit null from an omitted field on update', async () => {
        // Break: treating null as "no change" removes the only way to
        // clear an optional field.
        db.vendor.findFirst.mockResolvedValue({ id: 'v-1' });

        await VendorRepository.update(asTx(db), ctx, 'v-1', {
            ownerUserId: null,
            nextReviewAt: null,
        });

        expect(dataOf(db.vendor.update)).toEqual({
            ownerUserId: null,
            nextReviewAt: null,
        });
    });
});

describe('VendorDocumentRepository — create', () => {
    it('records the uploader and stamps the tenant', async () => {
        // Break: losing uploadedByUserId removes the audit trail on
        // evidence documents.
        await VendorDocumentRepository.create(asTx(db), ctx, 'v-1', { type: 'SOC2' });

        expect(dataOf(db.vendorDocument.create)).toMatchObject({
            tenantId: 'tenant-1',
            vendorId: 'v-1',
            type: 'SOC2',
            uploadedByUserId: 'user-1',
        });
    });

    it('normalises a whitespace-only folder to null', async () => {
        // Break: storing '   ' as a folder name. The group-by code
        // keys on null for "no folder", so a blank string creates a
        // phantom folder in the UI.
        await VendorDocumentRepository.create(asTx(db), ctx, 'v-1', {
            type: 'SOC2',
            folder: '   ',
        });

        expect(dataOf(db.vendorDocument.create).folder).toBeNull();
    });

    it('trims a real folder name rather than storing it padded', async () => {
        // Break: ' Audits' and 'Audits' becoming two distinct folders.
        await VendorDocumentRepository.create(asTx(db), ctx, 'v-1', {
            type: 'SOC2',
            folder: '  Audits  ',
        });

        expect(dataOf(db.vendorDocument.create).folder).toBe('Audits');
    });
});

describe('VendorLinkRepository — create', () => {
    it('defaults the relation to RELATED', async () => {
        // Break: an undefined relation would violate the column's
        // enum constraint at insert time.
        await VendorLinkRepository.create(asTx(db), ctx, 'v-1', {
            entityType: 'RISK',
            entityId: 'r-1',
        });

        expect(dataOf(db.vendorLink.create)).toMatchObject({
            tenantId: 'tenant-1',
            vendorId: 'v-1',
            entityType: 'RISK',
            entityId: 'r-1',
            relation: 'RELATED',
        });
    });

    it('honours an explicit relation', async () => {
        // Break: always writing the default would collapse every link
        // type into one.
        await VendorLinkRepository.create(asTx(db), ctx, 'v-1', {
            entityType: 'RISK',
            entityId: 'r-1',
            relation: 'MITIGATES',
        });

        expect(dataOf(db.vendorLink.create).relation).toBe('MITIGATES');
    });
});
