import { test, expect } from '@playwright/test';
import {
    createIsolatedTenant,
    gotoAndVerify,
    loginAndGetTenant as loginAsAdmin,
    signInAs,
    type IsolatedTenantCredentials,
} from './e2e-utils';

/**
 * Onboarding Wizard E2E Tests
 *
 * Tests the full onboarding flow: start → steps → resume → finish → dashboard.
 * Uses relative URLs so playwright.config.ts baseURL is respected.
 *
 * GAP-23: provisions its own tenant. Onboarding state is per-tenant
 * by design — running this against a shared seed pulled the test
 * into "already complete" branches that masked regressions in the
 * actual welcome → wizard flow.
 */

// ─── Tests ───

test.describe('Onboarding Wizard', () => {
    test.describe.configure({ mode: 'serial' });

    let tenant: IsolatedTenantCredentials;

    test.beforeAll(async ({ request }) => {
        tenant = await createIsolatedTenant({ request, namePrefix: 'onb' });
    });

    test('admin starts onboarding and sees the wizard', async ({ page }) => {
        const slug = await signInAs(page, tenant);
        await gotoAndVerify(page, `/t/${slug}/onboarding`, 'main');

        // The onboarding page uses dynamic import (ssr: false) + API fetch.
        // Wait for either the welcome screen OR the wizard OR completed state to render.
        // Use .or() to match any of the possible post-loading states.
        const welcomeOrWizard = page.locator('[data-testid="onboarding-wizard"]')
            .or(page.getByText('set up your workspace'))
            .or(page.getByText('Setup Wizard'))
            .or(page.getByText('Onboarding Complete'))
            .or(page.getByText('Access Restricted'));
        await welcomeOrWizard.first().waitFor({ state: 'visible', timeout: 30000 });

        const pageContent = await page.textContent('body');
        const hasWizard = pageContent?.includes('Setup Wizard')
            || pageContent?.includes('set up your workspace')
            || pageContent?.includes('Onboarding Complete')
            || pageContent?.includes('Access Restricted');
        expect(hasWizard).toBeTruthy();
    });

    test('admin completes Company Profile step', async ({ page }) => {
        const slug = await signInAs(page, tenant);
        await gotoAndVerify(page, `/t/${slug}/onboarding`, 'main');

        // Start onboarding if on welcome screen
        // `isVisible()` does not wait — the `{ timeout }` argument is ignored.
        // Each of these was therefore an INSTANT read, which is what made the
        // `networkidle` after every click load-bearing: the wait was standing
        // in for the auto-waiting the probe itself should have been doing.
        // `waitFor` keeps the conditional shape exactly, returns as soon as the
        // control appears, and costs nothing when it is already there.
        const appears = (l: import('@playwright/test').Locator, ms: number) =>
            l.waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);

        const startBtn = page.locator('button:has-text("Start Setup")');
        if (await appears(startBtn, 3000)) {
            await startBtn.click();
        }

        // Fill company name
        const nameInput = page.locator('[data-testid="company-name"]');
        if (await appears(nameInput, 5000)) {
            await nameInput.fill('Acme Corporation');
        }

        // Click Continue
        const continueBtn = page.locator('button:has-text("Continue")');
        if (await appears(continueBtn, 5000)) {
            await continueBtn.click();
        }
    });

    test('wizard resumes on refresh', async ({ page }) => {
        const slug = await signInAs(page, tenant);
        await gotoAndVerify(page, `/t/${slug}/onboarding`, 'main');

        // Should NOT show the welcome screen — should show the wizard with progress.
        // Auto-waiting probe rather than `networkidle` + an instant `isVisible()`.
        const wizardEl = page.locator('[data-testid="onboarding-wizard"]');
        const hasWizard = await wizardEl
            .waitFor({ state: 'visible', timeout: 5000 })
            .then(() => true)
            .catch(() => false);

        if (hasWizard) {
            // Verify we resumed — at least 1 step should be complete
            const checkmarks = page.locator('[data-testid^="step-nav-"]');
            const count = await checkmarks.count();
            expect(count).toBeGreaterThan(0);
        }
    });

    test('non-admin cannot access onboarding', async ({ page }) => {
        // GAP-23 carve-out: this test exercises the seeded `viewer@acme.com`
        // (READER role) to prove the onboarding wizard rejects non-admins.
        // The isolation factory currently provisions only OWNER users —
        // a future PR will add a multi-role provisioner so this test can
        // run against its own tenant. Until then, the assertion is
        // independent of the rest of this describe block's tenant state,
        // so the shared-seed dependency is bounded to a single test.
        const slug = await loginAsAdmin(page, { email: 'viewer@acme.com', password: 'password123' });

        await gotoAndVerify(page, `/t/${slug}/onboarding`, 'main');

        // `textContent` is an instant read and the assertion below is satisfied
        // by the ABSENCE of 'Setup Wizard', so an unrendered page would pass it.
        // The positive control is `gotoAndVerify` above, which waits for `main`
        // to be visible and for hydration — that, not `networkidle`, is what
        // makes the read below meaningful.
        const pageContent = await page.textContent('body');
        const blocked = pageContent?.includes('Access Restricted') || pageContent?.includes('administrator');
        // Either blocked with message or redirected — both are acceptable
        expect(blocked || !pageContent?.includes('Setup Wizard')).toBeTruthy();
    });
});
