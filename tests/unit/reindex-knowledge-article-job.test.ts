/**
 * reindex-knowledge-article job (S4/S5/S6 — KB agronomy structure PR).
 *
 * Fully mocked: db-context's `runInTenantContext` just calls the callback
 * with a fake db, and `./queue`'s `enqueue` is a spy. Uses the REAL
 * chunker (`chunkHtmlByParagraph`) — it has its own dedicated unit tests
 * (`rag-chunk.test.ts`), and exercising it here also proves the wiring.
 *
 * Covers the single decision point: PUBLISHED-with-content → replace the
 * chunk set + trigger embedding; everything else → remove the chunk set
 * (the archive invariant this whole job exists for).
 */
const mockFindFirst = jest.fn();
const mockDeleteMany = jest.fn();
const mockCreateMany = jest.fn();
const mockDb = {
    knowledgeArticle: { findFirst: mockFindFirst },
    knowledgeChunk: { deleteMany: mockDeleteMany, createMany: mockCreateMany },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

const mockEnqueue = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...a: unknown[]) => mockEnqueue(...a),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logger } from '@/lib/observability/logger';
import { runReindexKnowledgeArticle } from '@/app-layer/jobs/reindex-knowledge-article';

const BASE_ARTICLE = {
    id: 'art-1',
    title: 'Wheat spray SOP',
    status: 'PUBLISHED',
    deletedAt: null,
    source: null,
    language: 'bg',
    cropTags: ['wheat'],
    regions: [],
    bbchStageMin: 30,
    bbchStageMax: 39,
    currentVersion: { contentText: '<p>Wear gloves.</p><p>Apply before noon.</p>' },
};

beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteMany.mockResolvedValue({ count: 2 });
    mockCreateMany.mockResolvedValue({ count: 2 });
    mockEnqueue.mockResolvedValue(undefined);
});

describe('runReindexKnowledgeArticle — removal branch', () => {
    it('removes chunks when the article no longer exists', async () => {
        mockFindFirst.mockResolvedValue(null);

        const result = await runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'gone' });

        expect(result).toEqual({
            tenantId: 't1', articleId: 'gone', action: 'removed', chunksWritten: 0, chunksRemoved: 2,
        });
        expect(mockDeleteMany).toHaveBeenCalledWith({
            where: { tenantId: 't1', articleId: 'gone', sourceType: 'KB' },
        });
        expect(mockCreateMany).not.toHaveBeenCalled();
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('removes chunks for an ARCHIVED article — the whole point of the job', async () => {
        mockFindFirst.mockResolvedValue({ ...BASE_ARTICLE, status: 'ARCHIVED' });

        const result = await runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'art-1' });

        expect(result.action).toBe('removed');
        expect(mockDeleteMany).toHaveBeenCalledTimes(1);
        expect(mockCreateMany).not.toHaveBeenCalled();
    });

    it('removes chunks for a DRAFT article', async () => {
        mockFindFirst.mockResolvedValue({ ...BASE_ARTICLE, status: 'DRAFT' });
        const result = await runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'art-1' });
        expect(result.action).toBe('removed');
    });

    it('removes chunks for a soft-deleted article even if status is PUBLISHED', async () => {
        mockFindFirst.mockResolvedValue({ ...BASE_ARTICLE, deletedAt: new Date('2026-01-01') });
        const result = await runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'art-1' });
        expect(result.action).toBe('removed');
    });

    it('removes chunks for a PUBLISHED article with no current-version content', async () => {
        mockFindFirst.mockResolvedValue({ ...BASE_ARTICLE, currentVersion: { contentText: null } });
        const result = await runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'art-1' });
        expect(result.action).toBe('removed');
        expect(mockEnqueue).not.toHaveBeenCalled();
    });
});

describe('runReindexKnowledgeArticle — index branch', () => {
    it('replaces the chunk set for a PUBLISHED article and stamps agronomy metadata', async () => {
        mockFindFirst.mockResolvedValue(BASE_ARTICLE);

        const result = await runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'art-1' });

        expect(result).toEqual({
            tenantId: 't1', articleId: 'art-1', action: 'indexed', chunksWritten: 2, chunksRemoved: 2,
        });
        // Delete-then-insert, in that order, inside the same run.
        expect(mockDeleteMany).toHaveBeenCalledWith({
            where: { tenantId: 't1', articleId: 'art-1', sourceType: 'KB' },
        });
        expect(mockCreateMany).toHaveBeenCalledTimes(1);
        const { data } = mockCreateMany.mock.calls[0][0];
        expect(data).toEqual([
            expect.objectContaining({
                tenantId: 't1', articleId: 'art-1', sourceType: 'KB', sourceRef: 'art-1',
                text: 'Wear gloves.', chunkIndex: 0,
                cropTags: ['wheat'], regions: [], bbchStageMin: 30, bbchStageMax: 39, language: 'bg',
                source: 'Knowledge base: Wheat spray SOP',
            }),
            expect.objectContaining({ text: 'Apply before noon.', chunkIndex: 1 }),
        ]);
    });

    it('uses the article source when set, instead of the title fallback', async () => {
        mockFindFirst.mockResolvedValue({ ...BASE_ARTICLE, source: 'OpenFarm' });
        await runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'art-1' });
        const { data } = mockCreateMany.mock.calls[0][0];
        expect(data[0].source).toBe('OpenFarm');
    });

    it('triggers embed-chunks for the tenant after a successful index', async () => {
        mockFindFirst.mockResolvedValue(BASE_ARTICLE);
        await runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'art-1' });
        expect(mockEnqueue).toHaveBeenCalledWith('embed-chunks', { tenantId: 't1' });
    });

    it('does not call createMany or enqueue when the chunker produces nothing', async () => {
        mockFindFirst.mockResolvedValue({ ...BASE_ARTICLE, currentVersion: { contentText: '<p></p>' } });
        const result = await runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'art-1' });
        expect(result).toMatchObject({ action: 'indexed', chunksWritten: 0 });
        expect(mockCreateMany).not.toHaveBeenCalled();
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('a failed embed-chunks enqueue is logged, not thrown', async () => {
        mockFindFirst.mockResolvedValue(BASE_ARTICLE);
        mockEnqueue.mockRejectedValueOnce(new Error('redis down'));

        await expect(
            runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'art-1' }),
        ).resolves.toMatchObject({ action: 'indexed' });

        expect(logger.warn).toHaveBeenCalledWith(
            'reindex-knowledge-article: embed-chunks enqueue failed',
            expect.objectContaining({ tenantId: 't1', articleId: 'art-1' }),
        );
    });

    it('re-running for the same article is idempotent — always one delete then one insert', async () => {
        mockFindFirst.mockResolvedValue(BASE_ARTICLE);

        await runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'art-1' });
        await runReindexKnowledgeArticle({ tenantId: 't1', articleId: 'art-1' });

        expect(mockDeleteMany).toHaveBeenCalledTimes(2);
        expect(mockCreateMany).toHaveBeenCalledTimes(2);
    });
});
