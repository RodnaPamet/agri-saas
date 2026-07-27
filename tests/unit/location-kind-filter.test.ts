/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Regression: an unknown `kind` must never reach Prisma.
 *
 * `GET /locations?kind=…` takes a comma-separated list straight from the
 * client, and `LocationRepository._buildWhere` used to forward it with an
 * unchecked `as LocationKind[]` cast. Prisma rejects the ENTIRE query when
 * it sees a value outside the enum, so one bad member turned the locations
 * list into a **500**:
 *
 *   PrismaClientValidationError: Invalid value for argument `in`.
 *   Expected LocationKind.
 *
 * That is not hypothetical — it shipped. `LocationKind` is
 * `FIELD | BIN | STORAGE`, and two call sites requested
 * `?kind=BIN,STORAGE,BARN,WAREHOUSE` (the journal entry modal's storage
 * picker and the inventory location list), so both 500'd. The cast was the
 * only reason TypeScript did not catch `'BARN'`.
 *
 * Both halves are fixed: the call sites ask for real kinds, and the
 * repository now filters to actual enum members so no caller can reproduce
 * the crash. This test covers the repository half — the durable one, since
 * a future caller can always pass something new.
 */

import { LocationKind } from '@prisma/client';
import { LocationRepository } from '@/app-layer/repositories/LocationRepository';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-1',
});

function makeDb() {
    return {
        location: {
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
        },
    } as any;
}

let db: ReturnType<typeof makeDb>;
beforeEach(() => {
    db = makeDb();
});

const whereOf = () => db.location.findMany.mock.calls[0][0].where;

describe('LocationRepository kind filter', () => {
    it('forwards every valid kind unchanged', async () => {
        await LocationRepository.list(db, ctx, { kind: ['BIN', 'STORAGE'] });

        expect(whereOf().kind).toEqual({ in: ['BIN', 'STORAGE'] });
        expect(whereOf()).toMatchObject({ tenantId: 'tenant-1', deletedAt: null });
    });

    it('drops an unknown kind instead of handing Prisma a 500', async () => {
        // The exact shipped payload. Before the fix this reached Prisma and
        // took out the whole locations list.
        await LocationRepository.list(db, ctx, {
            kind: ['BIN', 'STORAGE', 'BARN', 'WAREHOUSE'],
        });

        expect(whereOf().kind).toEqual({ in: ['BIN', 'STORAGE'] });
    });

    it.each([
        ['a lowercase kind', ['bin']],
        ['a typo', ['BIN_STORAGE']],
        ['an injection-shaped string', ["BIN'; DROP TABLE"]],
        ['an empty string', ['']],
    ])('drops %s', async (_label, kind) => {
        await LocationRepository.list(db, ctx, { kind });

        // Nothing invalid survives; the query is still well-formed.
        expect(whereOf().kind).toEqual({ in: [] });
    });

    it('yields an empty result rather than an unfiltered one when no kind is valid', async () => {
        // Falling back to "no filter" would be worse than returning nothing:
        // the caller asked for storage locations and would silently get
        // FIELDs mixed in — the very confusion the kind filter exists to
        // prevent.
        await LocationRepository.list(db, ctx, { kind: ['BARN'] });

        expect(whereOf().kind).toEqual({ in: [] });
        expect(whereOf().kind).not.toBeUndefined();
    });

    it('omits the kind clause entirely when no kinds are requested', async () => {
        await LocationRepository.list(db, ctx, {});
        expect(whereOf().kind).toBeUndefined();

        await LocationRepository.list(db, ctx, { kind: [] });
        expect(db.location.findMany.mock.calls[1][0].where.kind).toBeUndefined();
    });

    it('accepts every member of the real enum', async () => {
        // Guards against the filter drifting out of sync with the schema: if
        // a kind is added to LocationKind, it must pass through here.
        const all = Object.values(LocationKind) as string[];

        await LocationRepository.list(db, ctx, { kind: all });

        expect(whereOf().kind.in.sort()).toEqual([...all].sort());
        expect(all).toContain('FIELD');
        expect(all).toContain('BIN');
        expect(all).toContain('STORAGE');
    });

    it('applies the same validation on the paginated path', async () => {
        // Both list() and listPaginated() route through _buildWhere, so the
        // fix must hold for the cursor-paginated reads the UI actually uses.
        await LocationRepository.listPaginated(db, ctx, {
            limit: 20,
            filters: { kind: ['BIN', 'BARN'] },
        } as any);

        expect(db.location.findMany.mock.calls[0][0].where.kind).toEqual({ in: ['BIN'] });
    });

    it('leaves the other filters alone', async () => {
        await LocationRepository.list(db, ctx, {
            kind: ['BIN', 'BARN'],
            status: 'ACTIVE',
            q: 'north',
        });

        const where = whereOf();
        expect(where.kind).toEqual({ in: ['BIN'] });
        expect(where.status).toBe('ACTIVE');
        expect(where.OR).toEqual([
            { name: { contains: 'north', mode: 'insensitive' } },
            { description: { contains: 'north', mode: 'insensitive' } },
        ]);
    });
});
