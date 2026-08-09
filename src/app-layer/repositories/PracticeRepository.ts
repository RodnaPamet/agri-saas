import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, PracticeStatus } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { traceRepository } from '@/lib/observability/repository-tracing';

export interface PracticeListFilters {
    // ARRAYS for the `multiple: true` facets. `toApiSearchParams`
    // comma-joins a multi-select into ONE param, so a scalar `string`
    // here let "IMPLEMENTED,PLANNED" reach Prisma as an enum equality —
    // a 500 the list page renders as its EMPTY state.
    status?: PracticeStatus[];
    applicability?: string;
    ownerUserId?: string[];
    q?: string;
    category?: string[];
}

export interface PracticeListParams {
    limit?: number;
    cursor?: string;
    filters?: PracticeListFilters;
}

// PR-3 — tight SELECT shape for the Practices list page. Lists exactly
// the columns PracticesClient.tsx renders (or filters on); switches off
// `include` so Prisma doesn't fetch the unused Practice scalars
// (long-text fields like description, frequency justifications, etc.).
const practiceListSelect = {
    id: true,
    code: true,
    name: true,
    description: true,
    status: true,
    applicability: true,
    // Framework-native category (SOC 2 TSC, NIS2 / ISO section, …).
    // The Browse rail's category grouping (`categorizePractice`) uses it
    // as the cross-framework fallback — ISO 27001 derives its granular
    // domain from the Annex clause instead.
    category: true,
    frequency: true,
    ownerUserId: true,
    // `createdAt` is required by the cursor-pagination helper
    // (`computePageInfo`) — it's not rendered in the table.
    createdAt: true,
    owner: { select: { id: true, name: true, email: true } },
    _count: { select: { practiceTasks: true, evidenceLinks: true } },
} as const;

