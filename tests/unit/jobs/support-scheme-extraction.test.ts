/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock
 * pattern; per-line typing has poor cost/benefit ratio. */

/**
 * The weekly support-scheme extraction job.
 *
 * The acceptance criteria this file exists to hold:
 *
 *   - with no `ANTHROPIC_API_KEY` the job never calls the model and never
 *     writes a row (and the schedule never registers at all — see
 *     `schedules.ts`, asserted separately);
 *   - every row lands PROPOSED with its provenance stamped, so an AI reading
 *     of a news article is never indistinguishable from an official
 *     announcement;
 *   - a re-run over an overlapping lookback window never duplicates.
 */

const mockDb = {
    marketNewsItem: { findMany: jest.fn() },
    supportScheme: { createMany: jest.fn() },
} as any;

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockDb, prisma: mockDb }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/app-layer/ai/cost', () => ({ estimateCostMicros: jest.fn(() => 42) }));

import { runSupportSchemeExtraction } from '@/app-layer/jobs/support-scheme-extraction';
import { logger } from '@/lib/observability/logger';

const NOW = new Date('2026-08-06T00:00:00.000Z');
const now = () => NOW;

const NEWS_ROW = {
    id: 'news-1',
    title: 'ДФЗ отваря прием по мярка 4.1',
    summary: 'Приемът започва на 01.09.2026 г.',
    url: 'https://example.test/news-1',
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
};

const EXTRACTED = {
    sourceNewsItemId: 'news-1',
    title: 'Мярка 4.1',
    authority: 'ДФЗ' as const,
    measureCode: '4.1',
    status: 'announced' as const,
    applicationOpensAt: '2026-09-01',
    applicationClosesAt: '2026-09-30',
    eligibilitySummary: 'Земеделски стопани.',
    confidence: 0.9,
    sourceExcerpt: 'Приемът започва на 01.09.2026 г.',
};

beforeEach(() => {
    jest.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockDb.marketNewsItem.findMany.mockResolvedValue([NEWS_ROW]);
    mockDb.supportScheme.createMany.mockResolvedValue({ count: 1 });
});

describe('no key configured', () => {
    it('no-ops without calling the model or writing anything', async () => {
        // The acceptance criterion: "with no ANTHROPIC_API_KEY the job never
        // schedules and the page renders official/curated entries only."
        delete process.env.ANTHROPIC_API_KEY;
        const extractImpl = jest.fn();

        const res = await runSupportSchemeExtraction({}, { db: mockDb, extractImpl, now });

        expect(res).toEqual({ scanned: 0, extracted: 0, created: 0, skipped: 0 });
        expect(extractImpl).not.toHaveBeenCalled();
        expect(mockDb.supportScheme.createMany).not.toHaveBeenCalled();
        // It must not even read the news cache.
        expect(mockDb.marketNewsItem.findMany).not.toHaveBeenCalled();
    });
});

describe('input selection', () => {
    it('reads only policy-category items inside the lookback window', async () => {
        // `category: 'policy'` is set by lib/news/categorize.ts on the
        // Bulgarian subsidy stems — reused rather than re-derived.
        const extractImpl = jest.fn(async () => ({ schemes: [], usage: null }));
        await runSupportSchemeExtraction({}, { db: mockDb, extractImpl, now });

        const where = mockDb.marketNewsItem.findMany.mock.calls[0][0].where;
        expect(where.category).toBe('policy');
        expect(where.publishedAt.gt).toBeInstanceOf(Date);
        // Weekly cadence ⇒ an 8-day window, so one missed run is caught up.
        const hours = (NOW.getTime() - where.publishedAt.gt.getTime()) / 3_600_000;
        expect(hours).toBe(8 * 24);
    });

    it('honours a lookbackHours override for backfills', async () => {
        const extractImpl = jest.fn(async () => ({ schemes: [], usage: null }));
        await runSupportSchemeExtraction({ lookbackHours: 72 }, { db: mockDb, extractImpl, now });
        const where = mockDb.marketNewsItem.findMany.mock.calls[0][0].where;
        expect((NOW.getTime() - where.publishedAt.gt.getTime()) / 3_600_000).toBe(72);
    });

    it('skips the model call when there is nothing to read', async () => {
        mockDb.marketNewsItem.findMany.mockResolvedValue([]);
        const extractImpl = jest.fn();
        const res = await runSupportSchemeExtraction({}, { db: mockDb, extractImpl, now });
        expect(extractImpl).not.toHaveBeenCalled();
        expect(res.scanned).toBe(0);
    });
});

