/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock
 * pattern; per-line typing has poor cost/benefit ratio. */

/**
 * `createCostEntryBatch` — one cost SHEET, all-or-nothing (#1524).
 *
 * agrent-ios' ask: "A half-saved sheet in the books is the failure to avoid."
 * So the properties worth testing are not "it writes rows" but the three ways
 * a batch can half-succeed and still look fine:
 *
 *   1. **Ten lines cannot share one key.** `@@unique([tenantId,
 *      clientMutationId])` means the second line of a batch reusing the batch
 *      key hits the index. The derived key is what makes "all-or-nothing under
 *      one Idempotency-Key" expressible at all.
 *   2. **A prefix read collides.** Batch key `abc` matched by `startsWith`
 *      finds the lines of batch key `abc:1`, and outbox item ids routinely
 *      share a prefix — so the collision appears exactly for the clients the
 *      dedupe exists to serve.
 *   3. **Derived keys do not sort in line order.** `:10` falls between `:1`
 *      and `:2` lexicographically, so a replay ordered by the database pairs
 *      figures with the wrong lines — at ten lines, which is the sheet size
 *      the phone actually sends.
 */
const mockDb = {
    costEntry: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
    },
    fileRecord: { findFirst: jest.fn() },
    planting: { findFirst: jest.fn() },
    season: { findFirst: jest.fn() },
    location: { findFirst: jest.fn() },
    parcel: { findFirst: jest.fn(), findMany: jest.fn() },
    parcelLease: { findFirst: jest.fn() },
    item: { findFirst: jest.fn() },
    costEntryAllocationParcel: { deleteMany: jest.fn(), createMany: jest.fn() },
} as any;

const runInTenantContext = jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (...args: any[]) => (runInTenantContext as any)(...args),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { createCostEntryBatch } from '@/app-layer/usecases/cost-entry';
import {
    CreateCostEntryBatchSchema,
    MAX_COST_BATCH_LINES,
} from '@/app-layer/schemas/grain.schemas';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'u-1' });

const line = (over: Record<string, unknown> = {}) => ({
    category: 'FERTILIZER' as const,
    amount: 100,
    currency: 'BGN',
    incurredOn: '2026-03-01T00:00:00.000Z',
    ...over,
});

/** A created row, as Prisma would hand it back. */
const row = (id: string, key: string | null) => ({
    id,
    category: 'FERTILIZER',
    amount: 100,
    currency: 'BGN',
    incurredOn: new Date('2026-03-01T00:00:00.000Z'),
    supplier: null,
    invoiceFileId: null,
    plantingId: null,
    seasonId: null,
    locationId: null,
    parcelId: null,
    leaseId: null,
    itemId: null,
    allocationBasis: 'TARGET',
    createdByUserId: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    clientMutationId: key,
});

beforeEach(() => {
    jest.clearAllMocks();
    runInTenantContext.mockImplementation(async (_c: any, fn: any) => fn(mockDb));
    mockDb.costEntry.findMany.mockResolvedValue([]);
    let n = 0;
    mockDb.costEntry.create.mockImplementation(async ({ data }: any) =>
        row(`ce-${n++}`, data.clientMutationId ?? null),
    );
});

