import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { traceRepository } from '@/lib/observability/repository-tracing';

export interface ControlListFilters {
    status?: string;
    applicability?: string;
    ownerUserId?: string;
    q?: string;
    category?: string;
}

export interface ControlListParams {
    limit?: number;
    cursor?: string;
    filters?: ControlListFilters;
}

// PR-3 — tight SELECT shape for the Controls list page. Lists exactly
// the columns ControlsClient.tsx renders (or filters on); switches off
// `include` so Prisma doesn't fetch the unused Control scalars
// (long-text fields like description, frequency justifications, etc.).
const controlListSelect = {
    id: true,
    code: true,
    name: true,
    description: true,
    status: true,
    applicability: true,
    // Framework-native category (SOC 2 TSC, NIS2 / ISO section, …).
    // The Browse rail's category grouping (`categorizeControl`) uses it
    // as the cross-framework fallback — ISO 27001 derives its granular
    // domain from the Annex clause instead.
    category: true,
    frequency: true,
    ownerUserId: true,
    // `createdAt` is required by the cursor-pagination helper
    // (`computePageInfo`) — it's not rendered in the table.
    createdAt: true,
    owner: { select: { id: true, name: true, email: true } },
    _count: { select: { controlTasks: true, evidenceLinks: true } },
} as const;

