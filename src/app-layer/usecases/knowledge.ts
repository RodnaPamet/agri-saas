import { RequestContext } from '../types';
import { KnowledgeRepository, KnowledgeFilters } from '../repositories/KnowledgeRepository';
import { KnowledgeVersionRepository } from '../repositories/KnowledgeVersionRepository';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText, sanitizeRichTextHtml } from '@/lib/security/sanitize';
import { enqueue } from '../jobs/queue';
import { logger } from '@/lib/observability/logger';

/**
 * Knowledge Base usecases — versioned SOPs + growing guides, repurposing
 * IC's Policy machinery (createPolicy / createPolicyVersion / publishPolicy
 * / attestPolicy mirrored). Lifecycle: DRAFT → PUBLISHED → (workers)
 * ACKNOWLEDGE → ARCHIVED. No approval gate (the Policy IN_REVIEW/APPROVED
 * step is dropped). Content is sanitised at the write boundary (Epic C.5):
 * HTML (TipTap) via the rich-text allowlist, MARKDOWN via plain-text strip.
 */

// ─── Slug helper (mirrors policy.ts) ───
function slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 80);
}

function sanitizeContent(contentType: 'HTML' | 'MARKDOWN', text: string | null | undefined): string {
    if (text == null) return '';
    return contentType === 'HTML' ? sanitizeRichTextHtml(text) : sanitizePlainText(text);
}

// Three-state contract (Epic C.5 / D.2 convention, mirrors evidence.ts):
// undefined = no change, null = clear, string = sanitised-and-set.
function sanitizeOptional<T extends string | null | undefined>(value: T): T {
    if (value === undefined || value === null) return value;
    return sanitizePlainText(value as string) as T;
}

/**
 * GLOBAL articles (`tenantId === null`, W5 task — platform-authored,
 * e.g. the satellite-imagery guide) are read-only for every tenant. No
 * tenant-facing usecase may create, edit, publish, archive, unarchive,
 * delete, or acknowledge one — this is the usecase-layer half of that
 * invariant; RLS's `WITH CHECK (own)` backs it up at the DB layer, and
 * (for acknowledgement specifically) `KnowledgeAcknowledgement`'s
 * composite FK to `KnowledgeArticleVersion(id, tenantId)` makes the
 * write structurally impossible regardless — see the migration
 * 20260809130000_knowledge_global_articles header. Called AFTER the
 * `notFound` check in every write usecase below, so a bogus id and a
 * real GLOBAL id fail with the right respective error.
 */
function assertTenantOwned(article: { tenantId: string | null }): void {
    if (article.tenantId === null) {
        throw forbidden(
            'Global knowledge-base articles are platform-authored and read-only — they cannot be edited, published, archived, or acknowledged by a tenant.',
        );
    }
}

/** Cap on the number of crop tags / regions an article can carry — a
 *  runaway list is a data-entry mistake, not a real taxonomy. */
const MAX_TAGS = 20;

/**
 * Sanitise a `cropTags` / `regions` array: trim, strip HTML, drop empties,
 * dedupe case-insensitively (keeping the first-seen casing), cap length.
 * `undefined` passes through unchanged (three-state contract — undefined
 * means "no change" at the usecase boundary).
 */
