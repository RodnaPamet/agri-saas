/**
 * E2E Reporting & Audit Narrative Tests
 *
 * E-G) Audit cycle → pack → freeze → share link    (mutating scenario)
 *
 * Read-only tests A/B/D are gone with their surfaces: A and B drove the
 * `/frameworks` catalogue UI and D drove `/reports` (a Statement of
 * Applicability tab and a Risk Register tab). The SoA builder, the
 * frameworks UI and the risk register were all removed with the
 * inherited GRC stack, so those three tests had no subject left —
 * unlike E-G, which exercise audit cycles and packs, both of which
 * survive.
 *
 * Tenant strategy: this spec stays on the SHARED seeded `acme-corp`
 * tenant. The mutating scenario (E-G) creates an audit cycle *for
 * ISO27001* — an isolated tenant from `createIsolatedTenant` is empty
 * and has NO frameworks installed, so it cannot run this flow.
 * Migrating E-G is gated on the factory gaining a framework-install
 * option (same carve-out as `audit-readiness.spec.ts`).
 *
 * Cascade fix: the previous shape had E/F/G as three serial
 * `test()`s sharing module-level `let cycleId / packId /
 * shareToken` — F read `cycleId` written by E, G read `shareToken`
 * written by F. A failure in E cascaded into F and G. E-G is one
 * sequential scenario, so it is now a single `test()` with
 * `test.step(...)` sub-steps and no cross-test state.
 *
 * Uses AUTH_TEST_MODE=1 credentials provider (admin@acme.com).
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { loginAndGetTenant, gotoAndVerify } from './e2e-utils';

const UNIQUE = Date.now().toString(36);

test.describe('Reporting & Audit Narrative', () => {
    // ─── E-G) Audit cycle → pack → freeze → share (one scenario) ─────

    test('E-G — create audit cycle, pack, freeze, and share', async ({
        page,
        browser,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);
        let cycleId = '';
        let packId = '';
        let shareToken = '';

        await test.step('E — create audit cycle (ISO27001)', async () => {
            await gotoAndVerify(page, `/t/${tenantSlug}/audits/cycles`, 'h1', 3);

            await page.click('#create-cycle-btn');
            await page.waitForSelector('#cycle-form', { timeout: 5000 });
            // ISO27001 is the default Combobox selection — no click needed.
            await page.fill('#cycle-name-input', `E2E Audit Cycle ${UNIQUE}`);
            await page.click('#submit-cycle-btn');

            await page.waitForURL(/\/audits\/cycles\//, { timeout: 15000 });
            await page.waitForSelector('#cycle-name', { timeout: 15000 });
            await expect(page.locator('#cycle-name')).toContainText(
                `E2E Audit Cycle ${UNIQUE}`,
            );
            const urlMatch = page.url().match(/\/cycles\/([^/]+)/);
            expect(urlMatch).toBeTruthy();
            cycleId = urlMatch![1];
        });

        await test.step('F — create default pack, freeze, share link', async () => {
            expect(cycleId).toBeTruthy();
            await gotoAndVerify(
                page,
                `/t/${tenantSlug}/audits/cycles/${cycleId}`,
                '#cycle-name',
                3,
            );

            const createPackBtn = page.locator('#create-default-pack-btn');
            await expect(createPackBtn).toBeVisible({ timeout: 5000 });
            await createPackBtn.click();

            await page.waitForURL(/\/audits\/packs\//, { timeout: 60000 });
            await page.waitForSelector('#pack-name', { timeout: 15000 });
            const packMatch = page.url().match(/\/packs\/([^/]+)/);
            expect(packMatch).toBeTruthy();
            packId = packMatch![1];

            await expect(page.locator('#pack-status')).toContainText('DRAFT');

            // Freeze the pack.
            const freezeBtn = page.locator('#freeze-pack-btn');
            await expect(freezeBtn).toBeVisible({ timeout: 5000 });
            await Promise.all([
                page.waitForResponse(
                    resp =>
                        resp.url().includes('/audits/packs/') &&
                        resp.url().includes('action=freeze'),
                    { timeout: 90000 },
                ),
                freezeBtn.click(),
            ]);
            await page.waitForLoadState('networkidle').catch(() => {});
            await expect(page.locator('#pack-status')).toContainText('FROZEN', {
                timeout: 60000,
            });

            // Generate a share link.
            const shareBtn = page.locator('#share-pack-btn');
            await expect(shareBtn).toBeVisible({ timeout: 5000 });
            await shareBtn.click();

            await expect(page.locator('#share-link-card')).toBeVisible({
                timeout: 10000,
            });
            const shareUrl = await page.locator('#share-link-url').textContent();
            expect(shareUrl).toBeTruthy();
            expect(shareUrl).toContain('/audit/shared/');
            const tokenMatch = shareUrl!.match(/\/audit\/shared\/([^/]+)/);
            expect(tokenMatch).toBeTruthy();
            shareToken = tokenMatch![1];
        });

        await test.step('G — shared pack is accessible without login', async () => {
            expect(shareToken).toBeTruthy();
            const freshContext: BrowserContext = await browser.newContext();
            const freshPage = await freshContext.newPage();
            try {
                await freshPage.goto(`/audit/shared/${shareToken}`, {
                    timeout: 30000,
                });
                await freshPage.waitForLoadState('networkidle').catch(() => {});
                await freshPage.waitForSelector('#shared-pack-name', {
                    timeout: 30000,
                });

                await expect(freshPage.locator('#shared-pack-name')).toBeVisible();
                await expect(
                    freshPage.locator('#shared-pack-summary'),
                ).toBeVisible({ timeout: 5000 });
                await expect(
                    freshPage.locator('text=Read-only view').first(),
                ).toBeVisible({ timeout: 5000 });
                await expect(
                    freshPage.locator('#freeze-pack-btn'),
                ).not.toBeVisible();
                await expect(
                    freshPage.locator('#share-pack-btn'),
                ).not.toBeVisible();
            } finally {
                try {
                    await freshPage.close();
                } catch {
                    /* ignore */
                }
                try {
                    await freshContext.close();
                } catch {
                    /* ignore */
                }
            }
        });
    });
});
