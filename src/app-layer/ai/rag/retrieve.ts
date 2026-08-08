/**
 * RAG retrieval (feat/ai-rag) — HYBRID keyword + vector search over
 * KnowledgeChunk.
 *
 * Two branches, merged + deduped + ranked:
 *   (a) KEYWORD — Prisma `text: { contains: query, mode: 'insensitive' }`,
 *       scoped to the tenant (and optionally the GLOBAL catalog).
 *   (b) VECTOR  — embed the query, then a raw `$queryRaw` cosine-distance
 *       nearest-neighbour scan (`embedding <=> ${literal}::vector`).
 *
 * Tenant isolation: the whole call runs inside `runInTenantContext`, so
 * RLS scopes every read. We ALSO filter `tenantId` in the app query
 * (defence-in-depth + satisfies the query-shape / tenant-isolation
 * structural guards). `includeGlobal` widens the read to the NULL-tenant
 * GLOBAL catalog, which RLS permits for every tenant.
 *
 * Prisma `in` cannot carry NULL, so the GLOBAL-or-own filter is an OR:
 *   { OR: [{ tenantId: ctx.tenantId }, { tenantId: null }] }
 *
 * Embedding provider: this MUST call `getEmbeddingProvider()`, never
 * `getAiProvider()` (fix/rag-embedding-provider-split) — the completion
 * backend (AI_BACKEND, which may be 'claude' — Anthropic has no
 * embeddings endpoint) is orthogonal to which backend serves
 * embeddings. When the embedding call fails (unconfigured/unreachable
 * backend, e.g. the AI_BASE_URL default with nothing listening), we
 * degrade to the KEYWORD branch alone rather than throwing — a
 * lexical-only answer beats a 500, and `safety/advisor.ts` already
 * refuses on empty retrieval, so the degraded path stays safe.
 *
 * Language-aware ranking (S7, KB agronomy structure PR): the product is
 * Bulgarian-first, so a chunk whose stamped `language` matches the
 * caller's preferred language gets a small score BONUS
 * (`LANGUAGE_MATCH_BONUS`) — a PREFERENCE, not a WHERE-clause filter.
 * Chunks in another language, or with no language stamped at all (most
 * of the GLOBAL external corpus predates this field), are never excluded
 * — only ranked lower — so a query with no same-language match still
 * returns the best available result instead of an empty array. Omitting
 * `opts.language` defaults to `'bg'` (the product default); pass
 * `language: null` to disable the preference entirely (every language
 * ranks equally).
 */
import { Prisma } from '@prisma/client';
import { getEmbeddingProvider } from '@/app-layer/ai/provider';
import { runInTenantContext } from '@/lib/db-context';
import { toVectorLiteral } from '@/lib/db/embeddings';
import { getCachedEmbedding, setCachedEmbedding } from '@/lib/cache/ai-cache';
import { logger } from '@/lib/observability/logger';
import { env } from '@/env';
import type { RequestContext } from '@/app-layer/types';
import type { KnowledgeChunkSourceType } from '@prisma/client';

export interface RetrieveOptions {
    query: string;
    /** Include the GLOBAL (tenantId NULL) licensed catalog. Default true. */
    includeGlobal?: boolean;
    /** Max chunks to return after merge + rank. Default 6. */
    topK?: number;
    /**
     * Preferred language (e.g. "bg", "en") — chunks stamped with a
     * matching `language` rank higher (see the module doc comment).
     * Omit to use the product default (`'bg'`); pass `null` to disable
     * the preference and rank every language equally.
     */
    language?: string | null;
}

export interface RetrievedChunk {
    id: string;
    source: string;
    sourceType: KnowledgeChunkSourceType;
    text: string;
    /** The chunk's stamped language ("bg" / "en" / …), or null when not
     *  stamped (most of the GLOBAL external corpus predates this field). */
    language: string | null;
    /** Higher is better. Vector hits carry cosine similarity; keyword-only
     *  hits get a small fixed floor so a strong lexical match still ranks. */
    score: number;
}

const DEFAULT_TOP_K = 6;
/** Score floor for a keyword-only hit (no vector similarity available). */
const KEYWORD_SCORE = 0.2;
/** Bulgarian-first product default — see the module doc comment. */
const DEFAULT_LANGUAGE = 'bg';
/**
 * Score bonus for a chunk whose stamped language matches the preferred
 * one. Small relative to a strong vector similarity (0-1 scale) so a
 * highly relevant chunk in another language still outranks a weak
 * same-language match — "prefer, don't exclude".
 */
const LANGUAGE_MATCH_BONUS = 0.15;

/**
 * Hybrid retrieve. Returns the top-K merged chunks, ranked by score
 * (vector similarity, with keyword-only hits floored). Bounded `take`
 * on both branches.
 */
