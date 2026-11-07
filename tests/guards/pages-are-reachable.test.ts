/**
 * Every tenant page is LINKED from somewhere, or recorded as deliberately
 * unlinked (#2844).
 *
 * ## The gap this closes
 *
 * `/admin/public-profile` shipped with P6: the route resolved, its flag was on,
 * `/robots.txt` allowed `/f/`, the sitemap rendered. It was linked from
 * NOWHERE — not the `/admin` hub (which lists sixteen screens), not
 * `canonical-parents.ts`, not the sidebar. Measured 2026-11-07: **zero
 * `FarmBrand` rows in production**, so not one farm had ever started a brand,
 * because the only path to the screen was typing a URL nobody had seen.
 *
 * Every P6 check asked whether the surface was REACHABLE and it was. None
 * asked whether a person could FIND it. That is the difference between
 * [[existing-is-not-mounted]] and a 200.
 *
 * ## What counts as a link, and why the terminator matters
 *
 * A link is the route's path appearing as a STRING LITERAL in some other file
 * — `tenantHref('/admin/members')`, `href="/admin"`, a nav table entry. The
 * path must be followed by a closing quote or backtick, and that is the part
 * worth explaining: without it `/exchange` matches inside
 * `'/exchange/threads'`, so every parent route would read as linked because a
 * CHILD of it is. That failure points toward green, which is the direction this
 * guard must never fail in.
 *
 * A DYNAMIC route is matched on its static prefix plus a terminator of `${` or
 * a quote, because `/exchange/threads/[threadId]` is linked as
 * `` tenantHref(`/exchange/threads/${th.id}`) `` and the literal id never
 * appears in source.
 *
 * ## Its own directory does not count
 *
 * A page that only references its own path — a redirect to itself, a docblock
 * citation, a `usePathname` comparison — is not reachable from anywhere else.
 * So matches inside the page's own directory are ignored, which is what makes
 * the P6 case fail: `admin/public-profile/` mentioned itself twice.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_ROOT = path.join(REPO_ROOT, 'src/app/t/[tenantSlug]/(app)');

/**
 * Routes with no in-app link, each with a written reason.
 *
 * An entry is a claim that nobody is MEANT to navigate here from inside the
 * product. "We have not got round to linking it" is not such a reason — that
 * is the bug this guard exists to report.
 */
const DELIBERATELY_UNLINKED: Readonly<Record<string, string>> = {
    '/grain/payroll':
        'A retired surface kept as a REDIRECT to `/grain/costs`, where payroll became a category. Unlinked on purpose — the sidebar and `GrainSectionNav` point at the category — and kept rather than deleted because the URL is in browser histories and bookmarks, and a farmer who followed one to a 404 would reasonably conclude their payroll data had been lost.',
    '/issues/[issueId]':
        'A legacy redirect to `/farm-tasks/[id]`, and being unlinked is the POINT: it exists to catch bookmarks and old links from before the rename, so a link to it from inside the product would send somebody the long way round. Deleting it instead would 404 those bookmarks — #1087 is what a silent route removal costs.',
    '/field/[taskId]':
        'The offline operator PWA. Reached from a QR code on the machine or a push notification, never from in-app navigation — the MECHANISATOR persona is locked out of the rest of the product by `isOperatorAllowedPath`, so a link from a screen they cannot open would be the wrong affordance.',
};

interface PageRoute {
    /** Route path under the tenant, e.g. `/admin/members`. */
    route: string;
    /** Repo-relative directory of the page file. */
    dir: string;
}

function findPages(): PageRoute[] {
    const out: PageRoute[] = [];
    const walk = (dir: string): void => {
        if (!fs.existsSync(dir)) {
            throw new Error(
                `scan root does not exist: ${dir} — a renamed root would scan zero ` +
                    'pages and pass (#875).',
            );
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (entry.name !== 'page.tsx') continue;
            const rel = path.relative(APP_ROOT, path.dirname(full)).replace(/\\/g, '/');
            // Route groups — `(app)`, `(marketing)` — are not path segments.
            const segments = rel
                .split('/')
                .filter((s) => s.length > 0 && !(s.startsWith('(') && s.endsWith(')')));
            out.push({
                route: `/${segments.join('/')}`,
                dir: path.relative(REPO_ROOT, path.dirname(full)).replace(/\\/g, '/'),
            });
        }
    };
    walk(APP_ROOT);
    return out;
}

