import { Prisma } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

/**
 * PayrollExpense repository — the labour-cost register (enterprise-grain,
 * GRAIN module). Mirrors `LocationRepository` (tenant-scoped CRUD, explicit
 * soft delete via `deletedAt`/`deletedByUserId` since PayrollExpense is not
 * in `SOFT_DELETE_MODELS`).
 *
 * Every method takes the caller's RLS-bound `PrismaTx` and re-asserts the
 * tenant filter in the `where` clause — defence in depth over RLS, per
 * CLAUDE.md's "Multi-Tenant Isolation" contract.
 */

export interface PayrollExpenseFilters {
    seasonIds?: string[];
    plantingIds?: string[];
    /**
     * Free-text search over `currency` + the linked season's name + the
     * linked planting's crop-plan name. Deliberately EXCLUDES
     * `description` — it is encrypted at rest (Epic B manifest), so a
     * `contains` over it would match ciphertext and never the farmer's
     * search term. Mirrors `Contract`/`YieldRecord`'s exclusion of their
     * own encrypted narrative fields from search.
     */
    q?: string;
}

/** Relations every read needs for display — season name + a planting label. */
const PAYROLL_INCLUDE = {
    planting: {
        select: {
            id: true,
            successionNumber: true,
            cropPlan: { select: { name: true } },
        },
    },
    season: { select: { id: true, name: true } },
} satisfies Prisma.PayrollExpenseInclude;

/**
 * The LIST projection — every scalar EXCEPT `description`.
 *
 * An explicit allowlist rather than an omit, mirroring
 * `YIELD_LIST_SELECT`: a column added later should default to NOT being
 * broadcast. `description` is commercial/personal free text, encrypted at
 * rest, and its only renderer is the write-gated edit form — broadcasting
 * it on the list would decrypt it into every reader's RSC payload,
 * including READERs who can never open the edit form.
 */
const PAYROLL_LIST_SELECT = {
    id: true,
    amount: true,
    currency: true,
    incurredOn: true,
    plantingId: true,
    seasonId: true,
    createdByUserId: true,
    createdAt: true,
    updatedAt: true,
    ...PAYROLL_INCLUDE,
} satisfies Prisma.PayrollExpenseSelect;

function buildSearchWhere(q: string): Prisma.PayrollExpenseWhereInput {
    const term = q.trim();
    if (!term) return {};
    return {
        OR: [
            { currency: { contains: term, mode: 'insensitive' } },
            { season: { name: { contains: term, mode: 'insensitive' } } },
            { planting: { cropPlan: { is: { name: { contains: term, mode: 'insensitive' } } } } },
        ],
    };
}

export class PayrollExpenseRepository {
    static buildWhere(
        ctx: RequestContext,
        filters?: PayrollExpenseFilters,
    ): Prisma.PayrollExpenseWhereInput {
        return {
            tenantId: ctx.tenantId,
            deletedAt: null,
            ...(filters?.seasonIds?.length ? { seasonId: { in: filters.seasonIds } } : {}),
            ...(filters?.plantingIds?.length ? { plantingId: { in: filters.plantingIds } } : {}),
            ...(filters?.q ? buildSearchWhere(filters.q) : {}),
        };
    }

    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters: PayrollExpenseFilters | undefined,
        take: number,
    ) {
        return db.payrollExpense.findMany({
            where: this.buildWhere(ctx, filters),
            orderBy: [{ incurredOn: 'desc' }, { createdAt: 'desc' }],
            select: PAYROLL_LIST_SELECT,
            take,
        });
    }

    static async count(db: PrismaTx, ctx: RequestContext, filters?: PayrollExpenseFilters) {
        return db.payrollExpense.count({ where: this.buildWhere(ctx, filters) });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.payrollExpense.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: PAYROLL_INCLUDE,
        });
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        data: Omit<Prisma.PayrollExpenseUncheckedCreateInput, 'tenantId'>,
    ) {
        return db.payrollExpense.create({
            data: { ...data, tenantId: ctx.tenantId },
            include: PAYROLL_INCLUDE,
        });
    }

    /**
     * `where: { id }` only — mirrors `AutomationRuleRepository.update` /
     * `YieldRecord`'s usecase-layer update. The tenant check is the
     * caller's job (the usecase runs `getById`, which IS tenant-filtered,
     * before calling this), so a foreign id never reaches here; RLS is
     * the hard backstop underneath both.
     */
    static async update(
        db: PrismaTx,
        _ctx: RequestContext,
        id: string,
        data: Prisma.PayrollExpenseUncheckedUpdateInput,
    ) {
        return db.payrollExpense.update({
            where: { id },
            data,
            include: PAYROLL_INCLUDE,
        });
    }

    /** Soft delete — PayrollExpense is not in SOFT_DELETE_MODELS. */
    static async softDelete(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.payrollExpense.update({
            where: { id },
            data: { deletedAt: new Date(), deletedByUserId: ctx.userId ?? null },
            select: { id: true },
        });
    }
}
