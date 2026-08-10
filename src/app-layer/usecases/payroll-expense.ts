import { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    PayrollExpenseRepository,
    type PayrollExpenseFilters,
} from '../repositories/PayrollExpenseRepository';
import type {
    CreatePayrollExpenseInput,
    UpdatePayrollExpenseInput,
} from '../schemas/grain.schemas';

/**
 * Payroll expenses — the labour-cost register (enterprise-grain, GRAIN
 * module). A first-class COST alongside `LogEntry.costAmount` /
 * `StockTransaction.costAmount` (see `cost-rollup.ts`): labour is often a
 * farm's biggest single cost line, and this is the PRODUCER of those raw
 * rows — `plantingId` / `seasonId` are optional, and a later allocator is
 * expected to spread unattributed rows pro-rata by area. No allocation
 * logic lives here.
 *
 * Shape mirrors `yield-record.ts`:
 *   - authorize via assertCanRead/Write BEFORE data access,
 *   - sanitize user free text (`description` → sanitizePlainText) — it is
 *     ALSO encrypted at rest by the Epic B manifest,
 *   - `amount` stays a PLAINTEXT Decimal so a future cost rollup can SUM
 *     it in-DB,
 *   - emit a hash-chained audit event on EVERY mutation,
 *   - all DB access through runInTenantContext (RLS-bound) + bounded
 *     `take:`, via `PayrollExpenseRepository`.
 */

const LIST_TAKE = 500;

/** Prisma Decimal | null → plain number | null. */
function dec(v: Prisma.Decimal | number | null | undefined): number | null {
    if (v == null) return null;
    return typeof v === 'number' ? v : Number(v.toString());
}

function parseRequiredDate(value: string, label: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw badRequest(`${label} must be a valid date`);
    return d;
}

/**
 * Shape a PayrollExpense row into a DTO. `description` is only present on
 * rows read via `getPayrollExpense` (a single-record detail read) — the
 * list projection omits it entirely (see `PAYROLL_LIST_SELECT`), so it is
 * `undefined` rather than `null` on a list row: `null` would assert "this
 * row has no description", a different claim from "not sent here".
 */
