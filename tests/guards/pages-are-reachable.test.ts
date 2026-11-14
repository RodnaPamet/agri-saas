/**
 * Every page is LINKED from somewhere, or recorded as deliberately unlinked
 * (#2844, widened to the whole of `src/app` by #3037).
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
 * ## The population is every page under `src/app`, not one subtree
 *
 * It was `src/app/t/[tenantSlug]/(app)` alone until #3037 — 83 of the 111
 * pages — so a NON-TENANT page could ship linked from nothing and this guard
 * could not see it, which is the defect it was built for. `/library` (#2980)
 * is what found it: non-tenant by owner ruling, genuinely linked from the
 * «Пазар» sidebar, and nothing would have failed had it not been.
 *
 * ## Routes are measured PER SUBTREE, because that is how links are written
 *
 * A link is written relative to its subtree — `tenantHref('/admin/members')`,
 * `orgHref('/tenants')` — so a tenant page's route is its path under
 * `(app)`, not the `/t/[tenantSlug]/…` filesystem path. Deriving every route
 * from `src/app` instead would produce `/t/[tenantSlug]/admin/members`, which
 * no link in the repo spells, and every page in the product would read as
 * unlinked. Hence `SUBTREES`, most specific first.
 *
 * ## Exemptions are keyed `tree:route`, and that is load-bearing
 *
 * Four route keys occur in two subtrees at once — `/`, `/dashboard`,
 * `/evidence`, `/tenants` — so a bare-route key would excuse two different
 * pages with one entry. `/dashboard` is the live case: the ROOT `/dashboard`
 * is a legacy redirect shim that needs an exemption, and the TENANT
 * `/dashboard` is the main screen of the product. One shared key would
 * pre-approve the product's front page for whatever is done to it next — the
 * #1285 shape, where an exemption outlives the thing it described.
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
 * A DYNAMIC route is matched on its static prefix plus a terminator of `${`
 * or a quote, because `/exchange/threads/[threadId]` is linked as
 * `` tenantHref(`/exchange/threads/${th.id}`) `` and the literal id never
 * appears in source.
 *
 * ## TWO shapes, and the opening quote is what separates the subtrees
 *
 * Links come in two forms, measured 2026-11-13 across the whole tree:
 *
 *   relative  `tenantHref('/admin/members')`, `orgHref('/tenants')`
 *   full      `` `/t/${slug}/my-work` ``, `` `/org/${orgSlug}/tenants/new` ``
 *
 * The relative shape requires the path to START the literal — an opening
 * quote or backtick immediately before it. That anchor is doing three jobs at
 * once, each of which was a measured false positive before #3037:
 *
 *   • **An import specifier satisfied the old pattern.** `from
 *     '@/app-layer/usecases/library'` ends in `/library'`, so two API route
 *     files "linked" `/library`. No tenant page was masked by this (measured:
 *     0 of 83), which is exactly why it survived — a latent hole that the
 *     widening would have made live.
 *   • **A child subtree's full path satisfied a root route.** Root
 *     `/dashboard` matched in 97 files, every one of them a
 *     `/t/{slug}/dashboard` belonging to the TENANT page of the same name.
 *     The root shim read as the best-linked page in the repo.
 *   • **An org route matched its tenant twin.** Org `/audit` matched 83
 *     files; exactly one was an `orgHref('/audit')`.
 *
 * So the full shape is spelled per subtree (`/t/` + an interpolation, `/org/`
 * + an interpolation) rather than left to a bare suffix match, and the app
 * root — which has no prefix — accepts the relative shape only.
 *
 * ## Its own directory does not count
 *
 * A page that only references its own path — a redirect to itself, a docblock
 * citation, a `usePathname` comparison — is not reachable from anywhere else.
 * So matches inside the page's own directory are ignored, which is what makes
 * the P6 case fail: `admin/public-profile/` mentioned itself twice.
 *
 * ## The index route of a subtree is not checked
 *
 * `src/app/page.tsx` and the org portfolio overview both derive to `/`, which
 * as a pattern would match a quote followed by a slash — every path in the
 * repo. Both are linked (`orgHref('/')`, the landing page is the origin
 * itself) and neither is checkable this way, so they are skipped explicitly
 * rather than silently passing.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_DIR = path.join(REPO_ROOT, 'src/app');
/** `src/app/api` serves JSON. A route handler is not a page and links to none. */
const API_DIR = path.join(APP_DIR, 'api');

