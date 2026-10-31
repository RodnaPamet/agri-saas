/**
 * The per-tenant document ceiling and the band `/api/readyz` reports
 * (#2495 step 3).
 *
 * Three properties here are worth more than the arithmetic:
 *
 *   - **The default survives `SKIP_ENV_VALIDATION=1`.** It is a constant in
 *     `storage-limit.ts`, not a zod `.default()` in `env.ts`, because
 *     @t3-oss/env skips zod entirely under that flag and a defaulted var
 *     reads `undefined` in every test (#2518 — `AV_SCAN_MODE` is the measured
 *     instance, and it makes the AV download gate permissive under test while
 *     declaring strict). A ceiling that silently differs between test and
 *     production is worse than no ceiling.
 *   - **A zero or negative override is refused, not honoured.** "Limit 0" and
 *     "typo in a deploy variable" are indistinguishable, and the two readings
 *     are opposite: one bricks every upload, the other is a mistake somebody
 *     wants to find. Falling back is the recoverable direction.
 *   - **A broken total reports the LARGEST band, not the smallest.** The
 *     alarming direction being wrong in the reassuring direction is how a
 *     full disk reads as "plenty of room".
 */
import {
    DEFAULT_DOCUMENT_STORAGE_LIMIT_BYTES,
    documentStorageBand,
    documentStorageLimitBytes,
} from '@/lib/documents/storage-limit';
import { env } from '@/env';

const GB = 1024 ** 3;

describe('documentStorageLimitBytes', () => {
    it('is 2 GB by default — the owner decision on #2495', () => {
        expect(DEFAULT_DOCUMENT_STORAGE_LIMIT_BYTES).toBe(2 * GB);
    });

    it('falls back to the constant when the env var is unset', () => {
        // This is the live case under test, and the one that matters: the var
        // is declared OPTIONAL with no zod default precisely so this path is
        // the same in test and in a deployment that sets nothing.
        expect(env.DOCUMENT_STORAGE_LIMIT_BYTES).toBeUndefined();
        expect(documentStorageLimitBytes()).toBe(2 * GB);
    });
});

describe('documentStorageBand', () => {
    it('reports the four bands the contract names', () => {
        expect(documentStorageBand(0)).toBe('under_1gb');
        expect(documentStorageBand(500 * 1024 ** 2)).toBe('under_1gb');
        expect(documentStorageBand(2 * GB)).toBe('1_5gb');
        expect(documentStorageBand(10 * GB)).toBe('5_20gb');
        expect(documentStorageBand(50 * GB)).toBe('over_20gb');
    });

    it('puts each boundary in the HIGHER band — a threshold crossing must be visible', () => {
        // The reason the band exists is that a crossing prompts action, so
        // exactly-at-the-threshold has to read as crossed.
        expect(documentStorageBand(1 * GB - 1)).toBe('under_1gb');
        expect(documentStorageBand(1 * GB)).toBe('1_5gb');
        expect(documentStorageBand(5 * GB - 1)).toBe('1_5gb');
        expect(documentStorageBand(5 * GB)).toBe('5_20gb');
        expect(documentStorageBand(20 * GB - 1)).toBe('5_20gb');
        expect(documentStorageBand(20 * GB)).toBe('over_20gb');
    });

    it('reports the LARGEST band for a broken total, never the smallest', () => {
        // A failed read must not look like an empty disk.
        expect(documentStorageBand(-1)).toBe('over_20gb');
        expect(documentStorageBand(Number.NaN)).toBe('over_20gb');
        expect(documentStorageBand(Number.POSITIVE_INFINITY)).toBe('over_20gb');
    });

    it('never leaks the figure — the band is one of exactly four strings', () => {
        // `/api/readyz` is probed unauthenticated from six regions, so the
        // return value IS the public surface. A band that embedded a number
        // would defeat the whole reason for bucketing.
        const bands = new Set(
            [0, 1, 1 * GB, 3 * GB, 7 * GB, 100 * GB, -5, Number.NaN].map(documentStorageBand),
        );
        for (const b of bands) {
            expect(['under_1gb', '1_5gb', '5_20gb', 'over_20gb']).toContain(b);
            expect(b).not.toMatch(/\d{4,}/);
        }
    });
});
