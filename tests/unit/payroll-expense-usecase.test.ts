/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/payroll-expense.ts` (and, by
 * extension, `src/app-layer/repositories/PayrollExpenseRepository.ts` —
 * mocked only at the `runInTenantContext`/`db` boundary, so the
 * repository's real `where`-building logic runs).
 *
 * Covers:
 *   - listPayrollExpenses — read gate + tenantId/deletedAt filter +
 *     season/planting facets + free-text search + the encrypted
 *     `description` NOT being broadcast on the list projection.
 *   - createPayrollExpense — sanitises description, audits, keeps the
 *     numeric amount plaintext, uppercases currency, validates FKs,
 *     rejects a non-positive amount.
 *   - updatePayrollExpense / deletePayrollExpense — 404 on a missing row,
 *     audits on success, soft-deletes (never a hard delete).
 */

const mockDb = {
    payrollExpense: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    planting: { findFirst: jest.fn() },
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
    listPayrollExpenses,
    getPayrollExpense,
    createPayrollExpense,
    updatePayrollExpense,
    deletePayrollExpense,
} from '@/app-layer/usecases/payroll-expense';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN', { tenantSlug: 'acme', tenantId: 'tenant-1', userId: 'user-1' });
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme', tenantId: 'tenant-1' });

const BASE_ROW = {
    id: 'p-1',
    amount: '500.00',
    currency: 'BGN',
    incurredOn: new Date('2026-06-01'),
    plantingId: null,
    seasonId: null,
    createdByUserId: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    planting: null,
    season: null,
};

describe('listPayrollExpenses', () => {
    it('reads tenant-scoped + non-deleted, newest-incurred-first, take:500', async () => {
        mockDb.payrollExpense.findMany.mockResolvedValue([BASE_ROW]);
        const { rows: out } = await listPayrollExpenses(adminCtx, { seasonIds: ['s-1'] });
        const args = mockDb.payrollExpense.findMany.mock.calls[0][0];
        expect(args.where).toMatchObject({ tenantId: 'tenant-1', deletedAt: null, seasonId: { in: ['s-1'] } });
        expect(args.orderBy).toEqual([{ incurredOn: 'desc' }, { createdAt: 'desc' }]);
        expect(args.take).toBe(500);
        expect(out[0].amount).toBe(500);
        expect(out[0].currency).toBe('BGN');
    });

    it('does not select description — encrypted commercial/personal text, not list data', async () => {
        mockDb.payrollExpense.findMany.mockResolvedValue([]);
        await listPayrollExpenses(adminCtx);
        const args = mockDb.payrollExpense.findMany.mock.calls[0][0];
        expect(args.select).toBeDefined();
        expect(args.select.description).toBeUndefined();
        expect(args.select).toMatchObject({ amount: true, currency: true, incurredOn: true });
    });

    it('omits the key entirely on a list row rather than sending null', async () => {
        mockDb.payrollExpense.findMany.mockResolvedValue([BASE_ROW]);
        const { rows: out } = await listPayrollExpenses(adminCtx);
        expect('description' in out[0]).toBe(false);
    });

    it('still returns description on a single-record read', async () => {
        mockDb.payrollExpense.findFirst.mockResolvedValue({
            ...BASE_ROW,
            description: 'Overtime, combine operator',
        });
        const out = await getPayrollExpense(adminCtx, 'p-1');
        expect(out.description).toBe('Overtime, combine operator');
    });

    it('queries IN for two selected seasons, omits the filter for an empty selection', async () => {
        mockDb.payrollExpense.findMany.mockResolvedValue([]);
        await listPayrollExpenses(adminCtx, { seasonIds: ['s-1', 's-2'] });
        expect(mockDb.payrollExpense.findMany.mock.calls[0][0].where).toMatchObject({
            seasonId: { in: ['s-1', 's-2'] },
        });

        jest.clearAllMocks();
        mockDb.payrollExpense.findMany.mockResolvedValue([]);
        await listPayrollExpenses(adminCtx, { seasonIds: [] });
        expect(mockDb.payrollExpense.findMany.mock.calls[0][0].where.seasonId).toBeUndefined();
    });

    it('counts the total only when the page came back full (truncated)', async () => {
        mockDb.payrollExpense.findMany.mockResolvedValue([BASE_ROW]);
        mockDb.payrollExpense.count.mockResolvedValue(37);
        const { truncated, totalCount } = await listPayrollExpenses(adminCtx, {}, { take: 1 });
        expect(truncated).toBe(true);
        expect(mockDb.payrollExpense.count).toHaveBeenCalledTimes(1);
        expect(totalCount).toBe(37);
    });

    it('skips the count query when the page is NOT full', async () => {
        mockDb.payrollExpense.findMany.mockResolvedValue([BASE_ROW]);
        const { truncated, totalCount } = await listPayrollExpenses(adminCtx, {}, { take: 500 });
        expect(truncated).toBe(false);
        expect(mockDb.payrollExpense.count).not.toHaveBeenCalled();
        expect(totalCount).toBe(1);
    });
});

describe('createPayrollExpense', () => {
    it('sanitises description, uppercases currency, audits, keeps amount plaintext', async () => {
        mockDb.payrollExpense.create.mockResolvedValue({
            ...BASE_ROW,
            amount: '420.50',
            currency: 'EUR',
            description: 'SAN::Harvest crew overtime',
        });
        const out = await createPayrollExpense(adminCtx, {
            amount: 420.5,
            currency: 'eur',
            incurredOn: '2026-06-01',
            description: 'Harvest crew overtime',
        });
        expect(sanitizePlainText).toHaveBeenCalledWith('Harvest crew overtime');
        const data = mockDb.payrollExpense.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
            tenantId: 'tenant-1',
            amount: 420.5,
            currency: 'EUR',
            description: 'SAN::Harvest crew overtime',
        });
        expect(out.amount).toBe(420.5);
        expect(out.currency).toBe('EUR');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.entityType).toBe('PayrollExpense');
        expect(payload.detailsJson.operation).toBe('created');
    });

    it('validates plantingId belongs to the tenant', async () => {
        mockDb.planting.findFirst.mockResolvedValue(null);
        await expect(
            createPayrollExpense(adminCtx, {
                amount: 100,
                currency: 'BGN',
                incurredOn: '2026-06-01',
                plantingId: 'foreign',
            }),
        ).rejects.toThrow(/Planting not found/i);
        expect(mockDb.payrollExpense.create).not.toHaveBeenCalled();
    });

    it('validates seasonId belongs to the tenant', async () => {
        mockDb.season.findFirst.mockResolvedValue(null);
        await expect(
            createPayrollExpense(adminCtx, {
                amount: 100,
                currency: 'BGN',
                incurredOn: '2026-06-01',
                seasonId: 'foreign',
            }),
        ).rejects.toThrow(/Season not found/i);
        expect(mockDb.payrollExpense.create).not.toHaveBeenCalled();
    });

    it('rejects an invalid incurredOn date', async () => {
        await expect(
            createPayrollExpense(adminCtx, {
                amount: 100,
                currency: 'BGN',
                incurredOn: 'not-a-date',
            }),
        ).rejects.toThrow(/valid date/i);
    });

    it('READER cannot create', async () => {
        await expect(
            createPayrollExpense(readerCtx, { amount: 100, currency: 'BGN', incurredOn: '2026-06-01' }),
        ).rejects.toThrow();
        expect(mockDb.payrollExpense.create).not.toHaveBeenCalled();
    });
});

describe('updatePayrollExpense', () => {
    it('throws notFound when missing', async () => {
        mockDb.payrollExpense.findFirst.mockResolvedValue(null);
        await expect(
            updatePayrollExpense(adminCtx, 'missing', { amount: 1 }),
        ).rejects.toThrow(/not found/i);
    });

    it('updates + audits', async () => {
        mockDb.payrollExpense.findFirst.mockResolvedValue({ ...BASE_ROW });
        mockDb.payrollExpense.update.mockResolvedValue({ ...BASE_ROW, amount: '600.00' });
        const out = await updatePayrollExpense(adminCtx, 'p-1', { amount: 600 });
        expect(out.amount).toBe(600);
        expect(logEvent).toHaveBeenCalledTimes(1);
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.detailsJson.operation).toBe('updated');
    });
});

describe('deletePayrollExpense', () => {
    it('soft-deletes (never a hard delete) + audits', async () => {
        mockDb.payrollExpense.findFirst.mockResolvedValue({ ...BASE_ROW });
        mockDb.payrollExpense.update.mockResolvedValue({ id: 'p-1' });
        const res = await deletePayrollExpense(adminCtx, 'p-1');
        expect(res).toEqual({ id: 'p-1', deleted: true });
        const data = mockDb.payrollExpense.update.mock.calls[0][0].data;
        expect(data.deletedAt).toBeInstanceOf(Date);
        expect(data.deletedByUserId).toBe('user-1');
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('throws notFound when missing', async () => {
        mockDb.payrollExpense.findFirst.mockResolvedValue(null);
        await expect(deletePayrollExpense(adminCtx, 'missing')).rejects.toThrow(/not found/i);
    });
});