interface Subtree {
    /** Repo-relative directory routes are measured FROM. */
    root: string;
    /** Printed in the denominator and used to key an exemption. */
    label: string;
    /**
     * The URL prefix a FULL-PATH link carries ahead of the route, with the
     * subtree's dynamic segment interpolated — `` `/t/${slug}/my-work` ``.
     * `null` for the app root, which has no prefix, so only the relative
     * shape can link it.
     */
    prefix: string | null;
}

/**
 * Most specific first — a page is assigned to the first subtree that contains
 * it, so a tenant page is never measured as a root page.
 */
const SUBTREES: readonly Subtree[] = [
    { root: 'src/app/t/[tenantSlug]/(app)', label: 'tenant', prefix: '/t/' },
    { root: 'src/app/org/[orgSlug]/(app)', label: 'org', prefix: '/org/' },
    { root: 'src/app', label: 'root', prefix: null },
];

/**
 * Routes with no in-app link, each with a written reason.
 *
 * An entry is a claim that nobody is MEANT to navigate here from inside the
 * product. "We have not got round to linking it" is not such a reason — that
 * is the bug this guard exists to report.
 */
const DELIBERATELY_UNLINKED: Readonly<Record<string, string>> = {
    'tenant:/grain/payroll':
        'A retired surface kept as a REDIRECT to `/grain/costs`, where payroll became a category. Unlinked on purpose — the sidebar and `GrainSectionNav` point at the category — and kept rather than deleted because the URL is in browser histories and bookmarks, and a farmer who followed one to a 404 would reasonably conclude their payroll data had been lost.',
    'tenant:/issues/[issueId]':
        'A legacy redirect to `/farm-tasks/[id]`, and being unlinked is the POINT: it exists to catch bookmarks and old links from before the rename, so a link to it from inside the product would send somebody the long way round. Deleting it instead would 404 those bookmarks — #1087 is what a silent route removal costs.',
    // ── the app root (#3037) ──────────────────────────────────────────────
    //
    // Only TWO root pages have no in-app link at all. The other nineteen are
    // linked, several of them by something that is a sender rather than a
    // screen — a push payload, a redirect, an `openapi` next-step — and the
    // guard counts those, correctly: a push notification IS a way in.
    //
    // So the senders for the whole root population live in
    // `ROOT_PAGE_SENDERS` below, which documents rather than suppresses. An
    // entry here is a SUPPRESSION and is asserted LIVE: writing one for a
    // page that something already links would be an exemption that excuses
    // nothing and outlives whatever it described (#1285).

    'root:/reset-password':
        'Reached from an EMAILED token link and from nowhere else. The sender is `sendPasswordResetEmail` in `src/lib/auth/password-management.ts`, which builds `${base}/reset-password?token=…`; the token is the whole point, so an in-app link to the bare path would land on a page that can only refuse. `/forgot-password` is the in-app half and IS linked, from the login screen.',
    'root:/account':
        'An index that `redirect()`s to `/account/profile`, kept to catch a typed or bookmarked bare path — its own docblock records that `/account` used to 404, when the only way in was a deep link to one of the two sections. The two sections ARE linked, from `AccountNav` and the user menu, so a link here would send somebody through a redirect to reach what the menu already offers.',
};

/**
 * Who sends a person to each ROOT page — the #3037 classification.
 *
 * This is DOCUMENTATION, not suppression: most of these pages are linked, and
 * the guard sees it. The map exists because at the root the useful question is
 * "who sends a person here" rather than "which screen links it" — an emailed
 * link, a middleware redirect, a gate bounce and an external referrer are all
 * real ways in that no in-app link represents, and #3037 asked for the
 * judgement to be recorded entry by entry rather than as a blanket "root
 * pages are exempt", which would recreate the hole for the next non-tenant
 * surface.
 *
 * It is asserted COMPLETE against the filesystem population, so a new root
 * page cannot land without somebody naming its sender. That is the half that
 * makes it worth having — a prose list nobody checks would rot in a release.
 */