function toDto(row: {
    id: string;
    amount: Prisma.Decimal | number;
    currency: string;
    incurredOn: Date;
    plantingId: string | null;
    seasonId: string | null;
    createdByUserId: string | null;
    description?: string | null;
    createdAt: Date;
    updatedAt: Date;
    planting?: { id: string; successionNumber: number; cropPlan?: { name: string | null } | null } | null;
    season?: { id: string; name: string } | null;
}) {
    return {
        id: row.id,
        amount: dec(row.amount) ?? 0,
        currency: row.currency,
        incurredOn: row.incurredOn,
        plantingId: row.plantingId,
        seasonId: row.seasonId,
        createdByUserId: row.createdByUserId,
        ...(row.description !== undefined ? { description: row.description } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        planting: row.planting ?? null,
        season: row.season ?? null,
    };
}

export async function listPayrollExpenses(
    ctx: RequestContext,
    filters: PayrollExpenseFilters = {},
    opts: { take?: number } = {},
) {
    assertCanRead(ctx);
    const take = opts.take ?? LIST_TAKE;

    return runInTenantContext(ctx, async (db) => {
        const rows = await PayrollExpenseRepository.list(db, ctx, filters, take);

        // The cap used to be silent on the yield register — a full page
        // read as "the total" when it was really a truncated one. Only
        // count when the page came back FULL: in the ordinary case the
        // page length IS the total and the count query is skipped.
        const truncated = rows.length === take;
        const totalCount = truncated
            ? await PayrollExpenseRepository.count(db, ctx, filters)
            : rows.length;

        return { rows: rows.map(toDto), totalCount, truncated };
    });
}

export async function getPayrollExpense(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    const row = await runInTenantContext(ctx, async (db) => {
        const record = await PayrollExpenseRepository.getById(db, ctx, id);
        if (!record) throw notFound('Payroll expense not found');
        return record;
    });
    return toDto(row);
}

/** Validate the optional FKs belong to THIS tenant before writing them. */
async function assertFksBelongToTenant(
    db: PrismaTx,
    ctx: RequestContext,
    input: { plantingId?: string | null; seasonId?: string | null },
): Promise<void> {
    if (input.plantingId) {
        const planting = await db.planting.findFirst({
            where: { id: input.plantingId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!planting) throw badRequest('Planting not found or belongs to a different tenant');
    }
    if (input.seasonId) {
        const season = await db.season.findFirst({
            where: { id: input.seasonId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!season) throw badRequest('Season not found or belongs to a different tenant');
    }
}

export async function createPayrollExpense(ctx: RequestContext, input: CreatePayrollExpenseInput) {
    assertCanWrite(ctx);

    const description = input.description != null ? sanitizePlainText(input.description) : null;
    const incurredOn = parseRequiredDate(input.incurredOn, 'Incurred-on date');
    const currency = input.currency.trim().toUpperCase();

    const row = await runInTenantContext(ctx, async (db) => {
        await assertFksBelongToTenant(db, ctx, input);

        const record = await PayrollExpenseRepository.create(db, ctx, {
            amount: input.amount,
            currency,
            incurredOn,
            description,
            plantingId: input.plantingId ?? null,
            seasonId: input.seasonId ?? null,
            createdByUserId: ctx.userId ?? null,
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'PayrollExpense',
            entityId: record.id,
            details: `Recorded payroll expense: ${input.amount} ${currency}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'PayrollExpense',
                operation: 'created',
                after: {
                    amount: input.amount,
                    currency,
                    seasonId: input.seasonId ?? null,
                    plantingId: input.plantingId ?? null,
                },
                summary: `Recorded a payroll expense of ${input.amount} ${currency}`,
            },
        });

        return record;
    });

    return toDto(row);
}

export async function updatePayrollExpense(
    ctx: RequestContext,
    id: string,
    input: UpdatePayrollExpenseInput,
) {
    assertCanWrite(ctx);

    const data: Prisma.PayrollExpenseUncheckedUpdateInput = {};
    if (input.amount !== undefined) data.amount = input.amount;
    if (input.currency !== undefined) data.currency = input.currency.trim().toUpperCase();
    if (input.incurredOn !== undefined) {
        data.incurredOn = parseRequiredDate(input.incurredOn, 'Incurred-on date');
    }
    if (input.description !== undefined) {
        data.description = input.description != null ? sanitizePlainText(input.description) : null;
    }
    if (input.plantingId !== undefined) data.plantingId = input.plantingId;
    if (input.seasonId !== undefined) data.seasonId = input.seasonId;

    const row = await runInTenantContext(ctx, async (db) => {
        const existing = await PayrollExpenseRepository.getById(db, ctx, id);
        if (!existing) throw notFound('Payroll expense not found');

        await assertFksBelongToTenant(db, ctx, input);

        const record = await PayrollExpenseRepository.update(db, ctx, id, data);

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'PayrollExpense',
            entityId: id,
            details: 'Payroll expense updated',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'PayrollExpense',
                operation: 'updated',
                changedFields: Object.keys(input).filter(
                    (k) => (input as Record<string, unknown>)[k] !== undefined,
                ),
                after: { amount: dec(record.amount), currency: record.currency },
                summary: 'Payroll expense updated',
            },
        });

        return record;
    });

    return toDto(row);
}

export async function deletePayrollExpense(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);

    const result = await runInTenantContext(ctx, async (db) => {
        const existing = await PayrollExpenseRepository.getById(db, ctx, id);
        if (!existing) throw notFound('Payroll expense not found');

        await PayrollExpenseRepository.softDelete(db, ctx, id);

        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'PayrollExpense',
            entityId: id,
            details: `Deleted payroll expense: ${dec(existing.amount)} ${existing.currency}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'PayrollExpense',
                operation: 'deleted',
                before: { amount: dec(existing.amount), currency: existing.currency },
                summary: `Deleted a payroll expense of ${dec(existing.amount)} ${existing.currency}`,
            },
        });

        return { id, deleted: true };
    });

    return result;
}
