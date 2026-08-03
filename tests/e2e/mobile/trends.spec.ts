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
 * `horizontal-drift.spec.ts`; this spec adds the control-interaction check.
 */
import { test, expect, type Page } from '@playwright/test';
import { safeGoto, loginAndGetTenant } from '../e2e-utils';

async function settle(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle').catch(() => undefined);
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

        // Shell renders: title + the two page tabs (Prices active by default).
        await expect(page.getByRole('main').locator('#trends-title')).toBeVisible();
        const pricesTab = page.getByRole('tab', { name: /prices|цени/i });
        await expect(pricesTab).toHaveAttribute('aria-selected', 'true');

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

    test('switches to the News tab and renders a tappable article card', async ({ page }) => {
        const slug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${slug}/trends`);
        await settle(page);

        // Switch to the News tab.
        const newsTab = page.getByRole('tab', { name: /news|новини/i });
        await newsTab.click();
        await expect(newsTab).toHaveAttribute('aria-selected', 'true');
        await settle(page);

        // The seed provides a few global MarketNewsItem rows, so the feed
        // renders. A card links OUT to the publisher in a new tab.
        const main = page.getByRole('main');
        const firstCard = main.locator('[data-testid="news-card"]').first();
        await expect(firstCard).toBeVisible();
        const link = firstCard.getByRole('link').first();
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', /noopener/);

        await expectNoDrift(page);
    });
});
