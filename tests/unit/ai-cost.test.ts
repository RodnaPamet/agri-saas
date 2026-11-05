/**
 * AI cost estimation — unit tests.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { estimateCostMicros } from '@/app-layer/ai/cost';
import type { AiUsage } from '@/app-layer/ai/provider/types';

function usage(prompt: number, completion: number): AiUsage {
    return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

describe('estimateCostMicros', () => {
    it('prices a known model (Opus: $15/$75 per 1M)', () => {
        // 1M prompt + 1M completion → 15_000_000 + 75_000_000 micros.
        const micros = estimateCostMicros('claude-opus-4-8', usage(1_000_000, 1_000_000));
        expect(micros).toBe(15_000_000 + 75_000_000);
    });

    it('prices Sonnet and Haiku correctly', () => {
        expect(estimateCostMicros('claude-sonnet-4-6', usage(1_000_000, 0))).toBe(3_000_000);
        expect(estimateCostMicros('claude-haiku-4-5', usage(0, 1_000_000))).toBe(5_000_000);
    });

    it('matches OpenRouter-prefixed model ids to the same price', () => {
        const a = estimateCostMicros('claude-sonnet-4-6', usage(1000, 1000));
        const b = estimateCostMicros('anthropic/claude-sonnet-4-6', usage(1000, 1000));
        expect(a).toBe(b);
        expect(a).toBeGreaterThan(0);
    });

    it('prices the groq llama model', () => {
        const micros = estimateCostMicros('llama-3.3-70b-versatile', usage(1_000_000, 0));
        expect(micros).toBe(590_000); // $0.59/1M
    });

    it('charges 0 for a local ollama-tagged model', () => {
        expect(estimateCostMicros('qwen3:1.7b', usage(1_000_000, 1_000_000))).toBe(0);
    });

    it('returns 0 for an unknown model', () => {
        expect(estimateCostMicros('totally-unknown-model', usage(1000, 1000))).toBe(0);
    });

    it('returns an integer (micro-dollars)', () => {
        const micros = estimateCostMicros('claude-haiku-4-5', usage(123, 456));
        expect(Number.isInteger(micros)).toBe(true);
    });
});

describe('the three input rates (#2669)', () => {
    /** A usage row carrying cache figures, as #2674 now maps them. */
    const cached = (prompt: number, read: number, write: number): AiUsage => ({
        promptTokens: prompt,
        completionTokens: 0,
        totalTokens: prompt,
        cacheReadTokens: read,
        cacheWriteTokens: write,
    });

    it('a cache READ is charged at 0.1x input, not at zero', () => {
        /*
         * The defect. `promptTokens` EXCLUDES the cached portion on Anthropic,
         * and nothing else looked at the cache fields — so a cached token cost
         * nothing. Sonnet input is $3/Mtok, so 1M cache reads are $0.30.
         */
        expect(estimateCostMicros('claude-sonnet-4-6', cached(0, 1_000_000, 0))).toBe(300_000);
    });

    it('a cache WRITE is charged at 1.25x input', () => {
        expect(estimateCostMicros('claude-sonnet-4-6', cached(0, 0, 1_000_000))).toBe(3_750_000);
    });

    it('the three classes ADD — a realistic row is the sum of its parts', () => {
        // 100k full-rate + 900k cached read + 50k cache write, Sonnet.
        //   100_000 * 3   =   300_000
        //   900_000 * 0.3 =   270_000
        //    50_000 * 3.75=   187_500
        const micros = estimateCostMicros('claude-sonnet-4-6', cached(100_000, 900_000, 50_000));
        expect(micros).toBe(300_000 + 270_000 + 187_500);
    });

    it('REGRESSION CONTROL — the uncached arithmetic is unchanged', () => {
        /*
         * The real row #2669 was diagnosed from: 372 prompt / 163 completion
         * recorded 3,561 µ$, and `372*3 + 163*15 = 3,561` exactly. A row with
         * no cache measurement must still price identically, or this change
         * would have silently restated every historical figure.
         */
        expect(estimateCostMicros('claude-sonnet-4-6', usage(372, 163))).toBe(3_561);
    });

    it('an ABSENT cache figure costs nothing; an absent MULTIPLIER costs FULL rate', () => {
        /*
         * Two different defaults, on purpose. No measurement means no charge.
         * But a vendor whose discount we have not priced charges full rate —
         * the conservative direction, because over-counting refuses a question
         * while under-counting lets a ceiling be passed silently (#2666).
         *
         * `llama-3.3-70b` has no multipliers in the table, so its cache reads
         * are charged at its full input rate of $0.59/Mtok.
         */
        expect(estimateCostMicros('claude-sonnet-4-6', usage(1000, 0))).toBe(3_000);
        expect(estimateCostMicros('llama-3.3-70b', cached(0, 1_000_000, 0))).toBe(590_000);
    });
});
