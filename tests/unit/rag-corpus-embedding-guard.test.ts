/**
 * `assertEmbeddingBackendConfigured` + the `getEmbeddingProvider` fix
 * in `scripts/rag/corpus.ts` (2026-08-10 production-seed-path work).
 *
 * `ingestGlobalCorpus` used to call `getAiProvider()` — the COMPLETION
 * provider — for embeddings, which #496
 * (docs/implementation-notes/2026-08-07-rag-embedding-provider-split.md)
 * had already fixed everywhere else (`retrieve()`, the `embed-chunks`
 * job) but missed here. On the production VM, where no `AI_*` var is
 * set at all, that meant `AI_BASE_URL` silently defaulted to the zod
 * schema fallback `http://localhost:11434/v1` (nothing listens there
 * in the container) and the failure surfaced as an opaque
 * `ECONNREFUSED` deep inside the OpenAI SDK — never a message naming
 * the actual missing config.
 *
 * This file behaviourally locks in two things a structural guard
 * cannot: (1) `assertEmbeddingBackendConfigured` throws a message
 * naming the exact missing env var(s) and only when NEITHER the
 * dedicated `AI_EMBED_*` pair NOR the `AI_BASE_URL` fallback is set,
 * and (2) `ingestGlobalCorpus` runs that check BEFORE touching Prisma
 * or the network, and calls `getEmbeddingProvider()` (never
 * `getAiProvider()`) once configured.
 */

const ENV_KEYS = ['AI_EMBED_BASE_URL', 'AI_EMBED_API_KEY', 'AI_BASE_URL'] as const;

function snapshotEnv(): Record<string, string | undefined> {
    const snap: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) snap[key] = process.env[key];
    return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
    for (const key of ENV_KEYS) {
        if (snap[key] === undefined) delete process.env[key];
        else process.env[key] = snap[key];
    }
}

function clearEnv(): void {
    for (const key of ENV_KEYS) delete process.env[key];
}

describe('assertEmbeddingBackendConfigured', () => {
    let snap: Record<string, string | undefined>;

    beforeEach(() => {
        snap = snapshotEnv();
        clearEnv();
        jest.resetModules();
    });

    afterEach(() => {
        restoreEnv(snap);
        jest.resetModules();
    });

    it('throws naming BOTH missing vars when nothing is configured', () => {
        const { assertEmbeddingBackendConfigured } = require('../../scripts/rag/corpus');
        expect(() => assertEmbeddingBackendConfigured()).toThrow(
            /AI_EMBED_BASE_URL and AI_EMBED_API_KEY are not set/,
        );
    });

    it('names only the missing var when one of the AI_EMBED_* pair is set', () => {
        process.env.AI_EMBED_BASE_URL = 'https://embeddings.example.com/v1';
        const { assertEmbeddingBackendConfigured } = require('../../scripts/rag/corpus');
        expect(() => assertEmbeddingBackendConfigured()).toThrow(
            /AI_EMBED_API_KEY is not set/,
        );
        expect(() => assertEmbeddingBackendConfigured()).not.toThrow(/AI_EMBED_BASE_URL is not set/);
    });

    it('does not throw when AI_EMBED_BASE_URL + AI_EMBED_API_KEY are both set', () => {
        process.env.AI_EMBED_BASE_URL = 'https://embeddings.example.com/v1';
        process.env.AI_EMBED_API_KEY = 'embed-key';
        const { assertEmbeddingBackendConfigured } = require('../../scripts/rag/corpus');
        expect(() => assertEmbeddingBackendConfigured()).not.toThrow();
    });

    it('does not throw when only AI_BASE_URL is set (self-hosted Ollama-serves-both fallback)', () => {
        process.env.AI_BASE_URL = 'http://ollama.internal:11434/v1';
        const { assertEmbeddingBackendConfigured } = require('../../scripts/rag/corpus');
        expect(() => assertEmbeddingBackendConfigured()).not.toThrow();
    });
});

