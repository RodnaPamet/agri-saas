import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, RiskStatus } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { traceRepository } from '@/lib/observability/repository-tracing';

export interface RiskFilters {
    // ARRAYS for the multiple:true facets — see the note in
    // AssetRepository.AssetFilters; a scalar 500s the list.
    status?: RiskStatus[];
    scoreMin?: number;
    scoreMax?: number;
    category?: string[];
    ownerUserId?: string[];
    q?: string;
}

export interface RiskListParams {
    limit?: number;
    cursor?: string;
    filters?: RiskFilters;
}

// PR-3 — tight SELECT shape for the Risks list page. Lists exactly the
// columns RisksClient.tsx renders. The previous `include: { controls }`
// returned all Risk scalars (incl. long-text `description`, `mitigation`,
// `treatmentNotes` cipher blob, etc.); the page only uses the metadata
// + scoring fields enumerated below.
const riskListSelect = {
    id: true,
    // PR-B — RSK-N short identifier surfaced as the Code column.
    key: true,
    title: true,
    threat: true,
    likelihood: true,
    impact: true,
    inherentScore: true,
    score: true,
    status: true,
    treatment: true,
    treatmentOwner: true,
    nextReviewAt: true,
    category: true,
    ownerUserId: true,
    // RQ2-5 — quant inputs for the list-side ALE chip + the matrix
    // ALE heat overlay (`resolveALE` runs client-side on these).
    sleAmount: true,
    aroAmount: true,
    fairAle: true,
    // RQ2-9 — decomposed residual dims power the matrix movement
    // view (inherent → residual arrows). Null for legacy rows.
    residualLikelihood: true,
    residualImpact: true,
    residualScore: true,
    // `createdAt` is required by the cursor-pagination helper
    // (`computePageInfo`) — it's not rendered in the table.
    createdAt: true,
    controls: {
        select: {
            id: true,
            control: { select: { id: true, name: true, annexId: true, status: true } },
        },
    },
} as const;

export class RiskRepository {
    /**
     * List risks scoped to tenant (unpaginated — backward compat).
     */
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters: RiskFilters = {},
        options: { take?: number } = {},
    ) {
        return traceRepository('risk.list', ctx, async () => {
            const where = RiskRepository._buildWhere(ctx, filters);
            return db.risk.findMany({
                where,
                orderBy: { inherentScore: 'desc' },
                select: riskListSelect,
                ...(options.take ? { take: options.take } : {}),
            });
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: RiskListParams): Promise<PaginatedResponse<unknown>> {
        return traceRepository('risk.listPaginated', ctx, async () => {
            const limit = clampLimit(params.limit);
            const where = RiskRepository._buildWhere(ctx, params.filters);

            const cursorWhere = buildCursorWhere(params.cursor);
            if (cursorWhere) {
                where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), cursorWhere as Prisma.RiskWhereInput];
            }

            const items = await db.risk.findMany({
                where,
                orderBy: CURSOR_ORDER_BY,
                take: limit + 1,
                select: riskListSelect,
            });

            const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
            return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
        });
    }

    private static _buildWhere(ctx: RequestContext, filters: RiskFilters = {}): Prisma.RiskWhereInput {
        const where: Prisma.RiskWhereInput = { tenantId: ctx.tenantId };

        // Guarded on `.length`: a CLEARED facet must OMIT the filter — `{ in: [] }`
        // matches nothing and would blank the table.
        if (filters.status?.length) where.status = { in: filters.status };
        if (filters.scoreMin !== undefined || filters.scoreMax !== undefined) {
            where.score = {};
            if (filters.scoreMin !== undefined) where.score.gte = filters.scoreMin;
            if (filters.scoreMax !== undefined) where.score.lte = filters.scoreMax;
        }
        if (filters.category?.length) where.category = { in: filters.category };
        if (filters.ownerUserId?.length) where.ownerUserId = { in: filters.ownerUserId };
        if (filters.q) {
            where.OR = [
                { title: { contains: filters.q, mode: 'insensitive' } },
                { description: { contains: filters.q, mode: 'insensitive' } },
                { category: { contains: filters.q, mode: 'insensitive' } },
            ];
        }

        return where;
    }

    /**
     * Get a single risk by ID, scoped to tenant.
     */
    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return traceRepository('risk.getById', ctx, async () => {
            return db.risk.findFirst({
                where: { id, tenantId: ctx.tenantId },
                include: {
                    controls: { include: { control: true } },
                },
            });
        });
    }

    /**
     * Create a risk scoped to tenant.
     */
    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.RiskUncheckedCreateInput, 'tenantId'>) {
        return traceRepository('risk.create', ctx, async () => {
            // PR-B — mint a per-tenant `RSK-N` key from an atomic
            // counter. Mirrors `WorkItemRepository.create` / the
            // `TaskKeySequence` pattern: the upsert compiles to a
            // native `INSERT … ON CONFLICT DO UPDATE`, so the
            // increment is race-free under concurrent imports.
            // Callers that supply their own `key` (the migration
            // backfill path) win — we only mint when none is set.
            let key = (data as { key?: string | null }).key ?? null;
            if (!key) {
                const seq = await db.riskKeySequence.upsert({
                    where: { tenantId: ctx.tenantId },
                    create: { tenantId: ctx.tenantId, lastValue: 1 },
                    update: { lastValue: { increment: 1 } },
                });
                key = `RSK-${seq.lastValue}`;
            }
            return db.risk.create({
                data: {
                    ...data,
                    key,
                    tenantId: ctx.tenantId,
                },
            });
        });
    }

    /**
     * Update a risk, enforcing tenant ownership.
     */
    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.RiskUncheckedUpdateInput, 'tenantId'>) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return null;

        return db.risk.update({
            where: { id },
            data,
        });
    }

    /**
     * Delete a risk, enforcing tenant ownership.
     */
    static async delete(db: PrismaTx, ctx: RequestContext, id: string) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return false;

        await db.risk.delete({ where: { id } });
        return true;
    }

    /**
     * Link a control to a risk.
     */
    static async linkControl(db: PrismaTx, ctx: RequestContext, riskId: string, controlId: string) {
        const existing = await this.getById(db, ctx, riskId);
        if (!existing) return null;

        return db.riskControl.create({
            data: { tenantId: ctx.tenantId, riskId, controlId },
        });
    }

    /**
     * Unlink a control from a risk.
     */
    static async unlinkControl(db: PrismaTx, ctx: RequestContext, riskId: string, controlId: string) {
        const existing = await this.getById(db, ctx, riskId);
        if (!existing) return null;

        const link = await db.riskControl.findFirst({
            where: { riskId, controlId, tenantId: ctx.tenantId },
        });
        if (!link) return null;

        await db.riskControl.delete({ where: { id: link.id } });
        return true;
    }
}