/**
 * The pattern that finds a link to `route`.
 *
 * Static: the whole path, then a closing quote or backtick. Dynamic: the
 * static prefix, then `${` or a quote.
 *
 * ## The escaping has no effect on today's routes, which is why it has a test
 *
 * `Selector teeth` reported the inner `escape` as SURVIVED, and it was right:
 * no route in this repo contains a regex metacharacter. Dynamic segments are
 * the only source of `[` and `]`, and they are sliced off before the escape
 * runs — so `escape(route) === route` for all 78 of them and gutting it to
 * `return ''` broke no assertion.
 *
 * Deleting it is the wrong fix, the same way it was wrong for
 * `ui-hooks-barrel`'s derivation: a future page directory with a `.` or a `(`
 * in its name would silently produce a pattern that matches the wrong thing,
 * and a guard that fails toward "linked" is the one direction this must never
 * fail in. So it stays, and the case below gives it teeth with an input the
 * repo does not yet have.
 *
 * ## Do not run `selector-teeth.mjs` on this file locally
 *
 * It times out past ten minutes on a loaded machine and leaves `escape`
 * mutated in the working tree — twice, while this guard was being written. CI's
 * selector-teeth shard completes and is the signal to read; locally, the cost
 * is a file you then have to notice is wrong. See
 * [[mutation-runner-makes-the-tree-unsafe-to-stage]].
 */
function linkPattern(route: string): RegExp {
    const firstDynamic = route.indexOf('/[');
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (firstDynamic === -1) {
        return new RegExp(`${escape(route)}['"\`]`);
    }
    const prefix = route.slice(0, firstDynamic + 1);
    return new RegExp(`${escape(prefix)}(?:\\$\\{|['"\`])`);
}

