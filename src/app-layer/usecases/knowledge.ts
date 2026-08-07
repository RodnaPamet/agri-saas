import { RequestContext } from '../types';
import { KnowledgeRepository, KnowledgeFilters } from '../repositories/KnowledgeRepository';
import { KnowledgeVersionRepository } from '../repositories/KnowledgeVersionRepository';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText, sanitizeRichTextHtml } from '@/lib/security/sanitize';

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
    contentType?: 'HTML' | 'MARKDOWN';
    content?: string | null;
}

export async function createArticle(ctx: RequestContext, data: CreateArticleInput) {
    assertCanWrite(ctx);
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
    return runInTenantContext(ctx, async (db) => {
        const article = await KnowledgeRepository.getById(db, ctx, articleId);
        if (!article) throw notFound('Article not found');
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
}

export async function archiveArticle(ctx: RequestContext, articleId: string) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        const article = await KnowledgeRepository.getById(db, ctx, articleId);
        if (!article) throw notFound('Article not found');
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
 */
export async function acknowledgeArticle(ctx: RequestContext, articleId: string): Promise<AcknowledgeResult> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const article = await KnowledgeRepository.getById(db, ctx, articleId);
        if (!article) throw notFound('Article not found');
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
