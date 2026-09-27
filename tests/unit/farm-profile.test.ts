/**
 * Unit test — БАБХ farm-record FarmProfile usecase (PR1).
 * Proves the all-null default shape, row mapping, and that upsert
 * sanitises + blanks-to-null and keys on tenantId. Mocked DB (no real DB).
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

describe('farm-profile usecase', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        for (const k of Object.keys(mockDb)) delete mockDb[k];
    });

    test('getFarmProfile returns an all-null shape when the row is unset', async () => {
        mockDb.farmProfile = { findUnique: jest.fn().mockResolvedValue(null) };
        const p = await getFarmProfile(makeCtx());
        expect(p.producerName).toBeNull();
        expect(p.egn).toBeNull();
        expect(p.odbhCity).toBeNull();
    });

    test('getFarmProfile maps a stored row', async () => {
        mockDb.farmProfile = {
            findUnique: jest.fn().mockResolvedValue({
                producerName: 'ЕТ Иван Петров',
                egn: '7501011234',
                eik: null,
                municipality: 'Пловдив',
            }),
        };
        const p = await getFarmProfile(makeCtx());
        expect(p.producerName).toBe('ЕТ Иван Петров');
        expect(p.municipality).toBe('Пловдив');
        expect(p.eik).toBeNull();
    });

    test('upsertFarmProfile sanitises, blanks-to-null, and keys on tenantId', async () => {
        const upsert = jest.fn().mockResolvedValue({ id: 'fp-1', producerName: 'Иван', municipality: null, odbhCity: 'Пловдив' });
        mockDb.farmProfile = { upsert };

        await upsertFarmProfile(makeCtx(), {
            producerName: '  Иван  ',
            egn: '7501011234',
            municipality: '   ',
            odbhCity: '<b>Пловдив</b>',
        });

        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-A' } }));
        const arg = upsert.mock.calls[0][0];
        expect(arg.create.tenantId).toBe('tenant-A');
        expect(arg.create.producerName).toBe('Иван'); // trimmed
        expect(arg.update.municipality).toBeNull(); // blank → null
        expect(arg.update.odbhCity).toBe('Пловдив'); // sanitised (tags stripped)
        expect(arg.update.egn).toBe('7501011234');
    });

    // ── The holding's own identity: УРН, size, grains, location ──
    //
    // Three of the four behave like every other field. `sizeHa` and
    // `grainProduced` do not, and each rule below exists because the wrong
    // answer is silent: a negative area stored rather than refused, a zero
    // that means "unmeasured", a duplicate crop on a declaration, or a list
    // re-ordered on save without being asked.

    test('an unset row returns an empty grain ARRAY, not null', async () => {
        // A client maps over this. Null would make every consumer write a
        // guard for a state that means the same thing as empty.
        mockDb.farmProfile = { findUnique: jest.fn().mockResolvedValue(null) };
        const p = await getFarmProfile(makeCtx());
        expect(p.grainProduced).toEqual([]);
        expect(p.sizeHa).toBeNull();
        expect(p.urn).toBeNull();
    });

    test('sizeHa crosses the wire as a NUMBER, not a decimal string', async () => {
        // Prisma Decimals serialise to strings by default, and a numeric field
        // arriving as "12.5" is the asymmetry this codebase has been removing.
        mockDb.farmProfile = {
            findUnique: jest.fn().mockResolvedValue({
                // What a Decimal column hands back.
                sizeHa: { toString: () => '412.500' },
                grainProduced: ['пшеница'],
            }),
        };
        const p = await getFarmProfile(makeCtx());
        expect(typeof p.sizeHa).toBe('number');
        expect(p.sizeHa).toBeCloseTo(412.5, 3);
    });

    test('a NEGATIVE size is refused rather than stored', async () => {
        // Not a smaller farm — a typo, on a number that can reach a state form.
        const upsert = jest.fn().mockResolvedValue({ id: 'fp-1' });
        mockDb.farmProfile = { upsert };
        await upsertFarmProfile(makeCtx(), { sizeHa: -5 });
        expect(upsert.mock.calls[0][0].update.sizeHa).toBeNull();
    });

    test('a size of ZERO is KEPT — it is a declaration, not an absence', async () => {
        // The distinction the null-vs-zero rule turns on: a farm that declares
        // nothing and a farm nobody has measured are different claims, and
        // collapsing them would lose the first.
        const upsert = jest.fn().mockResolvedValue({ id: 'fp-1' });
        mockDb.farmProfile = { upsert };
        await upsertFarmProfile(makeCtx(), { sizeHa: 0 });
        expect(upsert.mock.calls[0][0].update.sizeHa).toBe(0);
    });

    test('grains are sanitised, blanks dropped, and duplicates removed case-insensitively', async () => {
        const upsert = jest.fn().mockResolvedValue({ id: 'fp-1' });
        mockDb.farmProfile = { upsert };
        await upsertFarmProfile(makeCtx(), {
            grainProduced: ['  пшеница  ', '<b>слънчоглед</b>', '', '   ', 'ПШЕНИЦА'],
        });
        expect(upsert.mock.calls[0][0].update.grainProduced).toEqual(['пшеница', 'слънчоглед']);
    });

    test('grain ORDER is preserved — saving is not an unasked-for edit', async () => {
        // Sorting someone's declaration on save changes what they wrote.
        const upsert = jest.fn().mockResolvedValue({ id: 'fp-1' });
        mockDb.farmProfile = { upsert };
        await upsertFarmProfile(makeCtx(), {
            grainProduced: ['царевица', 'ечемик', 'пшеница'],
        });
        expect(upsert.mock.calls[0][0].update.grainProduced).toEqual([
            'царевица',
            'ечемик',
            'пшеница',
        ]);
    });

    test('УРН is trimmed and sanitised like the other identifiers', async () => {
        const upsert = jest.fn().mockResolvedValue({ id: 'fp-1' });
        mockDb.farmProfile = { upsert };
        await upsertFarmProfile(makeCtx(), {
            urn: ' <i>1234567890</i> ',
            // The holding's LOCATION is this field — «Място на регистриране» on
            // the form. A separate `farmLocation` column was added and removed:
            // it duplicated this one, on a misreading that "location" meant
            // where the land is rather than where the farm is registered.
            registrationPlace: '  с. Труд  ',
        });
        expect(upsert.mock.calls[0][0].update.urn).toBe('1234567890');
        expect(upsert.mock.calls[0][0].update.registrationPlace).toBe('с. Труд');
    });
});
