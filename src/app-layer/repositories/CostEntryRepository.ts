import { Prisma, type CostCategory } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

/**
 * CostEntry repository — the cost register behind `/grain/costs`
 * (enterprise-grain, GRAIN module). Tenant-scoped CRUD with explicit soft
 * delete via `deletedAt` / `deletedByUserId`, since CostEntry is not in
 * `SOFT_DELETE_MODELS`.
 *
 * Every method takes the caller's RLS-bound `PrismaTx` and re-asserts the
 * tenant filter in the `where` clause — defence in depth over RLS, per
 * CLAUDE.md's "Multi-Tenant Isolation" contract.
 *
 * EVERY read here is bounded. The D2 guardrail's unbounded-`findMany`
 * budget is 40 and the live count is exactly 40 — there is no headroom, so
 * an unbounded read added here fails CI on the first commit rather than
 * accumulating quietly.
 */

export interface CostEntryFilters {
    categories?: CostCategory[];
    plantingIds?: string[];
    seasonIds?: string[];
    locationIds?: string[];
    parcelIds?: string[];
    leaseIds?: string[];
    itemIds?: string[];
    /**
     * Free-text search over `supplier` + `currency`. Deliberately EXCLUDES
     * `description` — it is encrypted at rest (Epic B manifest), so a
     * `contains` over it would match ciphertext and never the farmer's
     * search term. `supplier` is searchable precisely BECAUSE it was left
     * out of that manifest; see the column's schema comment.
     */
    q?: string;
    /**
     * Inclusive `incurredOn` window, both bounds optional. The route builds
     * it with `parseDateRangeParam`, which anchors both ends in UTC and
     * widens `to` to end-of-day — `incurredOn` is a DateTime, so a
     * same-day window whose upper bound was left at midnight would match
     * nothing at all.
     */
    incurredFrom?: Date;
    incurredTo?: Date;
}

/** Relations every read needs for display. */
const COST_INCLUDE = {
    planting: {
        select: { id: true, successionNumber: true, cropPlan: { select: { name: true } } },
    },
    season: { select: { id: true, name: true } },
    location: { select: { id: true, name: true } },
    parcel: { select: { id: true, name: true } },
    item: { select: { id: true, name: true, category: true } },
    invoiceFile: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true } },
} satisfies Prisma.CostEntryInclude;

/**
 * The LIST projection — every scalar EXCEPT `description`.
 *
 * An explicit allowlist rather than an omit, mirroring
 * `PAYROLL_LIST_SELECT`: a column added later should default to NOT being
 * broadcast. `description` is commercial free text, encrypted at rest, and
 * its only renderer is the write-gated edit form — broadcasting it on the
 * list would decrypt it into every reader's RSC payload, including READERs
 * who can never open that form.
 */
const COST_LIST_SELECT = {
    id: true,
    category: true,
    amount: true,
    currency: true,
    incurredOn: true,
    supplier: true,
    invoiceFileId: true,
    plantingId: true,
    seasonId: true,
    locationId: true,
    parcelId: true,
    leaseId: true,
    itemId: true,
    createdByUserId: true,
    createdAt: true,
    updatedAt: true,
    ...COST_INCLUDE,
} satisfies Prisma.CostEntrySelect;

function buildSearchWhere(q: string): Prisma.CostEntryWhereInput {
    const term = q.trim();
    if (!term) return {};
    return {
        OR: [
            { supplier: { contains: term, mode: 'insensitive' } },
            { currency: { contains: term, mode: 'insensitive' } },
        ],
    };
}