const ROOT_PAGE_SENDERS: Readonly<Record<string, string>> = {
    '/login': 'The Edge, on any unauthenticated request to a gated path; also linked from `/start` and `/accept-terms`.',
    '/start': 'Registration. Linked from `/login` and from the landing page — the one root page whose audience has no account yet.',
    '/forgot-password': 'Linked from `/login`. The in-app half of the reset flow, whose emailed half is `/reset-password`.',
    '/reset-password': 'An EMAILED token link, built by `sendPasswordResetEmail`. Suppressed above — nothing in-app links it, and nothing should.',
    '/accept-terms': 'A gate HOLD: the Edge keeps an unconsented session here rather than stamping an agreement nobody gave. Arrival is a redirect, not a click.',
    '/no-tenant': 'A gate BOUNCE: `src/middleware.ts` redirects here in four places when an authenticated person has no membership, and `/tenants` sends them at zero memberships.',
    '/suspended': 'A refusal destination, from `src/lib/auth/suspension-page.ts`. Reached by being turned away somewhere else.',
    '/tenants': 'The membership picker. Linked from the user menu, `/accept-terms` and the account layout.',
    '/account': 'A redirect to `/account/profile`, catching a typed or bookmarked bare path. Suppressed above.',
    '/account/profile': 'Linked from `AccountNav` and the user menu. Also the destination the bare `/account` index redirects to.',
    '/account/security': 'Linked from `AccountNav` and the user menu — the second of the two account sections.',
    '/dashboard': 'A legacy redirect shim into a tenant, kept for bookmarks and emailed links predating the `/t/{slug}` move — #1087 is what a silent route removal costs. The post-sign-in senders (both SSO callbacks, the invite accept-redirect) build `/t/{slug}/dashboard` directly, so the ~40 `tenantHref(\'/dashboard\')` breadcrumbs are the TENANT screen and not this one.',
    '/invite/[token]': 'An EMAILED invitation, token-bearing, built by `src/app-layer/usecases/invites.ts` and resolved by `/api/invites/[token]/accept-redirect`.',
    '/invite/org/[token]': 'The organization half of that emailed invitation, built by `src/app-layer/usecases/org-invites.ts`.',
    '/f/[handle]': 'EXTERNAL: a search engine or a link the farm pasted elsewhere. `sitemap.ts` offers it to crawlers and each profile decides its own `noindex`. Also linked in-app from `PublicProfileClient` as a preview of the operator\'s own page.',
    '/library': '«Вдъхновение» (#2980). Linked from the «Пазар» section of `SidebarNav`. Non-tenant by owner ruling, and the page whose addition found this guard\'s blind spot — it was linked, and nothing would have failed had it not been.',
    '/library/[slug]': 'Linked from the library directory at `/library`, which is the only way in — a book has no other surface that names it.',
    '/privacy': 'Linked from the consent checkbox, `/terms`, `/dsa-contact` and the offer modal. Public by legal duty.',
    '/terms': 'Linked from the shared consent control, which is why it must stay public: a login wall there would mean the only way to read the terms is to already hold the account you need them for.',
    '/dsa-contact': 'Linked from `/terms`. DSA Art 11/12 wants the contact point FINDABLE by an authority or a court — none of whom are signed in.',
    '/': 'EXTERNAL: somebody typing the domain, or any inbound link from outside the product. It IS the origin, so there is no path for a screen to link, which is why the reachability check skips it — see the docblock on index routes.',
};

interface PageRoute {
    /** Route path WITHIN its subtree, e.g. `/admin/members` or `/login`. */
    route: string;
    /** Repo-relative directory of the page file. */
    dir: string;
    /** Which subtree it was measured against. */
    tree: string;
    /** That subtree's full-path prefix, or `null` for the app root. */
    prefix: string | null;
}

/** `tree:route` — the key an exemption is written under. See the docblock. */
function keyOf(page: Pick<PageRoute, 'tree' | 'route'>): string {
    return `${page.tree}:${page.route}`;
}

function subtreeFor(relFile: string): Subtree {
    for (const st of SUBTREES) {
        if (relFile.startsWith(`${st.root}/`)) return st;
    }
    // `SUBTREES` ends with `src/app`, which contains every page by
    // construction, so this is unreachable rather than a fallback.
    throw new Error(`page outside every subtree: ${relFile}`);
}