function sanitizeTagArray(value: string[] | undefined): string[] | undefined {
    if (value === undefined) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of value) {
        const clean = sanitizePlainText(raw).trim();
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(clean.slice(0, 60));
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

/** BBCH is a 00-99 ordinal growth-stage scale. Validates the pair is
 *  internally consistent — both-or-neither set, in range, min <= max. */
function assertValidBbchRange(min: number | null | undefined, max: number | null | undefined): void {
    if (min == null && max == null) return;
    if (min == null || max == null) {
        throw badRequest('bbchStageMin and bbchStageMax must both be set or both be omitted');
    }
    if (min < 0 || min > 99 || max < 0 || max > 99) {
        throw badRequest('BBCH stage must be between 0 and 99');
    }
    if (min > max) {
        throw badRequest('bbchStageMin must be less than or equal to bbchStageMax');
    }
}

/**
 * Fire-and-forget enqueue of the reindex job (S4/S5) — publish makes an
 * article's content retrievable, archive/unpublish must remove it from
 * retrieval (an archived SOP must never keep being cited as current). A
 * queue failure must never fail the publish/archive request itself, so
 * this only logs on error, mirroring the `classify-photo` enqueue in
 * `journal.ts`.
 */
async function enqueueReindex(ctx: RequestContext, articleId: string): Promise<void> {
    try {
        await enqueue('reindex-knowledge-article', { tenantId: ctx.tenantId, articleId });
    } catch (err) {
        logger.warn('knowledge: reindex-knowledge-article enqueue failed', {
            component: 'knowledge',
            tenantId: ctx.tenantId,
            articleId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ─── Reads ───

export async function listArticles(ctx: RequestContext, filters?: KnowledgeFilters) {
    assertCanRead(ctx);
    // Status floor: a reader (no write permission) can only ever receive
    // PUBLISHED articles — DRAFT and ARCHIVED content is unreviewed /
    // retired and must never present as "the current procedure" to
    // someone who cannot tell it apart from an approved one. This
    // OVERRIDES whatever status filter the caller requested (including a
    // hand-crafted ?status=DRAFT query), it does not merely default it.
    const effectiveFilters: KnowledgeFilters = ctx.permissions.canWrite
        ? { ...filters }
        : { ...filters, status: ['PUBLISHED'] };
    return runInTenantContext(ctx, (db) => KnowledgeRepository.list(db, ctx, effectiveFilters));
}

export async function listCategories(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => KnowledgeRepository.listCategories(db, ctx));
}

/** A single article with version history + whether the caller has acknowledged. */
export async function getArticle(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const article = await KnowledgeRepository.getById(db, ctx, id);
        if (!article) throw notFound('Article not found');
        const versions = await KnowledgeVersionRepository.listByArticle(db, ctx, id);
        let acknowledged = false;
        if (article.currentVersionId) {
            const ack = await db.knowledgeAcknowledgement.findUnique({
                where: { articleVersionId_userId: { articleVersionId: article.currentVersionId, userId: ctx.userId } },
                select: { id: true },
            });
            acknowledged = !!ack;
        }
        return { ...article, versions, acknowledged };
    });
}

// ─── Create / version ───

export interface CreateArticleInput {
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
    contentType?: 'HTML' | 'MARKDOWN';
    content?: string | null;
}

export async function createArticle(ctx: RequestContext, data: CreateArticleInput) {
    assertCanWrite(ctx);
    assertValidBbchRange(data.bbchStageMin, data.bbchStageMax);
    return runInTenantContext(ctx, async (db) => {
        // Unique slug per tenant (collision-checked, mirrors createPolicy).
        let base = slugify(data.title) || 'article';
        let slug = base;
        let counter = 0;
        while (await KnowledgeRepository.getBySlug(db, ctx, slug)) {
            counter++;
            slug = `${base}-${counter}`;
        }

        const title = sanitizePlainText(data.title);
        if (!title) throw badRequest('Title is required');

        const article = await KnowledgeRepository.create(db, ctx, {
            slug,
            title,
            summary: data.summary != null ? sanitizePlainText(data.summary) : null,
            category: data.category != null ? sanitizePlainText(data.category) : null,
            ownerUserId: data.ownerUserId,
            language: data.language,
            source: data.source != null ? sanitizePlainText(data.source) : null,
            cropTags: sanitizeTagArray(data.cropTags),
            regions: sanitizeTagArray(data.regions),
            bbchStageMin: data.bbchStageMin ?? null,
            bbchStageMax: data.bbchStageMax ?? null,
        });

        if (data.content) {
            const contentType = data.contentType ?? 'HTML';
            const version = await KnowledgeVersionRepository.create(db, ctx, article.id, {
                contentType,
                contentText: sanitizeContent(contentType, data.content),
                changeSummary: 'Initial version',
            });
            await KnowledgeRepository.setCurrentVersion(db, ctx, article.id, version.id);
        }

        await logEvent(db, ctx, {
            action: 'KNOWLEDGE_ARTICLE_CREATED',
            entityType: 'KnowledgeArticle',
            entityId: article.id,
            details: `Created article: ${article.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'KnowledgeArticle',
                operation: 'created',
                after: { title: article.title, slug: article.slug, category: data.category ?? null },
                summary: `Created article: ${article.title}`,
            },
        });

        return article;
    });
}

export interface UpdateArticleMetadataInput {
    title?: string;
    summary?: string | null;
    category?: string | null;
    ownerUserId?: string | null;
    language?: string | null;
    cropTags?: string[];
    regions?: string[];
    bbchStageMin?: number | null;
    bbchStageMax?: number | null;
}

/**
 * Edit an article's metadata (title / summary / category / owner /
 * language). Content lives on versions, not here — this never touches
 * `currentVersionId` or `status`. WRITE-gated: any editor may correct
 * metadata, the same floor as drafting a new version; publish/archive
 * stay ADMIN-gated separately.
 */
export async function updateArticleMetadata(
    ctx: RequestContext,
    articleId: string,
    data: UpdateArticleMetadataInput,
) {
    assertCanWrite(ctx);
    // Both-or-neither: changing the BBCH range means sending both fields
    // together (see assertValidBbchRange) — a lone field is ambiguous
    // against whatever half of the range is already stored.
    assertValidBbchRange(data.bbchStageMin, data.bbchStageMax);
    return runInTenantContext(ctx, async (db) => {
        const article = await KnowledgeRepository.getById(db, ctx, articleId);
        if (!article) throw notFound('Article not found');
        assertTenantOwned(article);

        const title = data.title !== undefined ? sanitizePlainText(data.title) : undefined;
        if (title !== undefined && !title) throw badRequest('Title is required');

        const changedFields = (Object.keys(data) as (keyof UpdateArticleMetadataInput)[]).filter(
            (k) => data[k] !== undefined,
        );

        await KnowledgeRepository.updateMetadata(db, ctx, articleId, {
            title,
            summary: sanitizeOptional(data.summary),
            category: sanitizeOptional(data.category),
            ownerUserId: data.ownerUserId,
            language: data.language,
            cropTags: sanitizeTagArray(data.cropTags),
            regions: sanitizeTagArray(data.regions),
            bbchStageMin: data.bbchStageMin,
            bbchStageMax: data.bbchStageMax,
        });

        await logEvent(db, ctx, {
            action: 'KNOWLEDGE_ARTICLE_UPDATED',
            entityType: 'KnowledgeArticle',
            entityId: articleId,
            details: `Updated article: ${article.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'KnowledgeArticle',
                operation: 'updated',
                changedFields,
                summary: `Updated article: ${article.title}`,
            },
        });

        return KnowledgeRepository.getById(db, ctx, articleId);
    });
}

export interface CreateArticleVersionInput {
    contentType: 'HTML' | 'MARKDOWN';
    contentText: string;
    changeSummary?: string | null;
}

export async function createArticleVersion(ctx: RequestContext, articleId: string, data: CreateArticleVersionInput) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const article = await KnowledgeRepository.getById(db, ctx, articleId);
        if (!article) throw notFound('Article not found');
        assertTenantOwned(article);
        if (article.status === 'ARCHIVED') throw badRequest('Cannot add a version to an archived article');
        if (!data.contentText?.trim()) throw badRequest('contentText is required');

        const version = await KnowledgeVersionRepository.create(db, ctx, articleId, {
            contentType: data.contentType,
            contentText: sanitizeContent(data.contentType, data.contentText),
            changeSummary: data.changeSummary != null ? sanitizePlainText(data.changeSummary) : null,
        });

        // Deliberately NOT mirroring createPolicyVersion's PUBLISHED→DRAFT
        // rollback: this is an SOP surface, and unpublishing the live
        // procedure the instant someone starts drafting an edit would
        // retract the spray/safety instructions a worker is following
        // mid-task. A PUBLISHED article keeps serving `currentVersion`
        // while newer versions accumulate as drafts underneath it — only
        // `publishArticle` ever moves `currentVersionId` / flips status.
        // See docs/implementation-notes/2026-08-07-knowledge-crud-defects.md.

        await logEvent(db, ctx, {
            action: 'KNOWLEDGE_VERSION_CREATED',
            entityType: 'KnowledgeArticle',
            entityId: articleId,
            details: `Version ${version.versionNumber} created`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'KnowledgeArticleVersion',
                operation: 'created',
                after: { versionId: version.id, versionNumber: version.versionNumber, contentType: data.contentType },
                summary: `Version ${version.versionNumber} created`,
            },
            metadata: { versionId: version.id, versionNumber: version.versionNumber },
        });

        return version;
    });
}

