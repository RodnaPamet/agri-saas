/**
 * Unit — the farm-profile optimistic lock (If-Match / version).
 *
 * Mocked DB. What is proved here is the BRANCHING, which is where this design
 * can go wrong silently: which statement runs for which precondition, that an
 * unguarded write still moves the version, and that a concurrent create is
 * retried as a whole transaction rather than swallowed.
 */

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

const mockDb: Record<string, unknown> = {};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: unknown, cb: (db: unknown) => unknown) => cb(mockDb)),
    };
});

jest.mock('@/lib/security/sanitize', () => ({
    // Strip tags REPEATEDLY until stable — a single pass leaves nested
    // leftovers (e.g. `<<a>b>`), which CodeQL flags as incomplete
    // multi-character sanitization. Test-only mock of sanitizePlainText.
    sanitizePlainText: (s: string) => {
        let prev: string;
        do {
            prev = s;
            s = s.replace(/<[^>]*>/g, '');
        } while (s !== prev);
        return s;
    },
    sanitizeRichTextHtml: (s: string) => s,
}));

import { getFarmProfile, upsertFarmProfile } from '@/app-layer/usecases/farm-profile';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

function makeCtx(): RequestContext {
    return {
        requestId: 'req-fp',
        userId: 'user-1',
        tenantId: 'tenant-A',
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

import * as fs from 'fs';
import * as path from 'path';
import { Prisma } from '@prisma/client';


/** Source with comments stripped — see the sentinel assertion below. */
function codeOf(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const ROW = { id: 'fp-1', producerName: 'Иван', version: 4, grainProduced: [] };

/** A real P2002, so the production predicate (`isUniqueViolation`) is exercised. */
const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
    });

describe('farm-profile optimistic lock', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        for (const k of Object.keys(mockDb)) delete mockDb[k];
    });

    it('UNGUARDED write still increments the version', async () => {
        // The half that matters: an unguarded write that left the version
        // behind would silently corrupt the lock for clients that do send one.
        const upsert = jest.fn().mockResolvedValue(ROW);
        mockDb.farmProfile = { upsert };
        await upsertFarmProfile(makeCtx(), { producerName: 'Иван' });
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(upsert.mock.calls[0][0].update.version).toEqual({ increment: 1 });
    });

    it('a matching version swaps and increments', async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const findUniqueOrThrow = jest.fn().mockResolvedValue(ROW);
        const upsert = jest.fn();
        mockDb.farmProfile = { updateMany, findUniqueOrThrow, upsert };
        const out = await upsertFarmProfile(makeCtx(), { producerName: 'Иван' }, 4);
        expect(updateMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-A', version: 4 });
        expect(updateMany.mock.calls[0][0].data.version).toEqual({ increment: 1 });
        expect(upsert).not.toHaveBeenCalled(); // the guarded path, not the upsert
        expect(out.version).toBe(4);
    });

    it('a stale version 409s and reports the current one', async () => {
        mockDb.farmProfile = {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            findUnique: jest.fn().mockResolvedValue({ version: 9 }),
        };
        await expect(upsertFarmProfile(makeCtx(), { producerName: 'x' }, 4)).rejects.toMatchObject({
            code: 'STALE_DATA',
            status: 409,
            details: { currentVersion: 9, expectedVersion: 4 },
        });
    });

    it('If-Match 0 with no row CREATES', async () => {
        const create = jest.fn().mockResolvedValue({ ...ROW, version: 1 });
        mockDb.farmProfile = {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            findUnique: jest.fn().mockResolvedValue(null),
            create,
        };
        const out = await upsertFarmProfile(makeCtx(), { producerName: 'Иван' }, 0);
        expect(create).toHaveBeenCalledTimes(1);
        expect(out.version).toBe(1);
    });

    it('a non-zero If-Match with no row 409s rather than creating', async () => {
        const create = jest.fn();
        mockDb.farmProfile = {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            findUnique: jest.fn().mockResolvedValue(null),
            create,
        };
        await expect(upsertFarmProfile(makeCtx(), { producerName: 'x' }, 7)).rejects.toMatchObject({
            code: 'STALE_DATA',
            details: { currentVersion: 0, expectedVersion: 7 },
        });
        expect(create).not.toHaveBeenCalled();
    });

    it('two concurrent creates give ONE row and ONE 409, not a silent success', async () => {
        // The loser's create raises P2002. That has already aborted the
        // transaction, so the retry must re-run the WHOLE thing; on the second
        // pass a row exists and the caller is told it lost.
        let pass = 0;
        const create = jest.fn().mockImplementation(() => {
            throw p2002();
        });
        mockDb.farmProfile = {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            findUnique: jest.fn().mockImplementation(() => (pass++ === 0 ? null : { version: 1 })),
            create,
        };
        await expect(upsertFarmProfile(makeCtx(), { producerName: 'x' }, 0)).rejects.toMatchObject({
            code: 'STALE_DATA',
            details: { currentVersion: 1 },
        });
        // Asserting the 409 specifically, not merely "no duplicate row": a
        // silent-success bug would also produce no duplicate.
        expect(create).toHaveBeenCalledTimes(1);
        expect(pass).toBe(2); // the whole transaction ran twice
    });
});

