/**
 * `parseDateRangeParam` — the server half of the Epic 53 `dateRange` facet.
 *
 * This EXECUTES the parser rather than asserting on its source: the whole
 * point of the helper is the arithmetic at its edges (end-of-day widening,
 * inversion, the shape gate), and none of that is visible to a regex.
 */
import { parseDateRangeParam } from '@/lib/validation/query-params';

const iso = (d: Date | undefined) => d?.toISOString();

describe('parseDateRangeParam', () => {
    describe('absent / empty', () => {
        it.each([
            ['null', null],
            ['undefined', undefined],
            ['empty string', ''],
            ['whitespace', '   '],
            ['the empty sentinel', '|'],
        ])('returns undefined for %s so the filter is omitted', (_label, raw) => {
            // A cleared facet must omit the filter entirely. Returning an
            // empty window instead would put `incurredOn: {}` in the query —
            // harmless to results, but it makes a cleared facet look applied.
            expect(parseDateRangeParam(raw, 'incurredOn')).toBeUndefined();
        });
    });

    describe('bounds', () => {
        it('anchors `from` at UTC midnight', () => {
            const out = parseDateRangeParam('2026-08-01|', 'incurredOn');
            expect(iso(out?.from)).toBe('2026-08-01T00:00:00.000Z');
            expect(out?.to).toBeUndefined();
        });

        it('widens `to` to the END of its day', () => {
            // `incurredOn` is a DateTime. A literal midnight upper bound
            // would match only rows stamped exactly 00:00:00 — in practice
            // none — so a farmer filtering "up to the 12th" would see an
            // empty table and conclude the data was missing.
            const out = parseDateRangeParam('|2026-08-12', 'incurredOn');
            expect(iso(out?.to)).toBe('2026-08-12T23:59:59.999Z');
            expect(out?.from).toBeUndefined();
        });

        it('a single-day window covers that whole day', () => {
            const out = parseDateRangeParam('2026-08-12|2026-08-12', 'incurredOn');
            expect(iso(out?.from)).toBe('2026-08-12T00:00:00.000Z');
            expect(iso(out?.to)).toBe('2026-08-12T23:59:59.999Z');
        });

        it('swaps an inverted window rather than returning nothing', () => {
            // The calendar orders its own output; a shared or hand-edited
            // URL need not. An inverted window is a slip, not a request for
            // zero rows.
            const out = parseDateRangeParam('2026-08-12|2026-08-01', 'incurredOn');
            expect(iso(out?.from)).toBe('2026-08-01T00:00:00.000Z');
            expect(iso(out?.to)).toBe('2026-08-12T23:59:59.999Z');
        });
    });

    describe('rejection', () => {
        it.each([
            ['a year alone', '2026|'],
            ['a slashed date', '|2026/08/12'],
            ['prose', 'yesterday|'],
            ['an out-of-shape month', '|2026-8-1'],
        ])('throws on %s instead of guessing', (_label, raw) => {
            // `new Date('2026')` is a VALID Date object — accepting it would
            // turn a typo into a silently different window. Shape is checked
            // before parsing for exactly that reason.
            expect(() => parseDateRangeParam(raw, 'incurredOn')).toThrow();
        });

        it('names the parameter in the message', () => {
            expect(() => parseDateRangeParam('nope|', 'incurredOn')).toThrow(
                /incurredOn/,
            );
        });

        it('rejects an impossible calendar date', () => {
            expect(() => parseDateRangeParam('2026-02-30|', 'incurredOn')).toThrow();
        });
    });
});
