/**
 * Guard: every path on the SWR persist allowlist answers with an `ETag`
 * (#1845).
 *
 * ## Why the two belong in one assertion
 *
 * `PERSISTABLE_PATHS` keeps a response on a phone across launches, and SWR
 * revalidates on open. Without an `ETag` that revalidation is a FULL body
 * rather than a 304 — so allowlisting a path with no conditional-request
 * support does not make the app cheaper on a bad connection, it makes it
 * more expensive: the same bytes, now fetched on every launch instead of
 * when the screen is first opened.
 *
 * This was live, not hypothetical. #1845 allowlisted `/items`, `/units` and
 * `/parcels/by-crop`, and the argument for keeping the 24h age — "a stale
 * entry costs one conditional request" — was written into the docblock while
 * all three routes still answered with a plain JSON response. For a crop's
 * parcels that is up to 5000 geometries on the rural LTE this cache exists
 * for. The cost argument and the persistence decision are the same decision,
 * and nothing joined them.
 *
 * CLAUDE.md already carries the rule ("New cacheable list GETs SHOULD use
 * `jsonWithETag` instead of `jsonResponse`"). A SHOULD in prose is not a
 * gate, and the population it applies to is exactly this allowlist.
 *
 * ## What it ranges over
 *
 * The allowlist itself, parsed from `persistent-cache.ts` — the same source
 * `swr-persist-allowlist.test.ts` reads, so a future addition is covered the
 * moment somebody adds it rather than when somebody remembers this file.
 * That is the point: the next entry cannot land without its route having an
 * `ETag`, which is the half that was missing.
 *
 * ## What it does NOT claim
 *
 * That a 304 is served. This matches a CALL, not a response —
 * `parcel-clusters-etag.test.ts` states the same limit for the same reason.
 * `jsonWithETag`'s actual 200-then-304 behaviour is executed in
 * `tests/unit/http/etag.test.ts`; between that and this, the composition is
 * "the helper behaves" plus "these routes call it". Neither half alone says
 * the phone gets a 304.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

const CACHE_SRC = join(REPO_ROOT, 'src/lib/swr/persistent-cache.ts');
const TENANT_API = 'src/app/api/t/[tenantSlug]';

/** A real call, not a mention. Comments are blanked before this runs. */
const ETAG_CALL = /jsonWithETag\s*\(/;

/**
 * The allowlist, read from source rather than imported.
 *
 * Importing it would pull in the localStorage/IndexedDB module under a node
 * project that has neither; parsing the literal is what the sibling guard
 * does and keeps this file free of a jsdom dependency.
 */
function allowlist(): string[] {
    const src = readFileSync(CACHE_SRC, 'utf8');
    const m = src.match(/const PERSISTABLE_PATHS: readonly string\[\] = \[([\s\S]*?)\];/);
    if (m === null) {
        throw new Error(
            'PERSISTABLE_PATHS not found in src/lib/swr/persistent-cache.ts. If it was '
                + 'renamed, update this guard — an allowlist this cannot read is one it '
                + 'cannot check, and an empty population passes for free.',
        );
    }
    return Array.from(m[1].matchAll(/'([^']+)'/g)).map((e) => e[1]);
}

/** Where a tenant-relative allowlist path's route handler lives. */
function routeFileFor(path: string): string {
    return join(REPO_ROOT, TENANT_API, path.replace(/^\//, ''), 'route.ts');
}

describe('every persisted read answers with an ETag (#1845)', () => {
    const paths = allowlist();

    it('ranges over the real allowlist — the denominator', () => {
        // This REACHES CI now (#1879): the `denominator-summary` reporter
        // collects any `[tag] …` line and appends it to the step summary,
        // because jest's default reporter drops console output entirely once
        // a run has more than one suite. The floor below is still what FAILS
        // the build — the summary is a reading, not a gate.
        console.log(`[persisted-etag] ${paths.length} allowlisted path(s): ${paths.join(', ')}`);
        // The P3 four are the irreducible population. A parse that stopped
        // matching would return [] and every assertion below would pass over
        // nothing, which is the failure this floor exists for.
        expect(paths.length).toBeGreaterThanOrEqual(4);
    });

    it('the detector tells a call from a mention — the control it needs', () => {
        // Without this, an ETAG_CALL that matched nothing would report every
        // route as compliant and the guard would be green for ever.
        expect(ETAG_CALL.test('return jsonWithETag(req, rows);')).toBe(true);
        expect(ETAG_CALL.test('return jsonWithETag (req, rows);')).toBe(true);
        // A bare identifier with no call is not a call.
        expect(ETAG_CALL.test('import { jsonWithETag } from "@/lib/http/etag";')).toBe(false);
        // And prose is blanked before matching, so a docblock explaining the
        // helper cannot make an unwired route read as wired — the #1774 trap,
        // which has already disarmed one coverage assertion in this repo.
        const prose = blankNonCode('// we should use jsonWithETag(req, x) here one day\nreturn plain(x);');
        expect(ETAG_CALL.test(prose)).toBe(false);
    });

    it.each(allowlist().map((p) => [p]))('%s has a route handler', (path: string) => {
        // An allowlist entry naming no route is a decision recorded about an
        // endpoint that does not exist — it persists nothing and hides that
        // the real path was never covered.
        expect(`${path}: ${existsSync(routeFileFor(path))}`).toBe(`${path}: true`);
    });

    it.each(allowlist().map((p) => [p]))('%s answers via jsonWithETag', (path: string) => {
        const file = routeFileFor(path);
        if (!existsSync(file)) return; // reported by the test above
        const code = blankNonCode(readFileSync(file, 'utf8'));
        if (!ETAG_CALL.test(code)) {
            throw new Error(
                `${path} is on PERSISTABLE_PATHS but its route does not call jsonWithETag.\n\n`
                    + `A persisted response is revalidated on every launch. With no ETag that\n`
                    + `revalidation is a FULL body, so persisting the path makes the app more\n`
                    + `expensive on a bad connection rather than less — the opposite of what the\n`
                    + `allowlist is for, and the defect #1845 shipped for three paths before this\n`
                    + `guard existed.\n\n`
                    + `Fix the ROUTE, not this guard: return jsonWithETag(req, payload) from\n`
                    + `@/lib/http/etag. If the response genuinely cannot carry an ETag, it does\n`
                    + `not belong on the allowlist either.\n\n`
                    + `  route: ${file.slice(REPO_ROOT.length + 1)}`,
            );
        }
        expect(ETAG_CALL.test(code)).toBe(true);
    });
});
