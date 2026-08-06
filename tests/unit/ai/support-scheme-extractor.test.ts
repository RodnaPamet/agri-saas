/**
 * The support-scheme extractor's backstops.
 *
 * This is the test that matters most in the feature. A farmer who misses a
 * real ДФЗ application window because an AI-extracted date was three days off
 * suffers direct financial harm — so the interesting behaviour is not what the
 * extractor returns, it is what it REFUSES to return.
 *
 * Five backstops, in ascending order of how much they are trusted:
 *
 *   1. The verbatim-excerpt check — the model must quote text we actually
 *      supplied. A paraphrase fails even when the date is right, because then
 *      we cannot show a reviewer what it read.
 *   2. Date bounds [today, today+18mo].
 *   3. A confidence floor.
 *   4. A per-run cap.
 *   5. PROPOSED status + human approval — the one that actually holds. The
 *      other four only reduce how much a reviewer has to reject.
 *
 * `applyBackstops` is exported and tested directly rather than through the
 * Anthropic client: the network call is not the risk, the acceptance criteria
 * are.
 */
import {
    applyBackstops,
    MAX_SCHEMES_PER_RUN,
    MIN_CONFIDENCE,
    type ExtractedSupportScheme,
    type NewsPolicyItemInput,
} from '@/app-layer/ai/support-scheme-extractor';

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const NOW = new Date('2026-08-06T00:00:00.000Z');

const ITEM: NewsPolicyItemInput = {
    id: 'news-1',
    title: 'ДФЗ отваря прием по мярка 4.1',
    summary:
        'Приемът на заявления започва на 01.09.2026 г. и продължава до 30.09.2026 г. ' +
        'Кандидатстват земеделски стопани с регистрация по Наредба 3.',
    publishedAt: '2026-08-01T00:00:00.000Z',
    url: 'https://example.test/news-1',
};

const ITEMS = new Map([[ITEM.id, ITEM]]);

function scheme(over: Partial<ExtractedSupportScheme> = {}): ExtractedSupportScheme {
    return {
        sourceNewsItemId: 'news-1',
        title: 'Мярка 4.1 — инвестиции в стопанства',
        authority: 'ДФЗ',
        measureCode: '4.1',
        status: 'announced',
        applicationOpensAt: '2026-09-01',
        applicationClosesAt: '2026-09-30',
        eligibilitySummary: 'Земеделски стопани с регистрация по Наредба 3.',
        confidence: 0.9,
        sourceExcerpt: 'Приемът на заявления започва на 01.09.2026 г. и продължава до 30.09.2026 г.',
        ...over,
    };
}

beforeEach(() => jest.clearAllMocks());

describe('the happy path', () => {
    it('keeps a well-formed scheme', () => {
        const kept = applyBackstops([scheme()], ITEMS, NOW);
        expect(kept).toHaveLength(1);
        expect(kept[0].measureCode).toBe('4.1');
    });
});

describe('what it refuses', () => {
    it('drops a scheme citing a source item that was never supplied', () => {
        // A model that invents an id has invented the article too.
        const kept = applyBackstops([scheme({ sourceNewsItemId: 'made-up' })], ITEMS, NOW);
        expect(kept).toEqual([]);
    });

    it('drops a scheme whose excerpt is NOT verbatim in the source', () => {
        // The single most important check. A paraphrase means we cannot show a
        // reviewer the sentence the date came from — and an unverifiable date
        // is exactly the thing that costs a farmer money.
        const kept = applyBackstops(
            [scheme({ sourceExcerpt: 'Applications open in early September.' })],
            ITEMS,
            NOW,
        );
        expect(kept).toEqual([]);
    });

    it('accepts an excerpt differing only in whitespace and case', () => {
        // The check normalises, so a model that reflows whitespace is not
        // punished for something that changes no meaning.
        const kept = applyBackstops(
            [scheme({ sourceExcerpt: '  ПРИЕМЪТ на заявления   започва на 01.09.2026 г.  ' })],
            ITEMS,
            NOW,
        );
        expect(kept).toHaveLength(1);
    });

    it('drops a scheme with no application window at all', () => {
        // Then it is a news story, not a deadline.
        const kept = applyBackstops(
            [scheme({ applicationOpensAt: undefined, applicationClosesAt: undefined })],
            ITEMS,
            NOW,
        );
        expect(kept).toEqual([]);
    });

    it('drops a date in the past', () => {
        const kept = applyBackstops([scheme({ applicationOpensAt: '2020-01-01' })], ITEMS, NOW);
        expect(kept).toEqual([]);
    });

    it('drops a date beyond the 18-month horizon', () => {
        // A window three years out is a misread of a year, not a scheme.
        const kept = applyBackstops([scheme({ applicationClosesAt: '2029-09-30' })], ITEMS, NOW);
        expect(kept).toEqual([]);
    });

    it('drops a window that closes before it opens', () => {
        // Two dates read in the wrong order — the article is not wrong, the
        // extraction is.
        const kept = applyBackstops(
            [scheme({ applicationOpensAt: '2026-09-30', applicationClosesAt: '2026-09-01' })],
            ITEMS,
            NOW,
        );
        expect(kept).toEqual([]);
    });

    it('drops a scheme below the confidence floor', () => {
        const kept = applyBackstops(
            [scheme({ confidence: MIN_CONFIDENCE - 0.01 })],
            ITEMS,
            NOW,
        );
        expect(kept).toEqual([]);
    });

    it('keeps a scheme exactly at the floor', () => {
        const kept = applyBackstops([scheme({ confidence: MIN_CONFIDENCE })], ITEMS, NOW);
        expect(kept).toHaveLength(1);
    });

    it('caps the run — a model that hallucinates tends to hallucinate volume', () => {
        const many = Array.from({ length: MAX_SCHEMES_PER_RUN + 5 }, (_, i) =>
            scheme({ measureCode: `M-${i}` }),
        );
        expect(applyBackstops(many, ITEMS, NOW)).toHaveLength(MAX_SCHEMES_PER_RUN);
    });

    it('deduplicates a repeated (article, measure) pair within one run', () => {
        // The DB unique would reject the second anyway; this saves the write.
        const kept = applyBackstops([scheme(), scheme()], ITEMS, NOW);
        expect(kept).toHaveLength(1);
    });
});

describe('a partly-bad batch', () => {
    it('keeps the good scheme and drops the bad one', () => {
        // A single bad extraction must not discard the run — nor rescue itself
        // by riding along with a good one.
        const kept = applyBackstops(
            [
                scheme({ measureCode: 'GOOD' }),
                scheme({ measureCode: 'BAD', sourceExcerpt: 'not in the article' }),
            ],
            ITEMS,
            NOW,
        );
        expect(kept.map((s) => s.measureCode)).toEqual(['GOOD']);
    });
});
