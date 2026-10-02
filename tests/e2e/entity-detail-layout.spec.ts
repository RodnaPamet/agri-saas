/**
 * E2E — `<EntityDetailLayout>` structural promises (quality roadmap
 * P4, item 4).
 *
 * Detail-page shells are exercised tangentially by feature E2E (an
 * asset-edit spec navigates *through* the shell), but the layout's
 * own promises — the breadcrumb / header / rail / tab-bar
 * composition — have no dedicated browser test. This spec opens a
 * representative detail surface and asserts the shell paints the
 * contract.
 *
 * The representative surface has moved twice. It was a Risk until that
 * register was removed, then a Practice until the GRC teardown removed
 * `/practices` (phase 2). It is now an Asset — same shell, same
 * double-click → `/…/<id>` navigation contract, and the assets list is
 * seeded (3 rows) so the first row is always there to open. The
 * assertion was never about the entity: it is about the shell, which
 * `/assets/[id]` mounts exactly as the practice detail page did.
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto, waitForHydration, expectRouteTransition } from './e2e-utils';

// ── #1076 EXPERIMENT, not a fix. Remove before merge. ───────────────────
//
// The discriminator #1076 asks for: run this spec with the service worker
// unable to take control, and see whether the DROPPED navigation survives.
// `public/sw.js warmDocumentFor` fires ten concurrent full-document fetches
// in the 0.7s window containing the click; three traces correlate, and
// correlation across three traces is not a mechanism.
//
// `serviceWorkers: 'block'` rather than the `addInitScript` no-op the issue
// proposes. No-opping `navigator.serviceWorker.register` is NOT sufficient:
// `public/sw.js` calls `clients.claim()` on activate, so an already-active
// worker controls a newly-opened page whether or not that page registers one.
// Blocking at the context level means no worker can ever be installed, so the
// arm is clean instead of nearly clean.
//
// `data-table-platform.spec.ts` is the IN-RUN CONTROL and is deliberately
// left untouched: it shows the same dropped-transition shape and sat in the
// same E2E shard on run 36900688054, so it runs on the same runner under the
// same load in the same CI run. Comparing this spec against its own history
// would compare across runner loads, which is the variable that matters.
//
// Read as: this spec clean + control still retrying -> the SW storm is the
// mechanism, and the fix is in `isRscPrefetch` / `warmDocumentFor` (a real
// user-facing bug, not a test-only one). Both still retrying -> the storm is
// a bystander and the App Router transition itself is next.
test.use({ serviceWorkers: 'block' });

test.describe('EntityDetailLayout', () => {
    test('asset detail page renders the shell — breadcrumbs, header, body', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);

        await safeGoto(page, `/t/${tenantSlug}/assets`, {
            waitUntil: 'domcontentloaded',
        });

        // Open a real asset — the first row of the seeded fleet.
        const firstRow = page
            .getByRole('main')
            .locator('[data-testid="assets-table"] tbody tr')
            .first();
        await expect(firstRow).toBeVisible({ timeout: 15_000 });
        // The last cell is DataTable's trailing chevron column
        // (`aria-hidden`, `pointer-events-none`) — a guaranteed
        // non-interactive double-click target, unlike the leading
        // select checkbox or the title `<Link>` in the name cell.
        // A double-click on an unhydrated row is two no-ops that surface 15s
        // later as a URL that never changed. `networkidle` used to cover this.
        await waitForHydration(page, '[data-testid="assets-table"] tbody tr');
        await firstRow.locator('td').last().dblclick();

        // The shell's three structural promises:
        //
        // (1) the PageHeader subtree carrying breadcrumbs + title — asserted
        //     through `expectRouteTransition`, which gives the navigation and
        //     the first paint ONE budget.
        //
        //     The previous shape had `waitForURL` at 15s and this at 15s,
        //     with a comment correctly noting they are "the same slow-server
        //     event". The error was not having two waits — the URL one
        //     diagnoses an unhydrated double-click, which is a different
        //     fault. It was the BUDGET: `waitForURL` returns as soon as the
        //     URL changes, before the RSC payload lands, so it consumed none
        //     of its 15s and this assertion paid for the whole transition out
        //     of its own. It read as a 30s allowance and behaved as 15s
        //     (#1076). The paint now gets 30s of its own.
        await expectRouteTransition(page, {
            content: page.locator('[data-testid="entity-detail-header"]'),
            url: /\/assets\/[a-zA-Z0-9-]+$/,
        });
        // (2) the body wrapper. (The asset surface does not pass a
        //     `rail` — linked Tasks live in their own tab — so the
        //     rail is intentionally absent here; the AsidePanel
        //     primitive keeps its own rendered test.)
        await expect(
            page.locator('[data-entity-detail-layout]'),
        ).toBeVisible();
    });
});
