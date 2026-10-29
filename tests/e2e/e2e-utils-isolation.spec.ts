/**
 * GAP-23 — `createIsolatedTenant()` self-test + canonical example.
 *
 * This spec serves two purposes:
 *
 *   1. Sanity-checks the factory in `e2e-utils.ts`:
 *      - returns the full credential set
 *      - two invocations produce distinct tenants/users/slugs (the
 *        precondition for parallelising the suite)
 *      - the returned credentials authenticate end-to-end via the
 *        production credentials flow and the resulting page lands
 *        on `/t/<slug>/dashboard`
 *
 *   2. Acts as the reference adoption example for spec authors. A
 *      future spec wanting per-test isolation can copy the
 *      `test.describe(...)` block below and replace the assertions
 *      with its own.
 *
 * The factory is deliberately exercised via Playwright's request
 * fixture (the standard pattern for API-driven setup) AND via an
 * implicit ephemeral context (the no-options path) so both
 * call shapes are covered.
 */

import { expect, test } from '@playwright/test';
import {
    createIsolatedTenant,
    describeUrlChanges,
    instrumentUrlChanges,
    signInAs,
    type IsolatedTenantCredentials,
} from './e2e-utils';

test.describe('GAP-23 — createIsolatedTenant', () => {
    test('returns a full set of credentials with valid shape', async ({ request }) => {
        const tenant = await createIsolatedTenant({ request });

        // Slug shape: lowercase + hyphens (the route's slug derivation).
        expect(tenant.tenantSlug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
        expect(tenant.tenantId).toMatch(/^[a-z0-9]+$/); // cuid
        expect(tenant.tenantName.length).toBeGreaterThan(0);

        // Owner: e2e.test domain (intentionally non-routable so a
        // mis-fired verification email never escapes).
        expect(tenant.ownerEmail).toMatch(/@e2e\.test$/);
        expect(tenant.ownerUserId).toMatch(/^[a-z0-9]+$/);
        expect(tenant.ownerName.length).toBeGreaterThan(0);

        // Password is high-entropy (HIBP-safe). 32 hex chars + 4-char
        // prefix = 36 chars, mixed-case + symbol.
        expect(tenant.ownerPassword.length).toBeGreaterThanOrEqual(32);
        expect(tenant.ownerPassword).toMatch(/[A-Z]/);
        expect(tenant.ownerPassword).toMatch(/[!@#$%^&*]/);
    });

    test('produces distinct tenants/users/slugs across invocations', async ({ request }) => {
        // Two back-to-back calls — even with `Date.now()` rounding to
        // the same millisecond, the UUIDv4 prefix in orgName forces
        // distinct slug derivation.
        const a = await createIsolatedTenant({ request });
        const b = await createIsolatedTenant({ request });

        expect(a.tenantId).not.toBe(b.tenantId);
        expect(a.tenantSlug).not.toBe(b.tenantSlug);
        expect(a.ownerUserId).not.toBe(b.ownerUserId);
        expect(a.ownerEmail).not.toBe(b.ownerEmail);
    });

    test('returned credentials authenticate end-to-end and land on the right tenant', async ({ page, request }) => {
        const tenant = await createIsolatedTenant({
            request,
            namePrefix: 'auth-check',
        });

        const slug = await signInAs(page, tenant);
        expect(slug).toBe(tenant.tenantSlug);

        // Verify the dashboard actually rendered (not just URL match).
        // Sidebar is the most stable hydration signal across the app.
        await expect(page.locator('aside').first()).toBeVisible({
            timeout: 30_000,
        });

        // Also confirm we're scoped to OUR tenant — no leakage from a
        // sibling test's seeded state.
        await expect(page).toHaveURL(new RegExp(`/t/${tenant.tenantSlug}/dashboard`));
    });

    test('works without a caller-supplied request context (ephemeral path)', async () => {
        // The no-options path spins up its own request context against
        // process.env.URL / the Playwright baseURL and disposes it
        // after the call returns. Useful for global-setup hooks that
        // run before any test fixture exists.
        const tenant: IsolatedTenantCredentials = await createIsolatedTenant();

        expect(tenant.tenantSlug).toMatch(/^[a-z0-9-]+$/);
        expect(tenant.ownerEmail).toMatch(/@e2e\.test$/);
        expect(tenant.ownerPassword.length).toBeGreaterThanOrEqual(32);
    });
});

/**
 * `instrumentUrlChanges` self-test (#1076).
 *
 * The instrument patches `history.pushState` / `replaceState` on the page for
 * every run of `entity-detail-layout` and `data-table-platform`, and its dump
 * executes ONLY when those specs fail. Both halves of that need a test for
 * different reasons:
 *
 *   - **the patch** runs on the happy path, so a wrong one turns a spec that
 *     flakes a quarter of the time into one that cannot navigate at all. The
 *     load-bearing assertion is therefore that it DELEGATES — that the URL
 *     really changes — not merely that it records;
 *   - **the formatter** runs on the failure path, so a green suite never
 *     executes it. A typo there produces an unreadable dump at precisely the
 *     moment the dump is the only evidence, which is the shape of a control
 *     that cannot express failure.
 *
 * ## The fixture has to be a document with NO client router
 *
 * `about:blank` and `data:` URLs are opaque origins and `history.pushState`
 * throws on them, so the test would pass for the wrong reason, having never
 * exercised the patch. But `/login` is worse in the opposite direction:
 * measured in CI, Next's App Router makes its OWN history calls on a real
 * page, so the log carried three extra records and an exact-array assertion
 * failed on a working instrument.
 *
 * `/api/health` is the right fixture — same origin so `pushState` works,
 * public so no sign-in is needed, and a JSON document with no router, so the
 * only history calls are the ones this test makes. That also matches the
 * context the instrument was validated in locally; a router-ful page is a
 * different environment and answered a different question.
 */
test.describe('#1076 — instrumentUrlChanges', () => {
    test('records each mechanism AND still performs the navigation', async ({ page }) => {
        await page.goto('/api/health');
        await instrumentUrlChanges(page);

        await page.evaluate(() => history.pushState({}, '', '/api/health?pushed=1'));
        await page.evaluate(() => history.replaceState({}, '', '/api/health?replaced=1'));

        // THE load-bearing assertion: the patch delegates. A patch that
        // recorded and swallowed would satisfy every assertion below while
        // breaking navigation in the two specs that call it.
        expect(page.url()).toContain('replaced=1');

        await page.goBack();

        const recs = await page.evaluate(
            () =>
                (window as unknown as { __urlChanges?: Array<{ kind: string; to: string }> })
                    .__urlChanges ?? [],
        );
        expect(recs.map((r) => r.kind)).toEqual(['pushState', 'replaceState', 'popstate']);
        // The path is normalised, so a relative URL is recorded as a path.
        expect(recs[0].to).toBe('/api/health');

        // A pushState/replaceState record carries frames; a popstate cannot.
        const dump = await describeUrlChanges(page);
        expect(dump).toContain('url changes        : 3');
        expect(dump).toContain('pushState');
        expect(dump).toContain('popstate');
        expect(dump).toContain('via ');
    });

    test('is idempotent — a second call keeps the existing log', async ({ page }) => {
        await page.goto('/api/health');
        await instrumentUrlChanges(page);
        await page.evaluate(() => history.pushState({}, '', '/api/health?first=1'));
        await instrumentUrlChanges(page); // the specs may call it twice
        await page.evaluate(() => history.pushState({}, '', '/api/health?second=1'));

        const kinds = await page.evaluate(
            () =>
                (
                    (window as unknown as { __urlChanges?: Array<{ kind: string }> })
                        .__urlChanges ?? []
                ).map((r) => r.kind),
        );
        // Asserted as a COUNT rather than an exact list. Both failure modes
        // this guards are count-shaped — a re-patch RESETS the log (1) and a
        // double-patch records the second push TWICE (3) — and a count does
        // not break if the fixture ever gains a history call of its own,
        // which is how the `/login` version of this failed.
        expect(kinds).toHaveLength(2);
        expect(new Set(kinds)).toEqual(new Set(['pushState']));
    });

    test('says NOT INSTRUMENTED rather than implying nothing happened', async ({ page }) => {
        // The distinction the dump has to make: an absent instrument and an
        // instrument that saw nothing are opposite findings, and a formatter
        // that printed "NONE" for both would retire a hypothesis on no
        // evidence.
        await page.goto('/api/health');
        const dump = await describeUrlChanges(page);
        expect(dump).toContain('NOT INSTRUMENTED');

        await instrumentUrlChanges(page);
        const after = await describeUrlChanges(page);
        expect(after).toContain('NONE recorded after instrumenting');
        expect(after).not.toContain('NOT INSTRUMENTED');
    });
});
