/**
 * RAG usecase (feat/ai-rag) — `askKnowledgeBase`.
 *
 * The grounded-answer entry point: retrieve the most relevant
 * KnowledgeChunks (tenant-private + GLOBAL licensed catalog), build a
 * citation-forcing system prompt, and ask the general model. The result
 * is a cited answer plus the sources it was grounded in — so the general
 * model behaves like an agricultural expert via retrieval, not training.
 *
 * Read-only: gated by `assertCanRead`. Retrieval runs under
 * `runInTenantContext` (inside `retrieve`), so RLS isolates the tenant's
 * private chunks while still exposing the GLOBAL catalog.
 */
import { getAiProvider } from '@/app-layer/ai/provider';
import { retrieve, type RetrievedChunk } from '@/app-layer/ai/rag/retrieve';
import { buildContext, NO_SOURCES_ANSWER } from '@/app-layer/ai/rag/build-context';
import { assertCanRead } from '../policies/common';
import type { RequestContext } from '../types';

export interface AskKnowledgeBaseOptions {
    /** Include the GLOBAL (NULL-tenant) licensed catalog. Default true. */
    includeGlobal?: boolean;
    /** Max sources to ground on. Default uses retrieve()'s default. */
    topK?: number;
    /** Preferred language for ranking — see `retrieve()`'s doc comment.
     *  Omit for the Bulgarian-first product default; pass `null` to rank
     *  every language equally. */
    language?: string | null;
}

export interface AskKnowledgeBaseResult {
    answer: string;
    /** The sources the answer was grounded in (empty when none retrieved). */
    sources: RetrievedChunk[];
}

/**
 * Ask the knowledge base a question and get a grounded, cited answer.
 * When retrieval finds nothing, returns the fixed "not in my sources"
 * answer WITHOUT calling the model (no point asking with no context).
 */
export async function askKnowledgeBase(
    ctx: RequestContext,
    query: string,
    opts: AskKnowledgeBaseOptions = {},
): Promise<AskKnowledgeBaseResult> {
    assertCanRead(ctx);

    const sources = await retrieve(ctx, {
        query,
        includeGlobal: opts.includeGlobal,
        topK: opts.topK,
        language: opts.language,
    });

    if (sources.length === 0) {
        return { answer: NO_SOURCES_ANSWER, sources: [] };
    }

    const system = buildContext(sources, query);
    const completion = await getAiProvider().complete({
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: query },
        ],
    });

    return { answer: completion.text, sources };
}
