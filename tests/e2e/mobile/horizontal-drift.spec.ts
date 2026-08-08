/**
 * Mobile horizontal-drift ratchet (@mobile).
 *
 * READ-ONLY: logs into the shared seeded tenant and, at a phone viewport,
 * asserts every key page renders with NO horizontal overflow — the document's
 * scrollWidth never exceeds the viewport width (±1px for sub-pixel rounding).
 *
 * Why: commit #210 ("fix(mobile): remove horizontal drift on dashboard cards +
 * app-wide sweep") fixed this class BY HAND — a negative-margin child inside a
 * scroll container that pushes the page sideways on a phone, the single worst
 * mobile-feel bug for a field user. Nothing stopped it from recurring. This is
 * the mobile equivalent of the repo's structural ratchets: add a page to
 * `PAGES` in one line and it's guarded forever.
 *
 * The STATIC sibling `tests/guards/no-horizontal-drift-patterns.test.ts`
 * catches the root-cause markup patterns on 100% of files at author time; this
 * spec is the live-DOM backstop, exercising the real rendered pages a field
 * user touches.
 *
 * Runs under the `mobile-android` (Pixel 5) + `mobile-iphone` projects (both
 * < 768px). Picked up via the `@mobile` tag (see playwright.config.ts).
 */
import { test, expect, type Page } from '@playwright/test';
import { safeGoto, loginAndGetTenant } from '../e2e-utils';

/**
 * Assert the page has no horizontal drift. `documentElement.scrollWidth`
 * exceeding `clientWidth` means SOMETHING is wider than the viewport — the
 * exact symptom a user feels as "the page slides left/right".
 */
async function expectNoHorizontalDrift(page: Page, label: string): Promise<void> {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    expect(
        scrollWidth,
        `${label}: page overflows horizontally (scrollWidth ${scrollWidth} > viewport ${clientWidth})`,
    ).toBeLessThanOrEqual(clientWidth + 1);
}

/** Let streaming content + map tile loads settle before measuring. */
async function settle(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle').catch(() => undefined);
}

// Key field surfaces. One line per page — this is the extension point.
const PAGES: ReadonlyArray<{ label: string; path: (slug: string) => string }> = [
    { label: 'dashboard', path: (s) => `/t/${s}/dashboard` },
    // Climate — per-field Open-Meteo weather (current + forecast + spray
    // window). Renders empty states with no fields/weather, so no seed dependency.
    { label: 'climate', path: (s) => `/t/${s}/climate` },
    { label: 'journal', path: (s) => `/t/${s}/journal` },
    { label: 'exchange', path: (s) => `/t/${s}/exchange` },
    // Trends — market-price charts. Renders on any tenant (empty/unconfigured
    // state when the market-data backend has no data), so no seed dependency.
    { label: 'trends', path: (s) => `/t/${s}/trends` },
    // News — aggregated agri-news feed (its own destination now). Renders the
    // empty/operator state when no items are cached, so no seed dependency.
    { label: 'news', path: (s) => `/t/${s}/news` },
    // Calendar — month grid + side panel. Long event titles inside fixed-width
    // day cells make it the shape most prone to drift, and it was absent from
    // this ratchet entirely until the agriculture catalogue merged into it
    // (replacing the retired /events row).
    { label: 'calendar', path: (s) => `/t/${s}/calendar` },
    { label: 'my-listings', path: (s) => `/t/${s}/exchange/my-listings` },
    { label: 'my-interests', path: (s) => `/t/${s}/exchange/my-interests` },
    { label: 'farm-tasks', path: (s) => `/t/${s}/farm-tasks` },
    { label: 'locations (list)', path: (s) => `/t/${s}/locations` },
    // Rent — the lease register: wide table + KPI card + Fab.
    { label: 'rent', path: (s) => `/t/${s}/rent` },
    { label: 'mapping', path: (s) => `/t/${s}/mapping` },
    { label: 'notifications', path: (s) => `/t/${s}/notifications` },
    // Grain complex — wide numeric tables are prime drift candidates.
    { label: 'grain/bins', path: (s) => `/t/${s}/grain/bins` },
    { label: 'grain/contracts', path: (s) => `/t/${s}/grain/contracts` },
    { label: 'grain/yield', path: (s) => `/t/${s}/grain/yield` },
    // Planning visualisations (boards / calendars).
    { label: 'planning/seasons', path: (s) => `/t/${s}/planning/seasons` },
    // Admin — wide RBAC/role matrices + audit-log + integrations tables.
    { label: 'admin/rbac', path: (s) => `/t/${s}/admin/rbac` },
    { label: 'admin/roles', path: (s) => `/t/${s}/admin/roles` },
    { label: 'admin/billing', path: (s) => `/t/${s}/admin/billing` },
    { label: 'admin/audit-log', path: (s) => `/t/${s}/admin/audit-log` },
    { label: 'admin/integrations', path: (s) => `/t/${s}/admin/integrations` },
];