export class ControlRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters?: ControlListFilters,
        options: { take?: number } = {},
    ) {
        return traceRepository('control.list', ctx, async () => {
            const where = ControlRepository._buildWhere(ctx, filters);

            return db.control.findMany({
                where,
                orderBy: [{ code: 'asc' }],
                select: controlListSelect,
                ...(options.take ? { take: options.take } : {}),
            });
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: ControlListParams): Promise<PaginatedResponse<unknown>> {
        return traceRepository('control.listPaginated', ctx, async () => {
            const limit = clampLimit(params.limit);
            const where = ControlRepository._buildWhere(ctx, params.filters);

            // Apply cursor
            const cursorWhere = buildCursorWhere(params.cursor);
            if (cursorWhere) {
                where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), cursorWhere];
            }

            const items = await db.control.findMany({
                where,
                orderBy: CURSOR_ORDER_BY,
                take: limit + 1,
                select: controlListSelect,
            });

            const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
            return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
        });
    }

    private static _buildWhere(ctx: RequestContext, filters?: ControlListFilters): Prisma.ControlWhereInput {
        const where: Prisma.ControlWhereInput = {
            OR: [{ tenantId: ctx.tenantId }, { tenantId: null }],
        };

        if (filters?.status) where.status = filters.status as Prisma.EnumControlStatusFilter;
        if (filters?.applicability && (filters.applicability === 'APPLICABLE' || filters.applicability === 'NOT_APPLICABLE')) {
            where.applicability = filters.applicability;
        }
        if (filters?.ownerUserId) where.ownerUserId = filters.ownerUserId;
        if (filters?.category) where.category = filters.category;
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
        return traceRepository('control.getById', ctx, async () => {
            // `policyLinks` and `_count` are deliberately omitted —
            // they were eager-loaded historically but no caller ever
            // reads them off the detail payload (the page computes badge
            // counts from `.length` on the kept arrays; TraceabilityPanel
            // runs its own fetch). `risks` and `contributors` are gone
            // outright: the risk register and ControlContributor were
            // both dropped, and a stale `include` on a deleted relation
            // is a runtime PrismaClientValidationError, not a no-op.
            // The bigger tab-lazy refactor (drop controlTasks /
            // evidenceLinks / evidence / frameworkMappings arrays in
            // favour of per-tab fetches) is bounded follow-up; safe
            // trim landed here cuts the unused subqueries today.
            return db.control.findFirst({
                where: {
                    id,
                    OR: [{ tenantId: ctx.tenantId }, { tenantId: null }],
                },
                include: {
                    owner: { select: { id: true, name: true, email: true } },
                    createdBy: { select: { id: true, name: true, email: true } },
                    applicabilityDecidedBy: { select: { id: true, name: true, email: true } },
                    controlTasks: { orderBy: { createdAt: 'desc' }, include: { assignee: { select: { id: true, name: true, email: true } } } },
                    evidenceLinks: { orderBy: { createdAt: 'desc' }, include: { createdBy: { select: { id: true, name: true } } } },
                    evidence: { where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' } },
                    frameworkMappings: { include: { fromRequirement: { include: { framework: { select: { name: true } } } } } },
                },
            });
        });
    }

    /**
     * Header-only control fetch — the tab-lazy counterpart to
     * `getById` (#102 item 1).
     *
     * Loads control scalars and the three lightweight user refs (all
     * read by the Overview tab + header), plus a `_count` for the four
     * tabbed relations so the tab badges render without their arrays. The heavy arrays themselves —
     * `controlTasks` / `evidenceLinks` / `evidence` /
     * `frameworkMappings` — are deliberately NOT loaded; each tab
     * fetches its own slice on demand via its own endpoint.
     */
    static async getHeaderById(db: PrismaTx, ctx: RequestContext, id: string) {
        return traceRepository('control.getHeaderById', ctx, async () => {
            return db.control.findFirst({
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
                            controlTasks: true,
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
     * Framework mappings for one control — the per-tab fetch that
     * replaces the eager `frameworkMappings` array on `getById`
     * (#102 item 1). Same `include` shape the page already renders.
     */
    static async listFrameworkMappings(db: PrismaTx, ctx: RequestContext, controlId: string) {
        return db.frameworkMapping.findMany({
            where: { toControlId: controlId, toControl: { tenantId: ctx.tenantId } },
            include: { fromRequirement: { include: { framework: { select: { name: true } } } } },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.ControlUncheckedCreateInput, 'tenantId'>) {
        return traceRepository('control.create', ctx, async () => {
            return db.control.create({
                data: {
                    ...data,
                    tenantId: ctx.tenantId,
                },
            });
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.ControlUncheckedUpdateInput, 'tenantId'>) {
        const existing = await db.control.findFirst({
            where: { id, tenantId: ctx.tenantId }
        });
        if (!existing) return null;

        return db.control.update({
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
        const existing = await db.control.findFirst({
            where: { id, tenantId: ctx.tenantId },
        });
        if (!existing) return null;

        return db.control.update({
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
        const existing = await db.control.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;
        return db.control.update({
            where: { id },
            data: { ownerUserId },
            include: { owner: { select: { id: true, name: true, email: true } } },
        });
    }

    // ─── Tasks ───

    static async listTasks(db: PrismaTx, ctx: RequestContext, controlId: string) {
        return db.controlTask.findMany({
            where: { controlId, tenantId: ctx.tenantId },
            orderBy: { createdAt: 'asc' },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
    }

    static async createTask(db: PrismaTx, ctx: RequestContext, controlId: string, data: { title: string; description?: string | null; assigneeUserId?: string | null; dueAt?: string | null }) {
        const control = await db.control.findFirst({ where: { id: controlId, tenantId: ctx.tenantId } });
        if (!control) return null;
        return db.controlTask.create({
            data: {
                tenantId: ctx.tenantId,
                controlId,
                title: data.title,
                description: data.description || null,
                assigneeUserId: data.assigneeUserId || null,
                dueAt: data.dueAt ? new Date(data.dueAt) : null,
            },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
    }

    static async updateTask(db: PrismaTx, ctx: RequestContext, taskId: string, data: { title?: string; description?: string | null; status?: string; assigneeUserId?: string | null; dueAt?: string | null }) {
        const task = await db.controlTask.findFirst({ where: { id: taskId, tenantId: ctx.tenantId } });
        if (!task) return null;
        return db.controlTask.update({
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
        const task = await db.controlTask.findFirst({ where: { id: taskId, tenantId: ctx.tenantId } });
        if (!task) return null;
        await db.controlTask.delete({ where: { id: taskId } });
        return true;
    }

    // ─── Evidence Links ───

    static async listEvidenceLinks(db: PrismaTx, ctx: RequestContext, controlId: string) {
        return db.controlEvidenceLink.findMany({
            where: { controlId, tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            include: { createdBy: { select: { id: true, name: true } } },
        });
    }

    static async linkEvidence(db: PrismaTx, ctx: RequestContext, controlId: string, data: { kind: string; fileId?: string | null; url?: string | null; note?: string | null }) {
        const control = await db.control.findFirst({ where: { id: controlId, tenantId: ctx.tenantId } });
        if (!control) return null;
        return db.controlEvidenceLink.create({
            data: {
                tenantId: ctx.tenantId,
                controlId,
                kind: data.kind as 'FILE' | 'LINK' | 'INTEGRATION_RESULT',
                fileId: data.fileId || null,
                url: data.url || null,
                note: data.note || null,
                createdByUserId: ctx.userId,
            },
            include: { createdBy: { select: { id: true, name: true } } },
        });
    }

    static async unlinkEvidence(db: PrismaTx, ctx: RequestContext, controlId: string, linkId: string) {
        const link = await db.controlEvidenceLink.findFirst({
            where: { id: linkId, controlId, tenantId: ctx.tenantId },
        });
        if (!link) return null;
        await db.controlEvidenceLink.delete({ where: { id: linkId } });
        return true;
    }

    // ─── Asset Linking ───

    static async linkAsset(db: PrismaTx, ctx: RequestContext, controlId: string, assetId: string) {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
        });
        if (!control) return null;
        return db.controlAsset.create({
            data: { tenantId: ctx.tenantId, controlId, assetId },
        });
    }

    static async unlinkAsset(db: PrismaTx, ctx: RequestContext, controlId: string, assetId: string) {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
        });
        if (!control) return null;
        const link = await db.controlAsset.findFirst({
            where: { controlId, assetId, tenantId: ctx.tenantId },
        });
        if (!link) return null;
        await db.controlAsset.delete({ where: { id: link.id } });
        return true;
    }
}
