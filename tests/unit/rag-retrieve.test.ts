/**
 * RAG hybrid retrieve (feat/ai-rag) — merge / dedupe / rank.
 *
 * Fully mocked: the AiProvider.embed() returns a fixed query vector, and
 * the db is a fake where the keyword branch (knowledgeChunk.findMany) and
 * the vector branch ($queryRaw) return canned hits. Asserts:
 *   - vector + keyword hits merge, deduping by id
 *   - a chunk that hits BOTH branches gets a corroboration score bump
 *   - results are ranked by score desc and trimmed to topK
 *   - includeGlobal toggles the NULL-tenant OR filter
 *   - an empty query short-circuits
 *   - retrieval calls getEmbeddingProvider() (NOT getAiProvider()) —
 *     fix/rag-embedding-provider-split
 *   - a failing embed degrades to keyword-only instead of throwing
 */
const mockEmbed = jest.fn();
const mockGetAiProvider = jest.fn();
jest.mock('@/app-layer/ai/provider', () => ({
    getEmbeddingProvider: () => ({ embed: mockEmbed }),
    getAiProvider: mockGetAiProvider,
}));

/*
 * The AI spend gate is mocked so this suite measures RETRIEVAL, not billing.
 *
 * It is not optional cosmetics: until #2666 `getLimit` returned null for
 * ENTERPRISE in self-hosted mode, so `assertAiSpendAllowed` early-returned and
 * this suite never reached a budget read. Giving the cap a figure made the real
 * gate run here against no database and silently degraded every vector
 * assertion to keyword-only — 8 failures whose shape (0.2 where 0.7 was
 * expected) named a ranking bug that did not exist.
 *
 * Mocking it is safe because the gate's PRESENCE is held elsewhere, by a
 * population derived from the filesystem:
 * `tests/guards/ai-spend-gate-covers-embeddings.test.ts` requires every file
 * reaching `getEmbeddingProvider().embed()` to call it. What that guard does
 * NOT hold is what happens to a refusal, which is why the two tests at the
 * bottom of this file exist.
 */
const mockAssertAiSpendAllowed = jest.fn();
jest.mock('@/app-layer/ai/budget', () => ({
    assertAiSpendAllowed: (...a: unknown[]) => mockAssertAiSpendAllowed(...a),
}));

const mockLoggerWarn = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => mockLoggerWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// runInTenantContext(ctx, cb) just calls cb with our fake db.
let fakeDb: {
    knowledgeChunk: { findMany: jest.Mock };
    $queryRaw: jest.Mock;
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) => cb(fakeDb),
}));

// Embeddings helper — avoid the 768-dim width check in the unit test.
jest.mock('@/lib/db/embeddings', () => ({
    toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
    EMBED_DIM: 768,
}));

import { retrieve } from '@/app-layer/ai/rag/retrieve';
import { codedForbidden } from '@/lib/errors/types';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    mockEmbed.mockReset();
    mockGetAiProvider.mockReset();
    mockLoggerWarn.mockReset();
    // mockReset, not clearAllMocks: a rejection installed by one test would
    // otherwise poison every later one in this file.
    mockAssertAiSpendAllowed.mockReset();
    mockAssertAiSpendAllowed.mockResolvedValue({ ok: true });
    mockEmbed.mockResolvedValue([{ text: 'q', vector: [0.1, 0.2] }]);
    fakeDb = {
        knowledgeChunk: { findMany: jest.fn().mockResolvedValue([]) },
        $queryRaw: jest.fn().mockResolvedValue([]),
    };
});

const ctx = makeRequestContext('READER', { tenantId: 'tenant-1' });

