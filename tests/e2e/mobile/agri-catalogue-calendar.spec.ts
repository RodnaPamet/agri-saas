/**
 * Agriculture catalogue on the calendar — mobile smoke (@mobile).
 *
 * READ-ONLY: logs into the shared seeded tenant and checks that the GLOBAL
 * `AgriEvent` catalogue still reaches a farmer, now that `/events` is gone
 * and the entries render on the calendar itself.
 *
 * WHY THIS SPEC SURVIVED THE PAGE IT TESTED. It is the only guard that
 * `prisma/seed.ts` actually populates the catalogue — the defect the events
 * page originally shipped with was an empty feed. Deleting the spec along
 * with the page would have retired that guard silently, so it was rewritten
 * rather than removed.
 *
 * WHY THE POPULATION CHECK GOES THROUGH THE API. The calendar renders ONE
 * month. Seeded events fall on whatever dates the curator chose, so a UI
 * assertion that "the grid contains an agri event" is only true in the
 * months that happen to contain one — it would pass or fail depending on
 * when the suite runs, which is worse than no assertion. Querying a wide
 * range through the same endpoint the grid consumes keeps the guard
 * deterministic while still exercising the real loader, RLS path and DTO.
 *
 * The UI half then asserts what IS month-independent: the calendar shell
 * renders, and any agri event present is marked external so the renderer
 * gives it a safe anchor rather than a next/link.
 *
 * `loginAndGetTenant` forces NEXT_LOCALE=en, so assertions target English
 * copy even though the product is Bulgarian-first.
 *
 * Horizontal drift for `/calendar` is covered by the ratchet in
 * `horizontal-drift.spec.ts` (it replaced the `/events` row there).
 */
import { test, expect, type Page } from '@playwright/test';
import { safeGoto, loginAndGetTenant } from '../e2e-utils';

async function settle(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle').catch(() => undefined);
}

interface CalendarEventLike {
    category: string;
    // Titles are i18n KEYS resolved by the renderer — the payload is
    // locale-independent, so there is no rendered string to assert on here.
    titleKey: string;
    titleParams?: Record<string, string>;
    href: string;
    external?: boolean;
}

test.describe('Agriculture catalogue on the calendar @mobile', () => {
    test('the seeded catalogue reaches the calendar with safe external links', async ({
        page,
    }) => {
        const slug = await loginAndGetTenant(page);

        // ── Population guard (seed wiring) ──
        // A deliberately wide window so the assertion does not depend on
        // which month the suite happens to run in.
        const from = new Date();
        from.setUTCMonth(from.getUTCMonth() - 6);
        const to = new Date();
        to.setUTCMonth(to.getUTCMonth() + 12);

        const res = await page.request.get(
            `/api/t/${slug}/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
        );
        expect(res.ok()).toBe(true);
        const body = (await res.json()) as { events: CalendarEventLike[] };

        const agri = body.events.filter((e) => e.category === 'agri-event');
        // Zero here means the seed wiring has regressed — exactly the defect
        // the original events page shipped with.
        expect(agri.length).toBeGreaterThan(0);

        // Every catalogue entry carries a title. Curator-supplied text uses
        // the passthrough key, so the readable part is in titleParams.name.
        for (const ev of agri) {
            expect(ev.titleKey.length).toBeGreaterThan(0);
            expect((ev.titleParams?.name ?? '').trim().length).toBeGreaterThan(0);
        }

        // Entries with an off-site organiser page must be flagged external, so
        // the renderer emits a plain anchor: next/link cannot navigate to an
        // absolute URL. The seed includes at least one such event (AGRA).
        const offsite = agri.filter((e) => /^https?:\/\//.test(e.href));
        expect(offsite.length).toBeGreaterThan(0);
        for (const ev of offsite) {
            expect(ev.external).toBe(true);
        }

        // ── UI half (month-independent) ──
        await safeGoto(page, `/t/${slug}/calendar`);
        await settle(page);

        const main = page.getByRole('main');
        await expect(main.getByTestId('calendar-month-nav')).toBeVisible();
        await expect(main.getByTestId('calendar-side-panel')).toBeVisible();

        // Any agri event rendered in the CURRENT month must open safely. This
        // loop is conditional by design — see the docblock on why a hard
        // assertion here would be month-dependent.
        const externalAnchors = main.locator('a[target="_blank"]');
        const anchorCount = await externalAnchors.count();
        for (let i = 0; i < anchorCount; i += 1) {
            await expect(externalAnchors.nth(i)).toHaveAttribute(
                'rel',
                /noopener/,
            );
        }

        // No horizontal drift at phone width.
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
});