describe('ingestGlobalCorpus — embeddings preflight + provider selection', () => {
    let snap: Record<string, string | undefined>;
    const entry = {
        source: 'Agri-SaaS agronomy desk (original)' as const,
        sourceRef: 'unit-test-entry',
        text: 'Овесът е житна култура. Прибирането става при зряло зърно.',
        language: 'bg' as const,
    };

    beforeEach(() => {
        snap = snapshotEnv();
        clearEnv();
        jest.resetModules();
    });

    afterEach(() => {
        restoreEnv(snap);
        jest.resetModules();
        jest.dontMock('@/app-layer/ai/provider');
    });

    it('throws before making any Prisma call when no embeddings backend is configured', async () => {
        const findMany = jest.fn();
        const create = jest.fn();
        const fakePrisma = {
            knowledgeChunk: { findMany, create },
            $executeRaw: jest.fn(),
        };

        const { ingestGlobalCorpus } = require('../../scripts/rag/corpus');
        await expect(ingestGlobalCorpus(fakePrisma, [entry])).rejects.toThrow(
            /RAG corpus ingestion needs an embeddings backend/,
        );
        expect(findMany).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    });

    it('calls getEmbeddingProvider() (never getAiProvider()) once a backend is configured', async () => {
        process.env.AI_EMBED_BASE_URL = 'https://embeddings.example.com/v1';
        process.env.AI_EMBED_API_KEY = 'embed-key';

        // KnowledgeChunk.embedding is `vector(768)` — toVectorLiteral()
        // rejects any other dimensionality (see src/lib/db/embeddings.ts).
        const embed = jest.fn().mockResolvedValue([{ vector: new Array(768).fill(0.01) }]);
        const getAiProvider = jest.fn(() => {
            throw new Error('getAiProvider() must never be called by ingestGlobalCorpus');
        });
        const getEmbeddingProvider = jest.fn(() => ({ embed }));

        jest.doMock('@/app-layer/ai/provider', () => ({
            getAiProvider,
            getEmbeddingProvider,
        }));

        const findMany = jest.fn().mockResolvedValue([]);
        const create = jest.fn().mockResolvedValue({ id: 'chunk-1' });
        const $executeRaw = jest.fn().mockResolvedValue(undefined);
        const fakePrisma = {
            knowledgeChunk: { findMany, create },
            $executeRaw,
        };

        const { ingestGlobalCorpus } = require('../../scripts/rag/corpus');
        const result = await ingestGlobalCorpus(fakePrisma, [entry]);

        expect(result).toEqual({ created: 1, skipped: 0 });
        expect(getEmbeddingProvider).toHaveBeenCalledTimes(1);
        expect(getAiProvider).not.toHaveBeenCalled();
        expect(embed).toHaveBeenCalledWith({ texts: [entry.text] });
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('skips an already-present chunk without embedding it again, when a backend IS configured', async () => {
        // Idempotent re-run: nothing new to embed. embed() must not be
        // called for a fully-skipped batch (embed-then-write ordering
        // exists precisely so a config problem is caught before any
        // write — a skip that never reaches that line proves nothing
        // about the guard, so this test only asserts the no-duplicate
        // behaviour; the guard's unconditional placement is covered by
        // the next test).
        const findMany = jest.fn().mockResolvedValue([{ source: entry.source, sourceRef: entry.sourceRef }]);
        const create = jest.fn();
        const fakePrisma = {
            knowledgeChunk: { findMany, create },
            $executeRaw: jest.fn(),
        };

        process.env.AI_EMBED_BASE_URL = 'https://embeddings.example.com/v1';
        process.env.AI_EMBED_API_KEY = 'embed-key';

        const { ingestGlobalCorpus } = require('../../scripts/rag/corpus');
        const result = await ingestGlobalCorpus(fakePrisma, [entry]);
        expect(result).toEqual({ created: 0, skipped: 1 });
        expect(create).not.toHaveBeenCalled();
    });

    it('the embeddings preflight is unconditional — it fires even when every entry would ultimately skip', async () => {
        // A future "only check when there's real work" optimisation
        // would be a regression: it would make the failure mode
        // ENVIRONMENT-DEPENDENT (crashes only on a cold catalogue, not
        // once everything happens to already exist), which is exactly
        // the kind of inconsistency this preflight exists to avoid.
        const findMany = jest.fn().mockResolvedValue([{ source: entry.source, sourceRef: entry.sourceRef }]);
        const fakePrisma = {
            knowledgeChunk: { findMany, create: jest.fn() },
            $executeRaw: jest.fn(),
        };

        const { ingestGlobalCorpus } = require('../../scripts/rag/corpus');
        await expect(ingestGlobalCorpus(fakePrisma, [entry])).rejects.toThrow(
            /RAG corpus ingestion needs an embeddings backend/,
        );
        expect(findMany).not.toHaveBeenCalled();
    });
});
