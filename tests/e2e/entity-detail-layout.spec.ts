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
import {
    loginAndGetTenant,
    safeGoto,
    waitForHydration,
    expectRouteTransition,
    instrumentRowGestures,
    instrumentUrlChanges,
    readNavCounters,
} from './e2e-utils';

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
        // See the note in data-table-platform.spec.ts — measure the event,
        // not the paint (#1076).
        await instrumentRowGestures(page);
        // WHO changes the URL back (#1076). Four captures agree the push
        // COMMITS and the URL then returns to the list with no reload; every
        // probe so far samples state after the fact, so `back()`, a
        // `replaceState` and a framework revert are all still live. This
        // records the CALL, which separates them.
        await instrumentUrlChanges(page);
        // The count BEFORE the gesture. `expectRouteTransition` asks for it
        // because its own capture showed `rows: 1` at failure against a seed
        // of more than one, and only the caller can see the before — without
        // it, "the set shrank under the gesture" and "it was always 1" are
        // indistinguishable in the failure report.
        const rowsBefore = await page
            .getByRole('main')
            .locator('[data-testid="assets-table"] tbody tr')
            .count();
        const navBefore = await readNavCounters(page);
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
            rowsBefore,
            navBefore,
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
