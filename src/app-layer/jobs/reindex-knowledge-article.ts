/**
 * reindex-knowledge-article job (S4/S5/S6 — KB agronomy structure PR).
 *
 * Keeps `KnowledgeChunk` in sync with a `KnowledgeArticle`'s publish
 * lifecycle. Enqueued by `publishArticle` / `archiveArticle` /
 * `unarchiveArticle` (see `usecases/knowledge.ts`) — never scheduled, it
 * is purely event-triggered, same shape as `classify-photo` / `soil-fetch`.
 *
 * A single decision point, made from the article's CURRENT state at the
 * time the job runs (not the transition that triggered it):
 *   - status === 'PUBLISHED' and has a current version with content →
 *     paragraph-chunk the content (`chunkHtmlByParagraph`), stamp
 *     crop/BBCH/region/language/source onto each chunk, and REPLACE the
 *     article's existing KB chunk set.
 *   - anything else (ARCHIVED, DRAFT, soft-deleted, missing content) →
 *     REMOVE any existing KB chunks for the article. This is what makes
 *     archive mean something: an archived SOP must never keep being
 *     retrieved as the current procedure.
 *
 * Idempotent by construction: replace = delete-then-insert inside the
 * same tenant transaction, so re-running for one article (e.g. two
 * publishes of the same content) never duplicates chunks.
 *
 * After a successful (re)index, fire-and-forget enqueues `embed-chunks`
 * for the tenant so the freshly-written NULL-embedding rows get vectors
 * without waiting for a schedule (there isn't one — `embed-chunks` is
 * itself event-triggered). A failed enqueue only logs; it never fails
 * the reindex (the next embed-chunks run — ad hoc or triggered by the
 * next reindex — picks up the backlog).
 */
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { chunkHtmlByParagraph } from '@/app-layer/ai/rag/chunk';
import { enqueue } from './queue';
import { logger } from '@/lib/observability/logger';
import type { RequestContext } from '@/app-layer/types';

export interface RunReindexKnowledgeArticleResult {
    tenantId: string;
    articleId: string;
    action: 'indexed' | 'removed';
    chunksWritten: number;
    chunksRemoved: number;
}

/** A minimal context for the job — mirrors embed-chunks.ts's jobContext. */
function jobContext(tenantId: string): RequestContext {
    return {
        userId: 'system:reindex-knowledge-article',
        tenantId,
        requestId: `reindex-knowledge-article-${tenantId}`,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: false },
        appPermissions: undefined,
    } as unknown as RequestContext;
}

/** Remove any existing KB chunks for the article — the "not currently
 *  retrievable" terminal state (archived / draft / soft-deleted / gone). */
async function removeChunks(db: PrismaTx, tenantId: string, articleId: string): Promise<number> {
    const removed = await db.knowledgeChunk.deleteMany({
        where: { tenantId, articleId, sourceType: 'KB' },
    });
    return removed.count;
}

export async function runReindexKnowledgeArticle(opts: {
    tenantId: string;
    articleId: string;
}): Promise<RunReindexKnowledgeArticleResult> {
    const ctx = jobContext(opts.tenantId);

    const result = await runInTenantContext(ctx, async (db) => {
        const article = await db.knowledgeArticle.findFirst({
            where: { id: opts.articleId, tenantId: opts.tenantId },
            select: {
                id: true,
                title: true,
                status: true,
                deletedAt: true,
                source: true,
                language: true,
                cropTags: true,
                regions: true,
                bbchStageMin: true,
                bbchStageMax: true,
                currentVersion: { select: { contentText: true } },
            },
        });

        if (!article) {
            const chunksRemoved = await removeChunks(db, opts.tenantId, opts.articleId);
            return { action: 'removed' as const, chunksWritten: 0, chunksRemoved };
        }

        const contentText =
            !article.deletedAt && article.status === 'PUBLISHED'
                ? article.currentVersion?.contentText ?? null
                : null;

        if (!contentText) {
            // Covers ARCHIVED explicitly (the whole point — an archived
            // SOP must not keep being cited as current) as well as
            // DRAFT / soft-deleted / not-yet-published.
            const chunksRemoved = await removeChunks(db, opts.tenantId, opts.articleId);
            return { action: 'removed' as const, chunksWritten: 0, chunksRemoved };
        }

        const paragraphs = chunkHtmlByParagraph(contentText);
        const source = article.source?.trim() || `Knowledge base: ${article.title}`;

        // Idempotent re-chunk: delete-then-insert inside this same
        // tenant transaction so a re-run (edited + republished content)
        // never leaves stale paragraphs alongside fresh ones.
        const chunksRemoved = await removeChunks(db, opts.tenantId, opts.articleId);

        if (paragraphs.length > 0) {
            await db.knowledgeChunk.createMany({
                data: paragraphs.map((text, i) => ({
                    tenantId: opts.tenantId,
                    articleId: opts.articleId,
                    source,
                    sourceType: 'KB' as const,
                    sourceRef: article.id,
                    text,
                    chunkIndex: i,
                    cropTags: article.cropTags,
                    regions: article.regions,
                    bbchStageMin: article.bbchStageMin,
                    bbchStageMax: article.bbchStageMax,
                    language: article.language,
                })),
            });
        }

        return { action: 'indexed' as const, chunksWritten: paragraphs.length, chunksRemoved };
    });

    if (result.action === 'indexed' && result.chunksWritten > 0) {
        try {
            await enqueue('embed-chunks', { tenantId: opts.tenantId });
        } catch (err) {
            logger.warn('reindex-knowledge-article: embed-chunks enqueue failed', {
                component: 'reindex-knowledge-article',
                tenantId: opts.tenantId,
                articleId: opts.articleId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    logger.info('reindex-knowledge-article completed', {
        component: 'reindex-knowledge-article',
        tenantId: opts.tenantId,
        articleId: opts.articleId,
        action: result.action,
        chunksWritten: result.chunksWritten,
        chunksRemoved: result.chunksRemoved,
    });

    return { tenantId: opts.tenantId, articleId: opts.articleId, ...result };
}
