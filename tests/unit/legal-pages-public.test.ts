/**
 * `/terms` and `/dsa-contact` must be reachable WITHOUT an account (P3.1).
 *
 * This is the shape that already shipped broken once. `/privacy` was added and
 * allowlisted in the tenant-isolation structural guard — so it was allowed to
 * live outside `/t/[tenantSlug]` — but NOT in the middleware's public-path
 * allowlist, and in production it answered `307 → /login?next=…`. Two separate
 * lists that both have to agree, and satisfying one of them looks exactly like
 * being done. See `privacy-page-public.test.ts`, whose docblock records it.
 *
 * Both new pages are worse than `/privacy` to get wrong:
 *
 *   - `/terms` is linked from the registration consent checkbox. A login wall
 *     there means the only way to read the terms is to already have the account
 *     you need to accept them for, which is not consent in any sense.
 *   - `/dsa-contact` exists so a restricted user, an authority or a court can
 *     reach us. Every one of those is by definition not signed in.
 *
 * ── the key check is the other half, and it is behavioural ──
 *
 * Both pages build i18n keys by interpolation (`${section.key}Title`), so a
 * section added to the array without its two message keys throws at RUNTIME
 * and nothing static would catch it. The i18n parity gate compares the two
 * locales with each other; it cannot know which keys a page asks for.
 *
 * So the last block RENDERS each page with a `getTranslations` that throws on
 * any key absent from the real `messages/en.json`, and separately checks the
 * same set against `bg.json`. That executes the interpolation instead of
 * guessing at it with a regex.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGES = [
    { name: 'terms', route: '/terms', file: 'src/app/terms/page.tsx' },
    { name: 'dsa-contact', route: '/dsa-contact', file: 'src/app/dsa-contact/page.tsx' },
    // Added after `/start` shipped broken for exactly this reason: it was in
    // the structural allowlist and NOT in PUBLIC_PATH_EXACT, so an anonymous
    // visitor got `307 -> /login?next=%2Fstart` and registration was
    // unreachable by the people it exists for. The curated list above had the
    // two pages I happened to be writing at the time, which is why it did not
    // catch the one I had written three PRs earlier.
    { name: 'start', route: '/start', file: 'src/app/start/page.tsx' },
] as const;

describe('the legal pages are publicly reachable', () => {
    it.each(PAGES)('$route is in the middleware public-path allowlist', ({ route }) => {
        const guard = read('src/lib/auth/guard.ts');
        // EXACT entry, matched as its own list line — a substring match would
        // also be satisfied by the path appearing inside a comment.
        expect(guard).toMatch(new RegExp(`^\\s*'${route}',`, 'm'));
    });

    it.each(PAGES)('$route is also allowed to live outside /t/[tenantSlug]', ({ name }) => {
        // Both lists must agree. Satisfying only one is how /privacy broke.
        const structural = read('tests/unit/tenant-isolation-structural.test.ts');
        expect(structural).toMatch(new RegExp(`'${name}',`));
    });

    it.each(PAGES)('$route renders no tenant data — nothing to gate', ({ file }) => {
        // The justification for being public. If either page ever reads tenant
        // context, the allowlist entries above stop being safe.
        expect(read(file)).not.toMatch(/useTenantContext|getTenantCtx|tenantSlug/);
    });

    it('the shared consent control links to both /terms and /privacy', () => {
        // The link is the whole reason /terms has to be public.
        //
        // Retargeted from `FarmWizard.tsx`: the consent checkbox is now ONE
        // component rendered by both the wizard and the `/accept-terms`
        // interstitial, so this assertion follows it there. That is strictly
        // better — there is a single place the links can go missing, instead
        // of two that can disagree.
        const control = read('src/components/auth/TermsConsentCheckbox.tsx');
        expect(control).toMatch(/href="\/terms"/);
        expect(control).toMatch(/href="\/privacy"/);
    });

    it('both places that ask for consent render that one control', () => {
        // The other half: a link check on the shared component proves nothing
        // if a caller stops using it and hand-rolls its own label again.
        for (const caller of [
            'src/app/start/FarmWizard.tsx',
            'src/app/accept-terms/AcceptTermsForm.tsx',
        ]) {
            expect(read(caller)).toMatch(/TermsConsentCheckbox/);
        }
    });

    it('the terms page links onward to the DSA contact point', () => {
        // DSA Art 11/12 wants the contact point FINDABLE. A reader who starts
        // at the terms should not have to know the other URL exists.
        expect(read('src/app/terms/page.tsx')).toMatch(/href="\/dsa-contact"/);
    });
});

describe('every page allowed outside /t/ is EITHER public or session-gated on purpose', () => {
    // The curated list above is the detailed check; this is the one that would
    // have caught `/start` without anybody remembering to add it.
    //
    // `tenant-isolation-structural` allows a set of root-level page
    // directories to live outside `/t/[tenantSlug]`. Each is there because it
    // is identity-level or public — and every one of them that renders a page
    // an UNAUTHENTICATED visitor must reach has to appear in
    // `PUBLIC_PATH_EXACT` too. Satisfying one list looks exactly like being
    // finished, which is how this has now gone wrong three times.
    //
    // So the population is DERIVED from the structural allowlist, and each
    // entry must be classified. A new root page cannot be added without a
    // decision landing in one of these two lists.
    const structural = read('tests/unit/tenant-isolation-structural.test.ts');
    const guard = read('src/lib/auth/guard.ts');

    /**
     * Root page directories the structural guard permits.
     *
     * Scoped to the ALLOWED_ROOT_PAGES block specifically. A bare scan of
     * quoted strings in that file also picks up ALLOWED_API_DIRS and
     * ALLOWED_LEGACY_ROUTES — `metrics`, `webhooks`, `docs`, `openapi` and the
     * rest — which are API directories, not pages, and have nothing to do with
     * PUBLIC_PATH_EXACT. Deriving from the file instead of from the LIST is a
     * population one level off, and it reported ten phantom offenders the
     * first time this ran.
     */
    const rootPagesBlock = (() => {
        const start = structural.indexOf('const ALLOWED_ROOT_PAGES = new Set([');
        expect(start).toBeGreaterThan(-1);
        const end = structural.indexOf(']);', start);
        expect(end).toBeGreaterThan(start);
        return structural.slice(start, end);
    })();
    const allowedRoots = Array.from(
        // Trailing comments allowed: half the entries carry one
        // (`'login',  // Public login page`), and anchoring at `,$` silently
        // halved the population the first time — a partial set reported as
        // complete, which is the failure this whole block exists to stop.
        // Dotted entries (`page.tsx`, `layout.tsx`) are files, not page
        // directories, so they are excluded by the character class.
        rootPagesBlock.matchAll(/^\s*'([a-z0-9-]+)',/gm),
        (m) => m[1],
    );

    /**
     * Roots that are deliberately SESSION-GATED rather than public: reaching
     * them requires being signed in, so their absence from PUBLIC_PATH_EXACT
     * is correct. Each needs a reason, because the default must be to think
     * about it rather than to skip it.
     */
    const SESSION_GATED: Record<string, string> = {
        account: 'identity-level settings; a signed-out visitor has no account to edit',
        tenants: 'the membership picker — meaningless without a session',
        'no-tenant': 'shown to an authenticated user with no membership',
        onboarding: 'post-signup, always authenticated',
        dashboard: 'legacy redirect shim into a tenant',
        org: 'org surfaces resolve an OrgContext, which needs a session',
        'accept-terms': 'the consent interstitial — it holds an authenticated session',
        invite: 'sign-in gated by design (Epic 1): the invitee authenticates, then redeems',
        audit: 'token-gated share view under /audit/shared/[token], not a root page',
        'vendor-assessment': 'token-gated respondent page, same shape as audit/shared',
    };

    it('reports the population it classified', () => {
        // eslint-disable-next-line no-console -- the denominator IS the output
        console.log(`[root-pages] ${allowedRoots.length} roots allowed outside /t/`);
        expect(allowedRoots.length).toBeGreaterThan(5);
    });

    it.each(['start', 'terms', 'dsa-contact', 'privacy'])(
        '%s is in BOTH lists',
        (root) => {
            expect(allowedRoots).toContain(root);
            expect(guard).toMatch(new RegExp(`^\\s*'/${root}',`, 'm'));
        },
    );

    it('no allowed root is unclassified — public, session-gated, or a new decision', () => {
        const unclassified = allowedRoots.filter(
            (root) =>
                !SESSION_GATED[root] &&
                !new RegExp(`^\\s*'/${root}',`, 'm').test(guard),
        );
        expect(unclassified).toEqual([]);
    });
});

