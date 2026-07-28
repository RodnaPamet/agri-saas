/**
 * Coverage wave 17 — `JournalRepository`.
 *
 * 107 uncovered branches at 29.1%. Same shape as the wave 16 vendor
 * suite: assert the QUERY the repository emits, with `db` as a
 * recording double.
 *
 * Two contracts here carry more weight than the filter plumbing:
 *
 *  - **Soft delete.** Every read path must exclude `deletedAt != null`.
 *    A break does not lose data, it RESURFACES deleted entries into the
 *    journal — worse than a crash, because it looks like working
 *    software.
 *  - **Cross-tenant id validation.** `validLocationIds` /
 *    `validEquipmentIds` / `validParcelIds` are what stop a caller
 *    attaching another tenant's location, equipment or parcel to their
 *    own journal entry. They are the tenant boundary for those joins.
 */
import { JournalRepository } from '@/app-layer/repositories/JournalRepository';
import { makeRequestContext } from '../../helpers/make-context';
import { encodeCursor, MAX_LIMIT, DEFAULT_LIMIT } from '@/lib/pagination';
import type { PrismaTx } from '@/lib/db-context';

const ctx = makeRequestContext('ADMIN'); // tenantId: 'tenant-1', userId: 'user-1'

function makeDb() {
    const model = () => ({
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'created' }),
        update: jest.fn().mockResolvedValue({ id: 'updated' }),
        delete: jest.fn().mockResolvedValue({ id: 'deleted' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    return {
        logEntry: model(),
        logEntryFile: model(),
        location: model(),
        equipment: model(),
        parcel: model(),
    };
}

type FakeDb = ReturnType<typeof makeDb>;
const asTx = (db: FakeDb) => db as unknown as PrismaTx;

const argOf = (fn: jest.Mock) => fn.mock.calls[0][0];
const whereOf = (fn: jest.Mock) => argOf(fn).where;

let db: FakeDb;
beforeEach(() => {
    db = makeDb();
});

describe('JournalRepository — soft-delete visibility', () => {
    it('hides soft-deleted entries from the default listing', async () => {
        // Break: dropping `deletedAt: null` resurfaces every deleted
        // entry into the journal. Nothing errors — the app just starts
        // showing records the user believes they removed.
        await JournalRepository.list(asTx(db), ctx);

        expect(whereOf(db.logEntry.findMany)).toMatchObject({
            tenantId: 'tenant-1',
            deletedAt: null,
        });
    });

    it('hides soft-deleted entries from a single-entry read', async () => {
        // Break: the detail route would render a deleted entry.
        await JournalRepository.getById(asTx(db), ctx, 'e-1');

        expect(whereOf(db.logEntry.findFirst)).toEqual({
            id: 'e-1',
            tenantId: 'tenant-1',
            deletedAt: null,
        });
    });

    it('scopes the attached files of an entry to the tenant too', async () => {
        // Break: an unscoped `files` include would surface another
        // tenant's file rows on an otherwise correctly-scoped entry.
        await JournalRepository.getById(asTx(db), ctx, 'e-1');

        expect(argOf(db.logEntry.findFirst).include.files.where).toEqual({
            tenantId: 'tenant-1',
        });
    });

    it('deliberately INCLUDES soft-deleted rows in the restore/purge lookup', async () => {
        // The mirror of the rule above: restore and purge must be able
        // to find a deleted row. Break: adding `deletedAt: null` here
        // makes the trash can permanently un-restorable.
        await JournalRepository.getByIdWithDeleted(asTx(db), ctx, 'e-1');

        const where = whereOf(db.logEntry.findFirst);
        expect(where).toEqual({ id: 'e-1', tenantId: 'tenant-1' });
        expect(where).not.toHaveProperty('deletedAt');
    });

    it('lists only deleted entries in the trash view, newest first and bounded', async () => {
        // Break: `deletedAt: null` here would show LIVE entries in the
        // trash can and offer to purge them.
        await JournalRepository.listDeleted(asTx(db), ctx);

        const arg = argOf(db.logEntry.findMany);
        expect(arg.where).toEqual({
            tenantId: 'tenant-1',
            deletedAt: { not: null },
        });
        expect(arg.orderBy).toEqual({ deletedAt: 'desc' });
        expect(arg.take).toBe(200);
    });
});

describe('JournalRepository — soft-delete lifecycle', () => {
    // NOTE: softDelete / restore / purge mutate by BARE id — no tenant
    // filter and no existence check, unlike VendorRepository which
    // guards inline. That is deliberate layering here: every caller in
    // `usecases/journal.ts` first runs the tenant-scoped `getById` /
    // `getByIdWithDeleted` and throws notFound, with RLS as the
    // database-level backstop. These tests pin the repository's actual
    // contract; the guard itself belongs to the usecase's tests.

    it('stamps who deleted the entry and when', async () => {
        // Break: losing deletedByUserId removes the only record of who
        // removed an agronomic entry — a compliance-relevant trail.
        const before = Date.now();
        await JournalRepository.softDelete(asTx(db), ctx, 'e-1');

        const arg = argOf(db.logEntry.update);
        expect(arg.where).toEqual({ id: 'e-1' });
        expect(arg.data.deletedByUserId).toBe('user-1');
        expect(arg.data.deletedAt).toBeInstanceOf(Date);
        expect((arg.data.deletedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('clears both delete markers on restore', async () => {
        // Break: clearing deletedAt but leaving deletedByUserId set
        // leaves a live entry looking deleted-by-someone.
        await JournalRepository.restore(asTx(db), ctx, 'e-1');

        expect(argOf(db.logEntry.update).data).toEqual({
            deletedAt: null,
            deletedByUserId: null,
        });
    });

    it('hard-deletes on purge', async () => {
        // Break: purge silently soft-deleting again would make the
        // trash can impossible to empty.
        const result = await JournalRepository.purge(asTx(db), ctx, 'e-1');

        expect(db.logEntry.delete).toHaveBeenCalledWith({ where: { id: 'e-1' } });
        expect(result).toBe(true);
    });
});

describe('JournalRepository — cross-tenant id validation', () => {
    it('returns an empty set without querying when given no ids', async () => {
        // Break: dropping the short-circuit issues `id: { in: [] }`,
        // a pointless round-trip on every free-hand entry.
        const result = await JournalRepository.validLocationIds(asTx(db), ctx, []);

        expect(result).toEqual(new Set());
        expect(db.location.findMany).not.toHaveBeenCalled();
    });

    it('confirms only the location ids that belong to the tenant', async () => {
        // Break: dropping the tenantId filter lets a caller attach
        // ANOTHER tenant's location to their journal entry — the whole
        // point of this helper.
        db.location.findMany.mockResolvedValue([{ id: 'loc-mine' }]);

        const result = await JournalRepository.validLocationIds(asTx(db), ctx, [
            'loc-mine',
            'loc-theirs',
        ]);

        expect(whereOf(db.location.findMany)).toMatchObject({
            tenantId: 'tenant-1',
            id: { in: ['loc-mine', 'loc-theirs'] },
        });
        // Only what the DB confirmed comes back.
        expect(result).toEqual(new Set(['loc-mine']));
        expect(result.has('loc-theirs')).toBe(false);
    });

    it('treats soft-deleted equipment as invalid', async () => {
        // Break: omitting `deletedAt: null` lets retired equipment be
        // attached to new work records.
        await JournalRepository.validEquipmentIds(asTx(db), ctx, ['eq-1']);

        expect(whereOf(db.equipment.findMany)).toMatchObject({
            tenantId: 'tenant-1',
            deletedAt: null,
        });
    });

    it('treats soft-deleted parcels as invalid', async () => {
        // Break: same, for parcels — a retired parcel would accept new
        // operations.
        await JournalRepository.validParcelIds(asTx(db), ctx, ['p-1']);

        expect(whereOf(db.parcel.findMany)).toMatchObject({
            tenantId: 'tenant-1',
            deletedAt: null,
        });
    });

    it('bounds each validation query by the size of the id set', async () => {
        // Break: an unbounded findMany here trips the repository
        // query-shape guardrail and removes the explicit bound the
        // comment relies on.
        await JournalRepository.validParcelIds(asTx(db), ctx, ['p-1', 'p-2', 'p-3']);

        expect(argOf(db.parcel.findMany).take).toBe(3);
    });
});

describe('JournalRepository — filter translation', () => {
    it('passes type and status straight through', async () => {
        await JournalRepository.list(asTx(db), ctx, {
            type: 'SPRAY',
            status: 'DONE',
        });

        expect(whereOf(db.logEntry.findMany)).toMatchObject({
            type: 'SPRAY',
            status: 'DONE',
        });
    });

    it('builds a half-open range when only one date bound is given', async () => {
        // Break: emitting `lte: undefined` alongside `gte` — Prisma
        // rejects an undefined comparator inside a filter object.
        await JournalRepository.list(asTx(db), ctx, { occurredFrom: '2026-03-01' });

        const { occurredAt } = whereOf(db.logEntry.findMany);
        expect(Object.keys(occurredAt)).toEqual(['gte']);
        expect(occurredAt.gte).toBeInstanceOf(Date);
    });

    it('builds a closed range when both date bounds are given', async () => {
        await JournalRepository.list(asTx(db), ctx, {
            occurredFrom: '2026-03-01',
            occurredTo: '2026-03-31',
        });

        const { occurredAt } = whereOf(db.logEntry.findMany);
        expect(Object.keys(occurredAt).sort()).toEqual(['gte', 'lte']);
    });

    it('omits the date filter entirely when neither bound is given', async () => {
        // Break: an always-present empty `occurredAt: {}` would match
        // nothing on some Prisma versions.
        await JournalRepository.list(asTx(db), ctx, { type: 'SPRAY' });

        expect(whereOf(db.logEntry.findMany)).not.toHaveProperty('occurredAt');
    });

    it('searches title and notes case-insensitively', async () => {
        await JournalRepository.list(asTx(db), ctx, { q: 'pšenica' });

        expect(whereOf(db.logEntry.findMany).OR).toEqual([
            { title: { contains: 'pšenica', mode: 'insensitive' } },
            { notes: { contains: 'pšenica', mode: 'insensitive' } },
        ]);
    });

    it('accepts a comma-separated multi-select of crops, trimming each', async () => {
        // Break: not trimming makes ' maize' miss every row, so a
        // multi-select silently returns nothing for all but the first.
        await JournalRepository.list(asTx(db), ctx, { crop: 'wheat, maize ,barley' });

        expect(whereOf(db.logEntry.findMany).operationParcel).toEqual({
            is: { parcel: { is: { cropType: { in: ['wheat', 'maize', 'barley'] } } } },
        });
    });

    it('adds no crop filter when the value is only separators', async () => {
        // Break: emitting `cropType: { in: [] }` matches nothing, so a
        // stray comma would blank the entire journal.
        await JournalRepository.list(asTx(db), ctx, { crop: ' , , ' });

        expect(whereOf(db.logEntry.findMany)).not.toHaveProperty('operationParcel');
    });

    it('filters by location through the join table', async () => {
        await JournalRepository.list(asTx(db), ctx, { locationId: 'loc-1' });

        expect(whereOf(db.logEntry.findMany).locations).toEqual({
            some: { locationId: 'loc-1' },
        });
    });

    it('filters by crop plan through plantings', async () => {
        await JournalRepository.list(asTx(db), ctx, { cropPlanId: 'plan-1' });

        expect(whereOf(db.logEntry.findMany).plantings).toEqual({
            some: { planting: { is: { cropPlanId: 'plan-1' } } },
        });
    });
});

describe('JournalRepository — equipment picker', () => {
    it('lists active equipment newest-first, bounded by default', async () => {
        // Break: an unbounded picker query on a tenant with thousands
        // of machines.
        await JournalRepository.listEquipment(asTx(db), ctx);

        const arg = argOf(db.equipment.findMany);
        expect(arg.where).toEqual({ tenantId: 'tenant-1', deletedAt: null });
        expect(arg.take).toBe(200);
        expect(arg.orderBy).toEqual([{ createdAt: 'desc' }]);
    });

    it('honours an explicit take', async () => {
        await JournalRepository.listEquipment(asTx(db), ctx, 10);

        expect(argOf(db.equipment.findMany).take).toBe(10);
    });
});

describe('JournalRepository — file links', () => {
    it('stamps the tenant and null-coerces a missing caption on attach', async () => {
        // Break: writing `undefined` for caption, which Prisma rejects
        // on a nullable column in strict mode.
        await JournalRepository.attachFile(asTx(db), ctx, 'e-1', 'f-1');

        expect(argOf(db.logEntryFile.create).data).toEqual({
            tenantId: 'tenant-1',
            logEntryId: 'e-1',
            fileRecordId: 'f-1',
            caption: null,
        });
    });

    it('scopes a file-link lookup to the tenant', async () => {
        // Break: an unscoped lookup would report another tenant's link
        // as already existing, so the idempotent-upload path would
        // return a foreign file.
        await JournalRepository.findFileLink(asTx(db), ctx, 'e-1', 'f-1');

        expect(whereOf(db.logEntryFile.findFirst)).toEqual({
            logEntryId: 'e-1',
            fileRecordId: 'f-1',
            tenantId: 'tenant-1',
        });
    });

    it('scopes the existence probe to the tenant and selects only the id', async () => {
        // Break: an unscoped probe reports another tenant's link as
        // existing, so an upload would be skipped as a duplicate.
        await JournalRepository.getFileLink(asTx(db), ctx, 'e-1', 'f-1');

        const arg = argOf(db.logEntryFile.findFirst);
        expect(arg.where).toEqual({
            logEntryId: 'e-1',
            fileRecordId: 'f-1',
            tenantId: 'tenant-1',
        });
        expect(arg.select).toEqual({ id: true });
    });

    it('scopes a detach to the tenant', async () => {
        // Break: an unscoped deleteMany removes matching links from
        // EVERY tenant, not just the caller's.
        const result = await JournalRepository.detachFile(asTx(db), ctx, 'e-1', 'f-1');

        expect(whereOf(db.logEntryFile.deleteMany)).toEqual({
            logEntryId: 'e-1',
            fileRecordId: 'f-1',
            tenantId: 'tenant-1',
        });
        expect(result).toBe(true);
    });
});

describe('JournalRepository — createLogEntry', () => {
    const dataOf = () => argOf(db.logEntry.create).data;

    it('stamps tenant and author, and defaults status, timestamp and notes', async () => {
        // Break: a different default status would land every offline
        // entry in the wrong workflow state.
        const before = Date.now();
        await JournalRepository.createLogEntry(asTx(db), ctx, {
            type: 'SPRAY',
            title: 'Spray block A',
        } as never);

        const data = dataOf();
        expect(data.tenantId).toBe('tenant-1');
        expect(data.createdByUserId).toBe('user-1');
        expect(data.status).toBe('DONE');
        expect(data.notes).toBeNull();
        expect(data.clientMutationId).toBeNull();
        expect((data.occurredAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('omits cost amount when absent but still writes a null currency', async () => {
        // The two are handled asymmetrically on purpose: costAmount is
        // spread conditionally (`!= null`), costCurrency is always
        // written (`?? null`). Break: writing `costAmount: null` on a
        // Decimal column, or dropping the currency key entirely.
        await JournalRepository.createLogEntry(asTx(db), ctx, {
            type: 'SPRAY',
            title: 'x',
        } as never);

        const data = dataOf();
        expect(data).not.toHaveProperty('costAmount');
        expect(data.costCurrency).toBeNull();
    });

    it('adds no child collections when none are supplied', async () => {
        // Break: emitting `create: []` for an untouched relation.
        await JournalRepository.createLogEntry(asTx(db), ctx, {
            type: 'SPRAY',
            title: 'x',
        } as never);

        const data = dataOf();
        expect(data).not.toHaveProperty('quantities');
        expect(data).not.toHaveProperty('locations');
        expect(data).not.toHaveProperty('equipment');
        expect(data).not.toHaveProperty('plantings');
    });

    it('treats an empty child array the same as an absent one', async () => {
        // Break: dropping the `.length` half of the guard emits an
        // empty nested create for every free-hand entry.
        await JournalRepository.createLogEntry(asTx(db), ctx, {
            type: 'SPRAY',
            title: 'x',
            locationIds: [],
            quantities: [],
        } as never);

        const data = dataOf();
        expect(data).not.toHaveProperty('locations');
        expect(data).not.toHaveProperty('quantities');
    });

    it('passes tenantId on the location and equipment joins', async () => {
        // These two join rows DO carry tenantId explicitly. Break:
        // omitting it violates the composite FK.
        await JournalRepository.createLogEntry(asTx(db), ctx, {
            type: 'SPRAY',
            title: 'x',
            locationIds: ['loc-1'],
            equipmentIds: ['eq-1'],
        } as never);

        const data = dataOf();
        expect(data.locations.create).toEqual([
            { tenantId: 'tenant-1', locationId: 'loc-1' },
        ]);
        expect(data.equipment.create).toEqual([
            { tenantId: 'tenant-1', equipmentId: 'eq-1' },
        ]);
    });

    it('does NOT pass tenantId on the quantity and planting joins', async () => {
        // The deliberate asymmetry with the two above, and the subtlest
        // contract in this file. Prisma populates tenantId on these from
        // the parent via the composite [logEntryId, tenantId] relation
        // FK and REJECTS it if passed ("Unknown argument tenantId"). A
        // tidy-up that makes all four nested creates look alike breaks
        // journal creation at runtime, not at compile time.
        await JournalRepository.createLogEntry(asTx(db), ctx, {
            type: 'SPRAY',
            title: 'x',
            quantities: [{ measure: 'VOLUME', value: 10, unitId: 'u-1' }],
            plantingLinks: [{ plantingId: 'pl-1', stage: 'V6' }],
        } as never);

        const data = dataOf();
        expect(data.quantities.create[0]).not.toHaveProperty('tenantId');
        expect(data.quantities.create[0]).toEqual({
            measure: 'VOLUME',
            value: 10,
            unitId: 'u-1',
            label: null,
        });
        expect(data.plantings.create[0]).not.toHaveProperty('tenantId');
        expect(data.plantings.create[0]).toEqual({
            plantingId: 'pl-1',
            stage: 'V6',
        });
    });
});

describe('JournalRepository — updateLogEntry', () => {
    const dataOf = () => argOf(db.logEntry.update).data;

    it('sends only the scalars the caller supplied', async () => {
        // Break: assigning every field unconditionally would blank the
        // columns the caller never mentioned.
        await JournalRepository.updateLogEntry(asTx(db), ctx, 'e-1', {
            title: 'Renamed',
        } as never);

        expect(dataOf()).toEqual({ title: 'Renamed' });
    });

    it('honours an explicit null as "clear this column"', async () => {
        // Break: an `if (input.notes)` truthy check instead of
        // `!== undefined` would make it impossible to clear notes.
        await JournalRepository.updateLogEntry(asTx(db), ctx, 'e-1', {
            notes: null,
            operationParcelId: null,
        } as never);

        expect(dataOf()).toEqual({ notes: null, operationParcelId: null });
    });

    it('leaves child collections untouched when the caller omits them', async () => {
        // Break: an unconditional replace would silently wipe an
        // entry's quantities on a title-only edit.
        await JournalRepository.updateLogEntry(asTx(db), ctx, 'e-1', {
            title: 'Renamed',
        } as never);

        const data = dataOf();
        expect(data).not.toHaveProperty('quantities');
        expect(data).not.toHaveProperty('locations');
        expect(data).not.toHaveProperty('equipment');
    });

    it('full-replaces a supplied collection rather than appending', async () => {
        // Break: dropping `deleteMany: {}` turns every edit into an
        // append, duplicating rows on each save.
        await JournalRepository.updateLogEntry(asTx(db), ctx, 'e-1', {
            locationIds: ['loc-2'],
        } as never);

        expect(dataOf().locations).toEqual({
            deleteMany: {},
            create: [{ tenantId: 'tenant-1', locationId: 'loc-2' }],
        });
    });

    it('full-replaces the equipment join with its tenant stamp', async () => {
        // The equipment arm is a separate branch from the locations one
        // above; covering only one leaves the other free to drift.
        await JournalRepository.updateLogEntry(asTx(db), ctx, 'e-1', {
            equipmentIds: ['eq-9'],
        } as never);

        expect(dataOf().equipment).toEqual({
            deleteMany: {},
            create: [{ tenantId: 'tenant-1', equipmentId: 'eq-9' }],
        });
    });

    it('clears a collection when handed an empty array', async () => {
        // Break: treating [] as "no change" removes the only way to
        // detach every location from an entry.
        await JournalRepository.updateLogEntry(asTx(db), ctx, 'e-1', {
            locationIds: [],
        } as never);

        expect(dataOf().locations).toEqual({ deleteMany: {}, create: [] });
    });

    it('keeps the tenantId asymmetry on replace as well as create', async () => {
        // Break: same rejected-argument failure as on create, but on
        // the edit path.
        await JournalRepository.updateLogEntry(asTx(db), ctx, 'e-1', {
            quantities: [{ measure: 'MASS', value: 5, unitId: 'u-2', label: 'seed' }],
        } as never);

        expect(dataOf().quantities.create[0]).not.toHaveProperty('tenantId');
        expect(dataOf().quantities.create[0].label).toBe('seed');
    });
});

describe('JournalRepository — cursor pagination', () => {
    const row = (i: number) => ({
        id: `e-${i}`,
        createdAt: new Date(Date.UTC(2026, 0, i + 1)),
    });

    it('over-fetches by one and trims, reporting the next page', async () => {
        // Break: fetching exactly `limit` makes hasNextPage always
        // false, so the journal stops paging one page early.
        db.logEntry.findMany.mockResolvedValue([row(1), row(2), row(3)]);

        const result = await JournalRepository.listPaginated(asTx(db), ctx, { limit: 2 });

        expect(argOf(db.logEntry.findMany).take).toBe(3);
        expect(result.items).toHaveLength(2);
        expect(result.pageInfo.hasNextPage).toBe(true);
        expect(result.pageInfo.nextCursor).toBeDefined();
    });

    it('clamps an oversized limit and defaults a missing one', async () => {
        // Break: honouring `limit=100000` lets one request pull a
        // tenant's entire journal.
        await JournalRepository.listPaginated(asTx(db), ctx, { limit: 10_000 });
        expect(argOf(db.logEntry.findMany).take).toBe(MAX_LIMIT + 1);

        db = makeDb();
        await JournalRepository.listPaginated(asTx(db), ctx, {});
        expect(argOf(db.logEntry.findMany).take).toBe(DEFAULT_LIMIT + 1);
    });

    it('keeps the soft-delete and tenant filters alongside the cursor', async () => {
        // Break: replacing `where` with the cursor predicate would page
        // across tenants AND resurface deleted entries.
        const cursor = encodeCursor({
            createdAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
            id: 'e-5',
        });

        await JournalRepository.listPaginated(asTx(db), ctx, { cursor });

        const where = whereOf(db.logEntry.findMany);
        expect(where.tenantId).toBe('tenant-1');
        expect(where.deletedAt).toBeNull();
        expect(where.AND).toHaveLength(1);
    });

    it('ignores an unparseable cursor rather than failing the query', async () => {
        // Break: a tampered or stale cursor turning a bookmarked page
        // into a 500.
        await JournalRepository.listPaginated(asTx(db), ctx, { cursor: 'not-a-cursor' });

        expect(whereOf(db.logEntry.findMany)).not.toHaveProperty('AND');
    });
});

describe('JournalRepository — offline replay idempotency', () => {
    it('looks a replayed mutation up within the tenant', async () => {
        // Break: an unscoped clientMutationId lookup could match
        // another tenant's entry and return it as "already created",
        // so the offline outbox would silently drop a real entry.
        await JournalRepository.findByClientMutationId(asTx(db), ctx, 'cmid-1');

        expect(whereOf(db.logEntry.findFirst)).toEqual({
            tenantId: 'tenant-1',
            clientMutationId: 'cmid-1',
        });
    });
});
