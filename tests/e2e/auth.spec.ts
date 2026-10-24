/**
 * E2E tests for authentication flow and middleware auth guard.
 * Uses the test-only Credentials provider (AUTH_TEST_MODE=1).
 */
import { test, expect, type Cookie, type Page } from '@playwright/test';
import { safeGoto } from './e2e-utils';

const TEST_USER = {
    email: 'admin@acme.com',
    password: 'password123',
};

/**
 * Navigate to login and wait for the form to hydrate (Suspense boundary resolved).
 * On cold start Next.js compiles the page which can take 15+ seconds.
 */
async function gotoLoginReady(page: Page) {
    await safeGoto(page, '/login');
    await page.waitForSelector('input[type="email"][name="email"]', { timeout: 60000 });
}

async function doLogin(page: Page) {
    await gotoLoginReady(page);

    // Wait for React hydration — ensure onSubmit is attached before interacting.
    // Without this, the browser does a native GET form submit, leaking creds as URL params.
    await page.waitForFunction(() => {
        const form = document.querySelector('form');
        // React attaches internal event props on the DOM node after hydration
        return form && Object.keys(form).some(k => k.startsWith('__reactEvents') || k.startsWith('__reactFiber'));
    }, { timeout: 30000 });

    const emailInput = page.locator('input[type="email"][name="email"]');
    await emailInput.click();
    await emailInput.fill(TEST_USER.email);
    await page.fill('#credentials-form input[type="password"]', TEST_USER.password);
    await page.click('#credentials-form button[type="submit"]');
    // The app redirects /dashboard → /t/{slug}/dashboard
    await page.waitForURL(/dashboard/, { waitUntil: 'domcontentloaded', timeout: 60000 });
}