describe('retrieve — hybrid merge', () => {
    it('returns [] (and does not embed) for an empty query', async () => {
        const out = await retrieve(ctx, { query: '   ' });
        expect(out).toEqual([]);
        expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('merges vector + keyword hits and dedupes by id', async () => {
        fakeDb.$queryRaw.mockResolvedValueOnce([
            { id: 'v1', source: 'KCC (GODL)', sourceType: 'EXTERNAL', text: 'vector hit', similarity: 0.8 },
        ]);
        fakeDb.knowledgeChunk.findMany.mockResolvedValueOnce([
            { id: 'k1', source: 'Field journal', sourceType: 'JOURNAL', text: 'keyword hit' },
        ]);

        const out = await retrieve(ctx, { query: 'blight', topK: 10 });

        const ids = out.map((c) => c.id).sort();
        expect(ids).toEqual(['k1', 'v1']);
        // Vector hit outranks the keyword-only floor.
        expect(out[0].id).toBe('v1');
    });

    it('bumps the score of a chunk that hits BOTH branches', async () => {
        fakeDb.$queryRaw.mockResolvedValueOnce([
            { id: 'dup', source: 'KCC (GODL)', sourceType: 'EXTERNAL', text: 'both', similarity: 0.5 },
        ]);
        fakeDb.knowledgeChunk.findMany.mockResolvedValueOnce([
            { id: 'dup', source: 'KCC (GODL)', sourceType: 'EXTERNAL', text: 'both' },
        ]);

        const out = await retrieve(ctx, { query: 'both', topK: 10 });
        expect(out).toHaveLength(1);
        // 0.5 (vector) + 0.2 (keyword corroboration floor) = 0.7.
        expect(out[0].score).toBeCloseTo(0.7, 5);
    });

    it('ranks by score desc and trims to topK', async () => {
        fakeDb.$queryRaw.mockResolvedValueOnce([
            { id: 'a', source: 's', sourceType: 'EXTERNAL', text: 'a', similarity: 0.9 },
            { id: 'b', source: 's', sourceType: 'EXTERNAL', text: 'b', similarity: 0.7 },
            { id: 'c', source: 's', sourceType: 'EXTERNAL', text: 'c', similarity: 0.3 },
        ]);
        const out = await retrieve(ctx, { query: 'x', topK: 2 });
        expect(out.map((c) => c.id)).toEqual(['a', 'b']);
    });

    it('keyword branch filters tenant + global OR when includeGlobal (default)', async () => {
        await retrieve(ctx, { query: 'x' });
        const where = fakeDb.knowledgeChunk.findMany.mock.calls[0][0].where;
        expect(where.OR).toEqual([{ tenantId: 'tenant-1' }, { tenantId: null }]);
    });

    it('keyword branch filters tenant only when includeGlobal=false', async () => {
        await retrieve(ctx, { query: 'x', includeGlobal: false });
        const where = fakeDb.knowledgeChunk.findMany.mock.calls[0][0].where;
        expect(where.tenantId).toBe('tenant-1');
        expect(where.OR).toBeUndefined();
    });

    it('never calls getAiProvider() — embeddings resolve via getEmbeddingProvider() only', async () => {
        await retrieve(ctx, { query: 'x' });
        expect(mockGetAiProvider).not.toHaveBeenCalled();
    });
});

// ─── Language-aware ranking (S7, KB agronomy structure PR) ───

describe('retrieve — language-aware ranking', () => {
    it('defaults to preferring Bulgarian (bg) when no language is given', async () => {
        fakeDb.$queryRaw.mockResolvedValueOnce([
            { id: 'en', source: 's', sourceType: 'EXTERNAL', text: 'en', language: 'en', similarity: 0.6 },
            { id: 'bg', source: 's', sourceType: 'EXTERNAL', text: 'bg', language: 'bg', similarity: 0.6 },
        ]);
        const out = await retrieve(ctx, { query: 'x', topK: 2 });
        // Equal similarity, but the bg chunk gets the language bonus.
        expect(out.map((c) => c.id)).toEqual(['bg', 'en']);
        expect(out[0].score).toBeGreaterThan(out[1].score);
    });

    it('never excludes another-language chunk — falls back instead of returning nothing', async () => {
        fakeDb.$queryRaw.mockResolvedValueOnce([
            { id: 'en', source: 's', sourceType: 'EXTERNAL', text: 'en only', language: 'en', similarity: 0.7 },
        ]);
        const out = await retrieve(ctx, { query: 'x', topK: 5 });
        expect(out.map((c) => c.id)).toEqual(['en']);
    });

    it('an explicit language preference overrides the bg default', async () => {
        fakeDb.$queryRaw.mockResolvedValueOnce([
            { id: 'en', source: 's', sourceType: 'EXTERNAL', text: 'en', language: 'en', similarity: 0.6 },
            { id: 'bg', source: 's', sourceType: 'EXTERNAL', text: 'bg', language: 'bg', similarity: 0.6 },
        ]);
        const out = await retrieve(ctx, { query: 'x', topK: 2, language: 'en' });
        expect(out.map((c) => c.id)).toEqual(['en', 'bg']);
    });

    it('language: null disables the preference — equal similarity ties stay in similarity order', async () => {
        fakeDb.$queryRaw.mockResolvedValueOnce([
            { id: 'en', source: 's', sourceType: 'EXTERNAL', text: 'en', language: 'en', similarity: 0.6 },
            { id: 'bg', source: 's', sourceType: 'EXTERNAL', text: 'bg', language: 'bg', similarity: 0.6 },
        ]);
        const out = await retrieve(ctx, { query: 'x', topK: 2, language: null });
        expect(out[0].score).toBeCloseTo(out[1].score, 5);
    });

    it('a chunk with no stamped language gets no bonus but is never excluded', async () => {
        fakeDb.$queryRaw.mockResolvedValueOnce([
            { id: 'unk', source: 's', sourceType: 'EXTERNAL', text: 'unknown language', language: null, similarity: 0.6 },
        ]);
        const out = await retrieve(ctx, { query: 'x', topK: 5 });
        expect(out.map((c) => c.id)).toEqual(['unk']);
        expect(out[0].score).toBeCloseTo(0.6, 5);
    });

    it('exposes the stamped language on every returned chunk', async () => {
        fakeDb.$queryRaw.mockResolvedValueOnce([
            { id: 'bg', source: 's', sourceType: 'EXTERNAL', text: 'bg', language: 'bg', similarity: 0.6 },
        ]);
        const out = await retrieve(ctx, { query: 'x' });
        expect(out[0].language).toBe('bg');
    });
});

// ─── Graceful degradation — embeddings unavailable ───
//
// fix/rag-embedding-provider-split: when the embedding provider is
// unreachable/unconfigured (e.g. AI_BASE_URL default with nothing
// listening), retrieve() must degrade to the keyword branch alone
// rather than throwing — a lexical-only answer beats a 500.

describe('retrieve — degrades to keyword-only when embeddings are unavailable', () => {
    it('does not throw when embed() rejects, and still returns keyword hits', async () => {
        mockEmbed.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
        fakeDb.knowledgeChunk.findMany.mockResolvedValueOnce([
            { id: 'k1', source: 'Field journal', sourceType: 'JOURNAL', text: 'keyword hit' },
        ]);

        const out = await retrieve(ctx, { query: 'blight' });

        expect(out).toEqual([
            { id: 'k1', source: 'Field journal', sourceType: 'JOURNAL', text: 'keyword hit', language: null, score: 0.2 },
        ]);
        // The vector branch never ran a raw query.
        expect(fakeDb.$queryRaw).not.toHaveBeenCalled();
    });

    it('logs the degradation via logger.warn (never console)', async () => {
        mockEmbed.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

        await retrieve(ctx, { query: 'blight' });

        expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
        expect(mockLoggerWarn.mock.calls[0][0]).toMatch(/keyword-only/i);
    });

    it('returns [] (not a throw) when embeddings fail AND there is no keyword hit either', async () => {
        mockEmbed.mockRejectedValueOnce(new Error('timeout'));
        const out = await retrieve(ctx, { query: 'no matches anywhere' });
        expect(out).toEqual([]);
    });
});

/*
 * ─── A policy refusal is NOT a provider outage (#2666) ───
 *
 * The handler above exists for an unconfigured or unreachable embedding
 * backend. The AI spend gate is called INSIDE it, so until #2666 a budget
 * refusal was caught by it and reported as `embedding provider unavailable`.
 *
 * Nobody noticed because the gate could not refuse: `getLimit` returned null
 * for ENTERPRISE in self-hosted mode, so `assertAiBudget` early-returned on
 * every self-hosted install — which is every install that ships. Giving the
 * cap a figure made the path reachable and the swallowing live.
 *
 * Two costs, and the second is the expensive one. A farm over its ceiling gets
 * quietly worse answers — keyword-only retrieval — instead of being told. And
 * the log line is FALSE in the direction that wastes an operator's day: it
 * names an embedding backend that is working perfectly.
 *
 * These two tests are a PAIR and neither is sufficient. The first alone passes
 * for a `retrieve` that stopped degrading at all (a 500 on every unreachable
 * backend, which is what the handler was written to prevent); the second alone
 * passes for the swallowing this fixes. The property is the SPLIT.
 */
describe('retrieve — a spend refusal propagates, a provider failure degrades', () => {
    const ctx = makeRequestContext();

    it('PROPAGATES an AI_BUDGET_EXCEEDED refusal instead of degrading', async () => {
        mockAssertAiSpendAllowed.mockRejectedValueOnce(
            codedForbidden('AI_BUDGET_EXCEEDED', 'Monthly AI budget exhausted.'),
        );
        fakeDb.knowledgeChunk.findMany.mockResolvedValueOnce([
            { id: 'k1', source: 's', sourceType: 'EXTERNAL', text: 'blight' },
        ]);

        await expect(retrieve(ctx, { query: 'blight' })).rejects.toMatchObject({
            code: 'AI_BUDGET_EXCEEDED',
        });

        // And it must not have been reported as a provider problem — the log
        // line is what would send an operator to the wrong system.
        expect(mockLoggerWarn).not.toHaveBeenCalled();
        // A keyword hit was available. Returning it would be the defect:
        // a degraded answer the caller cannot tell from a complete one.
        expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('still degrades for a genuine provider failure — the handler keeps its job', async () => {
        mockEmbed.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
        fakeDb.knowledgeChunk.findMany.mockResolvedValueOnce([
            { id: 'k1', source: 's', sourceType: 'EXTERNAL', text: 'blight' },
        ]);

        const out = await retrieve(ctx, { query: 'blight' });

        expect(out.map((c) => c.id)).toEqual(['k1']);
        expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
        expect(mockLoggerWarn.mock.calls[0][0]).toMatch(/keyword-only/i);
    });
});
