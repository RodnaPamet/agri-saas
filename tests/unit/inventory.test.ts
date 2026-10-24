/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Unit tests for `src/app-layer/usecases/inventory.ts`.
 *
 * Mocks the repositories + the ledger writer + db-context + audit, and
 * uses the REAL `resolveEnabledModules` so the WP-2 gating in
 * `recordInputApplication` is exercised for real. Covers lot CRUD, the
 * RECEIPT/ADJUSTMENT ledger paths, and the full spray-completion matrix
 * (modules off / journal-only / FEFO consumption / no-lot / dose math).
 */

const mockDb = {
    parcel: { findFirst: jest.fn() },
    item: { findFirst: jest.fn() },
    unit: { findMany: jest.fn() },
    // recordInputApplication's idempotency guard checks for an existing
    // INPUT_APPLICATION journal entry; default to "none" so the happy
    // paths proceed (a dedicated test overrides this for the retry case).
    logEntry: { findFirst: jest.fn().mockResolvedValue(null) },
    // The line's own TREATED area (#2284). `null` is the whole parcel, which
    // is what every case below assumes — the operator path through Задачи
    // never sets one. The partial-area case overrides it.
    operationParcel: { findFirst: jest.fn().mockResolvedValue({ treatedAreaHa: null }) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/InventoryRepository', () => ({
    InventoryRepository: {
        listLots: jest.fn(),
        getLot: jest.fn(),
        lotLedger: jest.fn(),
        getItem: jest.fn(),
        createLot: jest.fn(),
        getFefoLot: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/JournalRepository', () => ({
    JournalRepository: { createLogEntry: jest.fn() },
}));

jest.mock('@/app-layer/repositories/ModuleSettingsRepository', () => ({
    ModuleSettingsRepository: { get: jest.fn() },
}));

jest.mock('@/lib/inventory/stock-ledger', () => ({
    appendStockTransaction: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => s),
}));

import { InventoryRepository } from '@/app-layer/repositories/InventoryRepository';
import { JournalRepository } from '@/app-layer/repositories/JournalRepository';
import { ModuleSettingsRepository } from '@/app-layer/repositories/ModuleSettingsRepository';
import { appendStockTransaction } from '@/lib/inventory/stock-ledger';
import { logEvent } from '@/app-layer/events/audit';
import {
    listLots,
    createLot,
    receiveStock,
    adjustStock,
    recordInputApplication,
} from '@/app-layer/usecases/inventory';
import { makeRequestContext } from '../helpers/make-context';

const editorCtx = makeRequestContext('EDITOR', { userId: 'user-1' });
const readerCtx = makeRequestContext('READER');

beforeEach(() => {
    jest.clearAllMocks();
    (appendStockTransaction as jest.Mock).mockResolvedValue({
        id: 'tx-1',
        entryHash: 'h',
        previousHash: null,
        quantityOnHand: '5.0000',
    });
});

// ─── listLots ──────────────────────────────────────────────────────

describe('listLots', () => {
    it('maps rows and computes lowStock against the item reorder level', async () => {
        (InventoryRepository.listLots as jest.Mock).mockResolvedValue([
            {
                id: 'lot-1', lotCode: 'A', quantityOnHand: 3, expiresAt: null, receivedAt: null,
                item: { id: 'i1', name: 'Gly', category: 'PESTICIDE', reorderLevel: 5 },
                unit: { id: 'u-l', symbol: 'L' }, location: null,
            },
            {
                id: 'lot-2', lotCode: 'B', quantityOnHand: 20, expiresAt: null, receivedAt: null,
                item: { id: 'i2', name: 'N', category: 'FERTILIZER', reorderLevel: null },
                unit: { id: 'u-kg', symbol: 'kg' }, location: null,
            },
        ]);
        const out = await listLots(readerCtx);
        expect(out[0].lowStock).toBe(true); // 3 < 5
        expect(out[1].lowStock).toBe(false); // no reorder level
    });
});

// ─── createLot ─────────────────────────────────────────────────────

