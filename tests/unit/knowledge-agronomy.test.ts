/**
 * Knowledge Base agronomy structure (S1-S5, KB agronomy structure PR).
 *
 * Covers what's new in `usecases/knowledge.ts`:
 *   - cropTags/regions sanitisation (trim, dedupe, cap) on create + PATCH
 *   - BBCH range validation (both-or-neither, 0-99, min <= max)
 *   - reindex-knowledge-article is enqueued from publish/archive/unarchive,
 *     AFTER the DB transaction resolves (never from inside the callback —
 *     a job enqueued mid-transaction could race a still-open commit)
 *   - a failed enqueue never fails the request (logged, not thrown)
 *
 * `KnowledgeRepository` / `KnowledgeVersionRepository` / `logEvent` /
 * `runInTenantContext` / `enqueue` are all mocked — this is a pure
 * usecase-layer test, mirroring `rag-retrieve.test.ts`'s mocking shape.
 * DB-backed behaviour (RLS, real Prisma writes) is covered by
 * `tests/integration/knowledge.test.ts` (cannot run in this sandbox —
 * PgBouncer is down locally — but runs in CI).
 */
const mockGetById = jest.fn();
const mockGetBySlug = jest.fn();
const mockCreate = jest.fn();
const mockUpdateMetadata = jest.fn();
const mockUpdateStatus = jest.fn();
const mockSetCurrentVersion = jest.fn();
jest.mock('@/app-layer/repositories/KnowledgeRepository', () => ({
    KnowledgeRepository: {
        getById: (...a: unknown[]) => mockGetById(...a),
        getBySlug: (...a: unknown[]) => mockGetBySlug(...a),
        create: (...a: unknown[]) => mockCreate(...a),
        updateMetadata: (...a: unknown[]) => mockUpdateMetadata(...a),
        updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
        setCurrentVersion: (...a: unknown[]) => mockSetCurrentVersion(...a),
    },
}));

const mockVersionGetById = jest.fn();
jest.mock('@/app-layer/repositories/KnowledgeVersionRepository', () => ({
    KnowledgeVersionRepository: {
        getById: (...a: unknown[]) => mockVersionGetById(...a),
    },
}));

const mockLogEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({})),
}));

const mockEnqueue = jest.fn().mockResolvedValue(undefined);
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: (...a: unknown[]) => mockEnqueue(...a) }));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logger } from '@/lib/observability/logger';
import {
    createArticle,
    updateArticleMetadata,
    publishArticle,
    archiveArticle,
    unarchiveArticle,
} from '@/app-layer/usecases/knowledge';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1' });

beforeEach(() => {
    jest.clearAllMocks();
    mockGetBySlug.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: 'art-1', slug: 'wheat-sop', title: 'Wheat SOP' });
});

// ─── Crop tags / regions sanitisation ───

describe('createArticle — cropTags/regions sanitisation', () => {
    it('trims, dedupes case-insensitively, and caps at 20', async () => {
        const cropTags = [' Wheat ', 'wheat', 'Barley', ...Array.from({ length: 25 }, (_, i) => `crop${i}`)];
        await createArticle(ctx, { title: 'Test', cropTags });

        const passed = mockCreate.mock.calls[0][2].cropTags;
        expect(passed).toEqual(['Wheat', 'Barley', ...Array.from({ length: 18 }, (_, i) => `crop${i}`)]);
        expect(passed.length).toBe(20);
    });

    it('drops empty / whitespace-only entries', async () => {
        await createArticle(ctx, { title: 'Test', regions: ['  ', '', 'Северна България'] });
        expect(mockCreate.mock.calls[0][2].regions).toEqual(['Северна България']);
    });

    it('leaves cropTags/regions undefined (no change) when omitted', async () => {
        await createArticle(ctx, { title: 'Test' });
        expect(mockCreate.mock.calls[0][2].cropTags).toBeUndefined();
        expect(mockCreate.mock.calls[0][2].regions).toBeUndefined();
    });
});

// ─── BBCH range validation ───

