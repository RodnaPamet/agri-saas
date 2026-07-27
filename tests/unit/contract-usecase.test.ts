/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/contract.ts`.
 *
 * Covers:
 *   - listContracts — read gate + tenantId/deletedAt filter + MULTI-value
 *     status/type facets folded into Prisma `{ in: [...] }`.
 *   - createContract — sanitises counterparty/commodity/terms/pricingNotes,
 *     audits, validates non-empty counterparty + non-negative volume + dates,
 *     trims, and normalises a blank `key` to null.
 *   - updateContract — notFound, the ContractStatus lifecycle guard, the
 *     delivery-window ordering check against EFFECTIVE values, audit.
 *   - deleteContract — soft-delete + audit.
 *   - RBAC: a READER cannot write.
 *
 * `sanitizePlainText` is mocked to a visible `SAN::` prefix so call sites
 * are provable. Tests that need to prove REAL sanitiser behaviour (does it
 * trim? does it strip to empty?) swap in `jest.requireActual` for a single
 * call via `mockImplementationOnce` — asserting against the mock alone
 * would only prove a branch exists, not that it ever fires in production.
 */

const mockDb = {
    contract: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    season: { findFirst: jest.fn() },
    grainDelivery: { groupBy: jest.fn() },
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
    listContracts,
    getContract,
    createContract,
    updateContract,
    deleteContract,
} from '@/app-layer/usecases/contract';
import { Prisma } from '@prisma/client';
import { makeRequestContext } from '../helpers/make-context';

const Decimal = Prisma.Decimal;

/** The REAL sanitiser, for tests that must prove production behaviour. */
const realSanitize: (s: string) => string = jest.requireActual(
    '@/lib/security/sanitize',
).sanitizePlainText;

beforeEach(() => {
    jest.clearAllMocks();
    // `clearAllMocks` clears calls but NOT implementations — re-seed the
    // default so a per-test `mockImplementationOnce(realSanitize)` can
    // never leak into the next test.
    (sanitizePlainText as jest.Mock).mockImplementation((s: string) => `SAN::${s}`);
    // Default: nothing delivered. Tests that exercise the DELIVERED gate
    // override this per-case.
    mockDb.grainDelivery.groupBy.mockResolvedValue([]);
    mockDb.contract.findMany.mockResolvedValue([]);
});

const adminCtx = makeRequestContext('ADMIN', { tenantSlug: 'acme', tenantId: 'tenant-1', userId: 'user-1' });
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme', tenantId: 'tenant-1' });

describe('listContracts', () => {
    it('reads tenant-scoped + non-deleted with filters folded in', async () => {
        mockDb.contract.findMany.mockResolvedValue([{ id: 'c-1' }]);
        const { rows: out } = await listContracts(adminCtx, {
            status: ['ACTIVE'],
            type: ['SALE'],
            seasonIds: ['s-1'],
        });
        // Rows are DECORATED with derived figures (fulfilment + value),
        // so this is a subset match, not equality.
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ id: 'c-1' });
        const args = mockDb.contract.findMany.mock.calls[0][0];
        expect(args.where).toMatchObject({
            tenantId: 'tenant-1',
            deletedAt: null,
            status: { in: ['ACTIVE'] },
            type: { in: ['SALE'] },
            // Season is multi-select too — it was the one facet still read
            // as a scalar, which a String column accepts and no row matches.
            seasonId: { in: ['s-1'] },
        });
        expect(args.take).toBe(500);
    });

    it('folds TWO selected statuses into a single `in` filter', async () => {
        // The regression: both facets are `multiple: true`, so the toolbar
        // sends `?status=DRAFT,ACTIVE`. The old signature took a scalar and
        // cast the raw string into a Prisma enum, which threw a
        // PrismaClientValidationError (a 500 the table rendered as
        // "no contracts match your filters").
        mockDb.contract.findMany.mockResolvedValue([{ id: 'c-1' }, { id: 'c-2' }]);
        const { rows: out } = await listContracts(adminCtx, {
            status: ['DRAFT', 'ACTIVE'],
            type: ['SALE', 'PURCHASE'],
        });
        expect(out).toHaveLength(2);
        const args = mockDb.contract.findMany.mock.calls[0][0];
        expect(args.where).toEqual({
            tenantId: 'tenant-1',
            deletedAt: null,
            status: { in: ['DRAFT', 'ACTIVE'] },
            type: { in: ['SALE', 'PURCHASE'] },
        });
        // No bare enum equality anywhere in the where clause.
        expect(args.where.status).not.toBe('DRAFT,ACTIVE');
    });

    it('omits absent filters', async () => {
        mockDb.contract.findMany.mockResolvedValue([]);
        await listContracts(adminCtx, {});
        const args = mockDb.contract.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ tenantId: 'tenant-1', deletedAt: null });
    });

    it('omits an EMPTY facet array (cleared filter ≠ match nothing)', async () => {
        mockDb.contract.findMany.mockResolvedValue([]);
        await listContracts(adminCtx, { status: [], type: [] });
        const args = mockDb.contract.findMany.mock.calls[0][0];
        // `{ in: [] }` would match zero rows — a cleared facet must widen
        // back to "all", not silently empty the table.
        expect(args.where).toEqual({ tenantId: 'tenant-1', deletedAt: null });
    });

    it('READER can read', async () => {
        mockDb.contract.findMany.mockResolvedValue([]);
        await expect(listContracts(readerCtx, {})).resolves.toMatchObject({
            rows: [],
            totalCount: 0,
            truncated: false,
        });
    });

    // ── Derived decoration (fulfilment + value) ──
    describe('row decoration', () => {
        it('attaches the fulfilment position from ONE delivery groupBy', async () => {
            mockDb.contract.findMany.mockResolvedValue([
                { id: 'c-1', volumeTonnes: new Decimal('500'), pricePerTonne: null },
                { id: 'c-2', volumeTonnes: new Decimal('100'), pricePerTonne: null },
            ]);
            mockDb.grainDelivery.groupBy.mockResolvedValue([
                { contractId: 'c-1', _sum: { tonnes: new Decimal('300') }, _count: { _all: 2 } },
            ]);

            const { rows: out } = await listContracts(adminCtx, {});

            // One aggregate for the whole page — not one per row.
            expect(mockDb.grainDelivery.groupBy).toHaveBeenCalledTimes(1);
            expect(out[0].fulfilment).toMatchObject({
                deliveredTonnes: '300',
                remainingTonnes: '200',
                progressPct: 60,
                deliveryCount: 2,
            });
            // A contract with no deliveries reads as zero, not undefined.
            expect(out[1].fulfilment).toMatchObject({
                deliveredTonnes: '0',
                remainingTonnes: '100',
                progressPct: 0,
                complete: false,
            });
        });

        it('attaches a Decimal-exact contract value', async () => {
            mockDb.contract.findMany.mockResolvedValue([
                {
                    id: 'c-1',
                    volumeTonnes: new Decimal('1234.567'),
                    pricePerTonne: new Decimal('89.12'),
                },
                { id: 'c-2', volumeTonnes: new Decimal('100'), pricePerTonne: null },
            ]);

            const { rows: out } = await listContracts(adminCtx, {});

            expect(out[0].valueAmount).toBe('110024.61104');
            // Unpriced ⇒ null, never 0 (zero would claim the deal is
            // worth nothing and would drag a book total down).
            expect(out[1].valueAmount).toBeNull();
        });
    });
});

describe('createContract', () => {
    it('sanitises free text + audits + defaults type/status', async () => {
        mockDb.contract.create.mockResolvedValue({
            id: 'c-1',
            type: 'SALE',
            status: 'DRAFT',
            counterparty: 'SAN::Acme',
        });
        await createContract(adminCtx, {
            counterparty: 'Acme',
            commodity: 'Wheat',
            terms: 'secret terms',
            pricingNotes: 'basis note',
            volumeTonnes: 500,
        });

        // Every free-text field routed through the sanitiser.
        expect(sanitizePlainText).toHaveBeenCalledWith('Acme');
        expect(sanitizePlainText).toHaveBeenCalledWith('Wheat');
        expect(sanitizePlainText).toHaveBeenCalledWith('secret terms');
        expect(sanitizePlainText).toHaveBeenCalledWith('basis note');

        const data = mockDb.contract.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
            tenantId: 'tenant-1',
            counterparty: 'SAN::Acme',
            commodity: 'SAN::Wheat',
            terms: 'SAN::secret terms',
            pricingNotes: 'SAN::basis note',
            type: 'SALE',
            status: 'DRAFT',
            volumeTonnes: 500,
        });

        expect(logEvent).toHaveBeenCalledTimes(1);
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.entityType).toBe('Contract');
        expect(payload.detailsJson.category).toBe('entity_lifecycle');
        expect(payload.detailsJson.operation).toBe('created');
    });

    it('rejects a counterparty that is blank after sanitise + trim — proven against the REAL sanitiser', async () => {
        // Premise the assertion depends on: `sanitizePlainText` strips
        // markup but does NOT trim. So whitespace can only be rejected by
        // the usecase's own `.trim()`. Asserting this against the `SAN::`
        // mock (or a `mockReturnValueOnce('')`) would prove the branch
        // exists while `"   "` still sailed through in production.
        expect(realSanitize('   ')).toBe('   ');
        expect(realSanitize('\t\n ')).toBe('\t\n ');
        expect(realSanitize('<b></b>')).toBe('');

        for (const raw of ['   ', '\t\n ', '<b></b>']) {
            // Counterparty is the FIRST sanitiser call in createContract.
            (sanitizePlainText as jest.Mock).mockImplementationOnce(realSanitize);
            await expect(
                createContract(adminCtx, { counterparty: raw } as any),
            ).rejects.toThrow(/counterparty is required/i);
        }
        expect(mockDb.contract.create).not.toHaveBeenCalled();
    });

    it('trims a padded counterparty rather than persisting the padding', async () => {
        mockDb.contract.create.mockResolvedValue({ id: 'c-1', type: 'SALE', status: 'DRAFT', counterparty: 'Acme' });
        (sanitizePlainText as jest.Mock).mockImplementationOnce(realSanitize);
        await createContract(adminCtx, { counterparty: '  Acme  ' } as any);
        expect(mockDb.contract.create.mock.calls[0][0].data.counterparty).toBe('Acme');
    });

    it('normalises a blank `key` to null so a second key-less contract cannot 409', async () => {
        // `key` sits on a [tenantId, key] unique index. Postgres does not
        // collide NULLs, but it DOES collide two `""` rows — so a blank
        // key must become null, not empty string.
        mockDb.contract.create.mockResolvedValue({ id: 'c-1', type: 'SALE', status: 'DRAFT', counterparty: 'Acme' });
        (sanitizePlainText as jest.Mock)
            .mockImplementationOnce(realSanitize)  // counterparty
            .mockImplementationOnce(realSanitize); // key
        await createContract(adminCtx, { counterparty: 'Acme', key: '   ' } as any);
        expect(mockDb.contract.create.mock.calls[0][0].data.key).toBeNull();
    });

    it('keeps a real `key`, trimmed', async () => {
        mockDb.contract.create.mockResolvedValue({ id: 'c-1', type: 'SALE', status: 'DRAFT', counterparty: 'Acme' });
        (sanitizePlainText as jest.Mock)
            .mockImplementationOnce(realSanitize)
            .mockImplementationOnce(realSanitize);
        await createContract(adminCtx, { counterparty: 'Acme', key: ' WHEAT-01 ' } as any);
        expect(mockDb.contract.create.mock.calls[0][0].data.key).toBe('WHEAT-01');
    });

    it('rejects a negative volume', async () => {
        await expect(
            createContract(adminCtx, { counterparty: 'Acme', volumeTonnes: -1 }),
        ).rejects.toThrow(/zero or positive/i);
    });

    it('rejects delivery end before start', async () => {
        await expect(
            createContract(adminCtx, {
                counterparty: 'Acme',
                deliveryStart: '2026-06-01',
                deliveryEnd: '2026-05-01',
            }),
        ).rejects.toThrow(/on or after/i);
    });

    it('validates the season belongs to the tenant', async () => {
        mockDb.season.findFirst.mockResolvedValue(null);
        await expect(
            createContract(adminCtx, { counterparty: 'Acme', seasonId: 'foreign' }),
        ).rejects.toThrow(/Season not found/i);
    });

    it('READER cannot create', async () => {
        await expect(createContract(readerCtx, { counterparty: 'Acme' })).rejects.toThrow();
        expect(mockDb.contract.create).not.toHaveBeenCalled();
    });
});

describe('updateContract', () => {
    /** An existing row as the usecase now reads it (status + window). */
    const existing = (over: Record<string, any> = {}) => ({
        id: 'c-1',
        status: 'DRAFT',
        deliveryStart: null,
        deliveryEnd: null,
        ...over,
    });

    it('throws notFound when the contract is missing', async () => {
        mockDb.contract.findFirst.mockResolvedValue(null);
        await expect(updateContract(adminCtx, 'missing', { status: 'ACTIVE' })).rejects.toThrow(/not found/i);
    });

    it('updates + audits with changedFields', async () => {
        mockDb.contract.findFirst.mockResolvedValue(existing());
        mockDb.contract.update.mockResolvedValue({ id: 'c-1', counterparty: 'SAN::New', status: 'ACTIVE' });
        await updateContract(adminCtx, 'c-1', { counterparty: 'New', status: 'ACTIVE' });
        expect(sanitizePlainText).toHaveBeenCalledWith('New');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.detailsJson.changedFields).toEqual(expect.arrayContaining(['counterparty', 'status']));
    });

    // ── Lifecycle guard (documented on the ContractStatus enum) ──
    describe('status lifecycle', () => {
        it.each([
            ['DRAFT', 'ACTIVE'],
            ['DRAFT', 'CANCELLED'],
            ['ACTIVE', 'DELIVERED'],
            ['ACTIVE', 'CANCELLED'],
            ['DELIVERED', 'SETTLED'],
            ['DELIVERED', 'CANCELLED'],
        ])('allows %s → %s', async (from, to) => {
            mockDb.contract.findFirst.mockResolvedValue(existing({ status: from }));
            mockDb.contract.update.mockResolvedValue({ id: 'c-1', counterparty: 'Acme', status: to });
            // → DELIVERED additionally requires real movement in the
            // ledger; give every case a delivery so this table tests the
            // GRAPH, with the movement gate covered separately below.
            mockDb.grainDelivery.groupBy.mockResolvedValue([
                { contractId: 'c-1', _sum: { tonnes: new Decimal('100') }, _count: { _all: 1 } },
            ]);
            await updateContract(adminCtx, 'c-1', { status: to as any });
            expect(mockDb.contract.update.mock.calls[0][0].data.status).toBe(to);
        });

        it.each([
            // Skipping the signature / the delivery.
            ['DRAFT', 'DELIVERED'],
            ['DRAFT', 'SETTLED'],
            ['ACTIVE', 'SETTLED'],
            // Walking the lifecycle backwards.
            ['SETTLED', 'DRAFT'],
            ['SETTLED', 'ACTIVE'],
            ['DELIVERED', 'ACTIVE'],
            ['ACTIVE', 'DRAFT'],
            // Resurrecting a terminal state.
            ['CANCELLED', 'ACTIVE'],
            ['CANCELLED', 'DRAFT'],
            ['SETTLED', 'CANCELLED'],
        ])('rejects %s → %s as an illegal transition', async (from, to) => {
            mockDb.contract.findFirst.mockResolvedValue(existing({ status: from }));
            await expect(
                updateContract(adminCtx, 'c-1', { status: to as any }),
            ).rejects.toThrow(/Illegal contract transition/i);
            expect(mockDb.contract.update).not.toHaveBeenCalled();
        });

        it('treats a re-sent identical status as a legal no-op and does not write it', async () => {
            // Load-bearing: ContractFormModal submits the WHOLE form, so
            // every "fix a typo" edit re-sends the unchanged status. If the
            // guard rejected no-ops, a SETTLED contract could never be
            // edited again.
            mockDb.contract.findFirst.mockResolvedValue(existing({ status: 'SETTLED' }));
            mockDb.contract.update.mockResolvedValue({ id: 'c-1', counterparty: 'SAN::Fixed', status: 'SETTLED' });
            await updateContract(adminCtx, 'c-1', { counterparty: 'Fixed', status: 'SETTLED' });
            const data = mockDb.contract.update.mock.calls[0][0].data;
            expect(data.counterparty).toBe('SAN::Fixed');
            expect(data.status).toBeUndefined();
        });

        // ── Movement gate: DELIVERED must mean grain actually moved ──
        describe('DELIVERED movement gate', () => {
            it('refuses DELIVERED when the delivery ledger is empty', async () => {
                mockDb.contract.findFirst.mockResolvedValue(existing({ status: 'ACTIVE' }));
                mockDb.grainDelivery.groupBy.mockResolvedValue([]);
                await expect(
                    updateContract(adminCtx, 'c-1', { status: 'DELIVERED' }),
                ).rejects.toThrow(/no recorded deliveries/i);
                expect(mockDb.contract.update).not.toHaveBeenCalled();
            });

            it('refuses DELIVERED when the ledger sums to zero', async () => {
                mockDb.contract.findFirst.mockResolvedValue(existing({ status: 'ACTIVE' }));
                mockDb.grainDelivery.groupBy.mockResolvedValue([
                    { contractId: 'c-1', _sum: { tonnes: new Decimal('0') }, _count: { _all: 1 } },
                ]);
                await expect(
                    updateContract(adminCtx, 'c-1', { status: 'DELIVERED' }),
                ).rejects.toThrow(/no recorded deliveries/i);
            });

            it('allows DELIVERED on a PARTIAL delivery — the bar is movement, not completion', async () => {
                // Grain marketing runs on tolerance: moisture shrink and a
                // short final load are ordinary. Demanding an exact match
                // would push operators back to lying to the system.
                mockDb.contract.findFirst.mockResolvedValue(existing({ status: 'ACTIVE' }));
                mockDb.grainDelivery.groupBy.mockResolvedValue([
                    { contractId: 'c-1', _sum: { tonnes: new Decimal('0.5') }, _count: { _all: 1 } },
                ]);
                mockDb.contract.update.mockResolvedValue({
                    id: 'c-1',
                    counterparty: 'Acme',
                    status: 'DELIVERED',
                });
                await updateContract(adminCtx, 'c-1', { status: 'DELIVERED' });
                expect(mockDb.contract.update.mock.calls[0][0].data.status).toBe('DELIVERED');
            });

            it('does NOT gate other transitions on movement', async () => {
                // DRAFT → ACTIVE is signing a contract; no grain has moved
                // yet by definition.
                mockDb.contract.findFirst.mockResolvedValue(existing({ status: 'DRAFT' }));
                mockDb.grainDelivery.groupBy.mockResolvedValue([]);
                mockDb.contract.update.mockResolvedValue({
                    id: 'c-1',
                    counterparty: 'Acme',
                    status: 'ACTIVE',
                });
                await updateContract(adminCtx, 'c-1', { status: 'ACTIVE' });
                expect(mockDb.contract.update).toHaveBeenCalled();
                // The gate is not even consulted off the DELIVERED path.
                expect(mockDb.grainDelivery.groupBy).not.toHaveBeenCalled();
            });

            it('does not re-check movement when DELIVERED is a no-op', async () => {
                // Editing a typo on an already-DELIVERED contract must not
                // re-litigate the ledger.
                mockDb.contract.findFirst.mockResolvedValue(
                    existing({ status: 'DELIVERED' }),
                );
                mockDb.contract.update.mockResolvedValue({
                    id: 'c-1',
                    counterparty: 'SAN::Fixed',
                    status: 'DELIVERED',
                });
                await updateContract(adminCtx, 'c-1', {
                    counterparty: 'Fixed',
                    status: 'DELIVERED',
                });
                expect(mockDb.grainDelivery.groupBy).not.toHaveBeenCalled();
                expect(mockDb.contract.update).toHaveBeenCalled();
            });
        });

        it('leaves status untouched when the patch omits it', async () => {
            mockDb.contract.findFirst.mockResolvedValue(existing({ status: 'ACTIVE' }));
            mockDb.contract.update.mockResolvedValue({ id: 'c-1', counterparty: 'Acme', status: 'ACTIVE' });
            await updateContract(adminCtx, 'c-1', { volumeTonnes: 42 });
            expect(mockDb.contract.update.mock.calls[0][0].data.status).toBeUndefined();
        });
    });

    // ── Delivery-window ordering (create had this; update did not) ──
    describe('delivery window', () => {
        it('rejects end before start when BOTH edges are submitted', async () => {
            mockDb.contract.findFirst.mockResolvedValue(existing());
            await expect(
                updateContract(adminCtx, 'c-1', {
                    deliveryStart: '2026-06-01',
                    deliveryEnd: '2026-05-01',
                }),
            ).rejects.toThrow(/on or after/i);
            expect(mockDb.contract.update).not.toHaveBeenCalled();
        });

        it('rejects a new end that precedes the STORED start', async () => {
            // The subtle one: a PATCH sending only `deliveryEnd` must be
            // compared against the row's existing start, not skipped.
            mockDb.contract.findFirst.mockResolvedValue(
                existing({ deliveryStart: new Date('2026-06-01') }),
            );
            await expect(
                updateContract(adminCtx, 'c-1', { deliveryEnd: '2026-05-01' }),
            ).rejects.toThrow(/on or after/i);
            expect(mockDb.contract.update).not.toHaveBeenCalled();
        });

        it('rejects a new start that follows the STORED end', async () => {
            mockDb.contract.findFirst.mockResolvedValue(
                existing({ deliveryEnd: new Date('2026-05-01') }),
            );
            await expect(
                updateContract(adminCtx, 'c-1', { deliveryStart: '2026-06-01' }),
            ).rejects.toThrow(/on or after/i);
        });

        it('accepts a well-ordered window', async () => {
            mockDb.contract.findFirst.mockResolvedValue(existing());
            mockDb.contract.update.mockResolvedValue({ id: 'c-1', counterparty: 'Acme', status: 'DRAFT' });
            await updateContract(adminCtx, 'c-1', {
                deliveryStart: '2026-05-01',
                deliveryEnd: '2026-06-01',
            });
            expect(mockDb.contract.update).toHaveBeenCalled();
        });

        it('accepts CLEARING an edge (null) even when the other stays set', async () => {
            mockDb.contract.findFirst.mockResolvedValue(
                existing({ deliveryStart: new Date('2026-06-01') }),
            );
            mockDb.contract.update.mockResolvedValue({ id: 'c-1', counterparty: 'Acme', status: 'DRAFT' });
            await updateContract(adminCtx, 'c-1', { deliveryEnd: null });
            expect(mockDb.contract.update.mock.calls[0][0].data.deliveryEnd).toBeNull();
        });

        it('rejects a malformed date', async () => {
            await expect(
                updateContract(adminCtx, 'c-1', { deliveryEnd: 'not-a-date' }),
            ).rejects.toThrow(/must be a valid date/i);
        });
    });

    it('normalises a blank `key` to null on update too', async () => {
        mockDb.contract.findFirst.mockResolvedValue(existing());
        mockDb.contract.update.mockResolvedValue({ id: 'c-1', counterparty: 'Acme', status: 'DRAFT' });
        (sanitizePlainText as jest.Mock).mockImplementationOnce(realSanitize);
        await updateContract(adminCtx, 'c-1', { key: '  ' });
        expect(mockDb.contract.update.mock.calls[0][0].data.key).toBeNull();
    });

    it('READER cannot update', async () => {
        await expect(updateContract(readerCtx, 'c-1', { status: 'ACTIVE' })).rejects.toThrow();
        expect(mockDb.contract.update).not.toHaveBeenCalled();
    });
});

describe('deleteContract', () => {
    it('soft-deletes (sets deletedAt + deletedByUserId) + audits', async () => {
        mockDb.contract.findFirst.mockResolvedValue({ id: 'c-1', counterparty: 'Acme' });
        mockDb.contract.update.mockResolvedValue({ id: 'c-1' });
        const res = await deleteContract(adminCtx, 'c-1');
        expect(res).toEqual({ id: 'c-1', deleted: true });
        const data = mockDb.contract.update.mock.calls[0][0].data;
        expect(data.deletedAt).toBeInstanceOf(Date);
        expect(data.deletedByUserId).toBe('user-1');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.detailsJson.operation).toBe('deleted');
    });

    it('throws notFound when missing', async () => {
        mockDb.contract.findFirst.mockResolvedValue(null);
        await expect(deleteContract(adminCtx, 'missing')).rejects.toThrow(/not found/i);
    });
});

describe('getContract', () => {
    it('throws notFound when missing', async () => {
        mockDb.contract.findFirst.mockResolvedValue(null);
        await expect(getContract(adminCtx, 'missing')).rejects.toThrow(/not found/i);
    });
});

describe('listContracts — the season facet is multi-select too', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.contract.findMany.mockResolvedValue([]);
        mockDb.grainDelivery.groupBy.mockResolvedValue([]);
    });

    it('folds two selected seasons into one IN filter', async () => {
        await listContracts(adminCtx, { seasonIds: ['s-1', 's-2'] });
        expect(mockDb.contract.findMany.mock.calls[0][0].where).toMatchObject({
            seasonId: { in: ['s-1', 's-2'] },
        });
    });

    it('omits the filter for an empty selection rather than matching nothing', async () => {
        await listContracts(adminCtx, { seasonIds: [] });
        expect(mockDb.contract.findMany.mock.calls[0][0].where.seasonId).toBeUndefined();
    });
});
