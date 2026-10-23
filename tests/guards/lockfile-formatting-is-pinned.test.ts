/**
 * `package-lock.json`'s INDENT is pinned, and its `libc` entries have a floor
 * (#2188).
 *
 * Two invariants about a file nobody reads, both of which have already cost
 * real time this week.
 *
 * ## 1. The indent, because a mismatch rewrites 28,000 lines
 *
 * npm preserves whatever indentation a lockfile already has when it edits one
 * in place, and writes its own when it regenerates. Dependabot regenerates.
 * So main sitting at 2 spaces while npm writes 4 meant every Dependabot PR
 * re-indented the whole file — measured 2026-10-22 across all six open ones:
 *
 *     #2150 production group   +28459   157 real version changes
 *     #2055 dev-dependencies   +28377    25
 *     #2054 next               +28347    10
 *     #1695 motion             +28347     4
 *     #1694 jose               +28365     1   open since 2026-10-08
 *     #1435 handlebars         +28347     1   open since 2026-10-08
 *
 * Any two of those are a whole-file conflict, so they cannot be merged in
 * sequence — which is why two of them sat for a fortnight. It also hid what
 * changed: #1435 moves ONE package and shows +28347, so the only honest review
 * is to parse both files, which nobody does per PR. And it cost a duplicated
 * effort on the night of 2026-10-22, when two sessions independently bumped
 * `next` for the same three criticals and the deciding factor between the two
 * PRs was that one had re-indented the file.
 *
 * The pinned value is **4**, which is what this repo's own npm writes —
 * measured with `npm install --package-lock-only` rather than assumed, so the
 * repo agrees with the tool instead of the tool fighting the repo.
 *
 * ## 2. The `libc` floor, because a glibc host silently drops them
 *
 * `npm install` on a glibc machine removes the `libc` field from every
 * `@img/sharp-*`, `@swc/core-*` and `@oxc-parser/*` entry that carries one —
 * 34 of them. Those fields are what make the lockfile describe a MUSL build,
 * and the runtime image is `node:22-alpine`. Dropping them is invisible in a
 * 28k-line diff and survives review easily.
 *
 * Hit twice on 2026-10-22, both times caught only by counting: once bumping
 * `next` to 16.4.2, and once performing this very normalisation.
 *
 * A FLOOR rather than an equality, because adding a platform legitimately
 * raises the count. It only ever goes up on purpose.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const LOCKFILE = join(process.cwd(), 'package-lock.json');

/**
 * What `npm install --package-lock-only` writes with npm 10.9.8, measured
 * 2026-10-22. If a future npm changes its default, the fix is to re-measure
 * and move this constant in the same PR as the reformat — never to widen the
 * assertion so both pass.
 */
const PINNED_INDENT = 4;

/**
 * 34 on 2026-10-22. Raise it when a platform is deliberately added; never
 * lower it to make a red build green, because the thing that lowers it is a
 * `npm install` on a glibc host silently discarding musl metadata.
 */
const LIBC_FLOOR = 34;

function lockfileText(): string {
    return readFileSync(LOCKFILE, 'utf8');
}

/** The indent of the first nested key, which is the file's own answer. */
export function measureIndent(text: string): number {
    const second = text.split('\n')[1] ?? '';
    return second.length - second.trimStart().length;
}

describe('package-lock.json formatting is pinned (#2188)', () => {
    it(`is indented with ${PINNED_INDENT} spaces, matching what npm writes`, () => {
        const text = lockfileText();
        const indent = measureIndent(text);
        console.log(
            `[lockfile-format] indent ${indent} (pinned ${PINNED_INDENT}); ` +
                `${text.split('\n').length} lines; ` +
                `${(text.match(/"libc"/g) ?? []).length} libc entries (floor ${LIBC_FLOOR})`,
        );
        expect(indent).toBe(PINNED_INDENT);
    });

    it('keeps the musl `libc` metadata a glibc install drops', () => {
        const count = (lockfileText().match(/"libc"/g) ?? []).length;
        expect(count).toBeGreaterThanOrEqual(LIBC_FLOOR);
    });

    it('CONTROL: the indent measurement can distinguish 2 from 4', () => {
        // Without this the first assertion could be passing because
        // `measureIndent` always returns the pinned value — the shape where a
        // probe gives one answer whatever it is asked.
        expect(measureIndent('{\n  "a": 1\n}')).toBe(2);
        expect(measureIndent('{\n    "a": 1\n}')).toBe(4);
        expect(measureIndent('{\n\t"a": 1\n}')).toBe(1);
    });

    it('parses, so the pin is about a real lockfile and not any 4-indented file', () => {
        const parsed = JSON.parse(lockfileText()) as { lockfileVersion?: number; packages?: object };
        expect(parsed.lockfileVersion).toBe(3);
        // A denominator: if this collapses, the file being graded is not the
        // dependency tree anyone thinks it is.
        expect(Object.keys(parsed.packages ?? {}).length).toBeGreaterThan(1500);
    });
});
