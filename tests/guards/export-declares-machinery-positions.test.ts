/**
 * The Art 15 export must DECLARE the machinery position trace — #2969.
 *
 * `GET /api/account/export` answers a subject access request with what it
 * holds plus `notIncluded`, a list naming what it deliberately omits, because
 * "Art 15 is a right to know what is held" and a silent absence is the worse
 * answer. #2969 measured that none of the five existing entries reaches a
 * position trace: the farm-records entry covers records the person AUTHORED,
 * and a trace is not authored. So the export would have held position data
 * about a person and neither returned it nor declared it.
 *
 * The owner ruled option 2 on 2026-11-13 — "positions: rely on the 30-day
 * sweep; WorkedParcel: retain" — which declines both alternatives: widening
 * `personal-data-registry` to a tenant-scoped SURVEILLANCE class, and
 * exporting the trace outside the registry.
 *
 * ## Why this is a GUARD and not only an integration assertion
 *
 * `tests/integration/p5-6a-export.test.ts` asserts the real response carries
 * the sentence and the right NUMBER, which is the behaviour. It cannot see
 * HOW the number got there — a literal `30` produces a byte-identical
 * response today and silently keeps promising 30 days after
 * `RAW_POSITION_RETENTION_DAYS` moves. The drift direction is always the bad
 * one: a disclosure promising a shorter life than the data actually gets.
 *
 * That is the `{graceDays}` rule from the deletion paragraph and the
 * `USAGE_EVENT_RETENTION_DAYS` rule from the telemetry disclosure, applied to
 * the third place a retention period is written down for a reader.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { RAW_POSITION_RETENTION_DAYS } from '@/lib/machines/fleet-view';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const EXPORT_USECASE = path.join(ROOT, 'src/app-layer/usecases/personal-data-export.ts');

/**
 * The `NOT_INCLUDED` array's source text, comments BLANKED.
 *
 * Blanking is load-bearing rather than hygiene: the docblock I wrote above
 * that entry explains the interpolation rule and contains the constant's
 * NAME, so an unblanked read would find `RAW_POSITION_RETENTION_DAYS` in a
 * comment and pass with the interpolation replaced by a literal. That is
 * `a-scar-is-not-a-wound` — a comment hit usually means the code is absent.
 *
 * `strings` stays OFF: the declaration IS a string literal, so blanking
 * strings would empty the window and leave nothing to assert over.
 */
export function notIncludedSource(): string {
    const src = blankNonCode(readFileSync(EXPORT_USECASE, 'utf8'), { strings: false });
    const start = src.indexOf('const NOT_INCLUDED');
    if (start < 0) throw new Error('NOT_INCLUDED not found — has the export been restructured?');
    const end = src.indexOf('\n];', start);
    if (end < 0) throw new Error('NOT_INCLUDED has no terminator — selector needs updating.');
    return src.slice(start, end);
}

describe('the export declares the machinery position trace (#2969)', () => {
    it('names a tracker-recorded position, and the parcel record that survives it', () => {
        const block = notIncludedSource();

        // A control on the selector: the window must still contain the
        // entries that were there before this one, or an extraction that
        // stopped matching would pass over almost nothing.
        expect(block).toMatch(/farm records you authored/i);
        expect(block).toMatch(/credentials and sessions/i);

        expect(block).toMatch(/tracker fitted to a farm vehicle/i);
        expect(block).toMatch(/parcels were worked/i);
    });

    it('INTERPOLATES the retention rather than writing the number out', () => {
        const block = notIncludedSource();

        expect(block).toContain('${RAW_POSITION_RETENTION_DAYS}');

        /*
         * And no literal number of days anywhere in the list. Asserted over
         * the WHOLE block rather than the one entry because the failure to
         * catch is somebody adding a second sentence about retention beside
         * the interpolated one — two numbers that can disagree is worse than
         * one that can be wrong.
         *
         * `${…} days` is already blanked out of this match by the template
         * expression, so the pattern cannot hit the correct form.
         */
        const literalDays = block.match(/\b\d+\s+days?\b/g) ?? [];
        expect(literalDays).toEqual([]);
    });

    it('the declared retention is the one the sweep enforces', () => {
        /*
         * The constant is imported, so this is not a restatement: it fails if
         * `fleet-view` stops exporting it or starts exporting something that
         * is not a positive number of days, which is what the interpolation
         * above silently depends on.
         */
        expect(Number.isInteger(RAW_POSITION_RETENTION_DAYS)).toBe(true);
        expect(RAW_POSITION_RETENTION_DAYS).toBeGreaterThan(0);
        console.log(
            `[export-declares-positions] retention declared from the constant: ` +
                `${RAW_POSITION_RETENTION_DAYS} day(s)`
        );
    });
});
