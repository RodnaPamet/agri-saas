/**
 * Unit tests for runNewsEventExtraction with injected db + extractor seams
 * (no network, no DB, no real Anthropic call). Pins: the policy-only +
 * lookback-window query, the ANTHROPIC_API_KEY no-op gate, the
 * createMany({ skipDuplicates }) idempotent-claim dedup, and the
 * denormalised sourceUrl/sourceTitle snapshot on each written row.
 */
const envMock: { ANTHROPIC_API_KEY?: string } = { ANTHROPIC_API_KEY: 'sk-test' };
jest.mock('@/env', () => ({ env: envMock }));

import { runNewsEventExtraction } from '@/app-layer/jobs/news-event-extraction';
import type {
    ExtractedNewsEvent,
    NewsEventExtractionResult,
    NewsPolicyItemInput,
} from '@/app-layer/ai/news-event-extractor';

function policyItem(over: Record<string, unknown> = {}) {
    return {
        id: 'item-1',
        title: 'ДФЗ subsidy window',
        summary: 'summary',
        url: 'https://dfz.bg/a1',
        publishedAt: new Date('2026-08-05T09:00:00Z'),
        ...over,
    };
}

function extracted(over: Partial<ExtractedNewsEvent> = {}): ExtractedNewsEvent {
    return {
        sourceNewsItemId: 'item-1',
        kind: 'subsidy-deadline',
        title: 'ДФЗ subsidy window opens',
        eventDate: '2026-09-15',
        confidence: 0.9,
        sourceExcerpt: 'ДФЗ subsidy window',
        ...over,
    };
}

/** Typed extractor stub — keeps `.mock.calls[0][0]` typed as `NewsPolicyItemInput[]`. */
function fakeExtract(result: NewsEventExtractionResult) {
    return jest.fn(async (_items: NewsPolicyItemInput[], _opts?: { now?: Date }) => result);
}

function fakeDb(items: ReturnType<typeof policyItem>[] = [policyItem()]) {
    const findMany = jest.fn().mockResolvedValue(items);
    const created: unknown[] = [];
    const createMany = jest.fn(async (args: { data: unknown[]; skipDuplicates?: boolean }) => {
        created.push(...args.data);
        return { count: args.data.length };
    });
    return {
        marketNewsItem: { findMany },
        newsDerivedEvent: { createMany },
        _created: created,
    };
}

const NOW = () => new Date('2026-08-06T00:00:00Z');

beforeEach(() => {
    jest.clearAllMocks();
    envMock.ANTHROPIC_API_KEY = 'sk-test';
});

describe('runNewsEventExtraction', () => {
    it('queries only category: policy within the lookback window', async () => {
        const db = fakeDb();
        const extractImpl = fakeExtract({ events: [], usage: null });

        await runNewsEventExtraction({}, { db: db as never, extractImpl, now: NOW });

        expect(db.marketNewsItem.findMany).toHaveBeenCalledTimes(1);
        const call = db.marketNewsItem.findMany.mock.calls[0][0];
        expect(call.where.category).toBe('policy');
        // Default 36h lookback from NOW (2026-08-06T00:00Z) -> 2026-08-04T12:00Z.
        expect(call.where.publishedAt.gt.toISOString()).toBe('2026-08-04T12:00:00.000Z');
    });

    it('honors a payload-supplied lookbackHours override', async () => {
        const db = fakeDb();
        const extractImpl = fakeExtract({ events: [], usage: null });

        await runNewsEventExtraction({ lookbackHours: 12 }, { db: db as never, extractImpl, now: NOW });

        const call = db.marketNewsItem.findMany.mock.calls[0][0];
        expect(call.where.publishedAt.gt.toISOString()).toBe('2026-08-05T12:00:00.000Z');
    });

    it('is a no-op when ANTHROPIC_API_KEY is unset — never queries the DB', async () => {
        envMock.ANTHROPIC_API_KEY = undefined;
        const db = fakeDb();
        const extractImpl = jest.fn();

        const result = await runNewsEventExtraction({}, { db: db as never, extractImpl: extractImpl as never, now: NOW });

        expect(result).toEqual({ scanned: 0, extracted: 0, created: 0, skipped: 0 });
        expect(db.marketNewsItem.findMany).not.toHaveBeenCalled();
        expect(extractImpl).not.toHaveBeenCalled();
    });

    it('is a no-op when there are no policy items in the window', async () => {
        const db = fakeDb([]);
        const extractImpl = jest.fn();

        const result = await runNewsEventExtraction({}, { db: db as never, extractImpl: extractImpl as never, now: NOW });

        expect(result).toEqual({ scanned: 0, extracted: 0, created: 0, skipped: 0 });
        expect(extractImpl).not.toHaveBeenCalled();
    });

    it('writes rows via createMany({ skipDuplicates: true }) with a denormalised source snapshot', async () => {
        const db = fakeDb([policyItem()]);
        const extractImpl = fakeExtract({
            events: [extracted()],
            usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        });

        const result = await runNewsEventExtraction({}, { db: db as never, extractImpl, now: NOW });

        expect(db.newsDerivedEvent.createMany).toHaveBeenCalledTimes(1);
        const args = db.newsDerivedEvent.createMany.mock.calls[0][0];
        expect(args.skipDuplicates).toBe(true);
        expect(args.data).toHaveLength(1);
        const row = args.data[0] as { eventDate: Date; [key: string]: unknown };
        expect(row).toMatchObject({
            title: 'ДФЗ subsidy window opens',
            kind: 'subsidy-deadline',
            sourceNewsItemId: 'item-1',
            sourceUrl: 'https://dfz.bg/a1',
            sourceTitle: 'ДФЗ subsidy window',
            confidence: 0.9,
        });
        expect(row.eventDate.toISOString()).toBe('2026-09-15T00:00:00.000Z');
        expect(result).toEqual({ scanned: 1, extracted: 1, created: 1, skipped: 0 });
    });

    it('reports a skip when the unique-key claim collides (dedup across runs)', async () => {
        const db = fakeDb([policyItem()]);
        // Simulate the DB claiming 0 of 1 rows — a same (sourceNewsItemId,
        // kind) row already exists from a prior run.
        db.newsDerivedEvent.createMany.mockResolvedValueOnce({ count: 0 });
        const extractImpl = fakeExtract({ events: [extracted()], usage: null });

        const result = await runNewsEventExtraction({}, { db: db as never, extractImpl, now: NOW });

        expect(result).toEqual({ scanned: 1, extracted: 1, created: 0, skipped: 1 });
    });

    it('passes the fetched policy items to the extractor as NewsPolicyItemInput', async () => {
        const db = fakeDb([policyItem({ id: 'x1', summary: null })]);
        const extractImpl = fakeExtract({ events: [], usage: null });

        await runNewsEventExtraction({}, { db: db as never, extractImpl, now: NOW });

        expect(extractImpl).toHaveBeenCalledTimes(1);
        const [items] = extractImpl.mock.calls[0];
        expect(items).toEqual([
            {
                id: 'x1',
                title: 'ДФЗ subsidy window',
                summary: null,
                url: 'https://dfz.bg/a1',
                publishedAt: '2026-08-05T09:00:00.000Z',
            },
        ]);
    });
});