describe('createCostEntryBatch', () => {
    it('writes every line, and derives a per-line key from the batch key', async () => {
        const res = await createCostEntryBatch(ctx, { lines: [line(), line(), line()] }, 'sheet-1');

        expect(res.lines).toHaveLength(3);
        const keys = mockDb.costEntry.create.mock.calls.map((c: any) => c[0].data.clientMutationId);
        // Ten lines CANNOT share one key — the unique index forbids it. This is
        // what makes the batch key usable at all.
        expect(keys).toEqual(['sheet-1:0', 'sheet-1:1', 'sheet-1:2']);
    });

    it('writes the whole sheet in ONE transaction', async () => {
        await createCostEntryBatch(ctx, { lines: [line(), line(), line()] }, 'sheet-1');

        // One write context for three rows. Per-line contexts would let the
        // books half-commit, which is the entire point of the endpoint — and
        // it is also what makes the replay check a single cheap read.
        const writeCalls = runInTenantContext.mock.calls.length;
        expect(writeCalls).toBe(2); // one replay pre-check, one write
    });

    it('replays a committed sheet without writing again', async () => {
        mockDb.costEntry.findMany.mockResolvedValue([
            row('ce-a', 'sheet-1:0'),
            row('ce-b', 'sheet-1:1'),
        ]);

        const res = await createCostEntryBatch(ctx, { lines: [line(), line()] }, 'sheet-1');

        expect(res.lines.map((l: any) => l.id)).toEqual(['ce-a', 'ce-b']);
        expect(mockDb.costEntry.create).not.toHaveBeenCalled();
    });

    it('reads the replay by EXACT keys, never by prefix', async () => {
        await createCostEntryBatch(ctx, { lines: [line(), line()] }, 'abc');

        const where = mockDb.costEntry.findMany.mock.calls[0][0].where;
        // `in`, not `startsWith`. A prefix read makes batch key `abc` match the
        // lines of batch key `abc:1`, and outbox ids share prefixes routinely.
        expect(where.clientMutationId).toEqual({ in: ['abc:0', 'abc:1'] });
        expect(JSON.stringify(where)).not.toContain('startsWith');
    });

    it('returns replayed lines in LINE order, not database order', async () => {
        // The ten-line case, which is the sheet size the phone sends. Derived
        // keys sort lexicographically, so `:10` falls between `:1` and `:2` —
        // a replay trusting the query's order pairs figures with wrong lines.
        const lines = Array.from({ length: 11 }, () => line());
        const keys = lines.map((_l, i) => `sheet-1:${i}`);
        // Hand them back in LEXICOGRAPHIC order, as the database would.
        mockDb.costEntry.findMany.mockResolvedValue(
            [...keys].sort().map((k) => row(`id-${k}`, k)),
        );

        const res = await createCostEntryBatch(ctx, { lines }, 'sheet-1');

        expect(res.lines.map((l: any) => l.id)).toEqual(keys.map((k) => `id-${k}`));
        // And prove the fixture really was out of order, or this asserts nothing.
        expect([...keys].sort()).not.toEqual(keys);
    });

    it('a PARTIAL match is not a replay — it writes', async () => {
        // One transaction means all-or-none, so a partial set means something
        // other than this batch wrote those keys. Answering a client with half
        // a sheet is the failure the endpoint exists to prevent.
        mockDb.costEntry.findMany.mockResolvedValue([row('ce-a', 'sheet-1:0')]);

        await createCostEntryBatch(ctx, { lines: [line(), line()] }, 'sheet-1');

        expect(mockDb.costEntry.create).toHaveBeenCalledTimes(2);
    });

    it('with no Idempotency-Key it writes, and stores no derived key', async () => {
        await createCostEntryBatch(ctx, { lines: [line()] }, undefined);

        expect(mockDb.costEntry.findMany).not.toHaveBeenCalled();
        expect(mockDb.costEntry.create.mock.calls[0][0].data.clientMutationId).toBeNull();
    });

    it('refuses a contradictory line BEFORE writing anything', async () => {
        // `prepareCostEntry` runs over every line first, so the batch cannot
        // write six rows and then discover line 7 is invalid. A CROP basis
        // with no commodity is the cheapest such contradiction.
        await expect(
            createCostEntryBatch(
                ctx,
                { lines: [line(), line({ allocationBasis: 'CROP' })] },
                'sheet-1',
            ),
        ).rejects.toThrow();

        expect(mockDb.costEntry.create).not.toHaveBeenCalled();
    });
});

describe('CreateCostEntryBatchSchema', () => {
    it('refuses an EMPTY batch', () => {
        // Not a no-op to absorb: a 201 for a write that did nothing is what
        // makes an outbox believe it has synced and drop the sheet.
        expect(CreateCostEntryBatchSchema.safeParse({ lines: [] }).success).toBe(false);
    });

    it('accepts a sheet at the bound and refuses one over it', () => {
        const at = Array.from({ length: MAX_COST_BATCH_LINES }, () => line());
        const over = Array.from({ length: MAX_COST_BATCH_LINES + 1 }, () => line());

        expect(CreateCostEntryBatchSchema.safeParse({ lines: at }).success).toBe(true);
        // Unbounded would be one transaction whose size the CLIENT chooses.
        expect(CreateCostEntryBatchSchema.safeParse({ lines: over }).success).toBe(false);
    });
});