describe('the draft banner is wired to the constant, not hand-placed', () => {
    it('renders only while TERMS_ARE_LEGALLY_REVIEWED is false', () => {
        const page = read('src/app/terms/page.tsx');
        // Gated on the constant, so a reviewed version removes the banner by
        // flipping one boolean. A hand-placed banner would need somebody to
        // remember, and a reviewed document still claiming to be unreviewed is
        // as wrong as the reverse — only one of those corrects itself.
        expect(page).toMatch(/!TERMS_ARE_LEGALLY_REVIEWED\s*&&/);
    });

    it('the constant still says these terms are unreviewed', () => {
        // Not a belief about the law — a statement about THIS repo's state. If
        // somebody flips it, the banner goes and this reddens, which is the
        // prompt to check that a review genuinely happened.
        const src = read('src/lib/legal/terms.ts');
        expect(src).toMatch(/TERMS_ARE_LEGALLY_REVIEWED\s*=\s*false/);
    });

    it('the version carries the -draft suffix while that is true', () => {
        // A stored consent row reading `2026-10-07-draft` cannot later be
        // mistaken for acceptance of a reviewed document.
        const src = read('src/lib/legal/terms.ts');
        const m = src.match(/TERMS_VERSION\s*=\s*'([^']+)'/);
        expect(m).not.toBeNull();
        expect(m![1]).toMatch(/-draft$/);
    });
});

