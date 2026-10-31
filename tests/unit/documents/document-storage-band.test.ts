/**
 * The band `/api/readyz` reports, on its own (#2495 step 3).
 *
 * The CEILING is covered by `document-storage-budget.test.ts` — this file is
 * only the bucketing, because the two answer different questions and have
 * different consequences for getting it wrong. A wrong ceiling refuses or
 * admits an upload. A wrong band publishes a business figure on an endpoint
 * probed unauthenticated from six regions, or reports "plenty of room" about
 * a measurement that never happened.
 *
 * Note the band is deliberately NOT derived from the ceiling: the ceiling is
 * per TENANT (2 GiB) and the band is a DEPLOYMENT-wide disk reading, so a
 * farm at its ceiling and a disk at 20 GB are unrelated facts. Bucketing by
 * "percentage of the ceiling" would report a healthy deployment as full the
 * moment one farm filled its own allowance.
 */
import { documentStorageBand } from '@/lib/documents/storage-band';

const GB = 1024 ** 3;

describe('documentStorageBand', () => {
    it('reports the four bands the contract names', () => {
        expect(documentStorageBand(0)).toBe('under_1gb');
        expect(documentStorageBand(700 * 1024 * 1024)).toBe('under_1gb');
        expect(documentStorageBand(3 * GB)).toBe('1_5gb');
        expect(documentStorageBand(11 * GB)).toBe('5_20gb');
        expect(documentStorageBand(64 * GB)).toBe('over_20gb');
    });

    it('puts each boundary in the HIGHER band — a threshold crossing must be visible', () => {
        // Exactly at a threshold means crossed. The other direction reports the
        // quieter band on precisely the value somebody set an expectation
        // against, which is the one reading that must not be reassuring.
        expect(documentStorageBand(1 * GB)).toBe('1_5gb');
        expect(documentStorageBand(5 * GB)).toBe('5_20gb');
        expect(documentStorageBand(20 * GB)).toBe('over_20gb');
        // And one byte below stays put, so the boundary is a boundary rather
        // than an off-by-one in the other direction.
        expect(documentStorageBand(1 * GB - 1)).toBe('under_1gb');
        expect(documentStorageBand(20 * GB - 1)).toBe('5_20gb');
    });

    it('reports the LARGEST band for a broken total, never the smallest', () => {
        // A caller that failed to read a number must not get "plenty of room".
        for (const broken of [NaN, Infinity, -Infinity, -1, -5 * GB]) {
            expect(documentStorageBand(broken)).toBe('over_20gb');
        }
    });

    it('never leaks the figure — the band is one of exactly four strings', () => {
        const bands = new Set(
            [0, 1, 999, 1 * GB, 7 * GB, 30 * GB, 1e15, NaN].map(documentStorageBand),
        );
        for (const b of bands) {
            expect(['under_1gb', '1_5gb', '5_20gb', 'over_20gb']).toContain(b);
            expect(b).not.toMatch(/[0-9]{4,}/);
        }
    });
});
