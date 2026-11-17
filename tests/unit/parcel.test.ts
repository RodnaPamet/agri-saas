/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Unit tests for `src/app-layer/usecases/parcel.ts` (in-map parcel
 * authoring). Mocks ParcelRepository + db-context + audit + sanitize.
 * Also asserts the GeoJSON validation schemas reject malformed input and
 * never accept a client-supplied `areaHa` (it is server-derived only).
 */

const mockDb = {
    location: { findFirst: jest.fn(), update: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: {
        createOne: jest.fn(),
        updateOne: jest.fn(),
        softDeleteOne: jest.fn(),
        getOne: jest.fn(),
        boundsForLocation: jest.fn(),
        isValidGeometry: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/security/sanitize', () => ({ sanitizePlainText: jest.fn((s: string) => s) }));

import { ParcelRepository } from '@/app-layer/repositories/ParcelRepository';
import { logEvent } from '@/app-layer/events/audit';
import { createParcel, updateParcel, deleteParcel } from '@/app-layer/usecases/parcel';
import { CreateParcelSchema, UpdateParcelSchema, PolygonGeometrySchema } from '@/app-layer/schemas/geo.schemas';
import { makeRequestContext } from '../helpers/make-context';

const editorCtx = makeRequestContext('EDITOR', { userId: 'u-1' });
const readerCtx = makeRequestContext('READER');

const square = {
    type: 'Polygon' as const,
    coordinates: [[[0, 0], [0, 0.01], [0.01, 0.01], [0.01, 0], [0, 0]]],
};

beforeEach(() => {
    jest.clearAllMocks();
    (ParcelRepository.boundsForLocation as jest.Mock).mockResolvedValue([0, 0, 0.01, 0.01]);
    (ParcelRepository.isValidGeometry as jest.Mock).mockResolvedValue(true);
});

// ─── geometry validation ───────────────────────────────────────────

describe('geometry schemas', () => {
    it('accepts a valid Polygon', () => {
        expect(PolygonGeometrySchema.safeParse(square).success).toBe(true);
    });
    it('rejects a ring with < 4 positions', () => {
        expect(PolygonGeometrySchema.safeParse({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] }).success).toBe(false);
    });
    it('rejects out-of-range coordinates', () => {
        expect(PolygonGeometrySchema.safeParse({ type: 'Polygon', coordinates: [[[0, 0], [0, 200], [1, 1], [0, 0]]] }).success).toBe(false);
    });
    it('rejects a non-polygon type', () => {
        expect(PolygonGeometrySchema.safeParse({ type: 'Point', coordinates: [0, 0] }).success).toBe(false);
    });
    it('strips a client-supplied areaHa (server-derived only)', () => {
        const parsed = CreateParcelSchema.parse({ name: 'P', geometry: square, areaHa: 9999 } as any);
        expect('areaHa' in parsed).toBe(false);
    });
    it('UpdateParcelSchema requires at least one field', () => {
        expect(UpdateParcelSchema.safeParse({}).success).toBe(false);
    });
});

// ─── createParcel ──────────────────────────────────────────────────

describe('createParcel', () => {
    it('validates the location, creates the parcel, recomputes bounds, audits', async () => {
        (mockDb.location.findFirst as jest.Mock).mockResolvedValue({ id: 'loc-1' });
        (ParcelRepository.createOne as jest.Mock).mockResolvedValue({ id: 'par-9', areaHa: 123.45 });

        const res = await createParcel(editorCtx, 'loc-1', { name: 'North 40', geometry: square });

        expect(res).toEqual({ id: 'par-9', areaHa: 123.45 });
        expect(ParcelRepository.createOne).toHaveBeenCalledWith(mockDb, editorCtx, 'loc-1', expect.objectContaining({ name: 'North 40', geometry: square }));
        expect(ParcelRepository.boundsForLocation).toHaveBeenCalledWith(mockDb, editorCtx, 'loc-1');
        expect(mockDb.location.update).toHaveBeenCalled();
        const [, , payload] = (logEvent as jest.Mock).mock.calls[0];
        expect(payload.action).toBe('PARCEL_CREATED');
    });

    it('rejects an empty name', async () => {
        await expect(createParcel(editorCtx, 'loc-1', { name: '   ', geometry: square })).rejects.toThrow(/name is required/i);
    });

    it('404s an unknown location', async () => {
        (mockDb.location.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(createParcel(editorCtx, 'nope', { name: 'P', geometry: square })).rejects.toThrow(/not found/i);
    });

    it('READER cannot draw a parcel', async () => {
        await expect(createParcel(readerCtx, 'loc-1', { name: 'P', geometry: square })).rejects.toThrow(/permission/i);
    });

    it('rejects an invalid (self-intersecting) polygon', async () => {
        (mockDb.location.findFirst as jest.Mock).mockResolvedValue({ id: 'loc-1' });
        (ParcelRepository.isValidGeometry as jest.Mock).mockResolvedValue(false);
        await expect(createParcel(editorCtx, 'loc-1', { name: 'Bowtie', geometry: square })).rejects.toThrow(/invalid/i);
        expect(ParcelRepository.createOne).not.toHaveBeenCalled();
    });
});

// ─── updateParcel ──────────────────────────────────────────────────

describe('updateParcel', () => {
    it('reshapes geometry and recomputes the owning location bounds', async () => {
        (ParcelRepository.getOne as jest.Mock).mockResolvedValue({ id: 'par-1', name: 'P', locationId: 'loc-1' });
        (ParcelRepository.updateOne as jest.Mock).mockResolvedValue({ areaHa: 200 });

        const res = await updateParcel(editorCtx, 'par-1', { geometry: square });

        expect(res).toEqual({ areaHa: 200 });
        expect(ParcelRepository.boundsForLocation).toHaveBeenCalledWith(mockDb, editorCtx, 'loc-1');
    });

    it('does NOT recompute bounds for a name-only edit', async () => {
        (ParcelRepository.getOne as jest.Mock).mockResolvedValue({ id: 'par-1', name: 'P', locationId: 'loc-1' });
        (ParcelRepository.updateOne as jest.Mock).mockResolvedValue({ areaHa: 200 });
        await updateParcel(editorCtx, 'par-1', { name: 'Renamed' });
        expect(ParcelRepository.boundsForLocation).not.toHaveBeenCalled();
    });

    it('a nickname alone is an update, sanitized, and blank clears it (#3169)', async () => {
        expect(UpdateParcelSchema.safeParse({ displayName: 'Нивата до реката' }).success).toBe(true);
        (ParcelRepository.getOne as jest.Mock).mockResolvedValue({ id: 'par-1', name: '20688.13', locationId: 'loc-1' });
        (ParcelRepository.updateOne as jest.Mock).mockResolvedValue({ areaHa: 200 });
        await updateParcel(editorCtx, 'par-1', { displayName: '  Нивата до реката  ' });
        expect((ParcelRepository.updateOne as jest.Mock).mock.calls.at(-1)?.[3]).toMatchObject({
            displayName: 'Нивата до реката',
            // The field number the ДНЕВНИК prints is not touched.
            name: undefined,
        });
        await updateParcel(editorCtx, 'par-1', { displayName: '   ' });
        expect((ParcelRepository.updateOne as jest.Mock).mock.calls.at(-1)?.[3]).toMatchObject({ displayName: null });
        await updateParcel(editorCtx, 'par-1', { displayName: null });
        expect((ParcelRepository.updateOne as jest.Mock).mock.calls.at(-1)?.[3]).toMatchObject({ displayName: null });
    });

    it('404s an unknown parcel', async () => {
        (ParcelRepository.getOne as jest.Mock).mockResolvedValue(null);
        await expect(updateParcel(editorCtx, 'nope', { name: 'X' })).rejects.toThrow(/not found/i);
    });

    it('rejects a reshape to an invalid polygon', async () => {
        (ParcelRepository.getOne as jest.Mock).mockResolvedValue({ id: 'par-1', name: 'P', locationId: 'loc-1' });
        (ParcelRepository.isValidGeometry as jest.Mock).mockResolvedValue(false);
        await expect(updateParcel(editorCtx, 'par-1', { geometry: square })).rejects.toThrow(/invalid/i);
        expect(ParcelRepository.updateOne).not.toHaveBeenCalled();
    });
});

// ─── deleteParcel ──────────────────────────────────────────────────

describe('deleteParcel', () => {
    it('soft-deletes, recomputes bounds, and audits', async () => {
        (ParcelRepository.getOne as jest.Mock).mockResolvedValue({ id: 'par-1', name: 'P', locationId: 'loc-1' });
        const res = await deleteParcel(editorCtx, 'par-1');
        expect(res).toEqual({ success: true });
        expect(ParcelRepository.softDeleteOne).toHaveBeenCalledWith(mockDb, editorCtx, 'par-1');
        expect(ParcelRepository.boundsForLocation).toHaveBeenCalledWith(mockDb, editorCtx, 'loc-1');
        const [, , payload] = (logEvent as jest.Mock).mock.calls[0];
        expect(payload.action).toBe('PARCEL_DELETED');
    });

    it('READER cannot delete', async () => {
        await expect(deleteParcel(readerCtx, 'par-1')).rejects.toThrow(/permission/i);
    });
});
