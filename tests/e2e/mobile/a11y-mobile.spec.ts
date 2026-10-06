/**
 * Mobile axe sweep — 0 serious findings at a phone viewport (@mobile).
 *
 * ── the gap this closes ──
 *
 * P2's hardening block asks for a "mobile axe check: 0 serious findings", and
 * the repo already had an axe gate — `tests/e2e/a11y.spec.ts`, 7 surfaces,
 * failing on `serious` + `critical`. It had never run at a phone viewport.
 * `playwright.config.ts` grants the two phone projects `grep: /@mobile/` and
 * that spec carries no tag, so all 7 of its scans ran on `chromium` at
 * 1280x720 and 0 of 7 ran on `Pixel 5` or the `iPhone 13` profile.
 *
 * The jsdom sweep (`tests/rendered/ag-pages-a11y.test.tsx`) is the nearest
 * thing that did, and it is not a substitute: jsdom computes no layout and
 * loads no stylesheet, so axe's `color-contrast` and target-size rules cannot
 * evaluate there at all. Those are precisely the mobile-specific rules.
 *
 * ── what this scans, and why these surfaces ──
 *
 * Below the `md:` (768px) breakpoint the app renders a DIFFERENT shell: the
 * `md:hidden` bottom-tab bar mounts (P2.5 — saved tab order, badges, 44px
 * targets), `<DataTable mobileFallback="card">` swaps its table for
 * `MobileCardList`, and the filter toolbar becomes a vaul bottom sheet. None
 * of that DOM exists in the desktop project, so none of it had been audited
 * by a real browser. The four surfaces here are the ones that carry it:
 * login (no shell), the dashboard, a card-mode list, and the filter sheet
 * OPEN — a dialog's focus trap and labelling are what an axe scan is for.
 *
 * ── «Слънце» ──
 *
 * The last test scans the high-contrast palette. It is the only RUNTIME check
 * of that theme anywhere in the repo: `tests/guards/token-contrast-wcag.test.ts`
 * measures its tokens statically, which cannot see a hardcoded colour, an
 * inline style, or a token used against a ground the static pairing does not
 * model. Note «Слънце» is `data-theme="light"` PLUS `data-contrast="high"`,
 * never `data-theme="sunlight"` — see `runA11yScan`'s read-back assertion.
 *
 * READ-ONLY throughout — the shared seeded tenant via `loginAndGetTenant`,
 * per the read-only/mutating split in CLAUDE.md.
 */
import { test, expect } from '@playwright/test';
import { safeGoto, loginAndGetTenant } from '../e2e-utils';
import { runA11yScan } from '../a11y-scan';

test.describe('a11y — mobile viewport @mobile', () => {
    test('the viewport really is a phone, and the mobile shell really mounted', async ({
        page,
    }) => {
        // A control, and the load-bearing one. Every scan below asserts an
        // ABSENCE of serious findings, and an absence is satisfied perfectly
        // by a page that rendered the desktop shell — or nothing at all. If
        // this project ever stops being a phone, the four scans go on passing
        // while covering exactly what the desktop gate already covered.
        const vp = page.viewportSize();
        expect(vp).not.toBeNull();
        expect(vp!.width).toBeLessThan(768);

        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/dashboard`);
        await page.waitForSelector('h1', { timeout: 30_000 });

        // The `md:hidden` bottom-tab bar is the DOM that only exists here.
        // Same locator `tests/e2e/mobile/nav.spec.ts` uses — the testid is
        // pre-existing, not added for this spec.
        await expect(page.getByTestId('bottom-tab-bar')).toBeVisible({ timeout: 30_000 });
    });

    test('login has no critical/serious WCAG violations on a phone', async ({ page }) => {
        await safeGoto(page, '/login', { timeout: 60_000 });
        await page.waitForSelector('input[type="email"][name="email"]', { timeout: 60_000 });
        await runA11yScan(page, 'login (mobile)');
    });

    test('dashboard has no critical/serious WCAG violations on a phone', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/dashboard`);
        await page.waitForSelector('h1', { timeout: 30_000 });
        await runA11yScan(page, 'dashboard (mobile)');
    });

    test('a card-mode list has no critical/serious WCAG violations on a phone', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/farm-tasks`);
        // `#mobile-card-list` is the card branch — the markup the desktop
        // project never renders. Fall back to the heading so a seeded state
        // with no rows still scans the shell rather than skipping.
        await page.waitForSelector('#mobile-card-list, h1', { timeout: 30_000 });
        await runA11yScan(page, 'farm-tasks card list (mobile)');
    });

    test('the filter bottom sheet has no critical/serious WCAG violations', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/farm-tasks`);
        await page.waitForSelector('#mobile-card-list, h1', { timeout: 30_000 });

        // On a phone the FilterToolbar's popover is a vaul Drawer. Scanning it
        // open is the point: a sheet's focus trap, labelling and heading
        // structure are invisible to a scan of the page behind it.
        //
        // Scoped to `main` and matched case-insensitively — the same locator
        // `tests/e2e/mobile/lists.spec.ts` already drives this control with.
        // The Drawer content portals to <body>, so the dialog wait is
        // page-scoped while the trigger is not.
        const main = page.getByRole('main');
        const filterBtn = main.getByRole('button', { name: /filter/i }).first();
        await expect(filterBtn).toBeVisible({ timeout: 30_000 });
        await filterBtn.click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });

        await runA11yScan(page, 'farm-tasks filter sheet (mobile)');
    });

    test('«Слънце» has no critical/serious WCAG violations on a phone', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);

        // Set the theme the way the PRODUCT does, not only by poking
        // attributes: `agrent_theme=sunlight` is what P2.4's cookie +
        // pre-paint script read, so the server seeds `data-theme="light"` +
        // `data-contrast="high"` into the SSR markup and the first paint is
        // already «Слънце». That removes the race the attribute force exists
        // to cover — a ThemeProvider re-render re-asserting from the cookie
        // would otherwise strip `data-contrast` between the force and the
        // scan — and it exercises the real mechanism rather than a synthetic
        // one. The name and value are the constants in
        // `src/lib/theme/theme-cookie.ts`.
        await page.context().addCookies([
            {
                name: 'agrent_theme',
                value: 'sunlight',
                url: page.url(),
            },
        ]);

        await safeGoto(page, `/t/${tenantSlug}/dashboard`);
        await page.waitForSelector('h1', { timeout: 30_000 });

        // `theme: 'sunlight'` is still passed: the force is now a no-op on the
        // happy path, and the read-back is what turns a cookie that did not
        // take into a failure instead of a mislabelled green scan.
        await runA11yScan(page, 'dashboard (mobile, Слънце)', { theme: 'sunlight' });
    });
});
