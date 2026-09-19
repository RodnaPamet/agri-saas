/**
 * E2E — R-5 closure: Invitation journey (Epic 1)
 *
 * Walks the full happy path against a live server:
 *   1. OWNER creates an invite via the API (and pre-registers the
 *      invitee so their User row exists for credentials sign-in).
 *   2. Invitee opens the preview page (fresh browser context, no cookies).
 *   3. Invitee clicks "Sign in to accept" → cookie set → redirect to /login.
 *   4. Invitee signs in → lands on tenant dashboard / picker; EDITOR
 *      role is verified (admin.members endpoint returns 403).
 *   5. Invalid/garbage token → preview shows "Invite not available".
 *
 * Isolation: the happy path runs against a FRESH isolated tenant
 * provisioned by the `isolatedTenant` fixture, and the inviter is
 * that tenant's OWNER. The previous shape was four serial `test()`s
 * sharing module-level `let tenantSlug / inviteToken / invitePath`
 * assigned in test 1 and read by tests 2-4 — a failure in test 1
 * cascaded into all of them. Steps 1-4 are genuinely one sequential
 * scenario, so they are now a single `test()` with `test.step(...)`
 * sub-steps. Step 5 (garbage token) is independent and stays its
 * own `test()`; it needs no tenant at all.
 *
 * Uses AUTH_TEST_MODE=1 credentials provider.
 * All selectors use existing id / role attributes — no data-testid.
 */
import { test, expect } from './fixtures';
import { type BrowserContext, type Page } from '@playwright/test';
import { safeGoto, waitForHydration } from './e2e-utils';

/**
 * Sign in with email+password via the #credentials-form and return
 * to the caller once either the tenant dashboard or the tenant
 * picker is reached. Returns the URL the browser landed on.
 */
async function signInWithCredentials(
    page: Page,
    email: string,
    password: string,
): Promise<string> {
    await safeGoto(page, '/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const credentialsForm = page.locator('#credentials-form');
    await credentialsForm.locator('input[type="email"][name="email"]').waitFor({
        state: 'visible',
        timeout: 30_000,
    });

    // Wait for React hydration before interacting.
    await page.waitForFunction(() => {
        const form = document.querySelector('form');
        return (
            form &&
            Object.keys(form).some(
                (k) => k.startsWith('__reactEvents') || k.startsWith('__reactFiber'),
            )
        );
    }, { timeout: 30_000 });

    await credentialsForm.locator('input[type="email"][name="email"]').fill(email);
    await credentialsForm.locator('input[type="password"]').fill(password);
    await credentialsForm.locator('button[type="submit"]').click();

    await page.waitForURL(/\/(tenants|t\/[^/]+\/dashboard)/, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
    });
    return page.url();
}