describe('every message key these pages ask for exists in both locales', () => {
    const en = JSON.parse(read('messages/en.json')) as Record<string, Record<string, string>>;
    const bg = JSON.parse(read('messages/bg.json')) as Record<string, Record<string, string>>;

    /**
     * Render a page with a translator that records each key and throws on one
     * the real catalogue does not hold. Executing the page is the point: both
     * build keys by interpolation, so a regex over the source would miss
     * exactly the keys most likely to be missing.
     */
    async function keysAskedFor(
        namespace: string,
        load: () => Promise<{ default: () => Promise<unknown> }>,
    ): Promise<string[]> {
        const asked: string[] = [];
        jest.resetModules();
        jest.doMock('next-intl/server', () => ({
            getTranslations: async () => {
                const t = (key: string, params?: Record<string, unknown>) => {
                    asked.push(key);
                    const value = en[namespace]?.[key];
                    if (value === undefined) {
                        throw new Error(`missing key: ${namespace}.${key}`);
                    }
                    return params ? `${value}` : value;
                };
                return t;
            },
        }));
        jest.doMock('@/env', () => ({ env: { DSA_CONTACT_EMAIL: 'role@example.test' } }));

        const mod = await load();
        const { renderToStaticMarkup } = await import('react-dom/server');
        const element = await mod.default();
        // Rendering forces every branch the page takes at request time.
        renderToStaticMarkup(element as React.ReactElement);
        return asked;
    }

    it('the terms page', async () => {
        const asked = await keysAskedFor('terms', () => import('@/app/terms/page'));
        // Guard against the test passing because nothing rendered: a page that
        // threw early, or one whose sections array emptied, would ask for few
        // keys and satisfy a bare "no missing key" assertion.
        expect(asked.length).toBeGreaterThan(20);
        const missingInBg = asked.filter((k) => bg.terms?.[k] === undefined);
        expect(missingInBg).toEqual([]);
    });

    it('the DSA contact page', async () => {
        const asked = await keysAskedFor('dsa', () => import('@/app/dsa-contact/page'));
        expect(asked.length).toBeGreaterThan(8);
        const missingInBg = asked.filter((k) => bg.dsa?.[k] === undefined);
        expect(missingInBg).toEqual([]);
    });
});
