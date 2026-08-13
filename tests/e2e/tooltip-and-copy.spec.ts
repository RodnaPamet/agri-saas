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
 *   3. CopyButton on a rendered value (the SCIM endpoint URL) writes it
 *      to the clipboard and shows a toast.
 *
 * GRC teardown phase 2 — check 3 used to drive the audit-pack share
 * link. `/audits` was deleted along with the whole inherited GRC
 * surface, and so were `#share-link-card` / `#share-pack-btn` /
 * `#share-link-url`. It is re-pointed at `/admin/scim`, which is the
 * only surviving <CopyButton> call site in the product. The assertion
 * shape is unchanged and is what this check is for: click the button,
 * a toast appears, and the clipboard holds exactly the value rendered
 * beside it. `/admin/scim` also keeps the check read-only — the
 * endpoint URL is returned by `GET /admin/scim` on page load, so no
 * token has to be minted against the shared seeded tenant.
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
        // GRC teardown phase 2 — was `/practices`; re-pointed to
        // `/assets`. The subject is the shared DataTable's
        // SelectionToolbar, not the entity, and `/assets` is a
        // surviving list page with seeded rows on acme-corp and row
        // selection left at its default-on setting.
        await safeGoto(page, `/t/${tenantSlug}/assets`, {
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

    // GRC teardown phase 2 — this was the audit-pack share link
    // (`/audits/cycles` → cycle → pack → `#share-link-card`). The whole
    // `/audits` surface was deleted, so the flow has no route to walk.
    // Re-pointed at `/admin/scim`, the only surviving <CopyButton> call
    // site: `<CopyButton value={state.scimEndpoint}
    // label="Copy SCIM endpoint" successMessage="SCIM endpoint copied">`
    // sits next to the `#scim-endpoint-url` <code> that renders the same
    // value, which is exactly the "copy what you can see" shape the
    // share-link banner had. Read-only — the endpoint arrives with the
    // page's `GET /admin/scim`, no token generation on the shared tenant.
    test('SCIM endpoint — CopyButton writes to clipboard + shows toast', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);

        await safeGoto(page, `/t/${tenantSlug}/admin/scim`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForLoadState('networkidle').catch(() => {});

        // The <code> starts as a loading placeholder and fills in once
        // `GET /admin/scim` resolves; wait for a real URL rather than a
        // dash/placeholder so the clipboard comparison is meaningful.
        const endpointEl = page.locator('#scim-endpoint-url');
        await expect(endpointEl).toBeVisible({ timeout: 30_000 });
        await expect(endpointEl).toContainText(/https?:\/\/.+\/api\/scim\/v2/, {
            timeout: 30_000,
        });

        const endpointUrl = (await endpointEl.textContent()) ?? '';
        expect(endpointUrl.trim().length).toBeGreaterThan(0);

        await page
            .getByRole('button', { name: /Copy SCIM endpoint/i })
            .click();

        // Toast appears.
        await expect(
            page.getByText('SCIM endpoint copied', { exact: false }),
        ).toBeVisible({ timeout: 5000 });

        // Clipboard contains the exact URL rendered beside the button.
        const clipboard = await readClipboard(page);
        expect(clipboard).toBe(endpointUrl.trim());
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