/**
 * Detail pages need a real entity id. Rather than hard-code seeded ids (which
 * drift with the seed), each entry resolves the FIRST entity from its own list
 * page via the title-cell `<Link href="/t/<slug>/<entity>/<id>">` anchor, then
 * measures that detail page. Entities the shared seed doesn't populate today
 * (vendors / journal / locations / field tasks) resolve to `null` and the test
 * skips — coverage grows automatically as the seed grows. One line each.
 */
const DETAIL_PAGES: ReadonlyArray<{
    label: string;
    list: (slug: string) => string;
    entity: string; // path segment after the slug, e.g. 'controls'
}> = [
    { label: 'controls/[controlId]', list: (s) => `/t/${s}/controls`, entity: 'controls' },
    { label: 'vendors/[vendorId]', list: (s) => `/t/${s}/vendors`, entity: 'vendors' },
    { label: 'journal/[id]', list: (s) => `/t/${s}/journal`, entity: 'journal' },
    { label: 'field/[taskId]', list: (s) => `/t/${s}/farm-tasks`, entity: 'field' },
    { label: 'locations/[locationId]', list: (s) => `/t/${s}/locations`, entity: 'locations' },
];

/**
 * Resolve the first detail URL for an entity from its list page. Returns the
 * href of the first anchor pointing at `/t/<slug>/<entity>/<id-like-segment>`,
 * or `null` if the list has no such entity (empty seed → the test skips).
 */
async function firstDetailHref(
    page: Page,
    slug: string,
    listPath: string,
    entity: string,
): Promise<string | null> {
    await safeGoto(page, listPath);
    await settle(page);
    const prefix = `/t/${slug}/${entity}/`;
    const hrefs = await page
        .getByRole('main')
        .locator(`a[href^="${prefix}"]`)
        .evaluateAll((els) =>
            els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''),
        )
        .catch(() => [] as string[]);
    // The last path segment of a detail URL is an entity id (cuid/uuid-like),
    // not a known sub-route word (new / import / dashboard / board / …).
    const detail = hrefs.find((h) => {
        const seg = h.split('?')[0].split('/').filter(Boolean).pop() ?? '';
        return /^[a-z0-9-]{12,}$/i.test(seg);
    });
    return detail ?? null;
}