test.describe('Authentication Flow', () => {
    /**
     * ── THE AUTH SURFACE RESOLVES EVERY MESSAGE IT RENDERS ── #2264
     *
     * `/login` used to throw `MISSING_MESSAGE` thousands of times per CI run.
     * `src/app/providers.tsx` is rendered by the ROOT layout on every request
     * and mounted the command palette and the shortcut-help overlay
     * unconditionally, while `bundlesFor('auth')` returns `['auth', 'shared']`
     * — so neither overlay's copy was loaded and next-intl, which has no
     * `getMessageFallback` configured here, rendered the KEY PATH to a
     * stranger on the product's front door. Measured on two main runs:
     * `commandPalette` 1320, `shortcutHelp` 840, `notFound` 360, `common` 240.
     *
     * #2265 fixed it by gating both mounts on `isAuthSurface` and moving
     * `notFound` into the `shared` bundle, and
     * `tests/guards/auth-surface-skips-global-overlays.test.ts` holds the
     * gating in place.
     *
     * What nothing held was the OUTCOME. The issue's own acceptance was "the
     * error count going to zero", and that was checked by grepping a job log
     * by hand. This asserts it.
     *
     * Deliberately NOT done by failing `e2e-utils`' console handler on any
     * error: that handler logs rather than throws on purpose — "so the
     * genuinely benign occurrences stay greppable noise instead of failing
     * unrelated specs" — and promoting anything there reaches every spec in
     * the suite. This spec attaches its own listener instead.
     */
    test('renders no MISSING_MESSAGE, in the browser or the HTML (#2264)', async ({ page, request }) => {
        const missing: string[] = [];
        page.on('console', (m) => {
            if (m.text().includes('MISSING_MESSAGE')) missing.push(`console: ${m.text()}`);
        });
        page.on('pageerror', (e) => {
            if (e.message.includes('MISSING_MESSAGE')) missing.push(`pageerror: ${e.message}`);
        });

        await gotoLoginReady(page);

        // CONTROL, before the assertion means anything: prove the listener can
        // SEE a MISSING_MESSAGE. A negative assertion whose observer is broken
        // passes forever, and this one is the whole test.
        await page.evaluate(() => console.error('MISSING_MESSAGE: observability probe'));
        await expect
            .poll(() => missing.filter((m) => m.includes('observability probe')).length, {
                timeout: 5_000,
            })
            .toBe(1);
        missing.length = 0;

        // Now the real surface. Reload so anything thrown during render is
        // caught by the listener that is now attached.
        await gotoLoginReady(page);
        await page.waitForTimeout(1_000);
        expect(missing).toEqual([]);

        /**
         * The SERVER half, which a console listener cannot see.
         *
         * When a message is missing, next-intl renders the key path into the
         * markup, so the served HTML is the observable — and the loaded
         * bundles are serialised into it too, which makes the same HTML a
         * check on WHICH bundles loaded.
         *
         * `notFound` is asserted PRESENT, not absent. #2265 moved it from
         * `public` into `shared` precisely so the auth surface would have it,
         * and `bundlesFor('auth')` returns `['auth', 'shared']` — so its keys
         * belong in this HTML. Asserting its absence is the mistake I made
         * first, and it would have failed CI for the fix working.
         *
         * The two overlay namespaces live in `app`, which this surface must
         * never load. Asserting their absence also holds what #2099 bought:
         * `/login` used to serialise all 5,787 keys into what a stranger
         * downloads, and a widened auth bundle would start giving that back.
         */
        const res = await request.get('/login');
        expect(res.status()).toBe(200);
        const html = await res.text();
        for (const ns of ['commandPalette.', 'shortcutHelp.']) {
            expect({ ns, present: html.includes(ns) }).toEqual({ ns, present: false });
        }
        // And the positive control for the bundle arithmetic: a surface that
        // loaded NOTHING would satisfy the two absences above.
        expect({ ns: 'notFound', present: html.includes('notFound') })
            .toEqual({ ns: 'notFound', present: true });
    });


    test('login page loads and shows sign-in options', async ({ page }) => {
        await gotoLoginReady(page);

        // Should see OAuth buttons
        await expect(page.getByText('Continue with Google')).toBeVisible({ timeout: 10000 });
        await expect(page.getByText('Continue with Microsoft')).toBeVisible();

        // Should see email/password form
        await expect(page.locator('input[type="email"][name="email"]')).toBeVisible();
        // BARE on purpose. `<main>` comes from `AppShell`
        // (src/components/layout/AppShell.tsx:237), which `/login` does not
        // mount — there is no `main` landmark on that page to scope to
        // (#1516).
        await expect(page.locator('#credentials-form input[type="password"]')).toBeVisible();
    });

    test('credentials login → redirect to dashboard', async ({ page }) => {
        await doLogin(page);
        await expect(page).toHaveURL(/dashboard/);
    });

    test('protected dashboard page shows user identity after login', async ({ page }) => {
        await doLogin(page);
        await expect(page.locator('text=Alice Admin').first()).toBeVisible({ timeout: 10000 });
    });

    test('session cookie is httpOnly', async ({ page, context }) => {
        await doLogin(page);

        const cookies = await context.cookies();
        // GAP-04 — NextAuth v4 uses `next-auth.*` cookie prefix, v5
        // used `authjs.*`. The codebase is on v4 since 2026-04-25;
        // accept both names so a future v5-stable upgrade doesn't
        // immediately break this test.
        const sessionCookie = cookies.find(
            (c: Cookie) =>
                c.name === 'next-auth.session-token' ||
                c.name === '__Secure-next-auth.session-token' ||
                c.name === 'authjs.session-token' ||
                c.name === '__Secure-authjs.session-token'
        );

        expect(sessionCookie).toBeDefined();
        expect(sessionCookie!.httpOnly).toBe(true);
        expect(sessionCookie!.sameSite).toBe('Lax');
    });

    test('logout works and blocks access to dashboard', async ({ page, context }) => {
        await doLogin(page);

        // Clear all cookies to simulate being logged out
        await context.clearCookies();

        // Navigate to a protected route — should redirect to login
        await page.goto('/dashboard');
        await page.waitForURL('**/login**', { timeout: 15000 });
        expect(page.url()).toContain('/login');
    });

    test('unauthenticated access to /dashboard redirects to /login with next param', async ({ page }) => {
        await page.goto('/dashboard');
        await page.waitForURL('**/login**', { timeout: 15000 });
        const url = new URL(page.url());
        expect(url.pathname).toBe('/login');
        expect(url.searchParams.get('next')).toBe('/dashboard');
    });

    test('session API does not expose tokens', async ({ page }) => {
        await doLogin(page);

        const sessionResponse = await page.evaluate(async () => {
            const res = await fetch('/api/auth/session');
            return res.json();
        });

        const sessionStr = JSON.stringify(sessionResponse);
        expect(sessionStr).not.toContain('"access_token"');
        expect(sessionStr).not.toContain('"refresh_token"');
        expect(sessionStr).not.toContain('"accessToken"');
        expect(sessionStr).not.toContain('"refreshToken"');

        if (sessionResponse.user) {
            expect(sessionResponse.user.email).toBeDefined();
        }
    });

    test('CSRF token endpoint works', async ({ request }) => {
        const response = await request.get('/api/auth/csrf');
        expect(response.status()).toBe(200);
        const data = await response.json();
        expect(data.csrfToken).toBeDefined();
        expect(typeof data.csrfToken).toBe('string');
    });
});

