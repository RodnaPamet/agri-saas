/**
 * The ONE correction-trail reader, shared by treatments and bare activities
 * (#2373).
 *
 * Tested against a stub client rather than a database because the claims worth
 * making are about the MAPPING, and two of them are promises made to another
 * team: the envelope's exact key names, which the agrent-ios session decodes
 * with a single type for both routes, and that the actor is resolved to a
 * display NAME rather than passed through as an id.
 *
 * A stub also lets the ordering and the cap be asserted as what this function
 * ASKS FOR. Against a real database those are properties of the rows that came
 * back, and a query that forgot `orderBy` would still look right whenever the
 * insertion order happened to match.
 */
import { readCorrectionTrail } from '@/app-layer/usecases/correction-trail';
import type { RequestContext } from '@/app-layer/types';

const ctx = { tenantId: 't1', userId: 'u1' } as unknown as RequestContext;

function stubDb(opts: {
    version?: number | null;
    rows: {
        correctedAt: Date;
        correctedByUserId: string | null;
        changedFields: string[];
        previous: unknown;
    }[];
    users?: { id: string; name: string | null }[];
}) {
    const calls: { findManyArgs?: Record<string, unknown> } = {};
    const db = {
        treatmentGroup: {
            findUnique: async () => (opts.version === null ? null : { version: opts.version ?? 3 }),
        },
        treatmentCorrection: {
            findMany: async (args: Record<string, unknown>) => {
                calls.findManyArgs = args;
                return opts.rows;
            },
        },
        user: {
            findMany: async () => opts.users ?? [],
        },
    };
    return { db, calls };
}

const AT = new Date('2026-10-25T21:17:06.000Z');

describe('readCorrectionTrail', () => {
    it('publishes exactly the envelope agrent-ios decodes for BOTH routes', async () => {
        const { db } = stubDb({
            rows: [
                {
                    correctedAt: AT,
                    correctedByUserId: 'u9',
                    changedFields: ['occurredOn'],
                    previous: { harvestKg: 10 },
                },
            ],
            users: [{ id: 'u9', name: 'Иван Петров' }],
        });
        const trail = await readCorrectionTrail(db as never, ctx, 'h1');

        // The key names, pinned. One reader serves two routes precisely so the
        // phone can use one decoder; a rename here breaks both at once, which
        // is why this asserts the names and not just that they are consistent.
        expect(Object.keys(trail).sort()).toEqual(['corrections', 'treatmentGroupId', 'version']);
        expect(Object.keys(trail.corrections[0]).sort()).toEqual([
            'changedFields',
            'correctedAt',
            'correctedBy',
            'previous',
        ]);
        expect(trail.treatmentGroupId).toBe('h1');
        expect(trail.version).toBe(3);
        expect(trail.corrections[0].correctedAt).toBe('2026-10-25T21:17:06.000Z');
    });

    it('resolves the actor to a display NAME, never an id', async () => {
        const { db } = stubDb({
            rows: [{ correctedAt: AT, correctedByUserId: 'u9', changedFields: [], previous: null }],
            users: [{ id: 'u9', name: 'Иван Петров' }],
        });
        const trail = await readCorrectionTrail(db as never, ctx, 'h1');
        expect(trail.corrections[0].correctedBy).toBe('Иван Петров');
    });

    it('declines to name an actor it cannot name, rather than printing an id', async () => {
        // Three ways this happens: no actor (a job), an account since removed,
        // and a stored name that is null. All of them must read as null — the
        // record says a correction happened without naming someone, which is
        // the honest answer for «Коригирано от …».
        const { db } = stubDb({
            rows: [
                { correctedAt: AT, correctedByUserId: null, changedFields: [], previous: null },
                { correctedAt: AT, correctedByUserId: 'gone', changedFields: [], previous: null },
                { correctedAt: AT, correctedByUserId: 'u8', changedFields: [], previous: null },
            ],
            users: [{ id: 'u8', name: null }],
        });
        const trail = await readCorrectionTrail(db as never, ctx, 'h1');
        expect(trail.corrections.map((c) => c.correctedBy)).toEqual([null, null, null]);
    });

    it('ASKS FOR newest-first and a cap of 50', async () => {
        // Asserted as the request, not as the result. Against a real database a
        // query that forgot `orderBy` would still look correct whenever the
        // insertion order happened to match.
        const { db, calls } = stubDb({ rows: [] });
        await readCorrectionTrail(db as never, ctx, 'h1');
        expect(calls.findManyArgs?.orderBy).toEqual({ correctedAt: 'desc' });
        expect(calls.findManyArgs?.take).toBe(50);
    });

    it('a record with no group row reads version 0, not a crash', async () => {
        // The backfill starts at 0 rather than claiming a version it never
        // served, and a missing row must not throw on a read.
        const { db } = stubDb({ version: null, rows: [] });
        const trail = await readCorrectionTrail(db as never, ctx, 'h1');
        expect({ version: trail.version, corrections: trail.corrections }).toEqual({
            version: 0,
            corrections: [],
        });
    });

    it('passes `previous` through whole, not as a diff', async () => {
        const previous = { treatmentGroupId: 'h1', kind: 'HARVEST', harvestKg: 12400, version: 0 };
        const { db } = stubDb({
            rows: [{ correctedAt: AT, correctedByUserId: null, changedFields: ['harvestKg'], previous }],
        });
        const trail = await readCorrectionTrail(db as never, ctx, 'h1');
        // The whole definition: a diff needs the reader to already hold the
        // state it was a diff against, and the point of the record is that the
        // state is gone.
        expect(trail.corrections[0].previous).toEqual(previous);
    });
});
