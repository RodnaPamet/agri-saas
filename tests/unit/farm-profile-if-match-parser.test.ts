/**
 * The `If-Match` parser on the farm-profile route, asserted as a TABLE.
 *
 * This exists because the two routes that already have an optimistic lock
 * DISAGREE on this header, and the looser one coerces in a way that is harmless
 * where it lives and dangerous here:
 *
 *     header     journal /^\d+$/   field-operations parseInt+isInteger
 *     5          5                 5
 *     "5"        unguarded         unguarded          <- RFC form, silently ignored
 *     W/"5"      unguarded         unguarded
 *     0abc       unguarded         0                  <- becomes the create sentinel
 *     -1         unguarded         -1
 *
 * Measured 2026-10-01 (#1182). Under THIS design `version: 0` means "no row
 * exists yet", so a malformed header coerced to 0 is a create attempt. Hence:
 * accept the bare form and the strong tag, refuse everything else with a 400,
 * and never fall through to unguarded on a header that was present.
 *
 * The bare form is asserted explicitly because that is what both real clients
 * send — the web outbox via `outboxHeaders` and the iOS app via
 * `String(version)` — confirmed with the iOS session rather than assumed.
 */
const ROUTE = 'src/app/api/t/[tenantSlug]/admin/farm-profile/route.ts';

describe('If-Match parsing — the table', () => {
    // The parser is a module-private function, so it is exercised through its
    // observable contract: the regexes it is built from, asserted against the
    // same inputs the two existing routes were measured on. A behavioural test
    // through the route needs the permission middleware and is covered by E2E.
    const WEAK = /^W\//i;
    const STRONG = /^"(.*)"$/;
    const DIGITS = /^\d+$/;

    const classify = (raw: string | null): 'absent' | 'weak-400' | 'bad-400' | number => {
        if (raw === null) return 'absent';
        const v = raw.trim();
        if (WEAK.test(v)) return 'weak-400';
        const unq = STRONG.exec(v)?.[1] ?? v;
        if (!DIGITS.test(unq)) return 'bad-400';
        return Number.parseInt(unq, 10);
    };

    it.each([
        ['5', 5],
        ['0', 0],
        ['"5"', 5],
        ['"0"', 0],
        ['  7  ', 7],
    ])('accepts %p as %p', (header, expected) => {
        expect(classify(header as string)).toBe(expected);
    });

    it.each([['W/"5"'], ['w/"5"']])('refuses the weak tag %p with a 400', (header) => {
        expect(classify(header as string)).toBe('weak-400');
    });

    it.each([['0abc'], ['5xyz'], ['0x0'], ['-1'], [''], ['null'], ['"a"'], ['1.5']])(
        'refuses %p with a 400 rather than coercing or ignoring it',
        (header) => {
            expect(classify(header as string)).toBe('bad-400');
        },
    );

    it('treats an ABSENT header as unguarded — that half is deliberate', () => {
        expect(classify(null)).toBe('absent');
    });

    it('would NOT coerce the two values field-operations turns into the sentinel', () => {
        // The specific regression this parser exists to avoid. Under
        // field-operations' parseInt both of these become 0, which here means
        // "create".
        expect(classify('0abc')).not.toBe(0);
        expect(classify('0x0')).not.toBe(0);
    });

    it('control: the route really does use these three patterns', () => {
        // Without this the table above would be asserting a local copy that had
        // drifted from the route it claims to describe.
        const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../', ROUTE), 'utf8');
        expect(src).toMatch(/\^W\\\//);
        expect(src).toMatch(/\^"\(\.\*\)"\$/);
        expect(src).toMatch(/\^\\d\+\$/);
    });
});
