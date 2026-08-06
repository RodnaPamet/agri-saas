/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock
 * pattern; per-line typing has poor cost/benefit ratio. */

/**
 * The support-scheme read side.
 *
 * Two properties carry the feature:
 *
 *   1. **The tenant-facing read returns APPROVED rows only.** An unreviewed AI
 *      extraction is a guess, and a farmer acting on a guessed ДФЗ deadline can
 *      lose money. Filtering in the query rather than in the UI means a future
 *      page cannot forget it.
 *   2. **Window status is DERIVED from the dates**, not read from the stored
 *      column. A stored status is a fact about the past — nobody wants a farmer
 *      reading "open" on 1 October about a window that shut in September.
 */

const mockPrisma = {
    supportScheme: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
} as any;

jest.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
    listSupportSchemes,
    listPendingSupportSchemes,
    reviewSupportScheme,
} from '@/app-layer/usecases/support-schemes';
import { deriveWindowStatus } from '@/app-layer/schemas/support-scheme.schemas';

const NOW = new Date('2026-08-06T00:00:00.000Z');

function row(over: Record<string, unknown> = {}) {
    return {
        id: 's-1',
        title: 'Мярка 4.1',
        summary: null,
        authority: 'ДФЗ',
        measureCode: '4.1',
        status: 'announced',
        applicationOpensAt: new Date('2026-09-01T00:00:00.000Z'),
        applicationClosesAt: new Date('2026-09-30T00:00:00.000Z'),
        eligibilitySummary: null,
        budgetAmount: null,
        budgetCurrency: null,
        sourceUrl: 'https://example.test/a',
        source: 'ai-news',
        sourceTitle: 'ДФЗ отваря прием',
        confidence: 0.9,
        extractedAt: new Date('2026-08-05T00:00:00.000Z'),
        ...over,
    };
}

beforeEach(() => jest.clearAllMocks());

describe('the tenant-facing read', () => {
    it('asks the database for APPROVED rows only', async () => {
        // The single most important clause in the feature. Filtering here
        // rather than in the UI means an unreviewed row is unreachable by
        // construction, not by convention.
        mockPrisma.supportScheme.findMany.mockResolvedValue([]);
        await listSupportSchemes({}, { now: NOW });
        expect(mockPrisma.supportScheme.findMany.mock.calls[0][0].where.reviewStatus).toBe('APPROVED');
    });

    it('orders by soonest deadline', async () => {
        mockPrisma.supportScheme.findMany.mockResolvedValue([]);
        await listSupportSchemes({}, { now: NOW });
        expect(mockPrisma.supportScheme.findMany.mock.calls[0][0].orderBy[0]).toEqual({
            applicationClosesAt: 'asc',
        });
    });

    it('carries provenance through to the row', async () => {
        // An AI reading of a news article and an official announcement must
        // never be indistinguishable — the UI needs all four fields to say so.
        mockPrisma.supportScheme.findMany.mockResolvedValue([row()]);
        const [r] = await listSupportSchemes({}, { now: NOW });
        expect(r.source).toBe('ai-news');
        expect(r.sourceUrl).toBe('https://example.test/a');
        expect(r.confidence).toBe(0.9);
        expect(r.extractedAt).toBe('2026-08-05T00:00:00.000Z');
    });

    it('filters by authority in the query', async () => {
        mockPrisma.supportScheme.findMany.mockResolvedValue([]);
        await listSupportSchemes({ authority: 'ДФЗ' }, { now: NOW });
        expect(mockPrisma.supportScheme.findMany.mock.calls[0][0].where.authority).toBe('ДФЗ');
    });

    it('filters by DERIVED status in memory, because it is not a column', async () => {
        mockPrisma.supportScheme.findMany.mockResolvedValue([
            row({ id: 'open', applicationOpensAt: new Date('2026-08-01T00:00:00.000Z') }),
            row({ id: 'future' }),
        ]);
        const res = await listSupportSchemes({ status: 'open' }, { now: NOW });
        expect(res.map((r) => r.id)).toEqual(['open']);
    });
});

describe('window status is derived, not stored', () => {
    it.each([
        ['before it opens', '2026-09-01', '2026-09-30', 'announced'],
        ['while open', '2026-08-01', '2026-12-31', 'open'],
        ['closing within a fortnight', '2026-08-01', '2026-08-15', 'closing-soon'],
        ['after it closed', '2026-06-01', '2026-06-30', 'closed'],
    ])('%s → %s', (_label, opens, closes, expected) => {
        expect(deriveWindowStatus(opens, closes, NOW)).toBe(expected);
    });

    it('falls back to the stored value when there are no dates at all', () => {
        // A curated row may state a status without a window; there is nothing
        // to derive from, so the stored value is the only answer.
        expect(deriveWindowStatus(null, null, NOW, 'announced')).toBe('announced');
    });

    it('ignores a stored value that is not a known status', () => {
        expect(deriveWindowStatus(null, null, NOW, 'nonsense')).toBe('announced');
    });

    it('overrides a stale stored status once the deadline has passed', () => {
        // The reason derivation exists. A row stored as "open" in June is
        // still stored as "open" in October.
        expect(deriveWindowStatus('2026-06-01', '2026-06-30', NOW, 'open')).toBe('closed');
    });
});

describe('the platform review queue', () => {
    it('lists PROPOSED rows', async () => {
        mockPrisma.supportScheme.findMany.mockResolvedValue([]);
        await listPendingSupportSchemes({ now: NOW });
        expect(mockPrisma.supportScheme.findMany.mock.calls[0][0].where.reviewStatus).toBe('PROPOSED');
    });

    it('records who decided and when', async () => {
        mockPrisma.supportScheme.findUnique.mockResolvedValue(row());
        mockPrisma.supportScheme.update.mockResolvedValue(row({ reviewStatus: 'APPROVED' }));

        await reviewSupportScheme('s-1', 'APPROVED', 'req-123');

        const data = mockPrisma.supportScheme.update.mock.calls[0][0].data;
        expect(data.reviewStatus).toBe('APPROVED');
        expect(data.reviewedBy).toBe('req-123');
        expect(data.reviewedAt).toBeInstanceOf(Date);
    });

    it('rejects too', async () => {
        mockPrisma.supportScheme.findUnique.mockResolvedValue(row());
        mockPrisma.supportScheme.update.mockResolvedValue(row({ reviewStatus: 'REJECTED' }));
        await reviewSupportScheme('s-1', 'REJECTED', 'req-123');
        expect(mockPrisma.supportScheme.update.mock.calls[0][0].data.reviewStatus).toBe('REJECTED');
    });

    it('404s on an unknown id rather than creating one', async () => {
        mockPrisma.supportScheme.findUnique.mockResolvedValue(null);
        await expect(reviewSupportScheme('nope', 'APPROVED', 'req')).rejects.toThrow(/not found/i);
        expect(mockPrisma.supportScheme.update).not.toHaveBeenCalled();
    });
});
