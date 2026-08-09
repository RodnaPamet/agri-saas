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
    test('login page loads and shows sign-in options', async ({ page }) => {
        await gotoLoginReady(page);

        // Should see OAuth buttons
        await expect(page.getByText('Continue with Google')).toBeVisible({ timeout: 10000 });
        await expect(page.getByText('Continue with Microsoft')).toBeVisible();

        // Should see email/password form
        await expect(page.locator('input[type="email"][name="email"]')).toBeVisible();
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
    test('unauthenticated API request returns 401 JSON (not redirect)', async ({ request }) => {
        const response = await request.get('/api/clauses', {
            maxRedirects: 0,
        });
        expect(response.status()).toBe(401);
        const data = await response.json();
        expect(data.error).toBe('Unauthorized');
    });

    test('authenticated API request returns 200', async ({ page }) => {
        await doLogin(page);

        // Same route as the 401 case above, so the pair isolates exactly one
        // variable: the session. It used to hit `/api/dashboard`, a legacy
        // non-tenant route deleted with the GRC stack — this spec was its
        // only remaining caller, so the test 404'd rather than proving
        // anything about the guard.
        const apiResponse = await page.evaluate(async () => {
            const res = await fetch('/api/clauses');
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

    test('redirect includes next param for return navigation', async ({ page }) => {
        await page.goto('/clauses');
        await page.waitForURL('**/login**', { timeout: 15000 });
        const url = new URL(page.url());
        expect(url.searchParams.get('next')).toBe('/clauses');
    });

    test('static assets are not blocked by middleware', async ({ request }) => {
        // favicon.ico should be accessible
        const response = await request.get('/favicon.ico', { maxRedirects: 0 });
        // Could be 200 or 404 depending on asset presence, but NOT 401 or 302 to login
        expect(response.status()).not.toBe(401);
        expect(response.headers()['location']).toBeUndefined();
    });
});