export class CostEntryRepository {
    static buildWhere(ctx: RequestContext, filters?: CostEntryFilters): Prisma.CostEntryWhereInput {
        return {
            tenantId: ctx.tenantId,
            deletedAt: null,
            ...(filters?.categories?.length ? { category: { in: filters.categories } } : {}),
            ...(filters?.plantingIds?.length ? { plantingId: { in: filters.plantingIds } } : {}),
            ...(filters?.seasonIds?.length ? { seasonId: { in: filters.seasonIds } } : {}),
            ...(filters?.locationIds?.length ? { locationId: { in: filters.locationIds } } : {}),
            ...(filters?.parcelIds?.length ? { parcelId: { in: filters.parcelIds } } : {}),
            ...(filters?.leaseIds?.length ? { leaseId: { in: filters.leaseIds } } : {}),
            ...(filters?.itemIds?.length ? { itemId: { in: filters.itemIds } } : {}),
            // Guarded on having a bound: `{ incurredOn: {} }` is legal Prisma
            // and matches everything, but it makes a cleared facet look like
            // an applied one in a logged query.
            ...(filters?.incurredFrom || filters?.incurredTo
                ? {
                      incurredOn: {
                          ...(filters.incurredFrom ? { gte: filters.incurredFrom } : {}),
                          ...(filters.incurredTo ? { lte: filters.incurredTo } : {}),
                      },
                  }
                : {}),
            ...(filters?.q ? buildSearchWhere(filters.q) : {}),
        };
    }

    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters: CostEntryFilters | undefined,
        take: number,
    ) {
        return db.costEntry.findMany({
            where: this.buildWhere(ctx, filters),
            // `id` breaks the tie: `incurredOn` is a DATE, so a day with
            // several entries has no total order without it, and a capped
            // read would return a different subset on each refresh.
            orderBy: [{ incurredOn: 'desc' }, { id: 'desc' }],
            select: COST_LIST_SELECT,
            take,
        });
    }

    static async count(db: PrismaTx, ctx: RequestContext, filters?: CostEntryFilters) {
        return db.costEntry.count({ where: this.buildWhere(ctx, filters) });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.costEntry.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: COST_INCLUDE,
        });
    }

    /**
     * Every entry in a set of categories, for the calculator's cost and
     * cash-out figures. ONE batched read — the caller reduces in memory.
     */
    static async listByCategories(
        db: PrismaTx,
        ctx: RequestContext,
        categories: readonly CostCategory[],
        take: number,
    ) {
        if (categories.length === 0) return [];
        return db.costEntry.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                category: { in: [...categories] },
            },
            orderBy: [{ id: 'asc' }],
            select: {
                id: true,
                category: true,
                amount: true,
                currency: true,
                plantingId: true,
                seasonId: true,
            },
            take,
        });
    }

    /**
     * Entries linked to a SET of domain ids, in ONE read.
     *
     * This is the shape every domain page uses — rent on the lease
     * surface, input costs on the product surface. The alternative, a read
     * per row, is what D1 bans: a lease list of 200 would issue 200
     * queries. The caller builds an in-memory map from the result.
     */
    static async listByDomainIds(
        db: PrismaTx,
        ctx: RequestContext,
        link: 'plantingId' | 'seasonId' | 'locationId' | 'parcelId' | 'leaseId' | 'itemId',
        ids: readonly string[],
        take: number,
    ) {
        if (ids.length === 0) return [];
        return db.costEntry.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                [link]: { in: [...ids] },
            },
            orderBy: [{ incurredOn: 'desc' }, { id: 'desc' }],
            select: {
                id: true,
                category: true,
                amount: true,
                currency: true,
                incurredOn: true,
                supplier: true,
                invoiceFileId: true,
                plantingId: true,
                seasonId: true,
                locationId: true,
                parcelId: true,
                leaseId: true,
                itemId: true,
            },
            take,
        });
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        data: Omit<Prisma.CostEntryUncheckedCreateInput, 'tenantId'>,
    ) {
        return db.costEntry.create({
            data: { ...data, tenantId: ctx.tenantId },
            include: COST_INCLUDE,
        });
    }

    /**
     * `where: { id }` only. The tenant check is the caller's job (the usecase runs `getById`, which
     * IS tenant-filtered, before calling this), so a foreign id never
     * reaches here; RLS is the hard backstop underneath both.
     */
    static async update(
        db: PrismaTx,
        _ctx: RequestContext,
        id: string,
        data: Prisma.CostEntryUncheckedUpdateInput,
    ) {
        return db.costEntry.update({ where: { id }, data, include: COST_INCLUDE });
    }

    /** Soft delete — CostEntry is not in SOFT_DELETE_MODELS. */
    static async softDelete(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.costEntry.update({
            where: { id },
            data: { deletedAt: new Date(), deletedByUserId: ctx.userId ?? null },
            select: { id: true },
        });
    }
}
