import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, AssetType, AssetStatus, Criticality } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { MACHINE_ASSET_WHERE } from '@/lib/agriculture/machine-asset-types';

export interface AssetFilters {
    // ARRAYS, not `string` plus a cast. These facets are `multiple: true`
    // in filter-defs, so the route hands over every selected member; the
    // old scalar-plus-cast shape is what let "TRACTOR,HARVESTER" reach
    // Prisma as an enum equality and 500 the list.
    type?: AssetType[];
    status?: AssetStatus[];
    criticality?: Criticality[];
    q?: string;
}

/**
 * Hard ceiling on the flat (non-cursor) asset list.
 *
 * The read was unbounded, so a tenant with thousands of machines shipped
 * every row on every page load. Bounding it is only SAFE because the KPI
 * cards no longer count the loaded rows — they come from
 * `kpiCounts` over the whole filtered set, so capping the list can no
 * longer make "Total" lie. The client compares `rows.length` against
 * that total to tell the user when it is seeing a subset.
 */
export const ASSET_LIST_CAP = 1000;

export interface AssetListParams {
    limit?: number;
    cursor?: string;
    filters?: AssetFilters;
}

export class AssetRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters?: AssetFilters,
        options: { take?: number } = {},
    ) {
        const where = AssetRepository._buildWhere(ctx, filters);
        return db.asset.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: options.take ?? ASSET_LIST_CAP,
            include: {
                _count: { select: { controls: true } },
                // B4 — resolve the structured assignee so the list Owner
                // column can prefer the assigned user's name over the
                // free-text keeper.
                ownerUser: { select: { id: true, name: true, email: true } },
            },
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: AssetListParams): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where = AssetRepository._buildWhere(ctx, params.filters);

        const cursorWhere = buildCursorWhere(params.cursor);
        if (cursorWhere) {
            if (where.AND) {
                (where.AND as Prisma.AssetWhereInput[]).push(cursorWhere as Prisma.AssetWhereInput);
            } else {
                where.AND = [cursorWhere as Prisma.AssetWhereInput];
            }
        }

        const items = await db.asset.findMany({
            where,
            orderBy: CURSOR_ORDER_BY,
            take: limit + 1,
            include: { _count: { select: { controls: true } } },
        });

        const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
        return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
    }

    private static _buildWhere(ctx: RequestContext, filters?: AssetFilters): Prisma.AssetWhereInput {
        const where: Prisma.AssetWhereInput = { tenantId: ctx.tenantId };

        // Guarded on `.length`: a CLEARED facet must OMIT the filter, not
        // emit `{ in: [] }` — which matches nothing and would blank the
        // table exactly when the user asked to see everything.
        if (filters?.type?.length) where.type = { in: filters.type };
        if (filters?.status?.length) where.status = { in: filters.status };
        if (filters?.criticality?.length) where.criticality = { in: filters.criticality };
        if (filters?.q) {
            where.OR = [
                { name: { contains: filters.q, mode: 'insensitive' } },
                { manufacturer: { contains: filters.q, mode: 'insensitive' } },
                { model: { contains: filters.q, mode: 'insensitive' } },
                { serialNumber: { contains: filters.q, mode: 'insensitive' } },
                { owner: { contains: filters.q, mode: 'insensitive' } },
            ];
        }

        return where;
    }

    /**
     * One asset.
     *
     * `withControls` is OFF by default. The compliance control mapping
     * used to be eagerly joined on EVERY read — including plain-farm
     * tenants where the compliance tabs are gated off entirely, and
     * including `update()`/`delete()`, which call this purely to check
     * the row exists. Only the callers that actually render the
     * Mappings tab ask for it.
     */
    static async getById(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        options: { withControls?: boolean } = {},
    ) {
        return db.asset.findFirst({
            where: { id, tenantId: ctx.tenantId },
            ...(options.withControls
                ? { include: { controls: { include: { control: true } } } }
                : {}),
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.AssetUncheckedCreateInput, 'tenantId'>) {
        // Mint a per-tenant `AST-N` key from an atomic counter.
        // Mirrors `RiskRepository.create` / the TaskKeySequence
        // pattern — the upsert compiles to a native
        // `INSERT … ON CONFLICT DO UPDATE`, race-free under
        // concurrent imports. Callers that supply their own `key`
        // (the migration backfill path / future imports) win — we
        // only mint when none is set.
        let key = (data as { key?: string | null }).key ?? null;
        if (!key) {
            const seq = await db.assetKeySequence.upsert({
                where: { tenantId: ctx.tenantId },
                create: { tenantId: ctx.tenantId, lastValue: 1 },
                update: { lastValue: { increment: 1 } },
            });
            key = `AST-${seq.lastValue}`;
        }
        return db.asset.create({
            data: {
                ...data,
                key,
                tenantId: ctx.tenantId,
            },
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.AssetUncheckedUpdateInput, 'tenantId'>) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return null;

        return db.asset.update({
            where: { id },
            data,
        });
    }

    static async delete(db: PrismaTx, ctx: RequestContext, id: string) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return false;

        await db.asset.delete({ where: { id } });
        return true;
    }

    /**
     * KPI counts for the /assets header cards, computed IN THE DATABASE
     * over the whole filtered set.
     *
     * The client derived these from the loaded rows, which is correct
     * only while the list is unbounded. The moment it pages, "Total"
     * silently becomes "total on this page" — a wrong number that looks
     * like a right one. Counting server-side is what makes bounding the
     * list safe.
     *
     * The status/criticality cards are a BREAKDOWN of the current set, so
     * each ignores its OWN facet: with status=ACTIVE selected, a Retired
     * card reading 0 would imply the farm has no retired machines. Every
     * other filter still applies.
     */
    static async kpiCounts(db: PrismaTx, ctx: RequestContext, filters?: AssetFilters) {
        const where = AssetRepository._buildWhere(ctx, filters);
        const { status: _status, criticality: _criticality, ...rest } = where;
        const byStatus = { ...rest, ...(where.criticality ? { criticality: where.criticality } : {}) };
        const byCriticality = { ...rest, ...(where.status ? { status: where.status } : {}) };
        const [total, active, critical, retired] = await Promise.all([
            db.asset.count({ where }),
            db.asset.count({ where: { ...byStatus, status: 'ACTIVE' } }),
            db.asset.count({ where: { ...byCriticality, criticality: 'HIGH' } }),
            db.asset.count({ where: { ...byStatus, status: 'RETIRED' } }),
        ]);
        return { total, active, critical, retired };
    }

    // ─── Machine register (the retired `Equipment` model's job) ───────
    //
    // `Equipment` was merged into `Asset`; these two reads are what the
    // journal-modal and farm-task equipment pickers resolve through.
    // The projected shape is deliberately the OLD equipment row shape
    // (`category` / `make`) so `/api/t/:slug/equipment` keeps its
    // contract and neither picker needed a client change — the rows are
    // simply no longer empty. `type` maps to `category`, `manufacturer`
    // to `make`.

    /**
     * The tenant's machine-shaped, non-retired assets for a picker.
     * Bounded by `take` — pickers are a bounded surface, not a report.
     */
    static async listMachines(db: PrismaTx, ctx: RequestContext, take = 200) {
        const rows = await db.asset.findMany({
            where: { tenantId: ctx.tenantId, ...MACHINE_ASSET_WHERE },
            select: { id: true, name: true, type: true, manufacturer: true, model: true },
            orderBy: [{ createdAt: 'desc' }],
            take,
        });
        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            category: r.type as string,
            make: r.manufacturer,
            model: r.model,
        }));
    }

    /**
     * The subset of `ids` that are machine-shaped assets in this tenant.
     * Used to validate `equipmentIds` before writing link rows, so a
     * caller cannot attach a barn — or another tenant's tractor — to a
     * journal entry.
     */
    static async validMachineIds(db: PrismaTx, ctx: RequestContext, ids: string[]): Promise<Set<string>> {
        if (!ids.length) return new Set();
        // Bounded by the caller's id set (the Zod schemas cap it at 100).
        const rows = await db.asset.findMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId, ...MACHINE_ASSET_WHERE },
            select: { id: true },
            take: ids.length,
        });
        return new Set(rows.map((r) => r.id));
    }
}