export class PracticeRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters?: PracticeListFilters,
        options: { take?: number } = {},
    ) {
        return traceRepository('practice.list', ctx, async () => {
            const where = PracticeRepository._buildWhere(ctx, filters);

            return db.practice.findMany({
                where,
                orderBy: [{ code: 'asc' }],
                select: practiceListSelect,
                ...(options.take ? { take: options.take } : {}),
            });
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: PracticeListParams): Promise<PaginatedResponse<unknown>> {
        return traceRepository('practice.listPaginated', ctx, async () => {
            const limit = clampLimit(params.limit);
            const where = PracticeRepository._buildWhere(ctx, params.filters);

            // Apply cursor
            const cursorWhere = buildCursorWhere(params.cursor);
            if (cursorWhere) {
                where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), cursorWhere];
            }

            const items = await db.practice.findMany({
                where,
                orderBy: CURSOR_ORDER_BY,
                take: limit + 1,
                select: practiceListSelect,
            });

            const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
            return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
        });
    }

    private static _buildWhere(ctx: RequestContext, filters?: PracticeListFilters): Prisma.PracticeWhereInput {
        const where: Prisma.PracticeWhereInput = {
            OR: [{ tenantId: ctx.tenantId }, { tenantId: null }],
        };

        // Guarded on `.length`: a CLEARED facet must OMIT the filter, not
        // emit `{ in: [] }`, which matches nothing and would blank the table.
        if (filters?.status?.length) where.status = { in: filters.status };
        if (filters?.applicability && (filters.applicability === 'APPLICABLE' || filters.applicability === 'NOT_APPLICABLE')) {
            where.applicability = filters.applicability;
        }
        if (filters?.ownerUserId?.length) where.ownerUserId = { in: filters.ownerUserId };
        if (filters?.category?.length) where.category = { in: filters.category };
        if (filters?.q) {
            where.AND = [{
                OR: [
                    { name: { contains: filters.q, mode: 'insensitive' } },
                    { code: { contains: filters.q, mode: 'insensitive' } },
                    { description: { contains: filters.q, mode: 'insensitive' } },
                ],
            }];
        }

        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return traceRepository('practice.getById', ctx, async () => {
            // `policyLinks` and `_count` are deliberately omitted —
            // they were eager-loaded historically but no caller ever
            // reads them off the detail payload (the page computes badge
            // counts from `.length` on the kept arrays; TraceabilityPanel
            // runs its own fetch). `risks` and `contributors` are gone
            // outright: the risk register and PracticeContributor were
            // both dropped, and a stale `include` on a deleted relation
            // is a runtime PrismaClientValidationError, not a no-op.
            // The bigger tab-lazy refactor (drop practiceTasks /
            // evidenceLinks / evidence / frameworkMappings arrays in
            // favour of per-tab fetches) is bounded follow-up; safe
            // trim landed here cuts the unused subqueries today.
            return db.practice.findFirst({
                where: {
                    id,
                    OR: [{ tenantId: ctx.tenantId }, { tenantId: null }],
                },
                include: {
                    owner: { select: { id: true, name: true, email: true } },
                    createdBy: { select: { id: true, name: true, email: true } },
                    applicabilityDecidedBy: { select: { id: true, name: true, email: true } },
                    practiceTasks: { orderBy: { createdAt: 'desc' }, include: { assignee: { select: { id: true, name: true, email: true } } } },
                    evidenceLinks: { orderBy: { createdAt: 'desc' }, include: { createdBy: { select: { id: true, name: true } } } },
                    evidence: { where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' } },
                    frameworkMappings: { include: { fromRequirement: { include: { framework: { select: { name: true } } } } } },
                },
            });
        });
    }

    /**
     * Header-only practice fetch — the tab-lazy counterpart to
     * `getById` (#102 item 1).
     *
     * Loads practice scalars and the three lightweight user refs (all
     * read by the Overview tab + header), plus a `_count` for the four
     * tabbed relations so the tab badges render without their arrays. The heavy arrays themselves —
     * `practiceTasks` / `evidenceLinks` / `evidence` /
     * `frameworkMappings` — are deliberately NOT loaded; each tab
     * fetches its own slice on demand via its own endpoint.
     */
    static async getHeaderById(db: PrismaTx, ctx: RequestContext, id: string) {
        return traceRepository('practice.getHeaderById', ctx, async () => {
            return db.practice.findFirst({
                where: {
                    id,
                    OR: [{ tenantId: ctx.tenantId }, { tenantId: null }],
                },
                include: {
                    owner: { select: { id: true, name: true, email: true } },
                    createdBy: { select: { id: true, name: true, email: true } },
                    applicabilityDecidedBy: { select: { id: true, name: true, email: true } },
                    _count: {
                        select: {
                            practiceTasks: true,
                            evidenceLinks: true,
                            evidence: true,
                            frameworkMappings: true,
                        },
                    },
                },
            });
        });
    }

    /**
     * Framework mappings for one practice — the per-tab fetch that
     * replaces the eager `frameworkMappings` array on `getById`
     * (#102 item 1). Same `include` shape the page already renders.
     */
    static async listFrameworkMappings(db: PrismaTx, ctx: RequestContext, practiceId: string) {
        return db.frameworkMapping.findMany({
            where: { toPracticeId: practiceId, toPractice: { tenantId: ctx.tenantId } },
            include: { fromRequirement: { include: { framework: { select: { name: true } } } } },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.PracticeUncheckedCreateInput, 'tenantId'>) {
        return traceRepository('practice.create', ctx, async () => {
            return db.practice.create({
                data: {
                    ...data,
                    tenantId: ctx.tenantId,
                },
            });
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.PracticeUncheckedUpdateInput, 'tenantId'>) {
        const existing = await db.practice.findFirst({
            where: { id, tenantId: ctx.tenantId }
        });
        if (!existing) return null;

        return db.practice.update({
            where: { id },
            data,
        });
    }

    static async setApplicability(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        applicability: 'APPLICABLE' | 'NOT_APPLICABLE',
        justification: string | null
    ) {
        const existing = await db.practice.findFirst({
            where: { id, tenantId: ctx.tenantId },
        });
        if (!existing) return null;

        return db.practice.update({
            where: { id },
            data: {
                applicability,
                applicabilityJustification: applicability === 'NOT_APPLICABLE' ? justification : null,
                applicabilityDecidedByUserId: ctx.userId,
                applicabilityDecidedAt: new Date(),
            },
            include: {
                applicabilityDecidedBy: { select: { id: true, name: true, email: true } },
            },
        });
    }

    static async setOwner(db: PrismaTx, ctx: RequestContext, id: string, ownerUserId: string | null) {
        const existing = await db.practice.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;
        return db.practice.update({
            where: { id },
            data: { ownerUserId },
            include: { owner: { select: { id: true, name: true, email: true } } },
        });
    }

    // ─── Tasks ───

    static async listTasks(db: PrismaTx, ctx: RequestContext, practiceId: string) {
        return db.practiceTask.findMany({
            where: { practiceId, tenantId: ctx.tenantId },
            orderBy: { createdAt: 'asc' },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
    }

    static async createTask(db: PrismaTx, ctx: RequestContext, practiceId: string, data: { title: string; description?: string | null; assigneeUserId?: string | null; dueAt?: string | null }) {
        const practice = await db.practice.findFirst({ where: { id: practiceId, tenantId: ctx.tenantId } });
        if (!practice) return null;
        return db.practiceTask.create({
            data: {
                tenantId: ctx.tenantId,
                practiceId,
                title: data.title,
                description: data.description || null,
                assigneeUserId: data.assigneeUserId || null,
                dueAt: data.dueAt ? new Date(data.dueAt) : null,
            },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
    }

    static async updateTask(db: PrismaTx, ctx: RequestContext, taskId: string, data: { title?: string; description?: string | null; status?: string; assigneeUserId?: string | null; dueAt?: string | null }) {
        const task = await db.practiceTask.findFirst({ where: { id: taskId, tenantId: ctx.tenantId } });
        if (!task) return null;
        return db.practiceTask.update({
            where: { id: taskId },
            data: {
                ...(data.title !== undefined && { title: data.title }),
                ...(data.description !== undefined && { description: data.description }),
                ...(data.status !== undefined && { status: data.status as 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED' }),
                ...(data.assigneeUserId !== undefined && { assigneeUserId: data.assigneeUserId }),
                ...(data.dueAt !== undefined && { dueAt: data.dueAt ? new Date(data.dueAt) : null }),
            },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
    }

    static async deleteTask(db: PrismaTx, ctx: RequestContext, taskId: string) {
        const task = await db.practiceTask.findFirst({ where: { id: taskId, tenantId: ctx.tenantId } });
        if (!task) return null;
        await db.practiceTask.delete({ where: { id: taskId } });
        return true;
    }

    // ─── Evidence Links ───

    static async listEvidenceLinks(db: PrismaTx, ctx: RequestContext, practiceId: string) {
        return db.practiceEvidenceLink.findMany({
            where: { practiceId, tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            include: { createdBy: { select: { id: true, name: true } } },
        });
    }

    static async linkEvidence(db: PrismaTx, ctx: RequestContext, practiceId: string, data: { kind: string; fileId?: string | null; url?: string | null; note?: string | null }) {
        const practice = await db.practice.findFirst({ where: { id: practiceId, tenantId: ctx.tenantId } });
        if (!practice) return null;
        return db.practiceEvidenceLink.create({
            data: {
                tenantId: ctx.tenantId,
                practiceId,
                kind: data.kind as 'FILE' | 'LINK' | 'INTEGRATION_RESULT',
                fileId: data.fileId || null,
                url: data.url || null,
                note: data.note || null,
                createdByUserId: ctx.userId,
            },
            include: { createdBy: { select: { id: true, name: true } } },
        });
    }

    static async unlinkEvidence(db: PrismaTx, ctx: RequestContext, practiceId: string, linkId: string) {
        const link = await db.practiceEvidenceLink.findFirst({
            where: { id: linkId, practiceId, tenantId: ctx.tenantId },
        });
        if (!link) return null;
        await db.practiceEvidenceLink.delete({ where: { id: linkId } });
        return true;
    }

    // ─── Asset Linking ───

    static async linkAsset(db: PrismaTx, ctx: RequestContext, practiceId: string, assetId: string) {
        const practice = await db.practice.findFirst({
            where: { id: practiceId, tenantId: ctx.tenantId },
        });
        if (!practice) return null;
        return db.practiceAsset.create({
            data: { tenantId: ctx.tenantId, practiceId, assetId },
        });
    }

    static async unlinkAsset(db: PrismaTx, ctx: RequestContext, practiceId: string, assetId: string) {
        const practice = await db.practice.findFirst({
            where: { id: practiceId, tenantId: ctx.tenantId },
        });
        if (!practice) return null;
        const link = await db.practiceAsset.findFirst({
            where: { practiceId, assetId, tenantId: ctx.tenantId },
        });
        if (!link) return null;
        await db.practiceAsset.delete({ where: { id: link.id } });
        return true;
    }
}
