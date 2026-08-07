/**
 * RAG embed-chunks job (feat/ai-rag).
 *
 * Embeds tenant-scoped `KnowledgeChunk` rows whose `embedding` is still
 * NULL: load a bounded batch of un-embedded chunks, call
 * `getEmbeddingProvider().embed()` on their text, and write the vectors
 * back via raw `$executeRaw` (the `embedding` column is a Prisma
 * `Unsupported("vector(768)")`, so it can only be written through raw
 * SQL — see src/lib/db/embeddings.ts).
 *
 * Uses `getEmbeddingProvider()`, NOT `getAiProvider()`
 * (fix/rag-embedding-provider-split) — ingestion has the same "the
 * completion backend may be Claude, which has no embeddings endpoint"
 * hazard as retrieval, so it resolves the embedding backend
 * independently too. Unlike retrieval, this job does NOT degrade —
 * a failed embed throws so the BullMQ job fails loudly and retries,
 * rather than silently leaving chunks permanently un-embedded.
 *
 * Tenant isolation: the whole run executes inside `runInTenantContext`,
 * so RLS scopes both the candidate read and the vector writes to the
 * tenant. The GLOBAL catalog (tenantId NULL) is embedded by the
 * ingestion script directly under the superuser bypass — this job only
 * ever embeds tenant-private chunks.
 *
 * No N+1: ONE raw SELECT for the candidate ids+text, ONE batched embed
 * call, then per-row UPDATEs (each a single-row raw write — pgvector has
 * no Prisma `updateMany`-with-vector path). The batch is bounded by
 * `batchSize` (default 128) so a tenant with a huge backlog drains over
 * several runs rather than one unbounded sweep.
 */
import { getEmbeddingProvider } from '@/app-layer/ai/provider';
import { runInTenantContext } from '@/lib/db-context';
import { toVectorLiteral } from '@/lib/db/embeddings';
import { logger } from '@/lib/observability/logger';
import type { RequestContext } from '@/app-layer/types';

const DEFAULT_BATCH_SIZE = 128;

export interface RunEmbedChunksResult {
    tenantId: string;
    /** Chunks that needed embedding this run (the bounded batch). */
    scanned: number;
    /** Chunks whose embedding was written. */
    embedded: number;
}

/** A minimal context for the embed job — userId/requestId are synthetic. */
function jobContext(tenantId: string): RequestContext {
    return {
        userId: 'system:embed-chunks',
        tenantId,
        requestId: `embed-chunks-${tenantId}`,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: false },
        appPermissions: undefined,
    } as unknown as RequestContext;
}

/**
 * Embed the tenant's un-embedded KnowledgeChunks (bounded batch).
 * Idempotent — re-running picks up whatever is still NULL.
 */
export async function runEmbedChunks(opts: {
    tenantId: string;
    batchSize?: number;
}): Promise<RunEmbedChunksResult> {
    const batchSize = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH_SIZE, 512));
    const ctx = jobContext(opts.tenantId);

    return runInTenantContext(ctx, async (db) => {
        // Candidate read — one bounded raw SELECT (the `embedding` column
        // is Unsupported, so Prisma findMany can't filter on its NULL-ness).
        // RLS scopes this to the tenant; the explicit tenantId filter is
        // defence-in-depth (and excludes the GLOBAL NULL-tenant rows).
        const candidates = await db.$queryRaw<Array<{ id: string; text: string }>>`
            SELECT "id", "text"
            FROM "KnowledgeChunk"
            WHERE "tenantId" = ${opts.tenantId}
              AND "embedding" IS NULL
            ORDER BY "createdAt" ASC
            LIMIT ${batchSize}
        `;

        if (candidates.length === 0) {
            return { tenantId: opts.tenantId, scanned: 0, embedded: 0 };
        }

        // One batched embed call for the whole batch.
        const embeddings = await getEmbeddingProvider().embed({
            texts: candidates.map((c) => c.text),
        });

        let embedded = 0;
        for (let i = 0; i < candidates.length; i++) {
            const literal = toVectorLiteral(embeddings[i].vector);
            await db.$executeRaw`
                UPDATE "KnowledgeChunk"
                SET "embedding" = ${literal}::vector, "updatedAt" = now()
                WHERE "id" = ${candidates[i].id}
                  AND "tenantId" = ${opts.tenantId}
            `;
            embedded++;
        }

        logger.info('embed-chunks completed', {
            component: 'embed-chunks',
            tenantId: opts.tenantId,
            scanned: candidates.length,
            embedded,
        });

        return { tenantId: opts.tenantId, scanned: candidates.length, embedded };
    });
}