// ─── Publish / archive ───

export async function publishArticle(ctx: RequestContext, articleId: string, versionId: string) {
    assertCanAdmin(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const article = await KnowledgeRepository.getById(db, ctx, articleId);
        if (!article) throw notFound('Article not found');
        assertTenantOwned(article);
        const version = await KnowledgeVersionRepository.getById(db, ctx, versionId);
        if (!version || version.article.id !== articleId) {
            throw badRequest('Version does not belong to this article');
        }

        await KnowledgeRepository.setCurrentVersion(db, ctx, articleId, versionId, true);
        await KnowledgeRepository.updateStatus(db, ctx, articleId, 'PUBLISHED');

        await logEvent(db, ctx, {
            action: 'KNOWLEDGE_ARTICLE_PUBLISHED',
            entityType: 'KnowledgeArticle',
            entityId: articleId,
            details: `Published version ${version.versionNumber}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'KnowledgeArticle',
                fromStatus: article.status,
                toStatus: 'PUBLISHED',
                reason: `Published version ${version.versionNumber}`,
            },
            metadata: { versionId, versionNumber: version.versionNumber },
        });

        return KnowledgeRepository.getById(db, ctx, articleId);
    });

    // S4/S5 — publishing makes the article's content retrievable: chunk
    // the newly-current version + embed it. Enqueued AFTER the transaction
    // commits (not inside the callback above) so the worker never races a
    // still-open transaction and reads the pre-publish row.
    await enqueueReindex(ctx, articleId);

    return result;
}

export async function archiveArticle(ctx: RequestContext, articleId: string) {
    assertCanAdmin(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const article = await KnowledgeRepository.getById(db, ctx, articleId);
        if (!article) throw notFound('Article not found');
        assertTenantOwned(article);
        await KnowledgeRepository.updateStatus(db, ctx, articleId, 'ARCHIVED');
        await logEvent(db, ctx, {
            action: 'KNOWLEDGE_ARTICLE_ARCHIVED',
            entityType: 'KnowledgeArticle',
            entityId: articleId,
            details: `Archived article: ${article.title}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'KnowledgeArticle',
                fromStatus: article.status,
                toStatus: 'ARCHIVED',
            },
        });
        return { success: true };
    });

    // S4/S5 — archive must REMOVE the article's chunks, or an archived SOP
    // keeps being cited as current retrieval content. Same commit-then-
    // enqueue ordering as publishArticle above.
    await enqueueReindex(ctx, articleId);

    return result;
}

