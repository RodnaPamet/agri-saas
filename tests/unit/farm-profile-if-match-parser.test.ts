/**
 * Why `farm-profile` needs the STRICT `If-Match` parser specifically.
 *
 * The full input table now lives in `tests/unit/http/if-match-parser.test.ts`,
 * against the shared `@/lib/http/if-match` that all three locked routes use
 * since #1182. This file keeps only what is specific to THIS route, because the
 * reason it refused to reuse `field-operations`' parser is a property of its
 * own design rather than of HTTP.
 *
 * ## The route-specific stake
 *
 * Under this design `version: 0` means **"no row exists yet"**. So two things
 * have to hold at once, and they pull in opposite directions:
 *
 *   `0` must be ACCEPTED        — it is a real, meaningful precondition here
 *   `0abc` / `0x0` must NOT be 0 — `field-operations`' `parseInt` coerced both
 *                                  to 0, which here is a CREATE attempt
 *
 * A parser that got either half wrong would look correct on the other two
 * routes, where 0 is not a sentinel. That asymmetry is why one shared parser
 * had to be the strict one rather than the average one.
 *
 * ## What changed in #1182
 *
 * This file used to assert a LOCAL REIMPLEMENTATION of the parser — three
 * regexes copied out of the route, because the real function was module-private
 * — plus a text control asserting the route still contained those regexes, to
 * catch the copy drifting from the original. Extracting the parser to a shared
 * module removed the need for both: the test now drives the real function, so
 * there is nothing to drift and nothing to control for.
 */
import { parseIfMatch } from '@/lib/http/if-match';

/** 400 or the parsed version, so a refusal is distinguishable from a value. */
function outcome(raw: string | null): number | undefined | 400 {
    try {
        return parseIfMatch(raw);
    } catch {
        return 400;
    }
}

describe('farm-profile If-Match: the `version 0` sentinel', () => {
    it('ACCEPTS a real zero — it is a meaningful precondition here', () => {
        // "No row exists yet". A parser that refused 0 as falsy would make the
        // create path unlockable.
        expect(outcome('0')).toBe(0);
        expect(outcome('"0"')).toBe(0);
    });

    it('does NOT coerce to zero the two values field-operations turned into the sentinel', () => {
        // The specific regression. Under `parseInt` both become 0, which here
        // means create — so a malformed header would silently attempt one.
        expect(outcome('0abc')).not.toBe(0);
        expect(outcome('0x0')).not.toBe(0);
        // And they are refused rather than merely not-zero: `undefined` would
        // be the fall-through this parser exists to remove.
        expect(outcome('0abc')).toBe(400);
        expect(outcome('0x0')).toBe(400);
    });

    it('control: absent is STILL unguarded — that half is deliberate', () => {
        // The route documents last-write-wins for an absent header, and the
        // strictness above must not have eaten it. If this ever became a 400,
        // every online edit from the admin form would break.
        expect(outcome(null)).toBeUndefined();
    });

    it('control: the route uses the shared parser rather than a local one', () => {
        // Replaces the old regex-text control. What it protects is the same
        // claim — that this file describes the parser the route actually runs —
        // but by import rather than by matching source text.
        const src = require('fs').readFileSync(
            require('path').resolve(__dirname, '../../', 'src/app/api/t/[tenantSlug]/admin/farm-profile/route.ts'),
            'utf8',
        );
        expect(src).toContain("from '@/lib/http/if-match'");
        expect(src).not.toMatch(/function parseIfMatch/);
    });
});
