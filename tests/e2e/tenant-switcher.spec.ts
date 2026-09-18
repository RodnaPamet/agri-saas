/**
 * E2E — tenant switcher (quality roadmap P4, item 2).
 *
 * `<TenantSwitcher>` lives in the top-bar left slot; clicking it
 * opens a popover listing the user's active tenant memberships.
 * Structural tests pin the source — this spec pins the **observed
 * user-visible behaviour**: the trigger is reachable + opens, and
 * the current tenant's row is shown.
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto, waitForHydration } from './e2e-utils';

test.describe('Tenant switcher', () => {
    test('opens from the top chrome and lists the current tenant', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/dashboard`, {
            waitUntil: 'domcontentloaded',
        });

        const trigger = page.locator(
            '[data-testid="top-chrome-tenant-switcher"]',
        );
        await expect(trigger).toBeVisible({ timeout: 15_000 });
        // Visible is not clickable. The `networkidle` removed above was
        // buying hydration time incidentally; name the element being clicked
        // instead, since `main` hydrates long before top chrome does.
        await waitForHydration(page, '[data-testid="top-chrome-tenant-switcher"]');
        await trigger.click();

        // The current tenant's row exists in the popover. Other
        // memberships' rows depend on seed shape and are not
        // asserted to keep this resilient.
        await expect(
            page.locator(`[data-testid="tenant-switcher-row-${tenantSlug}"]`),
        ).toBeVisible({ timeout: 5_000 });
    });
});