/**
 * Restore an ARCHIVED article. Mirrors `unarchiveEvidence`: ADMIN-gated,
 * idempotent (a no-op on an article that isn't ARCHIVED).
 *
 * The restored status is derived from `lifecycleVersion`, NOT
 * `currentVersionId` — `currentVersionId` gets set at CREATE time too
 * (`createArticle` points it at the initial version for preview), so an
 * article that was never explicitly published still has a non-null
 * `currentVersionId`. Using that as the signal would silently promote an
 * unreviewed DRAFT to PUBLISHED on unarchive, bypassing the admin-gated
 * `publishArticle` step entirely — the exact "draft shown as approved"
 * failure mode this whole fix pass exists to close. `lifecycleVersion`
 * only increments inside `publishArticle` (`setCurrentVersion(...,
 * bumpLifecycle: true)`), so `> 1` is a reliable "has been published at
 * least once" signal; archiving never touches either field.
 */
export async function unarchiveArticle(ctx: RequestContext, articleId: string) {
    assertCanAdmin(ctx);
    let restoredToPublished = false;
    const result = await runInTenantContext(ctx, async (db) => {
        const article = await KnowledgeRepository.getById(db, ctx, articleId);
        if (!article) throw notFound('Article not found');
        assertTenantOwned(article);
        if (article.status !== 'ARCHIVED') return article; // idempotent

        const restoredStatus = article.lifecycleVersion > 1 ? 'PUBLISHED' : 'DRAFT';
        restoredToPublished = restoredStatus === 'PUBLISHED';
        await KnowledgeRepository.updateStatus(db, ctx, articleId, restoredStatus);

        await logEvent(db, ctx, {
            action: 'KNOWLEDGE_ARTICLE_UNARCHIVED',
            entityType: 'KnowledgeArticle',
            entityId: articleId,
            details: `Unarchived article: ${article.title}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'KnowledgeArticle',
                fromStatus: 'ARCHIVED',
                toStatus: restoredStatus,
            },
        });

        return KnowledgeRepository.getById(db, ctx, articleId);
    });

    // Symmetric with publish/archive: restoring to PUBLISHED makes the
    // article's content retrievable again (it was removed on archive).
    // Restoring to DRAFT needs no reindex — the job's own PUBLISHED check
    // would only ever remove (already-absent) chunks.
    if (restoredToPublished) {
        await enqueueReindex(ctx, articleId);
    }

    return result;
}

// ─── Acknowledgement (mirrors policy-attestation) ───

export interface AcknowledgeResult {
    acknowledgementId: string;
    articleVersionId: string;
    userId: string;
    acknowledgedAt: Date;
    created: boolean;
}

/**
 * Record the caller's acknowledgement of a published article's current
 * version. Any reader can acknowledge; only PUBLISHED articles are
 * acknowledgeable. Idempotent via @@unique([articleVersionId, userId]).
 *
 * GLOBAL articles are rejected (`assertTenantOwned`) — an acknowledgement
 * row always belongs to the ACTING tenant, and `KnowledgeAcknowledgement`'s
 * composite FK to `KnowledgeArticleVersion(id, tenantId)` would refuse the
 * write at the DB layer anyway (a GLOBAL version's tenantId is NULL, which
 * never matches an acting tenantId) — see the migration
 * 20260809130000_knowledge_global_articles header.
 */
export async function acknowledgeArticle(ctx: RequestContext, articleId: string): Promise<AcknowledgeResult> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const article = await KnowledgeRepository.getById(db, ctx, articleId);
        if (!article) throw notFound('Article not found');
        assertTenantOwned(article);
        if (article.status !== 'PUBLISHED') {
            throw badRequest(`Only PUBLISHED articles can be acknowledged. ${articleId} is ${article.status}.`);
        }
        if (!article.currentVersionId) {
            throw badRequest('Article is PUBLISHED but has no current version — re-publish required.');
        }

        const existing = await db.knowledgeAcknowledgement.findUnique({
            where: { articleVersionId_userId: { articleVersionId: article.currentVersionId, userId: ctx.userId } },
        });
        if (existing) {
            return {
                acknowledgementId: existing.id,
                articleVersionId: existing.articleVersionId,
                userId: existing.userId,
                acknowledgedAt: existing.acknowledgedAt,
                created: false,
            };
        }

        const row = await db.knowledgeAcknowledgement.create({
            data: {
                tenantId: ctx.tenantId,
                articleVersionId: article.currentVersionId,
                userId: ctx.userId,
            },
        });

        await logEvent(db, ctx, {
            action: 'KNOWLEDGE_ARTICLE_ACKNOWLEDGED',
            entityType: 'KnowledgeArticle',
            entityId: articleId,
            details: `User acknowledged article version ${article.currentVersionId}`,
            detailsJson: {
                category: 'access',
                entityName: 'KnowledgeArticle',
                summary: `User ${ctx.userId} acknowledged article ${articleId}`,
                after: { articleVersionId: article.currentVersionId, userId: ctx.userId },
            },
        });

        return {
            acknowledgementId: row.id,
            articleVersionId: row.articleVersionId,
            userId: row.userId,
            acknowledgedAt: row.acknowledgedAt,
            created: true,
        };
    });
}

/** Admin report: who has acknowledged an article's current version. */
export async function listAcknowledgements(ctx: RequestContext, articleId: string) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        const article = await KnowledgeRepository.getById(db, ctx, articleId);
        if (!article) throw notFound('Article not found');
        if (!article.currentVersionId) return [];
        return db.knowledgeAcknowledgement.findMany({
            where: { tenantId: ctx.tenantId, articleVersionId: article.currentVersionId },
            orderBy: { acknowledgedAt: 'desc' },
            include: { user: { select: { id: true, name: true, email: true } } },
            take: 500,
        });
    });
}

// ─── Satellite-imagery guide (W5 task) ───

/**
 * Category pivot for the satellite-imagery guide's GLOBAL articles — MUST
 * match the `category` seeded by `scripts/rag/ingest-satellite-guide.ts`
 * and the client-side `SATELLITE_ARTICLE_CATEGORY` constant on
 * `/knowledge/satellite/page.tsx`. Kept as a literal in each file rather
 * than a shared import — same reasoning as `AGRONOMY_SOURCE` in
 * `scripts/import-knowledge.ts`: no import-time coupling between a
 * server usecase, a client page, and a standalone seed script.
 */
const SATELLITE_ARTICLE_CATEGORY = 'Satellite Imagery';

/**
 * The satellite-imagery guide's GLOBAL (platform-authored) articles for
 * one language, WITH content — powers `/knowledge/satellite`'s
 * article-model integration (W5 task). Always PUBLISHED-only and
 * GLOBAL-only regardless of the caller's permission tier (see
 * `KnowledgeRepository.listGlobalByCategory`) — this is a small,
 * always-public documentation surface, not the general article list.
 */
export async function getSatelliteGuideArticles(ctx: RequestContext, language: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        KnowledgeRepository.listGlobalByCategory(db, SATELLITE_ARTICLE_CATEGORY, language),
    );
}
