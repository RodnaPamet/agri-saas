/**
 * A public prefix opens its own path and its CHILDREN — never a sibling that
 * merely shares its spelling.
 *
 * ## The defect
 *
 * `PUBLIC_PATH_PREFIXES` in `src/lib/auth/guard.ts` is a FAIL-OPEN list: an
 * entry that matches means the auth gate is skipped. It was matched with
 * `pathname.startsWith(prefix)`, and **20 of its 27 entries carry no trailing
 * slash**. Each of those therefore also opened every path that merely BEGINS
 * with its characters — so a future `/api/metrics-internal`,
 * `/api/admin/tenants-purge` or `/api/readyz-debug` would have been reachable
 * with no session, and nothing would have reported it. An unauthenticated
 * route looks exactly like a working route.
 *
 * `CLAUDE.md` already states the rule, on the one entry written correctly:
 *
 *   > The trailing slash on the prefix is load-bearing — `'/api/scim'` would
 *   > also open `/api/scimulator`.
 *
 * So this was not an unknown hazard. It was a convention holding only where an
 * author remembered it, across 27 entries — the same shape as the `getUserId`
 * rate-limit opt-in that left 343 routes keyed `anon`.
 *
 * ## Why the fix is the PREDICATE and not 20 trailing slashes
 *
 * Adding `/` to each bare entry would break the exact ones: `/api/stripe/webhook`
 * is a single route, and `'/api/stripe/webhook/'` matches it not at all. The
 * classification "is this entry exact or a prefix?" would also have to be
 * re-decided correctly 20 times, and re-decided again by whoever adds the 28th.
 *
 * `matchesPublicPrefix` makes the hazard unstatable instead: a match must end
 * at `/` or at the end of the string. An entry already ending in `/` keeps its
 * meaning byte-for-byte, which is why the SCIM behaviour is unchanged.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

import { isPublicPath, matchesPublicPrefix } from '@/lib/auth/guard';

const GUARD_SRC = path.join(REPO_ROOT, 'src/lib/auth/guard.ts');

/**
 * The live entry list, read from the source array.
 *
 * Parsed rather than imported because exporting a fail-open list invites a
 * second consumer. The extraction is floored below — a regex that silently
 * stops matching would otherwise make every assertion here vacuous, which is
 * the exact failure mode this file exists to prevent one level down.
 */
function publicPrefixEntries(): string[] {
    const src = fs.readFileSync(GUARD_SRC, 'utf8').split('\n');
    const start = src.findIndex((l) => l.startsWith('const PUBLIC_PATH_PREFIXES'));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.findIndex((l, i) => i > start && l.startsWith(']'));
    expect(end).toBeGreaterThan(start);
    return [...src.slice(start, end + 1).join('\n').matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Every URL path the app actually serves, derived from the route tree. */
function realAppPaths(): string[] {
    const files = collectSourceFiles({
        roots: ['src/app'],
        extensions: ['.ts', '.tsx'],
        floor: 500, // measured 615
    });
    const paths = files
        .filter((f) => /(?:route\.ts|page\.tsx)$/.test(f))
        .map((f) =>
            path
                .relative(path.join(REPO_ROOT, 'src/app'), f)
                .replace(/(?:\/)?(?:route\.ts|page\.tsx)$/, '')
                .replace(/\([^)]*\)\/?/g, '') // Next route groups are not URL segments
                .replace(/\/+$/, ''),
        )
        .map((p) => `/${p}`.replace(/\/+/g, '/'))
        .map((p) => (p.length > 1 ? p.replace(/\/$/, '') : p));
    return [...new Set(paths)];
}

const ENTRIES = publicPrefixEntries();
const REAL_PATHS = realAppPaths();

describe('a public prefix stops at a segment boundary', () => {
    // ── Controls, because the central assertions below are "this list is
    // empty", and two empty inputs produce that too.

    it('control: the entry list and the route population both parsed', () => {
        expect(ENTRIES.length).toBeGreaterThanOrEqual(20);
        expect(REAL_PATHS.length).toBeGreaterThanOrEqual(350); // measured 464
        // The entry this whole rule is named after is still spelled with its
        // slash. If someone "tidies" it away, the docblock above stops being
        // true and this fails rather than the suite quietly agreeing.
        expect(ENTRIES).toContain('/api/scim/');
    });

    it('control: real public routes ARE still public', () => {
        // Without this, "nothing lost access" is satisfied by a predicate that
        // returns false for everything.
        const stillPublic = REAL_PATHS.filter((p) => isPublicPath(p));
        expect(stillPublic.length).toBeGreaterThanOrEqual(10);
        // Named, so a collapse to "only static assets" cannot pass.
        for (const p of ['/login', '/api/readyz', '/api/health', '/no-tenant']) {
            expect(isPublicPath(p)).toBe(true);
        }
    });

    // ── The predicate itself ──────────────────────────────────────────

    it('opens the path itself and its children, not a shared-spelling sibling', () => {
        expect(matchesPublicPrefix('/api/metrics', '/api/metrics')).toBe(true);
        expect(matchesPublicPrefix('/api/metrics/live', '/api/metrics')).toBe(true);
        expect(matchesPublicPrefix('/api/metrics-internal', '/api/metrics')).toBe(false);
        expect(matchesPublicPrefix('/api/metricsfoo', '/api/metrics')).toBe(false);
        // Nothing before the prefix.
        expect(matchesPublicPrefix('/x/api/metrics', '/api/metrics')).toBe(false);
    });

    it('an entry that already declares a trailing slash is unchanged', () => {
        // The SCIM case, byte-for-byte as before.
        expect(matchesPublicPrefix('/api/scim/v2/Users', '/api/scim/')).toBe(true);
        expect(matchesPublicPrefix('/api/scimulator', '/api/scim/')).toBe(false);
        // ...and the declared form does NOT open the bare parent, which is the
        // behaviour the slash has always had.
        expect(matchesPublicPrefix('/api/scim', '/api/scim/')).toBe(false);
    });

    // ── The two halves of the migration ───────────────────────────────

    it('NO real route lost public access — the regression half', () => {
        // The predicate only ever narrows, so the risk of this change is a
        // route that WAS reachable becoming gated. Derived from the route tree
        // rather than a list, so a route added later is covered.
        const lost = REAL_PATHS.filter((p) => {
            const boundary = ENTRIES.some((e) => matchesPublicPrefix(p, e));
            const bare = ENTRIES.some((e) => p.startsWith(e));
            return bare && !boundary;
        });
        expect(lost).toEqual([]);
    });

    it('every bare entry refuses its shared-spelling sibling — the hazard half', () => {
        const bare = ENTRIES.filter((e) => !e.endsWith('/'));
        // Non-empty or the loop below asserts nothing.
        expect(bare.length).toBeGreaterThanOrEqual(15);
        for (const entry of bare) {
            const sibling = `${entry}-internal`;
            expect(matchesPublicPrefix(sibling, entry)).toBe(false);
            // ...and through the real gate, not just the predicate. Skipped for
            // a sibling that a static extension or the exact set would open on
            // its own merits — neither is this rule's business.
            if (!/\.[a-z0-9]+$/i.test(sibling)) {
                expect(isPublicPath(sibling)).toBe(false);
            }
        }
    });
});
