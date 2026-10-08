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
import { assertAiSpendAllowed } from '@/app-layer/ai/budget';
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

    // #1345 — and this one is a COMPLETION bypass, not an embedding one.
    //
    // The issue's table listed this file under embeddings; it is not. It calls
    // `getAiProvider().complete()` directly and never reaches
    // `completeWithRouting`, which is where `assertAiBudget` lives. So this
    // was the only path in the codebase spending COMPLETION tokens with no
    // budget check at all — the expensive kind, and closer to an open tap than
    // the embedding gaps the issue was filed about.
    //
    // `retrieve` above has its own gate, so a refusal normally fires there
    // first; this is not redundant, because `sources.length === 0` returns
    // early and a caller reaching here has already paid for the retrieval.
    // More to the point, the two are independently reachable and a gate that
    // only works because another one ran first is not a gate.
    //
    // NOTE for a follow-up: routing this through `completeWithRouting` would
    // be better than asserting beside it — this path also skips provider
    // failover and the usage ledger, so its tokens are spent without being
    // RECORDED, which means the monthly total this very gate reads is
    // understated by whatever RAG has consumed. Filed separately rather than
    // widened into here, because routing takes a task tier this caller has no
    // obvious value for.
    await assertAiSpendAllowed(ctx);

    const completion = await getAiProvider().complete({
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: query },
        ],
    });

    return { answer: completion.text, sources };
}
