/**
 * Epic 56 E2E — canonical tooltip + copy interactions.
 *
 * Exercises the highest-value user journeys that depend on the Epic 56
 * primitive layer working end-to-end in a real browser:
 *
 *   1. A canonical <Tooltip> opens on focus and announces its content
 *      via the standard Radix `aria-describedby` linkage.
 *   2. CopyText on a prominent entity identifier (task key) writes the
 *      value to the clipboard and shows a toast.
 *   3. CopyButton on the share link (audits/packs) writes the URL to
 *      the clipboard and shows a toast.
 *
 * These are the smoke checks — we don't re-verify every tooltip copy
 * target. The source-contract guards
 * (`tests/guards/no-ad-hoc-tooltip-title.test.ts`,
 *  `tests/guards/no-inline-clipboard.test.ts`) keep the surface durable
 * between runs; these E2Es prove the primitives actually wire up in a
 * real browser with the real `TooltipProvider` + Sonner `<Toaster />`.
 */

import { test, expect, type Page } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

const ADMIN_USER = { email: 'admin@acme.com', password: 'password123' };

async function readClipboard(page: Page): Promise<string> {
    // Playwright grants clipboard permissions automatically when the
    // test requests them via browser contexts; on chromium the
    // navigator.clipboard API is fully available for same-origin
    // scripts after the page grants via user gesture. Our primitives
    // already gate copies behind a click handler, so by the time we
    // read here, the write has resolved.
    return page.evaluate(async () => {
        try {
            return await navigator.clipboard.readText();
        } catch {
            return '';
        }
    });
}

test.describe('Epic 56 — tooltip + copy primitives', () => {
    test.beforeEach(async ({ context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    });

    // Re-enabled with the TOOLTIPS_ENABLED kill-switch. Desktop Playwright
    // runs a fine pointer, so hover-reveal is still the path under test here;
    // touch devices now open the same tooltip by tap instead (see the
    // coarse-pointer branch in src/components/ui/tooltip.tsx).
    test('selection-toolbar Clear tooltip exposes its hint on hover', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);
        await safeGoto(page, `/t/${tenantSlug}/controls`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForLoadState('networkidle').catch(() => {});

        // Select the first row to make the SelectionToolbar visible.
        // The shared DataTable wraps its Radix Checkbox in a
        // `<div role="presentation" title="Select">` (a plain <button>
        // wrapper triggers the "<button> inside <button>" hydration
        // mismatch because Radix Checkbox already renders as <button>;
        // GAP-CI-77 changed the wrapper from role="button" to
        // role="presentation" so axe sees only the inner labelled
        // Radix button as the canonical control). The inner checkbox
        // has `pointer-events-none` so the click reaches the wrapping
        // div's handler.
        const firstRowSelect = page
            .locator('tbody tr')
            .first()
            .locator('[title="Select"]')
            .first();
        await firstRowSelect.waitFor({ state: 'visible', timeout: 30_000 });
        await firstRowSelect.click();

        const toolbar = page.locator('[data-testid="selection-toolbar"]');
        await expect(toolbar).toBeVisible({ timeout: 5000 });

        // Hover the Clear button — the Tooltip wrapper installed by
        // Epic 56 should render "Clear selection" content and keep the
        // `Esc` shortcut inside a <kbd> element.
        const clearBtn = toolbar.getByRole('button', { name: 'Clear selection' });
        await clearBtn.hover();

        const tip = page.getByRole('tooltip', { name: /Clear selection/i });
        await expect(tip).toBeVisible({ timeout: 5000 });
        // The shortcut chip renders inside a <kbd>.
        await expect(tip.locator('kbd')).toContainText('Esc');
    });

    // The original skip rationale ("seed billing plan doesn't
    // include AUDIT_PACK_SHARING") was stale —
    // `<UpgradeGate>` treats a null `plan` (no `BillingAccount`
    // row) as ungated, and the seed doesn't create one. The
    // share-pack flow runs cleanly under the seeded admin tenant.
    // Re-enabled in the Epic-69 follow-up pass that swept the
    // remaining E2E skips.
    test('audit pack share link — CopyButton writes to clipboard + shows toast', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);

        // Navigate via the cycle list (no standalone /audits/packs route
        // exists) — pick the seeded ISO27001 cycle, then the seeded
        // frozen pack inside it.
        await safeGoto(page, `/t/${tenantSlug}/audits/cycles`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForLoadState('networkidle').catch(() => {});

        const firstCycle = page
            .locator('a[id^="cycle-link-"]')
            .first();
        await expect(firstCycle).toBeVisible({ timeout: 30_000 });
        await firstCycle.click();
        await page.waitForURL(/audits\/cycles\/[^/]+/, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });
        await page.waitForLoadState('networkidle').catch(() => {});

        const firstPack = page.locator('a[href*="/audits/packs/"]').first();
        await expect(firstPack).toBeVisible({ timeout: 30_000 });
        await firstPack.click();
        await page.waitForURL(/audits\/packs\/[^/]+/, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });

        // If the share-link banner isn't rendered yet (the seed share
        // token was hashed without exposing the raw token for the UI),
        // click the Share action to surface one.
        const shareBanner = page.locator('#share-link-card');
        if (!(await shareBanner.isVisible().catch(() => false))) {
            const shareBtn = page.locator('#share-pack-btn');
            await expect(shareBtn).toBeVisible({ timeout: 15_000 });
            await shareBtn.click();
            await expect(shareBanner).toBeVisible({ timeout: 15_000 });
        }

        const shareUrl =
            (await page.locator('#share-link-url').textContent()) ?? '';
        expect(shareUrl.length).toBeGreaterThan(0);

        await shareBanner.getByRole('button', { name: /Copy share link/i }).click();

        // Toast appears.
        await expect(
            page.getByText('Share link copied', { exact: false }),
        ).toBeVisible({ timeout: 5000 });

        // Clipboard contains the exact URL rendered on the banner.
        const clipboard = await readClipboard(page);
        expect(clipboard).toBe(shareUrl.trim());
    });

    test('task detail header — task.key is copyable via CopyText', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);
        await safeGoto(page, `/t/${tenantSlug}/farm-tasks`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForLoadState('networkidle').catch(() => {});

        // First task ROW link inside the farm-tasks table (the title cell is a
        // TableTitleCell <Link>). Not the page-level header / FAB nav buttons
        // that share the `/farm-tasks/` prefix. Seeded tasks always carry a key.
        const firstTask = page
            .locator('[data-testid="farm-tasks-table"] tbody tr a[href*="/farm-tasks/"]')
            .first();
        await expect(firstTask).toBeVisible({ timeout: 30_000 });
        await firstTask.click();
        await page.waitForURL(/farm-tasks\/[a-z0-9]+$/i, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });

        // `task.key` renders as the CopyText button — accessible name
        // is "Copy task key {KEY}". Seeded tasks always have a key.
        const keyBtn = page.locator(
            'button[aria-label^="Copy task key "]',
        );
        await expect(keyBtn.first()).toBeVisible({ timeout: 30_000 });

        const expected = (await keyBtn.textContent())?.trim() ?? '';
        expect(expected).toMatch(/^[A-Z]+-\d+$/);

        await keyBtn.click();
        await expect(
            page.getByText('Task key copied', { exact: false }),
        ).toBeVisible({ timeout: 5000 });

        const clipboard = await readClipboard(page);
        expect(clipboard).toBe(expected);
    });
});