describe('createLot', () => {
    it('validates item, creates the lot, posts an opening RECEIPT, audits', async () => {
        (InventoryRepository.getItem as jest.Mock).mockResolvedValue({ id: 'i1', name: 'Gly', defaultUnitId: 'u-l' });
        (InventoryRepository.createLot as jest.Mock).mockResolvedValue({ id: 'lot-9', lotCode: 'BATCH-1', unitId: 'u-l' });

        const res = await createLot(editorCtx, { itemId: 'i1', lotCode: 'BATCH-1', initialQuantity: 10 });

        expect(res).toEqual({ id: 'lot-9', lotCode: 'BATCH-1' });
        expect(appendStockTransaction).toHaveBeenCalledWith(
            mockDb,
            editorCtx,
            expect.objectContaining({ lotId: 'lot-9', type: 'RECEIPT', quantityDelta: 10 }),
        );
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('does NOT post a RECEIPT when no initial quantity', async () => {
        (InventoryRepository.getItem as jest.Mock).mockResolvedValue({ id: 'i1', name: 'Gly', defaultUnitId: 'u-l' });
        (InventoryRepository.createLot as jest.Mock).mockResolvedValue({ id: 'lot-9', lotCode: 'B', unitId: 'u-l' });
        await createLot(editorCtx, { itemId: 'i1', lotCode: 'B' });
        expect(appendStockTransaction).not.toHaveBeenCalled();
    });

    it('rejects an unknown item', async () => {
        (InventoryRepository.getItem as jest.Mock).mockResolvedValue(null);
        await expect(createLot(editorCtx, { itemId: 'nope', lotCode: 'B' })).rejects.toThrow(/Item not found/);
    });

    it('READER cannot create a lot', async () => {
        await expect(createLot(readerCtx, { itemId: 'i1', lotCode: 'B' })).rejects.toThrow(/permission/i);
    });
});

// ─── receiveStock / adjustStock ────────────────────────────────────

describe('receiveStock', () => {
    it('appends a positive RECEIPT and audits', async () => {
        (InventoryRepository.getLot as jest.Mock).mockResolvedValue({ id: 'lot-1', lotCode: 'A', unit: { id: 'u-l', symbol: 'L' } });
        await receiveStock(editorCtx, 'lot-1', 4);
        expect(appendStockTransaction).toHaveBeenCalledWith(
            mockDb, editorCtx,
            expect.objectContaining({ lotId: 'lot-1', type: 'RECEIPT', quantityDelta: 4 }),
        );
    });
    it('rejects a non-positive quantity', async () => {
        await expect(receiveStock(editorCtx, 'lot-1', 0)).rejects.toThrow(/positive/);
    });
});

describe('adjustStock', () => {
    it('requires a reason', async () => {
        await expect(adjustStock(editorCtx, 'lot-1', -2, '   ')).rejects.toThrow(/reason/i);
    });
    it('rejects a zero delta', async () => {
        await expect(adjustStock(editorCtx, 'lot-1', 0, 'x')).rejects.toThrow(/non-zero/);
    });
    it('appends a signed ADJUSTMENT carrying the reason', async () => {
        (InventoryRepository.getLot as jest.Mock).mockResolvedValue({ id: 'lot-1', lotCode: 'A', unit: { id: 'u-l', symbol: 'L' } });
        await adjustStock(editorCtx, 'lot-1', -2.5, 'count correction');
        expect(appendStockTransaction).toHaveBeenCalledWith(
            mockDb, editorCtx,
            expect.objectContaining({ type: 'ADJUSTMENT', quantityDelta: -2.5, reason: 'count correction' }),
        );
    });
});

// ─── recordInputApplication (the spray-completion bridge) ──────────

const line = { id: 'op-1', parcelId: 'p-1', productItemId: 'i1', doseValue: 2, doseUnitId: 'u-rate' };

function primeParcelProductUnits(measure = 'RATE') {
    (mockDb.parcel.findFirst as jest.Mock).mockResolvedValue({ name: 'North 40', areaHa: 10 });
    (mockDb.item.findFirst as jest.Mock).mockResolvedValue({ id: 'i1', name: 'Gly', defaultUnitId: 'u-l' });
    (mockDb.unit.findMany as jest.Mock).mockResolvedValue([
        { id: 'u-rate', measure, symbol: 'L/ha' },
        { id: 'u-l', measure: 'VOLUME', symbol: 'L' },
    ]);
}

describe('recordInputApplication', () => {
    it('is a no-op when both JOURNAL and INVENTORY are disabled', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({ enabledModules: ['CERTIFICATION'] });
        const res = await recordInputApplication(mockDb, editorCtx, line as any);
        expect(res).toEqual({ journalEntryId: null, consumed: 0, deductedFromLotId: null, note: 'inventory_disabled' });
        expect(JournalRepository.createLogEntry).not.toHaveBeenCalled();
        expect(appendStockTransaction).not.toHaveBeenCalled();
    });

    it('JOURNAL-only: writes the LogEntry, no consumption', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({ enabledModules: ['JOURNAL'] });
        primeParcelProductUnits('RATE');
        (JournalRepository.createLogEntry as jest.Mock).mockResolvedValue({ id: 'log-1' });
        const res = await recordInputApplication(mockDb, editorCtx, line as any);
        expect(JournalRepository.createLogEntry).toHaveBeenCalledTimes(1);
        expect(appendStockTransaction).not.toHaveBeenCalled();
        expect(res.journalEntryId).toBe('log-1');
        expect(res.consumed).toBe(20); // dose 2 (RATE) × 10 ha
    });

    // The auto-generated entry is freely editable/deletable, so the hash chain
    // is the accountability layer — it must start with a CREATE like the manual
    // path, tagged with its origin.
    it('writes a LogEntry CREATE audit event for the auto-generated entry', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({ enabledModules: ['JOURNAL'] });
        primeParcelProductUnits('RATE');
        (JournalRepository.createLogEntry as jest.Mock).mockResolvedValue({
            id: 'log-1', type: 'INPUT_APPLICATION', title: 'Applied P to Parcel', status: 'DONE',
        });

        await recordInputApplication(mockDb, editorCtx, line as any);

        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(),
            editorCtx,
            expect.objectContaining({
                action: 'CREATE',
                entityType: 'LogEntry',
                entityId: 'log-1',
                detailsJson: expect.objectContaining({
                    category: 'entity_lifecycle',
                    entityName: 'LogEntry',
                    operation: 'created',
                    origin: 'field_operation',
                }),
            }),
        );
    });

    it('writes no LogEntry CREATE when JOURNAL is disabled', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({ enabledModules: ['INVENTORY'] });
        primeParcelProductUnits('RATE');

        await recordInputApplication(mockDb, editorCtx, line as any);

        expect(logEvent).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ entityType: 'LogEntry', action: 'CREATE' }),
        );
    });

    it('deducts CONSUMPTION from the FEFO lot (dose × area) linked to the journal entry', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null); // all modules
        primeParcelProductUnits('RATE');
        (JournalRepository.createLogEntry as jest.Mock).mockResolvedValue({ id: 'log-1' });
        (InventoryRepository.getFefoLot as jest.Mock).mockResolvedValue({ id: 'lot-7', unitId: 'u-l' });

        const res = await recordInputApplication(mockDb, editorCtx, line as any);

        expect(res.consumed).toBe(20);
        expect(res.deductedFromLotId).toBe('lot-7');
        expect(appendStockTransaction).toHaveBeenCalledWith(
            mockDb, editorCtx,
            expect.objectContaining({ lotId: 'lot-7', type: 'CONSUMPTION', quantityDelta: -20, logEntryId: 'log-1' }),
        );
    });

    it('skips the deduction (note: no_lot_available) when the product has no lot with stock', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null);
        primeParcelProductUnits('RATE');
        (JournalRepository.createLogEntry as jest.Mock).mockResolvedValue({ id: 'log-1' });
        (InventoryRepository.getFefoLot as jest.Mock).mockResolvedValue(null);

        const res = await recordInputApplication(mockDb, editorCtx, line as any);

        expect(res.note).toBe('no_lot_available');
        expect(res.deductedFromLotId).toBeNull();
        expect(appendStockTransaction).not.toHaveBeenCalled();
        expect(res.journalEntryId).toBe('log-1'); // record still stands
    });

    it('a flat (non-RATE) dose is taken as-is (not multiplied by area)', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null);
        primeParcelProductUnits('VOLUME'); // dose unit measure not RATE
        (JournalRepository.createLogEntry as jest.Mock).mockResolvedValue({ id: 'log-1' });
        (InventoryRepository.getFefoLot as jest.Mock).mockResolvedValue({ id: 'lot-7', unitId: 'u-l' });

        const res = await recordInputApplication(mockDb, editorCtx, line as any);
        expect(res.consumed).toBe(2); // flat dose, no area multiply
        expect(appendStockTransaction).toHaveBeenCalledWith(
            mockDb, editorCtx, expect.objectContaining({ quantityDelta: -2 }),
        );
    });

    it('a PARTIAL treated area is deducted over the treated area, not the parcel (#2284)', async () => {
        // The sibling of the `dose × area` case above, which deducts 20 for the
        // same dose over the whole 10 ha. Here the line says 4 ha were treated,
        // so 8 is the honest draw-down — and it is also what the journal entry
        // records, which is the half of #2284 an inspector reads.
        //
        // This case is also what keeps the `operationParcel.findFirst` stub
        // from being inert: every other test in this file leaves it `null`, so
        // without this one the mock would assert nothing about the new read.
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null);
        primeParcelProductUnits();
        (mockDb.operationParcel.findFirst as jest.Mock).mockResolvedValue({ treatedAreaHa: 4 });
        (JournalRepository.createLogEntry as jest.Mock).mockResolvedValue({ id: 'log-1' });
        (InventoryRepository.getFefoLot as jest.Mock).mockResolvedValue({ id: 'lot-7', unitId: 'u-l' });

        // No `as any` on `line`, unlike its siblings above: the literal already
        // satisfies `InputApplicationLine`, and the cast would spend the last
        // unit of the lint ceiling's suppressed-findings headroom (1584 of
        // 1584) on nothing.
        const res = await recordInputApplication(mockDb, editorCtx, line);
        expect(res.consumed).toBe(8);
        expect(appendStockTransaction).toHaveBeenCalledWith(
            mockDb, editorCtx, expect.objectContaining({ quantityDelta: -8 }),
        );
    });
});
