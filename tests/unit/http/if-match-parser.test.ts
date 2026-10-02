/**
 * `If-Match` is parsed one way, and a PRESENT header never falls through.
 *
 * ## The table this file is built from
 *
 * #1182 measured the three locked routes' parsers against the same inputs:
 *
 * ```
 * header      journal /^\d+$/        field-operations parseInt    farm-profile
 * 5           5                      5                            5
 * "5"         undefined UNGUARDED    undefined UNGUARDED          5
 * W/"5"       undefined UNGUARDED    undefined UNGUARDED          400
 * 0abc        undefined UNGUARDED    0            <- coerced      400
 * -1          undefined UNGUARDED    -1           <- accepted     400
 * ```
 *
 * Two defects. A **quoted tag was silently unguarded** on two of three — and
 * `"5"` is the RFC 7232 wire format, so the clients most likely to send it are
 * the well-behaved ones: they ask for protection, get none, and are told
 * nothing. And the looser parser **coerced** — harmless where 0 is not a
 * sentinel, and not harmless in `farm-profile`, where 0 means "no row exists
 * yet" and a coerced `0abc` would become a CREATE.
 *
 * ## The assertion that matters most
 *
 * `absent -> undefined` and `present-but-unparseable -> 400` are different
 * cases, and collapsing them is the bug. Every `UNGUARDED` in that table is a
 * present header read as absent. So the tests below are grouped by that
 * distinction rather than by input shape.
 */
import { parseIfMatch, etagFor } from '@/lib/http/if-match';

/** The thrown shape, so a 400 is asserted as a 400 rather than as "it threw". */
function statusOf(fn: () => unknown): number | string {
    try {
        fn();
        return 'did not throw';
    } catch (err) {
        const e = err as { status?: number; statusCode?: number };
        return e.status ?? e.statusCode ?? 'threw without a status';
    }
}

describe('parseIfMatch', () => {
    describe('ABSENT means no precondition — the documented, common case', () => {
        it.each([
            ['null', null],
            ['undefined', undefined],
        ])('%s -> undefined', (_label, raw) => {
            expect(parseIfMatch(raw as string | null | undefined)).toBeUndefined();
        });
    });

    describe('PRESENT and readable', () => {
        it.each([
            ['bare integer', '5', 5],
            ['bare zero — a sentinel on farm-profile, so it must survive', '0', 0],
            ['strong entity-tag, the RFC 7232 form', '"5"', 5],
            ['strong tag of zero', '"0"', 0],
            ['surrounding whitespace is trimmed', '  7  ', 7],
            ['a large version', '4294967296', 4294967296],
        ])('%s: %s -> %s', (_label, raw, want) => {
            expect(parseIfMatch(raw as string)).toBe(want);
        });
    });

    describe('PRESENT and unreadable is a 400, NEVER a fall-through', () => {
        // Every row here returned `undefined` — i.e. unguarded — on at least
        // one route before #1182. That is the defect, stated as a test.
        it.each([
            ['weak tag — RFC 7232 forbids it for If-Match', 'W/"5"'],
            ['weak tag, lowercase', 'w/"5"'],
            ['trailing garbage, which parseInt COERCED to 5', '5xyz'],
            ['leading zero garbage, COERCED to 0', '0abc'],
            ['hex, COERCED to 0', '0x0'],
            ['negative, ACCEPTED by parseInt', '-1'],
            ['decimal', '1.5'],
            ['empty string — present, so not absent', ''],
            ['whitespace only', '   '],
            ['a non-numeric tag', '"abc"'],
            ['an unclosed quote', '"5'],
            ['a list, which If-Match permits but a version lock cannot use', '"5", "6"'],
            ['the wildcard, which means something else entirely', '*'],
        ])('%s: %s -> 400', (_label, raw) => {
            expect(statusOf(() => parseIfMatch(raw as string))).toBe(400);
        });
    });

    describe('etagFor round-trips through parseIfMatch', () => {
        // The property that makes the header usable without the client
        // reformatting: what the server emits, the server accepts.
        it.each([0, 1, 5, 99, 4294967296])('version %s survives the round trip', (v) => {
            expect(parseIfMatch(etagFor(v as number))).toBe(v);
        });

        it('emits the strong-tag form, not a bare integer', () => {
            // If this ever emitted `5`, a client echoing it back would still
            // work — which is exactly why it needs asserting rather than
            // assuming. The quoted form is what an HTTP client expects.
            expect(etagFor(5)).toBe('"5"');
        });
    });

    it('control: the 400s are thrown, not returned — a returned undefined would read as absent', () => {
        // The whole defect was a parser RETURNING undefined for a present
        // header. If a future edit made these return instead of throw, every
        // assertion above would still pass except this one.
        expect(() => parseIfMatch('W/"5"')).toThrow();
        expect(() => parseIfMatch('0abc')).toThrow();
        expect(parseIfMatch(null)).toBeUndefined();
    });
});