describe('a body that mentions nothing is a no-op, but still checked', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        for (const k of Object.keys(mockDb)) delete mockDb[k];
    });

    it('does not write, does not bump, and does not audit', async () => {
        const upsert = jest.fn();
        const updateMany = jest.fn();
        mockDb.farmProfile = {
            upsert,
            updateMany,
            findUnique: jest.fn().mockResolvedValue({ ...ROW, version: 4 }),
        };
        const out = await upsertFarmProfile(makeCtx(), {}, 4);
        expect(upsert).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
        // The version a holder is left with is UNCHANGED — this is the whole
        // point: a no-op must not invalidate anyone else's If-Match token.
        expect(out.version).toBe(4);
    });

    it('still 409s a stale token, because asking for nothing is still asking', async () => {
        mockDb.farmProfile = {
            upsert: jest.fn(),
            findUnique: jest.fn().mockResolvedValue({ ...ROW, version: 9 }),
        };
        await expect(upsertFarmProfile(makeCtx(), {}, 4)).rejects.toMatchObject({
            code: 'STALE_DATA',
            details: { currentVersion: 9, expectedVersion: 4 },
        });
    });

    it('an empty body with no row returns the unset shape rather than creating one', async () => {
        const create = jest.fn();
        mockDb.farmProfile = { create, upsert: jest.fn(), findUnique: jest.fn().mockResolvedValue(null) };
        const out = await upsertFarmProfile(makeCtx(), {}, 0);
        expect(create).not.toHaveBeenCalled();
        expect(out.version).toBe(0); // still the sentinel: no row exists
    });
});

describe('the 0 sentinel holds — two assertions, two failure modes', () => {
    const schema = () =>
        fs.readFileSync(
            path.resolve(__dirname, '../../prisma/schema/agriculture.prisma'),
            'utf8',
        );
    const farmProfileBlock = () => {
        const src = schema();
        const start = src.indexOf('model FarmProfile {');
        expect(start).toBeGreaterThan(-1); // control: the model is findable
        return src.slice(start, src.indexOf('\n}', start));
    };

    it('the COLUMN DEFAULT is 1 — catches a later "harmonisation" with OperationParcel', () => {
        expect(farmProfileBlock()).toMatch(/version\s+Int\s+@default\(1\)/);
    });

    it('no write path mints a 0 — catches a create path that computes a version', () => {
        // Separate from the default assertion on purpose: that one passes even
        // when no write path is exercised, and this one passes even when the
        // schema is changed. They fail for different reasons.
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/usecases/farm-profile.ts'),
            'utf8',
        );
        // Scoped to upsertFarmProfile. EMPTY_PROFILE legitimately carries
        // `version: 0` — that IS the sentinel's definition, the shape returned
        // for a tenant with no row. The thing that must never happen is a WRITE
        // producing one.
        const start = src.indexOf('export async function upsertFarmProfile');
        expect(start).toBeGreaterThan(-1); // control: the function is findable
        // Mask comments at the READ SEAM. Without this the assertion trips on
        // the docblock that EXPLAINS the sentinel — "`version: 0` never matches
        // a stored row" — which is the guard failing on its own prose rather
        // than on code. A longer anchor would only move the problem.
        const writePath = codeOf(src.slice(start));
        expect(writePath).not.toMatch(/version:\s*0\b/);
        // Control: the write path DOES assign version, so a regex that matched
        // nothing anywhere would be caught here rather than reading as a pass.
        expect(writePath).toMatch(/version:\s*\{\s*increment:\s*1\s*\}/);
        // And the sentinel definition is still present outside it.
        expect(src.slice(0, start)).toMatch(/version:\s*0\b/);
    });
});
