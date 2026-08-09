/**
 * E2E Core Certification Flow
 *
 * Covers the full compliance lifecycle as ONE scenario:
 *   A) Log in (OWNER of a fresh isolated tenant)
 *   B) Create a Control
 *   C) Upload Evidence linked to that Control
 *   D) Create an Asset (via API)
 *   E) Link Control → Asset and verify on the asset detail
 *   F) Verify the bidirectional link on the control detail
 *
 * Steps D-F used to run against the Risk register. That went with the
 * inherited GRC stack, so they were repointed onto Asset — the surviving
 * entity on the other side of a control's traceability graph. The shape
 * of the assertion (link once via API, read it back from BOTH detail
 * pages) is unchanged, which is the property this spec exists to hold.
 *
 * Isolation: the whole flow runs against ONE fresh, empty tenant
 * provisioned by the `isolatedTenant` fixture. The previous shape
 * was six separate `test()`s sharing a module-level `let
 * tenantSlug` + per-entity consts — a resource minted
 * in step B was read by step C, so a failure in B cascaded into
 * C-F. This is genuinely a single sequential scenario, so it is now
 * a single `test()` with `test.step(...)` sub-steps: a step failure
 * fails exactly this one test, nothing else, and there is no
 * cross-test state to leak.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import * as path from 'path';

const EVIDENCE_FIXTURE = path.resolve(__dirname, '../fixtures/evidence.txt');

test.describe('Core Certification Flow', () => {
    test('full compliance lifecycle: control → evidence → asset → link', async ({
        authedPage: page,
        isolatedTenant,
    }) => {
        const { tenantSlug } = isolatedTenant;
        const unique = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        const CONTROL_CODE = `E2E-CTRL-${unique}`;
        const CONTROL_NAME = `E2E Access Control ${unique}`;
        const ASSET_NAME = `E2E Asset ${unique}`;

        // ── A) Already signed in via the `authedPage` fixture ──
        await test.step('A — landed on dashboard as the isolated OWNER', async () => {
            await expect(page).toHaveURL(/\/t\/[^/]+\/dashboard/);
            await expect(page.locator('aside').first()).toBeVisible({
                timeout: 30_000,
            });
        });

        // ── B) Create Control ──
        let controlId: string | undefined;
        await test.step('B — create a new control', async () => {
            await page.goto(`/t/${tenantSlug}/controls/new`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#control-name-input', { timeout: 60000 });

            await page.fill('#control-name-input', CONTROL_NAME);
            await page.fill('#control-code-input', CONTROL_CODE);
            await page.fill(
                '#control-description-input',
                'E2E test control for certification flow',
            );
            await page.click('#create-control-btn');

            await page.waitForURL('**/controls/**', { timeout: 30000 });
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#control-title', { timeout: 60000 });
            await expect(page.locator('#control-title')).toContainText(
                CONTROL_NAME,
                { timeout: 5000 },
            );
            const m = page.url().match(/\/controls\/([^/?]+)/);
            controlId = m?.[1];
            expect(controlId).toBeTruthy();
        });

        // ── C) Upload Evidence linked to the Control ──
        await test.step('C — upload evidence and link to control', async () => {
            await page.goto(`/t/${tenantSlug}/evidence`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('h1', { timeout: 60000 });

            await page.click('#add-evidence-btn');
            await page.waitForSelector('#upload-form', { timeout: 5000 });

            await page.locator('#file-input').setInputFiles(EVIDENCE_FIXTURE);
            await page.fill('#upload-title-input', `E2E Evidence ${unique}`);

            // Epic 55: the control linker is a <Combobox>. Open it,
            // type into the cmdk search, click the matching option.
            // The tenant is isolated + freshly created, so this is the
            // ONLY control — the search is unambiguous.
            await page.click('#control-select');
            const comboSearch = page.getByPlaceholder('Search controls…');
            await comboSearch.fill(CONTROL_CODE);
            const codeOption = page
                .getByRole('option')
                .filter({ hasText: CONTROL_CODE })
                .first();
            await codeOption.waitFor({ state: 'visible', timeout: 10_000 });
            await codeOption.click();

            await page.click('#submit-upload-btn');
            await expect(page.locator('#upload-form')).not.toBeVisible({
                timeout: 15000,
            });
            await expect(
                page.locator(`text=E2E Evidence ${unique}`).first(),
            ).toBeVisible({ timeout: 10000 });
        });

        // ── D) Create an Asset via API ──
        let assetId: string | undefined;
        await test.step('D — create an asset via API', async () => {
            await page.goto(`/t/${tenantSlug}/assets`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('h1', { timeout: 60000 });

            const assetResult = await page.evaluate(async (assetName) => {
                const slug = window.location.pathname.split('/')[2];
                const res = await fetch(
                    `${window.location.origin}/api/t/${slug}/assets`,
                    {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: assetName,
                            type: 'TRACTOR',
                            criticality: 'HIGH',
                        }),
                    },
                );
                const data = await res.json();
                return { ok: res.ok, status: res.status, id: data?.id, name: data?.name };
            }, ASSET_NAME);

            expect(assetResult.ok).toBe(true);
            expect(assetResult.name).toBe(ASSET_NAME);
            assetId = assetResult.id;
            expect(assetId).toBeTruthy();

            await page.goto(
                `/t/${tenantSlug}/assets?q=${encodeURIComponent(ASSET_NAME)}`,
            );
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('h1', { timeout: 30000 });
            await expect(
                page.locator(`text=${ASSET_NAME}`).first(),
            ).toBeVisible({ timeout: 10000 });
        });

        // ── E) Link Control → Asset and verify on the asset detail ──
        await test.step('E — link control to asset and verify in traceability', async () => {
            const linkResult = await page.evaluate(
                async ({ cId, aId }) => {
                    const slug = window.location.pathname.split('/')[2];
                    const res = await fetch(
                        `${window.location.origin}/api/t/${slug}/assets/${aId}/controls`,
                        {
                            method: 'POST',
                            credentials: 'include',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ controlId: cId }),
                        },
                    );
                    return { ok: res.ok, status: res.status };
                },
                { cId: controlId!, aId: assetId! },
            );
            expect(linkResult.ok).toBe(true);

            await page.goto(`/t/${tenantSlug}/assets/${assetId}`);
            await page.waitForLoadState('networkidle').catch(() => {});
            // Traceability lives on its own tab. Wait for the tab trigger
            // itself (EntityDetailLayout renders `id={`tab-${key}`}`) so a
            // slow detail fetch can't race the click.
            await page.waitForSelector('#tab-traceability', { timeout: 60000 });
            await page.click('#tab-traceability');
            await page.waitForSelector('#traceability-panel', { timeout: 60000 });
            await expect(
                page.locator('#linked-controls-table'),
            ).toBeVisible({ timeout: 30_000 });
            await expect(
                page.locator('#linked-controls-table'),
            ).not.toContainText('Loading', { timeout: 30_000 });
            await expect(
                page.locator('#linked-controls-table'),
            ).toContainText(CONTROL_NAME, { timeout: 15_000 });
        });

        // ── F) Verify the bidirectional link on the control detail ──
        await test.step('F — verify control shows linked asset in traceability', async () => {
            await page.goto(`/t/${tenantSlug}/controls/${controlId}`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#control-title', { timeout: 60000 });
            await expect(page.locator('#control-title')).toContainText(
                CONTROL_NAME,
            );

            await page.click('button:has-text("Traceability")');
            await page.waitForSelector('#traceability-panel', { timeout: 60000 });

            await expect(
                page.locator('#linked-assets-table'),
            ).toBeVisible({ timeout: 10000 });
            await expect(
                page.locator('#linked-assets-table'),
            ).toContainText(ASSET_NAME, { timeout: 5000 });
        });
    });
});
