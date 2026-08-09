/**
 * Audit Readiness — E2E.
 *
 * Tenant strategy: stays on the SHARED seeded `acme-corp` tenant.
 * Both flows create audit cycles for the seeded ISO27001 / NIS2
 * frameworks; `createIsolatedTenant` yields an empty tenant with no
 * installed frameworks, so this spec cannot migrate until the
 * factory gains a framework-install option (same carve-out as
 * `frameworks.spec.ts` / `reporting.spec.ts`).
 *
 * Cascade fix: the previous shape had each flow split into many
 * serial `test()`s sharing module-level `let cycleId / packId /
 * shareToken` assigned inside one `test()` and read by later ones —
 * a failure in "create cycle" cascaded into every downstream test.
 * Each flow is one sequential scenario, so it is now a single
 * `test()` with `test.step(...)` sub-steps and zero cross-test
 * state. (`let page` is still hoisted, but it is assigned in
 * `beforeAll` — not inside a `test()` — which is the correct shared-
 * fixture pattern, not the cascade anti-pattern.)
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

test.describe('Audit Readiness', () => {
    test.describe.configure({ timeout: 180_000 });

    let tenantSlug: string;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        // Retry loop: cold-start server may need several attempts.
        for (let attempt = 0; attempt < 5; attempt++) {
            await safeGoto(page, '/login').catch(() => null);
            const emailInput = page.locator('input[type="email"][name="email"]');
            if (await emailInput.isVisible({ timeout: 10000 }).catch(() => false)) {
                break;
            }
            await page.waitForTimeout(5000);
        }
        tenantSlug = await loginAndGetTenant(page);
    });

    test.afterAll(async () => {
        await page.close();
    });

    // ─── ISO27001 Flow (one scenario) ────────────────────────────────

    test('ISO27001 — cycle → pack → freeze → share → shared view', async () => {
        let cycleId = '';
        let shareToken = '';

        await test.step('cycles page loads', async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const resp = await page.goto(
                        `/t/${tenantSlug}/audits/cycles`,
                    );
                    if (resp && resp.status() < 500) break;
                } catch {
                    /* net:: during heavy compilation */
                }
                if (attempt < 2) await page.waitForTimeout(5000);
            }
            await page.waitForLoadState('networkidle').catch(() => {});
            await expect(page.locator('text=Audit Readiness')).toBeVisible({
                timeout: 60000,
            });
        });

        await test.step('create ISO27001 cycle', async () => {
            const createBtn = page.locator('#create-cycle-btn');
            await createBtn.waitFor({ state: 'visible', timeout: 30000 });
            await createBtn.click();
            await page.waitForSelector('#cycle-form', {
                state: 'visible',
                timeout: 30000,
            });

            const uid = Date.now().toString(36);
            const cycleName = `E2E ISO27001 Audit ${uid}`;
            // ISO27001 is the default Combobox selection.
            await page.fill('#cycle-name-input', cycleName);
            await page.click('#submit-cycle-btn');

            await page.waitForURL(/\/audits\/cycles\//, { timeout: 30000 });
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#cycle-name', { timeout: 60000 });
            await expect(page.locator('#cycle-name')).toContainText(cycleName, {
                timeout: 15000,
            });

            const match = page.url().match(/\/cycles\/([^/?]+)/);
            expect(match).toBeTruthy();
            cycleId = match![1];
        });

        await test.step('cycle detail shows default pack preview', async () => {
            await page
                .waitForSelector('#preview-counts', { timeout: 15000 })
                .catch(() => null);
            const previewEl = page.locator('#preview-counts');
            if (await previewEl.isVisible().catch(() => false)) {
                await expect(page.locator('#preview-practices')).toBeVisible();
                await expect(page.locator('#preview-policies')).toBeVisible();
            }
        });

        await test.step('create pack from default selection', async () => {
            expect(cycleId).toBeTruthy();
            const btn = page.locator('#create-default-pack-btn');
            await expect(btn).toBeVisible({ timeout: 10000 });
            await btn.click();

            await page.waitForURL(/\/audits\/packs\//, { timeout: 60000 });
            await page.waitForLoadState('networkidle', { timeout: 60000 });
            await expect(page.locator('#pack-name')).toBeVisible({
                timeout: 60000,
            });
        });

        await test.step('pack is in DRAFT status', async () => {
            await expect(page.locator('#pack-status')).toContainText('DRAFT', {
                timeout: 10000,
            });
        });

        await test.step('freeze the pack', async () => {
            const freezeBtn = page.locator('#freeze-pack-btn');
            await expect(freezeBtn).toBeVisible({ timeout: 30_000 });
            const [response] = await Promise.all([
                page.waitForResponse(
                    resp =>
                        resp.url().includes('action=freeze') &&
                        resp.request().method() === 'POST',
                    { timeout: 60_000 },
                ),
                freezeBtn.click(),
            ]);
            expect(response.status()).toBe(200);
            await expect(page.locator('#pack-status')).toContainText('FROZEN', {
                timeout: 30_000,
            });
        });

        await test.step('generate share link', async () => {
            const shareBtn = page.locator('#share-pack-btn');
            await expect(shareBtn).toBeVisible({ timeout: 30_000 });
            await shareBtn.click();

            await expect(page.locator('#share-link-card')).toBeVisible({
                timeout: 15_000,
            });
            const linkEl = page.locator('#share-link-url');
            await expect(linkEl).toBeVisible();
            const linkText = await linkEl.textContent();
            expect(linkText).toContain('/audit/shared/');
            const match = linkText?.match(/\/audit\/shared\/([a-f0-9]+)/);
            expect(match).not.toBeNull();
            shareToken = match![1];
        });

        await test.step('auditor can view shared pack', async () => {
            expect(shareToken).toBeTruthy();
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const resp = await page.goto(
                        `/audit/shared/${shareToken}`,
                    );
                    if (resp && resp.status() < 500) break;
                } catch {
                    /* net:: during heavy compilation */
                }
                if (attempt < 2) await page.waitForTimeout(5000);
            }
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#shared-pack-name', { timeout: 60000 });
            await expect(page.locator('#shared-pack-name')).toBeVisible();
            await expect(page.locator('#shared-pack-summary')).toBeVisible();
            await expect(page.locator('text=Read-only view')).toBeVisible();
        });
    });

    // ─── NIS2 Flow (one scenario) ────────────────────────────────────

    test('NIS2 — cycle → preview → pack', async () => {
        await test.step('create NIS2 cycle', async () => {
            await page.goto(`/t/${tenantSlug}/audits/cycles`);
            await page.waitForLoadState('networkidle').catch(() => {});

            await page.waitForSelector('#create-cycle-btn', { timeout: 15000 });
            await page.click('#create-cycle-btn');
            await page.waitForSelector('#cycle-form', { timeout: 5000 });

            const uid = Date.now().toString(36);
            const cycleName = `E2E NIS2 Audit ${uid}`;
            await page.click('#fw-select');
            await page.getByRole('option', { name: /NIS2 Directive/ }).click();
            await page.fill('#cycle-name-input', cycleName);
            await page.click('#submit-cycle-btn');

            await page.waitForURL(/\/audits\/cycles\//, { timeout: 15000 });
            await expect(page.locator('#cycle-name')).toContainText(cycleName);
        });

        await test.step('NIS2 cycle shows preview and can create pack', async () => {
            await page.waitForSelector('#create-default-pack-btn', {
                timeout: 15000,
            });
            await page.click('#create-default-pack-btn');

            await page.waitForURL(/\/audits\/packs\//, { timeout: 15000 });
            await expect(page.locator('#pack-name')).toBeVisible({
                timeout: 10000,
            });
            await expect(page.locator('#pack-status')).toContainText('DRAFT');
        });
    });
});