function findPages(): PageRoute[] {
    if (!fs.existsSync(APP_DIR)) {
        throw new Error(
            `scan root does not exist: ${APP_DIR} — a renamed root would scan zero ` +
                'pages and pass (#875).',
        );
    }
    const out: PageRoute[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (full === API_DIR) continue;
                walk(full);
                continue;
            }
            if (entry.name !== 'page.tsx') continue;
            const relFile = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
            const st = subtreeFor(relFile);
            const rel = path
                .relative(path.join(REPO_ROOT, st.root), path.dirname(full))
                .replace(/\\/g, '/');
            // Route groups — `(app)`, `(marketing)` — are not path segments.
            const segments = rel
                .split('/')
                .filter((s) => s.length > 0 && !(s.startsWith('(') && s.endsWith(')')));
            out.push({
                route: `/${segments.join('/')}`,
                dir: path.relative(REPO_ROOT, path.dirname(full)).replace(/\\/g, '/'),
                tree: st.label,
                prefix: st.prefix,
            });
        }
    };
    walk(APP_DIR);
    return out;
}

/**
 * Calls whose path argument is SUBTREE-RELATIVE by construction.
 *
 * `tenantPath(slug, path)` is `` `/t/${encodeURIComponent(slug)}${path}` ``,
 * and `tenantHref` / `orgHref` are the same shape — so the argument can never
 * be a link to a ROOT page. That is a fact about these functions, not a
 * heuristic, which is what makes it safe to subtract them.
 *
 * It closes the fourth false positive #3037 measured, and the subtlest: the
 * root `/dashboard` and the tenant `/dashboard` are the same STRING, so an
 * opening quote cannot separate them. Root `/dashboard` read as linked by the
 * ~40 `tenantHref('/dashboard')` breadcrumbs, every one of which goes to the
 * tenant screen. Measured: with these subtracted, the root population's
 * unlinked set is `/account` and `/reset-password`; without them it is empty.
 *
 * The bare `href(` is included because all ten of its call sites are local
 * aliases for a tenant path (checked 2026-11-13) — the palette's
 * `const href = (path) => tenantPath(tenantSlug, path)` and three tenant
 * pages. If a root-relative `href()` helper ever appears, this is the line
 * that has to change.
 *
 * ## It is NOT applied to the prefixed subtrees, and that was measured
 *
 * Requiring a tenant link to sit inside one of these helpers reports **10**
 * tenant pages unlinked where the loose shape reports 2 — because legitimate
 * links also live in nav tables that hold a bare suffix
 * (`resolve-bottom-tabs.ts`, `page-segregation.ts`, `usage-events.ts`) and
 * are prefixed later. Eight false exemptions is a worse outcome than the
 * residual looseness, which is this: a bare root-style literal could excuse a
 * prefixed page of the same name. Recorded rather than fixed.
 */
const SUBTREE_HREF_HELPERS =
    '(?:tenantHref|useTenantHref|orgHref|useOrgHref|tenantPath|orgPath|href)';

