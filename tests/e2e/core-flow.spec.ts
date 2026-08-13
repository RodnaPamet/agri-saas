/**
 * E2E Core Lifecycle Flow
 *
 * Covers the primary create → evidence → link → read-back lifecycle as
 * ONE scenario:
 *   A) Log in (OWNER of a fresh isolated tenant)
 *   B) Create an Asset
 *   C) Upload tenant-wide Evidence
 *   D) Attach Evidence to that Asset from the asset detail
 *   E) Cold-reload the asset detail and read the link back
 *
 * GRC teardown phase 2 — the original A-F walked
 * practice → evidence → asset → bidirectional traceability. `/practices`
 * was deleted along with the whole inherited GRC surface, and so were
 * the two halves that made the link bidirectional: the
 * `TraceabilityPanel` component (`#traceability-panel`,
 * `#linked-practices-table`, `#linked-assets-table`) and the
 * `POST /api/t/:slug/assets/:id/practices` endpoint. There is no
 * practice to create, nothing to link it to, and no panel to read it
 * back from, so steps B/E/F could not be re-pointed — they were
 * replaced.
 *
 * What replaced them is the surviving link of the same SHAPE:
 * Asset ↔ Evidence, via `Evidence.assetId` and the
 * `<AttachedEvidencePanel>` on the asset detail's Evidence tab. The
 * property this spec exists to hold is unchanged — mint two entities,
 * link them, and prove the link is real by reading it back from a page
 * that did not perform the write. Step E does that with a cold
 * navigation, which additionally proves the link PERSISTED rather than
 * only living in post-mutation client state.
 *
 * Step C (the `/evidence` upload modal) survives intact except for the
 * practice linker: `UploadEvidenceModal` no longer renders
 * `#practice-select` — that combobox went with the GRC teardown, and
 * the modal now has no entity picker at all. The upload itself
 * (dropzone → multipart POST → optimistic list insert) is untouched and
 * still worth covering, so the step keeps everything but the link.
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

test.describe('Core Lifecycle Flow', () => {
    test('full lifecycle: asset → evidence → attach → read back', async ({
        authedPage: page,
        isolatedTenant,
    }) => {
        const { tenantSlug } = isolatedTenant;
        const unique = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        const ASSET_NAME = `E2E Asset ${unique}`;
        const EVIDENCE_TITLE = `E2E Evidence ${unique}`;
        const ATTACHED_TITLE = `E2E Attached Evidence ${unique}`;

        // ── A) Already signed in via the `authedPage` fixture ──
        await test.step('A — landed on dashboard as the isolated OWNER', async () => {
            await expect(page).toHaveURL(/\/t\/[^/]+\/dashboard/);
            await expect(page.locator('aside').first()).toBeVisible({
                timeout: 30_000,
            });
        });

        // ── B) Create an Asset ──
        let assetId: string | undefined;
        await test.step('B — create a new asset', async () => {
            // `/assets/new` is a redirect shim onto `/assets?create=1`,
            // which AssetsClient detects and opens <NewAssetModal> for.
            // `name` is the only required field — `type` and `status`
            // carry defaults (TRACTOR / ACTIVE) in useNewAssetForm.
            await page.goto(`/t/${tenantSlug}/assets/new`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#asset-name-input', { timeout: 60000 });

            await page.fill('#asset-name-input', ASSET_NAME);
            await page.click('#create-asset-submit');

            // The modal's onSuccess pushes to the new asset's detail page.
            await page.waitForURL('**/assets/**', { timeout: 30000 });
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#asset-title-heading', { timeout: 60000 });
            await expect(page.locator('#asset-title-heading')).toContainText(
                ASSET_NAME,
                { timeout: 5000 },
            );
            const m = page.url().match(/\/assets\/([^/?]+)/);
            assetId = m?.[1];
            expect(assetId).toBeTruthy();

            // Server-side list search. This assertion came off the deleted
            // /practices step; `assets/page.tsx` reads `q` out of
            // searchParams into listAssets, so the contract survives intact
            // on assets. Without it nothing in this spec ever reads the
            // LIST — step B lands on ?create=1 and the modal pushes
            // straight to the detail page.
            await page.goto(
                `/t/${tenantSlug}/assets?q=${encodeURIComponent(ASSET_NAME)}`,
            );
            await expect(
                page.locator(`text=${ASSET_NAME}`).first(),
            ).toBeVisible({ timeout: 10_000 });
        });

        // ── C) Upload tenant-wide Evidence ──
        await test.step('C — upload evidence from the evidence list', async () => {
            await page.goto(`/t/${tenantSlug}/evidence`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('h1', { timeout: 60000 });

            await page.click('#add-evidence-btn');
            await page.waitForSelector('#upload-form', { timeout: 5000 });

            await page.locator('#file-input').setInputFiles(EVIDENCE_FIXTURE);
            await page.fill('#upload-title-input', EVIDENCE_TITLE);

            // GRC teardown phase 2 — the `#practice-select` combobox that
            // used to link the upload to a practice was removed with
            // /practices. UploadEvidenceModal now carries no entity
            // picker, so the upload is tenant-wide; entity attachment
            // happens on the entity's own detail page (step D).

            await page.click('#submit-upload-btn');
            await expect(page.locator('#upload-form')).not.toBeVisible({
                timeout: 15000,
            });
            await expect(
                page.locator(`text=${EVIDENCE_TITLE}`).first(),
            ).toBeVisible({ timeout: 10000 });
        });

        // ── D) Attach Evidence to the Asset ──
        await test.step('D — attach evidence to the asset', async () => {
            await page.goto(`/t/${tenantSlug}/assets/${assetId}`);
            await page.waitForLoadState('networkidle').catch(() => {});
            // Attached evidence lives on its own tab. Wait for the tab
            // trigger itself (EntityDetailLayout renders `id={`tab-${key}`}`)
            // so a slow detail fetch can't race the click.
            await page.waitForSelector('#tab-evidence', { timeout: 60000 });
            await page.click('#tab-evidence');

            // <AttachedEvidencePanel entity="asset"> names its ids off the
            // entity, so the add form is `#add-asset-evidence-btn` →
            // `#asset-evidence-form`.
            await page.waitForSelector('#add-asset-evidence-btn', {
                timeout: 60000,
            });
            await page.click('#add-asset-evidence-btn');
            await page.waitForSelector('#asset-evidence-form', { timeout: 15000 });

            await page
                .locator('#asset-evidence-file')
                .setInputFiles(EVIDENCE_FIXTURE);
            await page.fill('#asset-evidence-title', ATTACHED_TITLE);
            await page.click('#submit-asset-evidence-btn');

            // The form closes on success and the panel refetches.
            await expect(page.locator('#asset-evidence-form')).not.toBeVisible({
                timeout: 30_000,
            });
            // Settle on EITHER branch first: EvidenceSubTable renders
            // #evidence-table only when rows.length > 0 and #no-evidence
            // otherwise. Waiting on the table alone turns a rejected
            // attach (AV scan / MIME reconcile / validation) into a bare
            // 30s "element not found" instead of a diagnosable failure.
            await page.waitForSelector('#evidence-table, #no-evidence', {
                timeout: 30_000,
            });
            await expect(page.locator('#evidence-table')).toBeVisible({
                timeout: 5_000,
            });
            await expect(page.locator('#evidence-table')).toContainText(
                ATTACHED_TITLE,
                { timeout: 15_000 },
            );
        });

        // ── E) Read the link back from a cold load ──
        await test.step('E — reload the asset and verify the attachment persisted', async () => {
            // Full navigation, not a client-side tab switch: the panel
            // re-fetches `/assets/:id/evidence/attached` from scratch, so
            // a row here proves the FK was persisted rather than only
            // reflected in post-mutation client state.
            await page.goto(`/t/${tenantSlug}/assets/${assetId}`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#tab-evidence', { timeout: 60000 });
            await page.click('#tab-evidence');

            // Settle on EITHER branch first: EvidenceSubTable renders
            // #evidence-table only when rows.length > 0 and #no-evidence
            // otherwise. Waiting on the table alone turns a rejected
            // attach (AV scan / MIME reconcile / validation) into a bare
            // 30s "element not found" instead of a diagnosable failure.
            await page.waitForSelector('#evidence-table, #no-evidence', {
                timeout: 30_000,
            });
            await expect(page.locator('#evidence-table')).toBeVisible({
                timeout: 5_000,
            });
            await expect(page.locator('#evidence-table')).toContainText(
                ATTACHED_TITLE,
                { timeout: 15_000 },
            );
            // The tenant-wide upload from step C was never attached to
            // this asset, so it must NOT appear on the asset's panel —
            // this is what makes the assertion above about the LINK
            // rather than about evidence existing in the tenant.
            await expect(page.locator('#evidence-table')).not.toContainText(
                EVIDENCE_TITLE,
            );
        });
    });
});