test.describe('mobile horizontal-drift ratchet @mobile', () => {
    let tenantSlug: string;

    test.beforeEach(async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
    });

    // ONE login per BLOCK, not per route. A fresh loginAndGetTenant per page
    // scaled to ~50 logins across the device matrix and pushed the E2E job past
    // its timeout. These are read-only drift checks, so a single authenticated
    // session navigates every route; `test.step` attributes any failure to the
    // specific page. Adding a page is still one line in PAGES / DETAIL_PAGES.
    test('static pages do not drift horizontally', async ({ page }) => {
        for (const { label, path } of PAGES) {
            await test.step(label, async () => {
                await safeGoto(page, path(tenantSlug));
                await settle(page);
                await expectNoHorizontalDrift(page, label);
            });
        }
    });

    test('detail pages do not drift horizontally', async ({ page }) => {
        for (const { label, list, entity } of DETAIL_PAGES) {
            await test.step(label, async () => {
                const href = await firstDetailHref(page, tenantSlug, list(tenantSlug), entity);
                if (href === null) return; // no seeded entity in the shared tenant — skip this route
                await safeGoto(page, href);
                await settle(page);
                await expectNoHorizontalDrift(page, label);
            });
        }
    });

    // Modal-open states — a wide form inside a phone-width sheet is the
    // historical drift culprit. Opening a create modal is read-only.
    test('create-modal open states do not drift', async ({ page }) => {
        await test.step('exchange + create-offer', async () => {
            await safeGoto(page, `/t/${tenantSlug}/exchange`);
            const trigger = page.getByRole('button', { name: /offer/i }).first();
            if (await trigger.count()) {
                await trigger.click().catch(() => undefined);
                await page.waitForTimeout(300);
            }
            await expectNoHorizontalDrift(page, 'exchange + create-offer modal');
        });
        await test.step('journal + create-entry', async () => {
            await safeGoto(page, `/t/${tenantSlug}/journal`);
            await settle(page);
            const trigger = page.locator('#new-journal-btn');
            if (await trigger.count()) {
                await trigger.click().catch(() => undefined);
                await page.waitForTimeout(300);
            }
            await expectNoHorizontalDrift(page, 'journal + create-entry modal');
        });
    });

    // Cadastre (КККР) WMS overlay — turning it ON must not introduce
    // horizontal drift (a mis-sized raster source is a classic overflow
    // culprit). The overlay toggle is ENV-GATED (CADASTRE_WMS_URL), so on a CI
    // run without the env the toggle never renders — this step then no-ops /
    // skips rather than hard-failing. When present, it toggles the overlay on
    // and re-measures.
    test('location map + cadastre overlay does not drift', async ({ page }) => {
        const href = await firstDetailHref(
            page,
            tenantSlug,
            `/t/${tenantSlug}/locations`,
            'locations',
        );
        if (href === null) return; // no seeded location — skip
        // Open the Map tab where the overlay toggle lives.
        const mapUrl = href.includes('?') ? `${href}&tab=map` : `${href}?tab=map`;
        await safeGoto(page, mapUrl);
        await settle(page);
        // The toggle renders only when the cadastre WMS is configured. Match
        // both locales (en "Cadastral map" / bg "Кадастрална карта").
        const toggle = page.getByRole('button', { name: /cadastr|кадастр/i }).first();
        if (!(await toggle.count())) return; // env-gated feature absent on this deploy — skip
        // Baseline before enabling, then flip it on and re-measure.
        await expectNoHorizontalDrift(page, 'location map (cadastre off)');
        if (await toggle.isEnabled()) {
            await toggle.click().catch(() => undefined);
            await page.waitForTimeout(400); // let the raster source mount + tiles settle
        }
        await expectNoHorizontalDrift(page, 'location map (cadastre on)');
    });
});

/**
 * Auth / entry surfaces sit OUTSIDE the tenant shell — some are public, some
 * redirect to `/login` when unauthenticated. Either way, whatever renders must
 * not drift on a phone. No login here — these are the very first screens a new
 * field user sees.
 */
test.describe('mobile horizontal-drift — auth/entry surfaces @mobile', () => {
    const SURFACES: ReadonlyArray<{ label: string; path: string }> = [
        { label: 'login', path: '/login' },
        { label: 'tenants (picker)', path: '/tenants' },
        { label: 'no-tenant', path: '/no-tenant' },
        // Invalid token → the preview renders its "invite unavailable" state,
        // which must not drift either.
        { label: 'invite/[token] preview', path: '/invite/drift-check-preview-token' },
    ];

    for (const { label, path } of SURFACES) {
        test(`${label} does not drift horizontally`, async ({ page }) => {
            await safeGoto(page, path);
            await settle(page);
            await expectNoHorizontalDrift(page, label);
        });
    }
});
