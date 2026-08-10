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
 *
 * GLOBAL articles (W5 task — `tenantId` NULL, platform-authored, e.g. the
 * satellite-imagery guide): every READ below widens to "own tenant OR
 * GLOBAL" via an explicit `OR: [{ tenantId: ctx.tenantId }, { tenantId:
 * null }]` — Prisma's `in` cannot carry NULL, so this is the shape (same
 * as `ai/rag/retrieve.ts` uses for `KnowledgeChunk`). RLS permits GLOBAL
 * rows regardless, but the app-layer `tenantId: ctx.tenantId` equality
 * filter used everywhere else in this repo would silently EXCLUDE them
 * (NULL never equals a tenant id) — miss this on any read path and GLOBAL
 * articles become invisible on it. WRITE methods below (`create`,
 * `updateMetadata`, `updateStatus`, `setCurrentVersion`, `softDelete`)
 * are deliberately left scoped ONLY to `tenantId: ctx.tenantId` — never
 * widened — so they can never match a GLOBAL row; the usecase layer
 * (`assertTenantOwned` in `usecases/knowledge.ts`) additionally rejects a
 * write against a GLOBAL article BEFORE any of these are called, so the
 * failure mode is a clear typed error, not a silent zero-row update.
 * `getBySlug` also stays tenant-scoped only — it exists purely to avoid a
 * slug collision within ONE tenant's own articles, and a tenant's slug is
 * allowed to coincide with a GLOBAL article's slug (see the partial
 * unique index in migration 20260809130000_knowledge_global_articles).
 */
export class KnowledgeRepository {
    static async list(db: PrismaTx, ctx: RequestContext, filters: KnowledgeFilters = {}, options: { take?: number } = {}) {
        // Every filter is composed as an AND member so the tenant-or-GLOBAL
        // OR (first entry) can coexist with the free-text search's OWN OR
        // (last entry) without one clobbering the other.
        const and: Prisma.KnowledgeArticleWhereInput[] = [
            { OR: [{ tenantId: ctx.tenantId }, { tenantId: null }] },
        ];
        // Guarded on `.length` so a cleared facet OMITS the filter rather
        // than emitting `{ in: [] }`, which matches nothing.
        if (filters.status?.length) and.push({ status: { in: filters.status } });
        if (filters.category?.length) and.push({ category: { in: filters.category } });
        if (filters.cropTags?.length) and.push({ cropTags: { hasSome: filters.cropTags } });
        if (filters.regions?.length) and.push({ regions: { hasSome: filters.regions } });
        if (filters.q) {
            and.push({
                OR: [
                    { title: { contains: filters.q, mode: 'insensitive' } },
                    { summary: { contains: filters.q, mode: 'insensitive' } },
                ],
            });
        }
        return db.knowledgeArticle.findMany({
            where: { AND: and, deletedAt: null },
            select: articleListSelect,
            orderBy: [{ updatedAt: 'desc' }],
            take: options.take ?? 200,
        });
    }

    /** Distinct non-empty categories for the browse/filter UI — includes
     *  GLOBAL articles' categories (e.g. "Satellite Imagery"). */
    static async listCategories(db: PrismaTx, ctx: RequestContext) {
        const rows = await db.knowledgeArticle.findMany({
            where: {
                OR: [{ tenantId: ctx.tenantId }, { tenantId: null }],
                deletedAt: null,
                category: { not: null },
            },
            select: { category: true },
            distinct: ['category'],
            take: 500,
        });
        return rows.map((r) => r.category).filter((c): c is string => !!c).sort((a, b) => a.localeCompare(b));
    }

    /** Fetches own-tenant OR GLOBAL articles — used for both reads AND the
     *  fetch-before-write in every mutating usecase (so a write against a
     *  GLOBAL article can be rejected with a clear error instead of a
     *  confusing 404; see the class doc comment). */
    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.knowledgeArticle.findFirst({
            where: { id, OR: [{ tenantId: ctx.tenantId }, { tenantId: null }], deletedAt: null },
            include: {
                owner: { select: { id: true, name: true } },
                currentVersion: {
                    include: { createdBy: { select: { id: true, name: true } } },
                },
            },
        });
    }

    /** Tenant-scoped ONLY (see class doc comment) — used solely to avoid a
     *  slug collision within the CALLER's own tenant. */
    static async getBySlug(db: PrismaTx, ctx: RequestContext, slug: string) {
        return db.knowledgeArticle.findFirst({
            where: { tenantId: ctx.tenantId, slug },
            select: { id: true, slug: true },
        });
    }

    /**
     * GLOBAL (platform-authored) articles in a category + language,
     * WITH their published content — powers `/knowledge/satellite`'s
     * article-model integration. Deliberately scoped to GLOBAL rows only
     * (`tenantId: null`, never a tenant's own private article) and to
     * PUBLISHED status regardless of the caller's write permission — this
     * is a small, always-public documentation surface, not the general
     * article list (which applies the reader status floor in the usecase
     * layer instead — see `listArticles`).
     */
    static async listGlobalByCategory(db: PrismaTx, category: string, language: string) {
        return db.knowledgeArticle.findMany({
            where: { tenantId: null, category, language, status: 'PUBLISHED', deletedAt: null },
            select: {
                id: true,
                slug: true,
                title: true,
                summary: true,
                language: true,
                currentVersion: { select: { contentType: true, contentText: true } },
            },
            orderBy: { slug: 'asc' },
            take: 50,
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
