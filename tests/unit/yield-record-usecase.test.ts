/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/yield-record.ts`.
 *
 * Covers:
 *   - listYieldRecords — read gate + tenantId/deletedAt filter + computed t/ha.
 *   - createYieldRecord — sanitises commodity/valuationNotes, audits, FK
 *     validation, non-negative numeric guards.
 *   - computed t/ha derivation (grossTonnes / areaHa) in the DTO.
 */

const mockDb = {
    yieldRecord: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    planting: { findFirst: jest.fn() },
    location: { findFirst: jest.fn() },
    season: { findFirst: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
}));

import { logEvent } from '@/app-layer/events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    listYieldRecords,
    createYieldRecord,
    updateYieldRecord,
    deleteYieldRecord,
} from '@/app-layer/usecases/yield-record';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN', { tenantSlug: 'acme', tenantId: 'tenant-1', userId: 'user-1' });
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme', tenantId: 'tenant-1' });

describe('listYieldRecords', () => {
    it('reads tenant-scoped + non-deleted, computes t/ha in the DTO', async () => {
        mockDb.yieldRecord.findMany.mockResolvedValue([
            { id: 'y-1', grossTonnes: 420, areaHa: 50, moisturePct: 14, plantingId: null, locationId: null, seasonId: null, commodity: 'Wheat', harvestedAt: null, valuationNotes: null, createdAt: new Date(), updatedAt: new Date() },
            { id: 'y-2', grossTonnes: 100, areaHa: 0, moisturePct: null, plantingId: null, locationId: null, seasonId: null, commodity: null, harvestedAt: null, valuationNotes: null, createdAt: new Date(), updatedAt: new Date() },
        ]);
        const out = await listYieldRecords(adminCtx, { seasonId: 's-1' });
        const args = mockDb.yieldRecord.findMany.mock.calls[0][0];
        expect(args.where).toMatchObject({ tenantId: 'tenant-1', deletedAt: null, seasonId: 's-1' });
        expect(args.take).toBe(500);
        // 420 / 50 = 8.4 ; area 0 ⇒ null (no divide-by-zero).
        expect(out[0].tPerHa).toBe(8.4);
        expect(out[1].tPerHa).toBeNull();
    });
});

describe('createYieldRecord', () => {
    it('sanitises commodity + valuationNotes, audits, keeps numerics plaintext', async () => {
        mockDb.yieldRecord.create.mockResolvedValue({
            id: 'y-1', grossTonnes: 420, areaHa: 50, moisturePct: 14, commodity: 'SAN::Wheat',
            plantingId: null, locationId: null, seasonId: null, harvestedAt: null,
            valuationNotes: 'SAN::note', createdAt: new Date(), updatedAt: new Date(),
        });
        const out = await createYieldRecord(adminCtx, {
            commodity: 'Wheat',
            valuationNotes: 'note',
            grossTonnes: 420,
            areaHa: 50,
            moisturePct: 14,
        });
        expect(sanitizePlainText).toHaveBeenCalledWith('Wheat');
        expect(sanitizePlainText).toHaveBeenCalledWith('note');
        const data = mockDb.yieldRecord.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
            tenantId: 'tenant-1',
            commodity: 'SAN::Wheat',
            valuationNotes: 'SAN::note',
            grossTonnes: 420,
            areaHa: 50,
        });
        expect(out.tPerHa).toBe(8.4);
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.entityType).toBe('YieldRecord');
        expect(payload.detailsJson.operation).toBe('created');
    });

    it('rejects a negative grossTonnes', async () => {
        await expect(createYieldRecord(adminCtx, { grossTonnes: -5 })).rejects.toThrow(/zero or positive/i);
    });

    it('validates plantingId belongs to the tenant', async () => {
        mockDb.planting.findFirst.mockResolvedValue(null);
        await expect(createYieldRecord(adminCtx, { plantingId: 'foreign' })).rejects.toThrow(/Planting not found/i);
    });

    it('READER cannot create', async () => {
        await expect(createYieldRecord(readerCtx, { commodity: 'Wheat' })).rejects.toThrow();
        expect(mockDb.yieldRecord.create).not.toHaveBeenCalled();
    });
});

describe('updateYieldRecord', () => {
    it('throws notFound when missing', async () => {
        mockDb.yieldRecord.findFirst.mockResolvedValue(null);
        await expect(updateYieldRecord(adminCtx, 'missing', { grossTonnes: 1 })).rejects.toThrow(/not found/i);
    });

    it('updates + audits', async () => {
        mockDb.yieldRecord.findFirst.mockResolvedValue({ id: 'y-1' });
        mockDb.yieldRecord.update.mockResolvedValue({
            id: 'y-1', grossTonnes: 500, areaHa: 50, moisturePct: null, commodity: 'SAN::Barley',
            plantingId: null, locationId: null, seasonId: null, harvestedAt: null,
            valuationNotes: null, createdAt: new Date(), updatedAt: new Date(),
        });
        const out = await updateYieldRecord(adminCtx, 'y-1', { commodity: 'Barley', grossTonnes: 500 });
        expect(sanitizePlainText).toHaveBeenCalledWith('Barley');
        expect(out.tPerHa).toBe(10);
        expect(logEvent).toHaveBeenCalledTimes(1);
    });
});

describe('deleteYieldRecord', () => {
    it('soft-deletes + audits', async () => {
        mockDb.yieldRecord.findFirst.mockResolvedValue({ id: 'y-1', commodity: 'Wheat' });
        mockDb.yieldRecord.update.mockResolvedValue({ id: 'y-1' });
        const res = await deleteYieldRecord(adminCtx, 'y-1');
        expect(res).toEqual({ id: 'y-1', deleted: true });
        const data = mockDb.yieldRecord.update.mock.calls[0][0].data;
        expect(data.deletedAt).toBeInstanceOf(Date);
        expect(data.deletedByUserId).toBe('user-1');
    });
});

// ─── one basis, one denominator ─────────────────────────────────────
//
// `moisturePct` used to be stored, displayed and used in nothing, so two
// harvests measured at different moistures were summed and ranked as if
// identical. The DTO now carries the standard-basis tonnage read from the
// database-generated column, and t/ha comes from the SHARED helper the
// season recap and the year-end PDF also call.

describe('yield DTO — moisture basis and t/ha', () => {
    /** A minimal live row; each test overrides the numbers it cares about. */
    const BASE_ROW = {
        id: 'y-1',
        plantingId: null,
        locationId: null,
        seasonId: null,
        commodity: 'Wheat',
        harvestedAt: null,
        valuationNotes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    it('passes the database-generated standard-basis tonnage through', async () => {
        mockDb.yieldRecord.findMany.mockResolvedValue([
            {
                ...BASE_ROW,
                grossTonnes: '90',
                moisturePct: '18',
                areaHa: '10',
                netTonnesStd: '85.814',
            },
        ]);
        const out = await listYieldRecords(readerCtx);
        expect(out[0].netTonnesStd).toBe(85.814);
    });

    it('computes t/ha from the ADJUSTED tonnage when moisture is known', async () => {
        mockDb.yieldRecord.findMany.mockResolvedValue([
            {
                ...BASE_ROW,
                grossTonnes: '90',
                moisturePct: '18',
                areaHa: '10',
                netTonnesStd: '85.814',
            },
        ]);
        const out = await listYieldRecords(readerCtx);
        // 85.814 / 10 — NOT 90 / 10, which would rank a wet field above a
        // dry one carrying the same sellable grain.
        expect(out[0].tPerHa).toBe(8.5814);
        expect(out[0].tPerHaBasis).toBe('standard-moisture');
    });

    it('falls back to gross when moisture was never measured, and says so', async () => {
        mockDb.yieldRecord.findMany.mockResolvedValue([
            {
                ...BASE_ROW,
                grossTonnes: '90',
                moisturePct: null,
                areaHa: '10',
                netTonnesStd: null,
            },
        ]);
        const out = await listYieldRecords(readerCtx);
        expect(out[0].netTonnesStd).toBeNull();
        expect(out[0].tPerHa).toBe(9);
        // The flag is the whole point: an unadjusted figure sits in the same
        // column as adjusted ones and must not look identical to them.
        expect(out[0].tPerHaBasis).toBe('gross');
    });

    it('keeps the zero-area guard — undefined, not 0 t/ha', async () => {
        mockDb.yieldRecord.findMany.mockResolvedValue([
            { ...BASE_ROW, grossTonnes: '90', moisturePct: '14', areaHa: '0', netTonnesStd: '90' },
        ]);
        const out = await listYieldRecords(readerCtx);
        expect(out[0].tPerHa).toBeNull();
    });
});