test.describe('Middleware Auth Guard', () => {
    // GRC teardown phase 2 — this pair used to hit `/api/clauses`, which
    // was deleted with the GRC stack. Re-pointed to `/api/notifications`:
    // the same class of route (session-authenticated, NOT tenant-slugged,
    // so the URL carries nothing the middleware could gate on besides the
    // cookie) and it returns 200 for any authenticated member —
    // `listMyNotifications` only asserts `canRead`. The pair still
    // isolates exactly one variable: the session.
    test('unauthenticated API request returns 401 JSON (not redirect)', async ({ request }) => {
        const response = await request.get('/api/notifications', {
            maxRedirects: 0,
        });
        expect(response.status()).toBe(401);
        const data = await response.json();
        expect(data.error).toBe('Unauthorized');
    });

    test('authenticated API request returns 200', async ({ page }) => {
        await doLogin(page);

        // Same route as the 401 case above.
        const apiResponse = await page.evaluate(async () => {
            const res = await fetch('/api/notifications');
            return { status: res.status, ok: res.ok };
        });
        expect(apiResponse.status).toBe(200);
    });

    test('/api/auth/session is always accessible (public route)', async ({ request }) => {
        const response = await request.get('/api/auth/session');
        expect(response.status()).toBe(200);
    });

    test('/api/auth/providers is always accessible', async ({ request }) => {
        const response = await request.get('/api/auth/providers');
        expect(response.status()).toBe(200);
    });

    // GRC teardown phase 2 — `/clauses` was deleted. Re-pointed to
    // `/account/profile`, a surviving protected non-tenant page. It is a
    // strictly better probe than the flat `/clauses` was: a NESTED path
    // proves the whole pathname survives into `next`, not just the first
    // segment. (The sibling test above covers the flat `/dashboard` case.)
    test('redirect includes next param for return navigation', async ({ page }) => {
        await page.goto('/account/profile');
        await page.waitForURL('**/login**', { timeout: 15000 });
        const url = new URL(page.url());
        expect(url.searchParams.get('next')).toBe('/account/profile');
    });

    test('static assets are not blocked by middleware', async ({ request }) => {
        // favicon.ico should be accessible
        const response = await request.get('/favicon.ico', { maxRedirects: 0 });
        // Could be 200 or 404 depending on asset presence, but NOT 401 or 302 to login
        expect(response.status()).not.toBe(401);
        expect(response.headers()['location']).toBeUndefined();
    });
});

