import { Prisma, KnowledgeArticleStatus } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

export interface KnowledgeFilters {
    /**
     * Multi-select status facet — the enterprise filter system
     * (Epic 53) comma-joins a `multiple: true` facet into one URL
     * param; the route parses it into an array via `parseCsvEnumParam`
     * BEFORE it reaches the repository, so this is always a validated
     * array, never a raw comma-joined string.
     */
    status?: KnowledgeArticleStatus[];
    /** Multi-select category facet — see `status` above. */
    category?: string[];
    /**
     * Multi-select crop-tag facet — "matches ANY of these crops"
     * (`hasSome`), mirroring `category` above. An article with an empty
     * `cropTags` array ("applies to every crop") is not force-matched by
     * this filter — the filter answers "articles tagged for crop X", not
     * "articles applicable to crop X" (that broader question belongs to
     * retrieval, not this list filter).
     */
    cropTags?: string[];
    /** Multi-select region facet — see `cropTags` above. */
    regions?: string[];
    /** Free-text match on title / summary. */
    q?: string;
}

const articleListSelect = {
    id: true,
    slug: true,
    title: true,
    summary: true,
    category: true,
    status: true,
    source: true,
    language: true,
    cropTags: true,
    regions: true,
    bbchStageMin: true,
    bbchStageMax: true,
    currentVersionId: true,
    updatedAt: true,
    createdAt: true,
    owner: { select: { id: true, name: true } },
} satisfies Prisma.KnowledgeArticleSelect;

/**
 * KnowledgeArticle repository — mirrors PolicyRepository. All reads/writes
 * tenant-scoped (RLS-bound + explicit tenantId). The article row holds
 * metadata + a pointer to the published `currentVersion`; content lives on
 * KnowledgeArticleVersion.
 */
export class KnowledgeRepository {
    static async list(db: PrismaTx, ctx: RequestContext, filters: KnowledgeFilters = {}, options: { take?: number } = {}) {
        const where: Prisma.KnowledgeArticleWhereInput = { tenantId: ctx.tenantId, deletedAt: null };
        // Guarded on `.length` so a cleared facet OMITS the filter rather
        // than emitting `{ in: [] }`, which matches nothing.
        if (filters.status?.length) where.status = { in: filters.status };
        if (filters.category?.length) where.category = { in: filters.category };
        if (filters.cropTags?.length) where.cropTags = { hasSome: filters.cropTags };
        if (filters.regions?.length) where.regions = { hasSome: filters.regions };
        if (filters.q) {
            where.OR = [
                { title: { contains: filters.q, mode: 'insensitive' } },
                { summary: { contains: filters.q, mode: 'insensitive' } },
            ];
        }
        return db.knowledgeArticle.findMany({
            where,
            select: articleListSelect,
            orderBy: [{ updatedAt: 'desc' }],
            take: options.take ?? 200,
        });
    }

    /** Distinct non-empty categories for the browse/filter UI. */
    static async listCategories(db: PrismaTx, ctx: RequestContext) {
        const rows = await db.knowledgeArticle.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null, category: { not: null } },
            select: { category: true },
            distinct: ['category'],
            take: 500,
        });
        return rows.map((r) => r.category).filter((c): c is string => !!c).sort((a, b) => a.localeCompare(b));
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.knowledgeArticle.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: {
                owner: { select: { id: true, name: true } },
                currentVersion: {
                    include: { createdBy: { select: { id: true, name: true } } },
                },
            },
        });
    }

    static async getBySlug(db: PrismaTx, ctx: RequestContext, slug: string) {
        return db.knowledgeArticle.findFirst({
            where: { tenantId: ctx.tenantId, slug },
            select: { id: true, slug: true },
        });
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        data: {
            slug: string;
            title: string;
            summary?: string | null;
            category?: string | null;
            ownerUserId?: string | null;
            language?: string | null;
            source?: string | null;
            cropTags?: string[];
            regions?: string[];
            bbchStageMin?: number | null;
            bbchStageMax?: number | null;
        },
    ) {
        return db.knowledgeArticle.create({
            data: {
                tenantId: ctx.tenantId,
                slug: data.slug,
                title: data.title,
                summary: data.summary ?? null,
                category: data.category ?? null,
                ownerUserId: data.ownerUserId ?? null,
                language: data.language ?? 'en',
                source: data.source ?? null,
                cropTags: data.cropTags ?? [],
                regions: data.regions ?? [],
                bbchStageMin: data.bbchStageMin ?? null,
                bbchStageMax: data.bbchStageMax ?? null,
            },
            select: { id: true, slug: true, title: true },
        });
    }

    static async updateMetadata(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        data: {
            title?: string;
            summary?: string | null;
            category?: string | null;
            ownerUserId?: string | null;
            language?: string | null;
            cropTags?: string[];
            regions?: string[];
            bbchStageMin?: number | null;
            bbchStageMax?: number | null;
        },
    ) {
        return db.knowledgeArticle.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data,
        });
    }

    static async updateStatus(db: PrismaTx, ctx: RequestContext, id: string, status: string) {
        return db.knowledgeArticle.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data: { status: status as Prisma.KnowledgeArticleUpdateManyMutationInput['status'] },
        });
    }

    static async setCurrentVersion(db: PrismaTx, ctx: RequestContext, id: string, versionId: string | null, bumpLifecycle = false) {
        return db.knowledgeArticle.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data: {
                currentVersionId: versionId,
                ...(bumpLifecycle ? { lifecycleVersion: { increment: 1 } } : {}),
            },
        });
    }

    static async softDelete(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.knowledgeArticle.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            data: { deletedAt: new Date(), deletedByUserId: ctx.userId },
        });
    }
}