describe('every tenant page is reachable from inside the product (#2844)', () => {
    const pages = findPages();

    // `src` only — a link from a TEST does not help a farmer.
    //
    // The exclusions are load-bearing, and the first version of this guard
    // shipped without them and was USELESS: removing the `/admin` hub pill —
    // the exact P6 defect — left it green, because three files mention a route
    // without offering any way to reach it.
    //
    //   * `src/lib/assistant/generated/page-routes.ts` is a generated
    //     INVENTORY of every route, so under a naive scan every page is
    //     always linked and the guard can never fail. It is also the one path
    //     that did work for `/admin/public-profile` — asking the assistant to
    //     navigate — which is not a way a farmer finds a screen.
    //   * `src/lib/nav/canonical-parents.ts` maps a page to its BREADCRUMB
    //     PARENT. It says where you came from, not that anything takes you
    //     there. P6 had no hub tile and this entry would have excused it.
    //   * `src/generated/**` is machine-written for the same reason as the
    //     first.
    //
    // COMMENTS ARE BLANKED, and that is not an optimisation — the guard is
    // useless without it. `/admin/public-profile` is named in two docblocks
    // (`exchange/page.tsx` compares gate shapes; `share-links.ts` cites the
    // client), and with prose counting as a link, deleting the hub pill — the
    // exact P6 defect — left this suite GREEN. The first version shipped with
    // a comment saying blanking was too expensive to bother with; the mutation
    // proof is what showed that reasoning to be the whole bug.
    //
    // Prose naming a path is not navigation. Nobody can click a docblock.
    const NOT_A_WAY_IN = [
        'src/generated/',
        'src/lib/assistant/generated/page-routes.ts',
        'src/lib/nav/canonical-parents.ts',
    ];
    const sources = collectSourceFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        exclude: (rel) => NOT_A_WAY_IN.some((p) => rel.startsWith(p)),
        // ~2100 at the time of writing. The floor separates "nothing links
        // this" from "nothing was examined", which is the only way this guard
        // can fail toward green.
        floor: 1500,
    });

    it('found a real population of pages and of sources', () => {
        // Printed so a shrinking denominator is visible rather than merely
        // above its floor.
        console.log(
            `[pages-are-reachable] ${pages.length} tenant page(s) scanned against ` +
                `${sources.length} source file(s); ${Object.keys(DELIBERATELY_UNLINKED).length} ` +
                'recorded as deliberately unlinked',
        );
        expect(pages.length).toBeGreaterThanOrEqual(40);
        expect(sources.length).toBeGreaterThanOrEqual(1500);
    });

    /**
     * The blanked corpus, built ONCE.
     *
     * The first version blanked inside the per-route loop: 78 routes times
     * 2,387 files is 186,000 blanking passes, and the suite took 53 seconds.
     * Blanking once and testing each route's pattern against the cached text
     * is the same answer two orders of magnitude cheaper — and a slow guard is
     * a guard somebody eventually moves out of the default population.
     */
    const blanked = new Map<string, string>();
    for (const abs of sources) {
        const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
        // `strings: false` — a link target IS a string literal, so blanking
        // strings would blank the thing being looked for.
        blanked.set(rel, blankNonCode(fs.readFileSync(abs, 'utf8')));
    }

    it('links every page, or records why not', () => {
        const unlinked: string[] = [];

        for (const { route, dir } of pages) {
            if (route === '/') continue;
            if (DELIBERATELY_UNLINKED[route]) continue;

            const re = linkPattern(route);
            let linked = false;
            for (const [rel, text] of blanked) {
                // A page referencing its OWN path is not a way in.
                if (rel.startsWith(`${dir}/`) || path.dirname(rel) === dir) continue;
                if (re.test(text)) {
                    linked = true;
                    break;
                }
            }
            if (!linked) unlinked.push(route);
        }

        if (unlinked.length > 0) {
            throw new Error(
                `${unlinked.length} page(s) exist and nothing in \`src/\` links to them, ` +
                    'so the only way in is typing the URL:\n' +
                    unlinked.map((r) => `  ${r}`).join('\n') +
                    '\n\nLink it (the `/admin` hub, the sidebar, a parent screen), or add it ' +
                    'to DELIBERATELY_UNLINKED in this file with a reason somebody would ' +
                    'defend out loud. "Not got round to it" is the bug, not an exemption.\n\n' +
                    'P6 is why this guard exists: /admin/public-profile was built, flag-on and ' +
                    'indexable, and had ZERO users because no screen offered it (#2844).',
            );
        }
    });

    it('escapes a regex metacharacter in a route path', () => {
        // The CONTROL for `escape`, which no real route exercises. Without it
        // the helper can be gutted to `return ''` and nothing fails — then the
        // static branch becomes /['"`]/, every file contains a quote, and
        // every page reads as linked. A guard that fails toward "linked" is
        // useless in exactly the direction that matters.
        const literal = linkPattern('/reports/q1.summary');
        expect(literal.source).toContain('q1\\.summary');
        // Proof it is not merely present but DISCRIMINATING: the escaped dot
        // must not match an arbitrary character in that position.
        expect(literal.test(`'/reports/q1.summary'`)).toBe(true);
        expect(literal.test(`'/reports/q1Xsummary'`)).toBe(false);

        // And the dynamic branch escapes its prefix too.
        const dynamic = linkPattern('/reports/q1.summary/[id]');
        expect(dynamic.source).toContain('q1\\.summary');
        expect(dynamic.test('`/reports/q1.summary/${x}`')).toBe(true);
        expect(dynamic.test('`/reports/q1Xsummary/${x}`')).toBe(false);
    });

    it('records no stale exemption', () => {
        const routes = new Set(pages.map((p) => p.route));
        for (const route of Object.keys(DELIBERATELY_UNLINKED)) {
            // An exemption for a deleted page keeps that PATH pre-approved for
            // whatever is created there next — the #1285 shape.
            expect(routes.has(route)).toBe(true);
        }
    });

    it('requires a real reason on every exemption', () => {
        for (const [route, reason] of Object.entries(DELIBERATELY_UNLINKED)) {
            expect(reason.length).toBeGreaterThan(40);
            expect(reason).not.toMatch(/\b(todo|tbd|later|for now|temporar)/i);
            expect(route.startsWith('/')).toBe(true);
        }
    });
});
