/**
 * Trends page — mobile smoke (@mobile).
 *
 * READ-ONLY: logs into the shared seeded tenant and, at a phone viewport,
 * checks the Trends page renders, the range selector switches, and the page
 * never drifts horizontally. Market data is env-gated (EC / Alpha Vantage), so
 * this spec asserts the CONTROLS + shell, not chart data — the page renders an
 * empty/operator state when the backend has no data, which is valid.
 *
 * Horizontal-drift for `/trends` is also covered by the structural ratchet in
 * `horizontal-drift.spec.ts`; this spec adds the practice-interaction check.
 */
import { test, expect, type Page } from '@playwright/test';
import { safeGoto, loginAndGetTenant, waitForHydration } from '../e2e-utils';

// Not `networkidle`: /trends and /news both read through `useTenantSWR` and the
// session polls, so network-quiet is a signal that often never arrives — the
// 30s default timeout is then swallowed by the `.catch` below and paid on every
// green run, four times over. What the callers actually need is React hydration
// of the control they are about to click: `if (await oneYear.count())` is an
// INSTANT probe, and `TabSelect`'s `onSelect` is a client handler, so a click on
// server-rendered markup is a no-op and the `aria-selected` assertion that
// follows burns its full timeout instead. The default names the two clicked
// controls (never `main`, which hydrates long before these nested panels);
// whichever page is loaded, one of them matches. Still never throws, so the
// deliberate data-agnostic `count()` skip keeps working.
async function settle(
    page: Page,
    hydrateSelector = '#trends-range-1y, #trends-news-filter-policy',
): Promise<void> {
    await waitForHydration(page, hydrateSelector, 15_000).catch(() => undefined);
}

async function expectNoDrift(page: Page): Promise<void> {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
}

test.describe('Trends page @mobile', () => {
    test('renders and switches range without drift at phone width', async ({ page }) => {
        const slug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${slug}/trends`);
        await settle(page);

        // Shell renders: the page title. Trends is Prices-only now (News moved
        // to its own /news destination), so there is no page-level tab bar —
        // the only tabs on the page are the Prices range selector below.
        await expect(page.getByRole('main').locator('#trends-title')).toBeVisible();

        // Switch the range selector — the panel re-renders (chart OR empty
        // state), and the selected range flips. Data-agnostic: works whether
        // or not the market backend is configured.
        const oneYear = page.locator('#trends-range-1y');
        if (await oneYear.count()) {
            await oneYear.click();
            await expect(oneYear).toHaveAttribute('aria-selected', 'true');
            await settle(page);
        }

        await expectNoDrift(page);
    });

    test('the News page renders and filters without drift at phone width', async ({ page }) => {
        const slug = await loginAndGetTenant(page);
        // News is now its own top-level destination, not a tab on /trends.
        await safeGoto(page, `/t/${slug}/news`);
        await settle(page);

        // The News page renders its heading + feed panel. With no feeds
        // configured in CI it shows the empty + operator state, which is valid —
        // assert the shell, not data.
        await expect(page.getByRole('main').locator('#news-title')).toBeVisible();
        await expect(page.getByRole('main').locator('#trends-news-panel')).toBeVisible();

        // Switch the category filter — panel re-renders, selection flips.
        const policyFilter = page.locator('#trends-news-filter-policy');
        if (await policyFilter.count()) {
            await policyFilter.click();
            await expect(policyFilter).toHaveAttribute('aria-selected', 'true');
            await settle(page);
        }

        await expectNoDrift(page);
    });
});