export async function retrieve(
    ctx: RequestContext,
    opts: RetrieveOptions,
): Promise<RetrievedChunk[]> {
    const query = opts.query.trim();
    if (query.length === 0) return [];

    const includeGlobal = opts.includeGlobal !== false;
    const topK = Math.max(1, Math.min(opts.topK ?? DEFAULT_TOP_K, 50));
    // Fetch a wider candidate set per branch so the merge has material
    // to rank, then trim to topK.
    const branchTake = topK * 2;
    // `undefined` → Bulgarian-first default; explicit `null` → no
    // preference (every language ranks equally).
    const preferredLanguage = opts.language === null ? null : (opts.language ?? DEFAULT_LANGUAGE);
    const languageBonus = (chunkLanguage: string | null | undefined): number => {
        if (!preferredLanguage || !chunkLanguage) return 0;
        return chunkLanguage.toLowerCase() === preferredLanguage.toLowerCase() ? LANGUAGE_MATCH_BONUS : 0;
    };

    // Embed the query up front (one call) for the vector branch. Repeated
    // identical queries are served from the Redis embedding cache (long
    // TTL — embeddings are deterministic). Graceful when Redis is absent.
    // If the embedding provider itself is unavailable (unconfigured /
    // unreachable backend), degrade to the keyword branch alone instead
    // of throwing — see the module doc comment above.
    const embedModel = env.AI_EMBED_MODEL;
    let queryVector: number[] | null = null;
    try {
        queryVector = await getCachedEmbedding(embedModel, query);
        if (!queryVector) {
            const [embedding] = await getEmbeddingProvider().embed({ texts: [query] });
            queryVector = embedding.vector;
            await setCachedEmbedding(embedModel, query, queryVector);
        }
    } catch (err) {
        logger.warn('rag retrieve: embedding provider unavailable, degrading to keyword-only search', {
            component: 'rag',
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
        queryVector = null;
    }
    const queryLiteral = queryVector ? toVectorLiteral(queryVector) : null;

    return runInTenantContext(ctx, async (db) => {
        // ── (a) Keyword branch ──
        // Defence-in-depth tenant filter (RLS already scopes; we restate it).
        const tenantFilter = includeGlobal
            ? { OR: [{ tenantId: ctx.tenantId }, { tenantId: null }] }
            : { tenantId: ctx.tenantId };

        const keywordHits = await db.knowledgeChunk.findMany({
            where: {
                ...tenantFilter,
                text: { contains: query, mode: 'insensitive' },
            },
            select: { id: true, source: true, sourceType: true, text: true, language: true },
            take: branchTake,
        });

        // ── (b) Vector branch ──
        // Raw cosine-distance NN scan — the `embedding` column is
        // Unsupported in Prisma so it can only be queried via raw SQL.
        // The tenant filter is inlined for defence-in-depth + index use.
        // Skipped entirely when the embedding provider degraded above
        // (queryLiteral === null) — the keyword branch alone still runs.
        const tenantSql = includeGlobal
            ? Prisma.sql`("tenantId" = ${ctx.tenantId} OR "tenantId" IS NULL)`
            : Prisma.sql`"tenantId" = ${ctx.tenantId}`;

        const vectorHits = queryLiteral
            ? await db.$queryRaw<
                  Array<{
                      id: string;
                      source: string;
                      sourceType: KnowledgeChunkSourceType;
                      text: string;
                      language: string | null;
                      similarity: number;
                  }>
              >(Prisma.sql`
            SELECT "id", "source", "sourceType", "text", "language",
                   (1 - ("embedding" <=> ${queryLiteral}::vector)) AS "similarity"
            FROM "KnowledgeChunk"
            WHERE ${tenantSql}
              AND "embedding" IS NOT NULL
            ORDER BY "embedding" <=> ${queryLiteral}::vector ASC
            LIMIT ${branchTake}
        `)
            : [];

        // ── Merge + dedupe by id + rank ──
        const byId = new Map<string, RetrievedChunk>();
        for (const v of vectorHits) {
            byId.set(v.id, {
                id: v.id,
                source: v.source,
                sourceType: v.sourceType,
                text: v.text,
                language: v.language ?? null,
                score: Number(v.similarity) + languageBonus(v.language),
            });
        }
        for (const k of keywordHits) {
            const existing = byId.get(k.id);
            if (existing) {
                // Already a vector hit — keyword corroboration bumps it.
                existing.score += KEYWORD_SCORE;
            } else {
                byId.set(k.id, {
                    id: k.id,
                    source: k.source,
                    sourceType: k.sourceType,
                    text: k.text,
                    language: k.language ?? null,
                    score: KEYWORD_SCORE + languageBonus(k.language),
                });
            }
        }

        return [...byId.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    });
}
