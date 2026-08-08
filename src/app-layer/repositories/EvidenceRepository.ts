import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, type EvidenceType, type EvidenceStatus } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { traceRepository } from '@/lib/observability/repository-tracing';

export interface EvidenceListFilters {
    /**
     * Multi-select facets, so ARRAYS — not `string` plus a cast.
     *
     * These were typed `string` and cast to a Prisma enum filter at the
     * where-builder. That cast is what let a comma-joined "FILE,LINK" through
     * to the query, where it matched nothing and the page reported an empty
     * library. The array type makes the shape the URL actually carries
     * impossible to get wrong at the boundary.
     */
    type?: EvidenceType[];
    /** EvidenceStatus: DRAFT | SUBMITTED | APPROVED | REJECTED */
    status?: EvidenceStatus[];
    controlId?: string;
    /**
     * B8 follow-up — folder filter. `__none__` is the sentinel for
     * "evidence with NULL or empty folder"; any other value is an
     * exact-match. Omitted ⇒ no filter.
     */
    folder?: string;
    q?: string;
    archived?: boolean;
    expiring?: boolean;
}

export interface EvidenceListParams {
    limit?: number;
    cursor?: string;
    filters?: EvidenceListFilters;
}

// PR-3 — tight SELECT shape for the Evidence list page. Lists exactly
// the columns EvidenceClient.tsx renders. The previous `include`
// returned every Evidence scalar (encrypted-at-rest `data` blob,
// `summary`, `transcript`, etc.) — none rendered in list view.
const evidenceListSelect = {
    id: true,
    title: true,
    fileName: true,
    type: true,
    status: true,
    owner: true,
    // Real owner FK — seeds the edit modal's owner picker when the
    // Evidence list-row edit affordance opens it (B8 follow-up parity
    // with the detail sheet's edit).
    ownerUserId: true,
    // B8 follow-up — folder label is rendered as a column + drives
    // the Folder filter's option set.
    folder: true,
    isArchived: true,
    expiredAt: true,
    deletedAt: true,
    retentionUntil: true,
    updatedAt: true,
    dateCollected: true,
    fileRecordId: true,
    // `content` holds the URL for LINK evidence — including the deep link
    // back to the journal entry that auto-evidence was derived from. It was
    // never selected, so that link existed in the database and was
    // unreachable from every list surface, and the list-row edit affordance
    // seeded its description field from `ev.content` and therefore always
    // opened empty.
    content: true,
    // Distinguishes AUTO_FARM_RECORD rows from hand-filed evidence.
    category: true,
    // The FK the deep link is built FROM. Deriving the href from the
    // relation rather than parsing the stored `content` string means a row
    // written before the tenant slug changed still resolves.
    sourceLogEntryId: true,
    // `createdAt` is required by the cursor-pagination helper
    // (`computePageInfo`) — it's not rendered in the table.
    createdAt: true,
    control: { select: { id: true, name: true, code: true } },
    fileRecord: { select: { id: true, mimeType: true } },
} as const;

export class EvidenceRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters?: EvidenceListFilters,
        options: { take?: number } = {},
    ) {
        return traceRepository('evidence.list', ctx, async () => {
            const where = EvidenceRepository._buildWhere(ctx, filters);
            return db.evidence.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                select: evidenceListSelect,
                ...(options.take ? { take: options.take } : {}),
            });
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: EvidenceListParams): Promise<PaginatedResponse<unknown>> {
        return traceRepository('evidence.listPaginated', ctx, async () => {
            const limit = clampLimit(params.limit);
            const where = EvidenceRepository._buildWhere(ctx, params.filters);

            // Apply cursor
            const cursorWhere = buildCursorWhere(params.cursor);
            if (cursorWhere) {
                if (where.AND) {
                    (where.AND as Prisma.EvidenceWhereInput[]).push(cursorWhere as Prisma.EvidenceWhereInput);
                } else {
                    where.AND = [cursorWhere as Prisma.EvidenceWhereInput];
                }
            }

            const items = await db.evidence.findMany({
                where,
                orderBy: CURSOR_ORDER_BY,
                take: limit + 1,
                select: evidenceListSelect,
            });

            const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
            return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
        });
    }

    private static _buildWhere(ctx: RequestContext, filters?: EvidenceListFilters): Prisma.EvidenceWhereInput {
        const where: Prisma.EvidenceWhereInput = { tenantId: ctx.tenantId };
        const andConditions: Prisma.EvidenceWhereInput[] = [];

        // `.length` guards are load-bearing: a CLEARED facet must OMIT the
        // filter, not emit `{ in: [] }`, which matches nothing and empties the
        // table in response to the user removing a filter.
        if (filters?.type && filters.type.length > 0) {
            where.type = { in: filters.type };
        }
        if (filters?.status && filters.status.length > 0) {
            where.status = { in: filters.status };
        }
        if (filters?.controlId) {
            where.controlId = filters.controlId;
        }
        if (filters?.folder) {
            // B8 follow-up — `__none__` matches rows with a NULL
            // or empty-string folder; any other value is exact.
            if (filters.folder === '__none__') {
                where.OR = [
                    { folder: null },
                    { folder: '' },
                ];
            } else {
                where.folder = filters.folder;
            }
        }
        if (filters?.archived !== undefined) {
            where.isArchived = filters.archived;
        }
        if (filters?.expiring) {
            // Evidence expiring within 30 days
            const soon = new Date();
            soon.setDate(soon.getDate() + 30);
            where.retentionUntil = { lte: soon };
        }
        if (filters?.q) {
            andConditions.push({
                OR: [
                    { title: { contains: filters.q, mode: 'insensitive' } },
                    { content: { contains: filters.q, mode: 'insensitive' } },
                    { fileName: { contains: filters.q, mode: 'insensitive' } },
                ],
            });
        }

        if (andConditions.length > 0) {
            where.AND = andConditions;
        }

        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return traceRepository('evidence.getById', ctx, async () => {
            return db.evidence.findFirst({
                where: { id, tenantId: ctx.tenantId },
                include: {
                    control: true,
                    // Source task / risk / asset — powers the "uploaded
                    // from" back-reference on the evidence detail sheet.
                    task: { select: { id: true, key: true, title: true } },
                    risk: { select: { id: true, key: true, title: true } },
                    asset: { select: { id: true, key: true, name: true } },
                    reviews: { include: { reviewer: { select: { name: true, email: true } } }, orderBy: { createdAt: 'desc' } },
                },
            });
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.EvidenceUncheckedCreateInput, 'tenantId'>) {
        return traceRepository('evidence.create', ctx, async () => {
            return db.evidence.create({
                data: {
                    ...data,
                    tenantId: ctx.tenantId,
                },
            });
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.EvidenceUncheckedUpdateInput, 'tenantId'>) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return null;

        return db.evidence.update({
            where: { id },
            data,
        });
    }

    static async addReview(db: PrismaTx, ctx: RequestContext, evidenceId: string, action: 'SUBMITTED' | 'APPROVED' | 'REJECTED', comment?: string | null) {
        return db.evidenceReview.create({
            data: {
                tenantId: ctx.tenantId,
                evidenceId,
                reviewerId: ctx.userId,
                action,
                comment,
            },
        });
    }
}