describe('what it writes', () => {
    it('lands every row PROPOSED with its provenance stamped', async () => {
        const extractImpl = jest.fn(async () => ({
            schemes: [EXTRACTED],
            usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        }));

        await runSupportSchemeExtraction({}, { db: mockDb, extractImpl, now });

        const { data } = mockDb.supportScheme.createMany.mock.calls[0][0];
        expect(data).toHaveLength(1);
        const row = data[0];

        // Provenance — the thing that keeps an AI reading distinguishable from
        // an official announcement, in the database and on screen.
        expect(row.source).toBe('ai-news');
        expect(row.sourceNewsItemId).toBe('news-1');
        expect(row.sourceUrl).toBe(NEWS_ROW.url);
        expect(row.sourceTitle).toBe(NEWS_ROW.title);
        expect(row.confidence).toBe(0.9);
        expect(row.sourceExcerpt).toBe(EXTRACTED.sourceExcerpt);
        expect(row.extractedAt).toEqual(NOW);

        // PROPOSED is the schema default and the job never overrides it —
        // there is no code path here that can publish.
        expect(row).not.toHaveProperty('reviewStatus');
    });

    it('parses the window dates as UTC midnight', async () => {
        const extractImpl = jest.fn(async () => ({ schemes: [EXTRACTED], usage: null }));
        await runSupportSchemeExtraction({}, { db: mockDb, extractImpl, now });
        const row = mockDb.supportScheme.createMany.mock.calls[0][0].data[0];
        expect(row.applicationOpensAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
        expect(row.applicationClosesAt.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    });

    it('claims idempotently, so a re-run cannot duplicate', async () => {
        const extractImpl = jest.fn(async () => ({ schemes: [EXTRACTED], usage: null }));
        await runSupportSchemeExtraction({}, { db: mockDb, extractImpl, now });
        expect(mockDb.supportScheme.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    });

    it('reports what the DB actually accepted, not what was extracted', async () => {
        // A re-run over an overlapping window extracts the same scheme again;
        // `created` must reflect the rows that landed, or the log claims work
        // that did not happen.
        mockDb.supportScheme.createMany.mockResolvedValue({ count: 0 });
        const extractImpl = jest.fn(async () => ({ schemes: [EXTRACTED], usage: null }));
        const res = await runSupportSchemeExtraction({}, { db: mockDb, extractImpl, now });
        expect(res).toMatchObject({ extracted: 1, created: 0, skipped: 1 });
    });

    it('writes nothing when the extractor returns nothing', async () => {
        const extractImpl = jest.fn(async () => ({ schemes: [], usage: null }));
        const res = await runSupportSchemeExtraction({}, { db: mockDb, extractImpl, now });
        expect(mockDb.supportScheme.createMany).not.toHaveBeenCalled();
        expect(res).toMatchObject({ scanned: 1, extracted: 0, created: 0 });
    });
});

describe('token accounting', () => {
    it('logs usage explicitly — there is no AiUsageEvent ledger for a global job', async () => {
        // `AiUsageEvent` requires a non-null tenantId and this job has no
        // tenant, so a log line is the ledger.
        const extractImpl = jest.fn(async () => ({
            schemes: [],
            usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        }));
        await runSupportSchemeExtraction({}, { db: mockDb, extractImpl, now });

        expect(logger.info).toHaveBeenCalledWith(
            'support-scheme-extraction: ai usage',
            expect.objectContaining({ totalTokens: 120, costMicros: 42 }),
        );
    });
});