/**
 * The patterns that find a link to `route`, as a disjunction.
 *
 * Relative: an opening quote or backtick, the path, then a closing quote or
 * backtick. Full: the subtree's prefix, an interpolated dynamic segment, then
 * the same. A dynamic route is matched on its static prefix, terminated by
 * `${` or a quote.
 *
 * ## The OPENING quote is the part that earns its place
 *
 * Without it the pattern matches a path SUFFIX anywhere, and three measured
 * false positives follow — an import specifier (`from
 * '@/app-layer/usecases/library'`), a child subtree's full path satisfying a
 * root route (`/t/{slug}/dashboard` for root `/dashboard`, 97 files), and an
 * org route satisfied by its tenant twin (`/audit`, 83 files). All three
 * point toward "linked", which is the one direction this guard must never
 * fail in. See the file docblock.
 *
 * ## The escaping has no effect on today's routes, which is why it has a test
 *
 * `Selector teeth` reported the inner `escape` as SURVIVED, and it was right:
 * no route in this repo contains a regex metacharacter. Dynamic segments are
 * the only source of `[` and `]`, and they are sliced off before the escape
 * runs — so `escape(route) === route` for all 107 of them and gutting it to
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
function linkPatterns(route: string, prefix: string | null): RegExp[] {
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // An INTERMEDIATE dynamic segment matches either an interpolation or a
    // literal segment, and stops at the next `/` — so it cannot run past its
    // own segment into the rest of the path. See "a nested route" below.
    const INTERP = `(?:\\$\\{[^}]*\\}|[^/'\"\`]+)`;
    const segments = route.split('/').filter(Boolean);
    const isDynamic = (s: string): boolean => s.startsWith('[');
    // A TRAILING dynamic segment is dropped and answered by the tail, because
    // the id itself never appears in source. An intermediate one stays, as
    // INTERP, because the path CONTINUES past it and that continuation is the
    // only thing telling this route from its parent.
    const trailingDynamic = segments.length > 0 && isDynamic(segments[segments.length - 1]!);
    const kept = trailingDynamic ? segments.slice(0, -1) : segments;
    const body = kept.length === 0
        ? '/'
        : `/${kept.map((s) => (isDynamic(s) ? INTERP : escape(s))).join('/')}${trailingDynamic ? '/' : ''}`;
    const tail = trailingDynamic ? `(?:\\$\\{|['"\`])` : `['"\`]`;
    if (prefix === null) {
        // The app root has no prefix, so the relative shape is all there is —
        // and it must additionally refuse a SUBTREE HELPER's argument. See
        // `SUBTREE_HREF_HELPERS`.
        return [new RegExp(`(?<!${SUBTREE_HREF_HELPERS}\\(\\s*)['"\`]${body}${tail}`)];
    }
    return [
        new RegExp(`['"\`]${body}${tail}`),
        // `/t/` + `${anything}` + the route. `[^}]*` stops at the closing
        // brace, so `${params.tenantSlug}` is matched and a nested template
        // cannot run past its own interpolation.
        new RegExp(`${escape(prefix)}\\$\\{[^}]*\\}${body}${tail}`),
    ];
}

describe('every page is reachable from inside the product (#2844, #3037)', () => {
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
    //   * `src/app/robots.ts` is a DISALLOW list. It names `/login`,
    //     `/reset-password`, `/forgot-password` and `/invite/` precisely to
    //     keep crawlers OUT, so a path there is being EXCLUDED — the exact
    //     inverse of being offered. Measured: `/account` and
    //     `/reset-password` matched here and nowhere else.
    //   * `src/app/sitemap.ts` tells a crawler what to fetch. That is an
    //     audience outside the product, not navigation within it.
    //   * `src/lib/auth/guard.ts` CLASSIFIES paths — the Edge public-path
    //     allowlist and the `isOperatorAllowedPath` comparisons. It performs
    //     zero redirects (measured: 0, against 11 in `src/middleware.ts`), so
    //     it decides whether a path is ALLOWED and never sends anybody there.
    //     `src/middleware.ts` is deliberately KEPT for the opposite reason: a
    //     redirect IS a sender, and it is the only thing that links
    //     `/my-work` and `/no-tenant`.
    const NOT_A_WAY_IN = [
        'src/generated/',
        'src/lib/assistant/generated/page-routes.ts',
        'src/lib/nav/canonical-parents.ts',
        'src/app/robots.ts',
        'src/app/sitemap.ts',
        'src/lib/auth/guard.ts',
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
        // above its floor. Broken down by subtree, because the whole point of
        // #3037 is that the total used to be one subtree's worth — a count
        // alone would not have shown that.
        const byTree = SUBTREES.map(
            (st) => `${st.label}=${pages.filter((p) => p.tree === st.label).length}`,
        ).join(' ');
        console.log(
            `[pages-are-reachable] ${pages.length} page(s) (${byTree}) scanned against ` +
                `${sources.length} source file(s); ${Object.keys(DELIBERATELY_UNLINKED).length} ` +
                'recorded as deliberately unlinked',
        );
        expect(pages.length).toBeGreaterThanOrEqual(100);
        expect(sources.length).toBeGreaterThanOrEqual(1500);
        // Each subtree must contribute, or a renamed root silently removes a
        // third of the population while the total stays above its floor.
        for (const st of SUBTREES) {
            expect(pages.filter((p) => p.tree === st.label).length).toBeGreaterThan(0);
        }
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

        for (const page of pages) {
            // A subtree's index route: `/` as a pattern matches a quote
            // followed by a slash, i.e. every path in the repo. See the
            // docblock — skipped explicitly rather than passing silently.
            if (page.route === '/') continue;
            if (DELIBERATELY_UNLINKED[keyOf(page)]) continue;

            const patterns = linkPatterns(page.route, page.prefix);
            let linked = false;
            for (const [rel, text] of blanked) {
                // A page referencing its OWN path is not a way in.
                if (rel.startsWith(`${page.dir}/`) || path.dirname(rel) === page.dir) {
                    continue;
                }
                if (patterns.some((re) => re.test(text))) {
                    linked = true;
                    break;
                }
            }
            if (!linked) unlinked.push(keyOf(page));
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
        // static branch becomes /['"`]['"`]/, and a file containing `''`
        // reads as linking every page. A guard that fails toward "linked" is
        // useless in exactly the direction that matters.
        const [literal] = linkPatterns('/reports/q1.summary', null);
        expect(literal.source).toContain('q1\\.summary');
        // Proof it is not merely present but DISCRIMINATING: the escaped dot
        // must not match an arbitrary character in that position.
        expect(literal.test(`'/reports/q1.summary'`)).toBe(true);
        expect(literal.test(`'/reports/q1Xsummary'`)).toBe(false);

        // And the dynamic branch escapes its prefix too.
        const [dynamic] = linkPatterns('/reports/q1.summary/[id]', null);
        expect(dynamic.source).toContain('q1\\.summary');
        expect(dynamic.test('`/reports/q1.summary/${x}`')).toBe(true);
        expect(dynamic.test('`/reports/q1Xsummary/${x}`')).toBe(false);
    });

    it('tells a route BELOW a dynamic segment from its parent (#3030)', () => {
        // The population this covers was EMPTY until #3030, and that is why
        // the hole was latent rather than visible: measured 2026-11-14, zero
        // of the 111 routes had any path after their first dynamic segment,
        // so truncating at the first `[` was lossless for every one of them.
        //
        // `/channels/[channelId]/posts/[postId]` is the first, and under the
        // truncating form its pattern was `'/channels/` + `${` — which the
        // EXISTING feed link already satisfies. The permalink page would have
        // read as linked before anything linked it, which is the one
        // direction this guard must never fail in.
        const [nested] = linkPatterns('/channels/[channelId]/posts/[postId]', null);

        // The parent's link is not a way in to the child.
        expect(nested.test('`/channels/${channel.id}`')).toBe(false);
        // Nor is the query-string form the push used before the page existed.
        expect(nested.test('`/channels/${channelId}?post=${postId}`')).toBe(false);
        // The real link is.
        expect(nested.test('`/channels/${channelId}/posts/${postId}`')).toBe(true);
        // An INTERMEDIATE id spelled literally counts — INTERP accepts a bare
        // segment as well as an interpolation. The TRAILING one does not, and
        // that is pre-existing rather than new: the tail has always required
        // `${` or a quote, because widening it to accept a literal id would
        // make `'/channels/` match `'/channels/anything'` and give the parent
        // its child's link back.
        expect(nested.test('`/channels/abc/posts/${id}`')).toBe(true);

        // INTERP stops at its own segment: an interpolation cannot swallow the
        // rest of the path and make the `/posts/` requirement vacuous.
        expect(nested.test('`/channels/${a}/${b}`')).toBe(false);

        // And the parent is still matched by its own link, so tightening the
        // child did not break the ancestor.
        const [parent] = linkPatterns('/channels/[channelId]', null);
        expect(parent.test('`/channels/${channel.id}`')).toBe(true);
    });

    it('builds today\'s routes exactly as the truncating form did', () => {
        // The REGRESSION control for the rewrite. Every route whose only
        // dynamic segment is trailing (or which has none) must produce the
        // identical pattern, because that is all 111 of them — so this change
        // is provably confined to the new population above.
        // Built through `new RegExp` so the comparison is against a SOURCE,
        // not a raw string: `RegExp` normalises `/` to `\/`, and comparing a
        // string to a source would differ on every route for that reason
        // alone. The `/t/` prefix is used because the app-root branch adds a
        // negative lookbehind, and restating that constant here would make
        // this control a second copy of the thing it grades.
        const truncating = (route: string): string => {
            const escape = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const firstDynamic = route.indexOf('/[');
            const body = escape(firstDynamic === -1 ? route : route.slice(0, firstDynamic + 1));
            const tail = firstDynamic === -1 ? `['"\`]` : `(?:\\$\\{|['"\`])`;
            return new RegExp(`['"\`]${body}${tail}`).source;
        };

        let compared = 0;
        for (const page of pages) {
            const route = page.route;
            const i = route.indexOf('/[');
            // Skip the new population — it is SUPPOSED to differ, and the
            // case above is what grades it.
            if (i !== -1 && route.slice(i + 1).includes('/')) continue;
            const [mine] = linkPatterns(route, '/t/');
            expect(mine.source).toBe(truncating(route));
            compared += 1;
        }
        // A floor, so an extraction that selected nothing cannot pass here.
        expect(compared).toBeGreaterThanOrEqual(100);
    });

    it('refuses a path that does not START the literal', () => {
        // The teeth for the opening quote, and for all three measured false
        // positives #3037 found. Each of these reads as a link under a bare
        // suffix match and is not one.
        const [root] = linkPatterns('/dashboard', null);
        expect(root.test(`'/dashboard'`)).toBe(true);
        // A CHILD subtree's full path. 97 files spell this, every one of them
        // the tenant dashboard rather than the root shim.
        expect(root.test('`/t/${slug}/dashboard`')).toBe(false);

        // An IMPORT SPECIFIER. Nothing about `/library` the route.
        const [library] = linkPatterns('/library', null);
        expect(library.test(`from '@/app-layer/usecases/library'`)).toBe(false);
        expect(library.test(`href="/library"`)).toBe(true);

        // The existing terminator rule, restated here because the anchor must
        // not have replaced it: a parent must not be linked by its child.
        const [exchange] = linkPatterns('/exchange', 'ro/');
        expect(exchange.test(`'/exchange/threads'`)).toBe(false);
    });

    it('matches a full-path link only for the subtree that owns the prefix', () => {
        // The second shape, and the reason it is spelled per subtree. A
        // tenant page is linked both ways; the same text must NOT link the
        // org page of that name, or an org surface could ship unlinked and be
        // excused by its tenant twin (`/audit` matched 83 files; exactly one
        // was an `orgHref`).
        const tenant = linkPatterns('/evidence', '/t/');
        expect(tenant.some((re) => re.test('`/t/${tenantSlug}/evidence`'))).toBe(true);
        expect(tenant.some((re) => re.test(`orgHref('/evidence')`))).toBe(true);

        const org = linkPatterns('/evidence', '/org/');
        expect(org.some((re) => re.test('`/org/${orgSlug}/evidence`'))).toBe(true);
        // The tenant full path must not satisfy the org route…
        expect(org.some((re) => re.test('`/t/${tenantSlug}/evidence`'))).toBe(false);

        // …and the app root, which has no prefix, gets the relative shape
        // ONLY — one pattern, not two.
        expect(linkPatterns('/login', null)).toHaveLength(1);
        expect(linkPatterns('/evidence', '/t/')).toHaveLength(2);
    });

    it('assigns every page to the most specific subtree', () => {
        // `SUBTREES` ends with `src/app`, which contains every page, so a
        // wrong ORDER would classify all 111 as root pages — and then every
        // tenant route would be measured without its `/t/` prefix and read as
        // unlinked. Cheap to assert, and the ordering is invisible otherwise.
        expect(subtreeFor('src/app/t/[tenantSlug]/(app)/admin/page.tsx').label).toBe('tenant');
        expect(subtreeFor('src/app/org/[orgSlug]/(app)/members/page.tsx').label).toBe('org');
        expect(subtreeFor('src/app/login/page.tsx').label).toBe('root');
    });

    it('records no stale exemption', () => {
        const keys = new Set(pages.map(keyOf));
        for (const key of Object.keys(DELIBERATELY_UNLINKED)) {
            // An exemption for a deleted page keeps that PATH pre-approved for
            // whatever is created there next — the #1285 shape.
            expect(keys.has(key)).toBe(true);
        }
    });

    it('keys every exemption by a REAL subtree', () => {
        // A key is `tree:route`, and a typo in the tree half — `tenants:` for
        // `tenant:` — produces an entry that matches no page. That would fail
        // the staleness test above, but with a message about a missing route
        // rather than about the typo, so this names it directly.
        const labels = new Set(SUBTREES.map((st) => st.label));
        for (const key of Object.keys(DELIBERATELY_UNLINKED)) {
            const [tree, ...rest] = key.split(':');
            expect(labels.has(tree)).toBe(true);
            expect(rest.join(':').startsWith('/')).toBe(true);
        }
    });

    it('requires a real reason on every exemption', () => {
        for (const [key, reason] of Object.entries(DELIBERATELY_UNLINKED)) {
            expect(reason.length).toBeGreaterThan(40);
            expect(reason).not.toMatch(/\b(todo|tbd|later|for now|temporar)/i);
            expect(key).toMatch(/^[a-z]+:\//);
        }
    });

    it('names a sender for EVERY root page', () => {
        // The #3037 classification, asserted complete against the filesystem
        // rather than against a second hand-written list. A new non-tenant
        // page cannot land without somebody deciding who sends a person
        // there — which is the judgement the issue asked for, and the one
        // thing a blanket root exemption would have skipped.
        const rootRoutes = pages.filter((p) => p.tree === 'root').map((p) => p.route);
        const unclassified = rootRoutes.filter((r) => !ROOT_PAGE_SENDERS[r]);
        expect(unclassified).toEqual([]);

        // And no stale entry: a sender for a page that no longer exists is
        // prose describing nothing (#1285).
        const live = new Set(rootRoutes);
        expect(Object.keys(ROOT_PAGE_SENDERS).filter((r) => !live.has(r))).toEqual([]);
    });

    it('names an actual SENDER, not a restatement', () => {
        const SENDER =
            /emailed|email|redirect|bounce|hold|sitemap|crawler|search engine|QR code|push|sent|turned away|linked from|Edge|external/i;
        expect(Object.keys(ROOT_PAGE_SENDERS).length).toBeGreaterThan(15);
        for (const [route, reason] of Object.entries(ROOT_PAGE_SENDERS)) {
            expect(reason.length).toBeGreaterThan(40);
            expect(reason).toMatch(SENDER);
            expect(route.startsWith('/')).toBe(true);
        }
    });

    it('suppresses only pages that are GENUINELY unlinked', () => {
        // An exemption is a suppression, so it must be LIVE: one written for a
        // page something already links excuses nothing today and keeps that
        // path pre-approved for whatever happens to it next (#1285).
        //
        // EVERY subtree, since #3048. It was scoped to the root entries when
        // #3037 added it, because two TENANT entries were already inert on
        // main — `/machines/[assetId]` and `/field/[taskId]`, both found
        // linked by their push payload `` `/t/${slug}/machines/${assetId}` ``.
        // The guard was right and the entries were wrong: a push notification
        // IS a way in, and `/field/[taskId]`'s own reason said so. Both pages
        // now carry that reasoning in their own docblocks, where "nothing
        // should link here" is a statement about the page rather than about
        // this guard, and the entries are gone.
        //
        // So the map means exactly one thing: nothing links this, and nothing
        // is meant to. An entry that fails this test is describing an
        // intention, which belongs in the page.
        const inert: string[] = [];
        for (const page of pages) {
            if (page.route === '/') continue;
            if (!DELIBERATELY_UNLINKED[keyOf(page)]) continue;

            const patterns = linkPatterns(page.route, page.prefix);
            for (const [rel, text] of blanked) {
                if (rel.startsWith(`${page.dir}/`) || path.dirname(rel) === page.dir) {
                    continue;
                }
                if (patterns.some((re) => re.test(text))) {
                    inert.push(`${keyOf(page)} (linked by ${rel})`);
                    break;
                }
            }
        }
        expect(inert).toEqual([]);
    });
});
