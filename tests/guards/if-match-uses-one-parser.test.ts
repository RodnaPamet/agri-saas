/**
 * Every route that reads `If-Match` parses it with the SHARED parser.
 *
 * #1182's fourth bullet, made structural: *"converge the two parsers on one
 * helper so a third route cannot pick the looser one."* The third route already
 * existed when that was written — `farm-profile` — and it had written its own
 * strict parser precisely because `field-operations`' `parseInt` coerced
 * `0abc` to 0, which under a design where 0 means "no row yet" is a CREATE.
 *
 * So the convergence is not tidiness. Three routes had three answers to one
 * header, two of them silently unguarded for `"5"` — the RFC 7232 form, i.e.
 * the one a well-behaved client sends. A fourth route hand-rolling a fourth
 * answer is the default outcome unless something refuses it.
 *
 * Derived from the filesystem, so a route added tomorrow is covered the moment
 * it exists rather than when someone remembers this file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const SHARED = '@/lib/http/if-match';

/** Routes that read the header at all. */
function routesReadingIfMatch(): Array<{ rel: string; src: string }> {
    return collectSourceFiles({
        roots: ['src/app/api'],
        extensions: ['.ts'],
        floor: 200, // measured 372 route files
    })
        .filter((f) => path.basename(f) === 'route.ts')
        .map((f) => ({ rel: path.relative(REPO_ROOT, f), src: fs.readFileSync(f, 'utf8') }))
        .filter(({ src }) => /headers\.get\(\s*['"]If-Match['"]\s*\)/i.test(src));
}

const READERS = routesReadingIfMatch();

describe('If-Match has exactly one parser', () => {
    it('control: the derived population is non-empty and holds the known three', () => {
        // Without this, every assertion below is satisfied by an empty set —
        // which is what a changed call shape or a moved directory would produce.
        expect(READERS.length).toBeGreaterThanOrEqual(3);
        const rels = READERS.map((r) => r.rel);
        expect(rels.some((r) => r.includes('journal/[id]'))).toBe(true);
        expect(rels.some((r) => r.includes('admin/farm-profile'))).toBe(true);
        expect(rels.some((r) => r.includes('parcels/[lineId]'))).toBe(true);
    });

    it('every reader imports the shared parser', () => {
        const missing = READERS.filter(({ src }) => !src.includes(SHARED)).map((r) => r.rel);
        expect(missing).toEqual([]);
    });

    it('no reader hand-rolls the parse', () => {
        // The two shapes that were actually wrong, named rather than guessed:
        // `parseInt` on the header (coerces) and a bare `/^\d+$/` test (falls
        // through on a quoted tag).
        const handRolled = READERS.filter(({ src }) =>
            /parseInt\([^)]*[Ii]f[Mm]atch/.test(src) ||
            /test\(\s*(raw)?[Ii]f[Mm]atch\s*\)/.test(src),
        ).map((r) => r.rel);
        expect(handRolled).toEqual([]);
    });

    it('the shared parser throws on a present-but-unreadable header', () => {
        // The property the routes depend on. A future edit that made it return
        // `undefined` instead would restore the original defect in all three at
        // once, and every route-level test would still pass.
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/http/if-match.ts'), 'utf8');

        // Each refusal path carries a CODE, not just prose. Pinned by code
        // rather than by helper NAME: the first version of this assertion
        // matched `throw badRequest` and went stale the moment the file moved
        // to `codedBadRequest` — a citation drifting while the property held.
        for (const code of ['IF_MATCH_EMPTY', 'IF_MATCH_WEAK_TAG', 'IF_MATCH_MALFORMED']) {
            expect(src).toContain(`'${code}'`);
        }

        // Absent is the ONLY `undefined`. This is the property the routes
        // depend on: if a future edit returned instead of throwing, the
        // original defect would return in all three routes at once and every
        // route-level test would still pass.
        const undefinedReturns = [...src.matchAll(/return undefined;/g)];
        expect(undefinedReturns.length).toBe(1);
        expect([...src.matchAll(/throw coded/g)].length).toBe(3);
    });
});