describe('BBCH stage range validation', () => {
    it('rejects a lone bbchStageMin with no bbchStageMax', async () => {
        await expect(createArticle(ctx, { title: 'Test', bbchStageMin: 30 })).rejects.toThrow(
            /must both be set or both be omitted/,
        );
    });

    it('rejects min > max', async () => {
        await expect(
            createArticle(ctx, { title: 'Test', bbchStageMin: 60, bbchStageMax: 30 }),
        ).rejects.toThrow(/less than or equal to/);
    });

    it('rejects an out-of-range stage', async () => {
        await expect(
            createArticle(ctx, { title: 'Test', bbchStageMin: -1, bbchStageMax: 30 }),
        ).rejects.toThrow(/between 0 and 99/);
        await expect(
            createArticle(ctx, { title: 'Test', bbchStageMin: 0, bbchStageMax: 100 }),
        ).rejects.toThrow(/between 0 and 99/);
    });

    it('accepts a valid range and passes it through', async () => {
        await createArticle(ctx, { title: 'Test', bbchStageMin: 30, bbchStageMax: 39 });
        expect(mockCreate.mock.calls[0][2]).toMatchObject({ bbchStageMin: 30, bbchStageMax: 39 });
    });

    it('accepts both omitted (not stage-specific)', async () => {
        await createArticle(ctx, { title: 'Test' });
        expect(mockCreate.mock.calls[0][2]).toMatchObject({ bbchStageMin: null, bbchStageMax: null });
    });

    it('PATCH: rejects a half-set range the same way as create', async () => {
        mockGetById.mockResolvedValue({ id: 'art-1', title: 'Existing' });
        await expect(
            updateArticleMetadata(ctx, 'art-1', { bbchStageMax: 39 }),
        ).rejects.toThrow(/must both be set or both be omitted/);
    });

    it('PATCH: both null clears a previously-set range', async () => {
        mockGetById.mockResolvedValue({ id: 'art-1', title: 'Existing' });
        await updateArticleMetadata(ctx, 'art-1', { bbchStageMin: null, bbchStageMax: null });
        expect(mockUpdateMetadata).toHaveBeenCalledWith(
            {}, ctx, 'art-1',
            expect.objectContaining({ bbchStageMin: null, bbchStageMax: null }),
        );
    });
});

// ─── Reindex enqueue wiring (S4/S5) ───

describe('publishArticle enqueues reindex-knowledge-article', () => {
    beforeEach(() => {
        mockGetById.mockResolvedValue({ id: 'art-1', status: 'DRAFT', title: 'Wheat SOP' });
        mockVersionGetById.mockResolvedValue({ id: 'v1', versionNumber: 1, article: { id: 'art-1' } });
    });

    it('enqueues with the tenantId + articleId', async () => {
        await publishArticle(ctx, 'art-1', 'v1');
        expect(mockEnqueue).toHaveBeenCalledWith('reindex-knowledge-article', {
            tenantId: 't1', articleId: 'art-1',
        });
    });

    it('enqueues AFTER runInTenantContext resolves, not from inside the callback', async () => {
        const order: string[] = [];
        // *Once variants — never leaks into later tests sharing these mocks.
        mockUpdateStatus.mockImplementationOnce(async () => { order.push('updateStatus'); });
        mockEnqueue.mockImplementationOnce(async () => { order.push('enqueue'); });

        await publishArticle(ctx, 'art-1', 'v1');

        expect(order).toEqual(['updateStatus', 'enqueue']);
    });

    it('a failed enqueue is logged, not thrown — publish still succeeds', async () => {
        mockEnqueue.mockRejectedValueOnce(new Error('redis down'));
        await expect(publishArticle(ctx, 'art-1', 'v1')).resolves.toBeDefined();
        expect(logger.warn).toHaveBeenCalledWith(
            'knowledge: reindex-knowledge-article enqueue failed',
            expect.objectContaining({ tenantId: 't1', articleId: 'art-1' }),
        );
    });
});

describe('archiveArticle enqueues reindex-knowledge-article', () => {
    it('enqueues so archive REMOVES the article from retrieval', async () => {
        mockGetById.mockResolvedValue({ id: 'art-1', status: 'PUBLISHED', title: 'Wheat SOP' });
        await archiveArticle(ctx, 'art-1');
        expect(mockEnqueue).toHaveBeenCalledWith('reindex-knowledge-article', {
            tenantId: 't1', articleId: 'art-1',
        });
    });
});

describe('unarchiveArticle enqueues reindex-knowledge-article only when restored to PUBLISHED', () => {
    it('enqueues when the article had been published before (lifecycleVersion > 1)', async () => {
        mockGetById
            .mockResolvedValueOnce({ id: 'art-1', status: 'ARCHIVED', lifecycleVersion: 2, title: 'Wheat SOP' })
            .mockResolvedValueOnce({ id: 'art-1', status: 'PUBLISHED' });
        await unarchiveArticle(ctx, 'art-1');
        expect(mockEnqueue).toHaveBeenCalledWith('reindex-knowledge-article', {
            tenantId: 't1', articleId: 'art-1',
        });
    });

    it('does NOT enqueue when restored to DRAFT (never published before)', async () => {
        mockGetById
            .mockResolvedValueOnce({ id: 'art-1', status: 'ARCHIVED', lifecycleVersion: 1, title: 'Wheat SOP' })
            .mockResolvedValueOnce({ id: 'art-1', status: 'DRAFT' });
        await unarchiveArticle(ctx, 'art-1');
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('does NOT enqueue on the idempotent no-op path (already not ARCHIVED)', async () => {
        mockGetById.mockResolvedValue({ id: 'art-1', status: 'PUBLISHED', lifecycleVersion: 2 });
        await unarchiveArticle(ctx, 'art-1');
        expect(mockEnqueue).not.toHaveBeenCalled();
    });
});