test.describe('Invitation journey (Epic 1)', () => {
    test('OWNER invites a new member who redeems and lands as EDITOR', async ({
        authedPage,
        isolatedTenant,
        browser,
    }) => {
        const tenantSlug = isolatedTenant.tenantSlug;
        const timestamp = Date.now();
        const inviteeEmail = `r5-invitee-${timestamp}@e2e.test`;
        // Sufficiently unique password unlikely to appear in HIBP.
        const inviteePassword = `InvT3st!${timestamp}`;
        let invitePath = '';

        // ── 1. OWNER creates the invite + pre-registers the invitee ──
        await test.step('OWNER creates an invite for a new email', async () => {
            // Pre-register the invitee so their User row exists before
            // credentials sign-in. /api/auth/register is public.
            const regResult = await authedPage.evaluate(
                async ({ email, password }: { email: string; password: string }) => {
                    const res = await fetch('/api/auth/register', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            action: 'register',
                            email,
                            password,
                            name: 'R5 Invitee',
                            orgName: 'R5 Invitee Org',
                        }),
                    });
                    const data = await res.json();
                    return { status: res.status, error: data?.error };
                },
                { email: inviteeEmail, password: inviteePassword },
            );
            // 200 on success; 409 if the email was already registered.
            expect([200, 409]).toContain(regResult.status);

            // POST to the admin invites API while authed as the OWNER.
            const result = await authedPage.evaluate(
                async ({ slug, email }: { slug: string; email: string }) => {
                    const res = await fetch(`/api/t/${slug}/admin/invites`, {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email, role: 'EDITOR' }),
                    });
                    const data = await res.json();
                    return { status: res.status, invite: data?.invite, url: data?.url };
                },
                { slug: tenantSlug, email: inviteeEmail },
            );

            expect(result.status).toBe(201);
            expect(result.invite?.token).toBeTruthy();
            expect(result.url).toContain('/invite/');
            invitePath = result.url as string;
        });

        // ── 2. Invite preview page (side-effect-free) ──
        await test.step('invite preview shows tenant + role + accept button', async () => {
            const ctx: BrowserContext = await browser.newContext();
            const page = await ctx.newPage();
            try {
                await safeGoto(page, invitePath, { waitUntil: 'domcontentloaded' });
                // `networkidle` removed: the auto-waiting matcher below already
                // out-waits it (30s), and it is also the positive control for the
                // `.not.toBeVisible()` absence check at the end of this step — a
                // blank page or a /login redirect fails here first. Refs #748.
                await expect(
                    page.locator('text=You have been invited'),
                ).toBeVisible({ timeout: 30_000 });
                await expect(page.getByText(/Editor/i).first()).toBeVisible({
                    timeout: 10_000,
                });
                await expect(
                    page.getByRole('link', { name: /Sign in to accept/i }),
                ).toBeVisible({ timeout: 10_000 });
                // No membership side-effect yet.
                await expect(
                    page.getByRole('button', { name: /Accept invitation/i }),
                ).not.toBeVisible();
            } finally {
                await ctx.close();
            }
        });

        // ── 3. Invitee redeems by signing in via test-mode credentials ──
        await test.step('invitee redeems by signing in', async () => {
            const ctx: BrowserContext = await browser.newContext();
            const page = await ctx.newPage();
            try {
                await safeGoto(page, invitePath, { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('a[href*="start-signin"]', {
                    timeout: 30_000,
                });
                // HYDRATE, do not wait for the network. The `networkidle` here was
                // swallowed (`.catch(() => {})`), so it could time out entirely and
                // the click still went ahead — and `waitForSelector` proves the link
                // is PAINTED, not that React has attached to it. Name the CLICKED
                // element, never `main`. Refs #748.
                await waitForHydration(page, 'a[href*="start-signin"]');

                await page.click('a[href*="start-signin"]');
                await page.waitForURL(/\/login/, { timeout: 30_000 });

                const credentialsForm = page.locator('#credentials-form');
                await credentialsForm
                    .locator('input[type="email"][name="email"]')
                    .waitFor({ state: 'visible', timeout: 30_000 });
                await page.waitForFunction(() => {
                    const form = document.querySelector('form');
                    return (
                        form &&
                        Object.keys(form).some(
                            (k) =>
                                k.startsWith('__reactEvents') ||
                                k.startsWith('__reactFiber'),
                        )
                    );
                }, { timeout: 30_000 });

                await credentialsForm
                    .locator('input[type="email"][name="email"]')
                    .fill(inviteeEmail);
                await credentialsForm
                    .locator('input[type="password"]')
                    .fill(inviteePassword);
                await credentialsForm.locator('button[type="submit"]').click();

                // Invitee has their own org + the redeemed membership →
                // 2 memberships → /tenants picker. Accept either dest.
                await page.waitForURL(/\/(tenants|t\/[^/]+\/dashboard)/, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60_000,
                });
                expect(page.url()).not.toContain('/no-tenant');

                if (page.url().includes('/tenants')) {
                    const link = page.getByRole('link', {
                        name: new RegExp(tenantSlug, 'i'),
                    });
                    await link.waitFor({ timeout: 10_000 });
                    await link.click();
                    await page.waitForURL(/\/t\/[^/]+\/dashboard/, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30_000,
                    });
                }

                const hasSidebar = await page
                    .locator('aside')
                    .isVisible()
                    .catch(() => false);
                expect(hasSidebar).toBe(true);

                const match = new URL(page.url()).pathname.match(
                    /^\/t\/([^/]+)\//,
                );
                expect(match).not.toBeNull();
                expect(match![1]).toBe(tenantSlug);
            } finally {
                await ctx.close();
            }
        });

        // ── 4. Invitee membership has the correct EDITOR role ──
        await test.step('invitee has EDITOR role (admin endpoint returns 403)', async () => {
            const ctx: BrowserContext = await browser.newContext();
            const page = await ctx.newPage();
            try {
                await signInWithCredentials(page, inviteeEmail, inviteePassword);

                if (page.url().includes('/tenants')) {
                    const link = page.getByRole('link', {
                        name: new RegExp(tenantSlug, 'i'),
                    });
                    await link.waitFor({ timeout: 10_000 });
                    await link.click();
                    await page.waitForURL(/\/t\/[^/]+\/dashboard/, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30_000,
                    });
                }

                const match = new URL(page.url()).pathname.match(
                    /^\/t\/([^/]+)\//,
                );
                if (!match) {
                    throw new Error('Could not extract slug after invitee sign-in');
                }
                const slug = match[1];

                // EDITOR lacks admin.members → 403.
                const result = await page.evaluate(async (s: string) => {
                    const res = await fetch(`/api/t/${s}/admin/members`, {
                        credentials: 'include',
                    });
                    return { status: res.status };
                }, slug);
                expect(result.status).toBe(403);

                // Confirm EDITOR role via the session's memberships array.
                const sessionResult = await page.evaluate(async (s: string) => {
                    const res = await fetch('/api/auth/session', {
                        credentials: 'include',
                    });
                    const data = await res.json();
                    const memberships: Array<{ slug: string; role: string }> =
                        data?.user?.memberships ?? [];
                    const m = memberships.find((x) => x.slug === s);
                    return { status: res.status, role: m?.role ?? null };
                }, slug);
                expect(sessionResult.status).toBe(200);
                expect(sessionResult.role).toBe('EDITOR');
            } finally {
                await ctx.close();
            }
        });
    });

    // Independent — needs no tenant, no shared state.
    test('invalid token shows a clear error on the preview page', async ({
        browser,
    }) => {
        const ctx: BrowserContext = await browser.newContext();
        const page = await ctx.newPage();
        try {
            await safeGoto(page, '/invite/not-a-real-token-00000000000', {
                waitUntil: 'domcontentloaded',
            });
            // `networkidle` removed: the auto-waiting matcher below out-waits it
            // (30s) AND is the positive control for the two `.not.toBeVisible()`
            // absence checks after it — a blank page, a 500 or a /login redirect
            // fails here rather than passing them vacuously. Refs #748.
            await expect(
                page.getByText(/Invite not available/i),
            ).toBeVisible({ timeout: 30_000 });
            await expect(
                page.getByRole('link', { name: /Sign in to accept/i }),
            ).not.toBeVisible();
            await expect(
                page.getByRole('button', { name: /Accept invitation/i }),
            ).not.toBeVisible();
        } finally {
            await ctx.close();
        }
    });
});
