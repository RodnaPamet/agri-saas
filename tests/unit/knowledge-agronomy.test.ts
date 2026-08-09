/**
 * Knowledge Base agronomy structure (S1-S5, KB agronomy structure PR) +
 * GLOBAL articles (W5 final task, 2026-08-09).
 *
 * Covers what's new in `usecases/knowledge.ts`:
 *   - cropTags/regions sanitisation (trim, dedupe, cap) on create + PATCH
 *   - BBCH range validation (both-or-neither, 0-99, min <= max)
 *   - reindex-knowledge-article is enqueued from publish/archive/unarchive,
 *     AFTER the DB transaction resolves (never from inside the callback —
 *     a job enqueued mid-transaction could race a still-open commit)
 *   - a failed enqueue never fails the request (logged, not thrown)
 *   - `assertTenantOwned` — every tenant-facing write usecase
 *     (updateArticleMetadata, createArticleVersion, publishArticle,
 *     archiveArticle, unarchiveArticle, acknowledgeArticle) rejects a
 *     GLOBAL (`tenantId: null`) article BEFORE calling any repository
 *     write, with a Forbidden error — this is the ONE piece of the W5
 *     migration that can be proven WITHOUT a live database (RLS itself,
 *     the partial unique index, and the composite-FK backstop on
 *     `KnowledgeAcknowledgement` all need Postgres — see
 *     `tests/integration/knowledge-article-rls.test.ts`, cannot run in
 *     this sandbox — PgBouncer is down locally — but runs in CI)
 *   - `getSatelliteGuideArticles` reads via
 *     `KnowledgeRepository.listGlobalByCategory`
 *
 * `KnowledgeRepository` / `KnowledgeVersionRepository` / `logEvent` /
 * `runInTenantContext` / `enqueue` are all mocked — this is a pure
 * usecase-layer test, mirroring `rag-retrieve.test.ts`'s mocking shape.
 * DB-backed behaviour (RLS, real Prisma writes) is covered by
 * `tests/integration/knowledge.test.ts` and
 * `tests/integration/knowledge-article-rls.test.ts` (cannot run in this
 * sandbox — PgBouncer is down locally — but runs in CI).
 */
const mockGetById = jest.fn();
const mockGetBySlug = jest.fn();
const mockCreate = jest.fn();
const mockUpdateMetadata = jest.fn();
const mockUpdateStatus = jest.fn();
const mockSetCurrentVersion = jest.fn();
const mockListGlobalByCategory = jest.fn();
jest.mock('@/app-layer/repositories/KnowledgeRepository', () => ({
    KnowledgeRepository: {
        getById: (...a: unknown[]) => mockGetById(...a),
        getBySlug: (...a: unknown[]) => mockGetBySlug(...a),
        create: (...a: unknown[]) => mockCreate(...a),
        updateMetadata: (...a: unknown[]) => mockUpdateMetadata(...a),
        updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
        setCurrentVersion: (...a: unknown[]) => mockSetCurrentVersion(...a),
        listGlobalByCategory: (...a: unknown[]) => mockListGlobalByCategory(...a),
    },
}));

const mockVersionGetById = jest.fn();
const mockVersionCreate = jest.fn();
jest.mock('@/app-layer/repositories/KnowledgeVersionRepository', () => ({
    KnowledgeVersionRepository: {
        getById: (...a: unknown[]) => mockVersionGetById(...a),
        create: (...a: unknown[]) => mockVersionCreate(...a),
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
    createArticleVersion,
    publishArticle,
    archiveArticle,
    unarchiveArticle,
    acknowledgeArticle,
    getSatelliteGuideArticles,
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

// ─── GLOBAL articles (W5 final task) — read-only for every tenant ───

describe('GLOBAL (tenantId null) articles reject every tenant-facing write', () => {
    const globalArticle = { id: 'art-global', tenantId: null, status: 'PUBLISHED', currentVersionId: 'v-global', title: 'Global' };

    beforeEach(() => {
        mockGetById.mockResolvedValue(globalArticle);
    });

    it('updateArticleMetadata rejects with a Forbidden error, never reaching the repository write', async () => {
        await expect(updateArticleMetadata(ctx, 'art-global', { title: 'Hacked' })).rejects.toThrow(
            /platform-authored and read-only/,
        );
        expect(mockUpdateMetadata).not.toHaveBeenCalled();
    });

    it('createArticleVersion rejects before touching the version repository', async () => {
        await expect(
            createArticleVersion(ctx, 'art-global', { contentType: 'HTML', contentText: '<p>hi</p>' }),
        ).rejects.toThrow(/platform-authored and read-only/);
        expect(mockVersionCreate).not.toHaveBeenCalled();
    });

    it('publishArticle rejects before looking up the version or touching the status', async () => {
        await expect(publishArticle(ctx, 'art-global', 'v-global')).rejects.toThrow(
            /platform-authored and read-only/,
        );
        expect(mockVersionGetById).not.toHaveBeenCalled();
        expect(mockUpdateStatus).not.toHaveBeenCalled();
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('archiveArticle rejects before touching the status', async () => {
        await expect(archiveArticle(ctx, 'art-global')).rejects.toThrow(/platform-authored and read-only/);
        expect(mockUpdateStatus).not.toHaveBeenCalled();
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('unarchiveArticle rejects even though the article is not ARCHIVED (guard runs first)', async () => {
        await expect(unarchiveArticle(ctx, 'art-global')).rejects.toThrow(/platform-authored and read-only/);
        expect(mockUpdateStatus).not.toHaveBeenCalled();
    });

    it('acknowledgeArticle rejects before ever touching db.knowledgeAcknowledgement', async () => {
        // runInTenantContext is mocked to hand back an empty `{}` as `db` —
        // if the guard did NOT run first, the next line in acknowledgeArticle
        // (`db.knowledgeAcknowledgement.findUnique`) would throw a
        // "not a function" TypeError instead of the Forbidden error asserted
        // here, so this test also proves the guard's ordering.
        await expect(acknowledgeArticle(ctx, 'art-global')).rejects.toThrow(/platform-authored and read-only/);
    });

    it('a bogus id still gets the plain notFound error, not the Forbidden one', async () => {
        mockGetById.mockResolvedValue(null);
        await expect(updateArticleMetadata(ctx, 'does-not-exist', { title: 'x' })).rejects.toThrow(
            'Article not found',
        );
    });
});

// ─── Satellite-imagery guide read (W5 final task) ───

describe('getSatelliteGuideArticles', () => {
    it('reads GLOBAL "Satellite Imagery" articles for the requested language', async () => {
        const rows = [{ id: 'a1', slug: 'satellite-ndvi-bg', title: 'NDVI', summary: null, language: 'bg', currentVersion: null }];
        mockListGlobalByCategory.mockResolvedValue(rows);

        const result = await getSatelliteGuideArticles(ctx, 'bg');

        expect(result).toBe(rows);
        expect(mockListGlobalByCategory).toHaveBeenCalledWith({}, 'Satellite Imagery', 'bg');
    });
});
