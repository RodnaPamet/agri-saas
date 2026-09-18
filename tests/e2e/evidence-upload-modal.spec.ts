/**
 * Epic 54 — Evidence upload + create-text modals.
 *
 * Verifies the modal-first evidence flow that replaces the old
 * inline `glass-card` forms on the Evidence list page. The Upload
 * modal POSTs FormData to `/evidence/uploads`; the Text modal POSTs
 * JSON to `/evidence`; both invalidate the React-Query cache so the
 * list repopulates on success.
 *
 * Isolation: each `test()` runs on its own fresh, empty tenant via
 * the `isolatedTenant` fixture. The two "submitting creates
 * evidence" tests write rows that, on an isolated tenant, cannot
 * pollute the shared seeded tenant.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { test, expect } from './fixtures';
import { safeGoto, waitForHydration } from './e2e-utils';

test.describe('Epic 54 — Evidence upload modal', () => {
    test('clicking Upload File opens the modal without navigating away', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/evidence`);
        await authedPage.waitForSelector('#add-evidence-btn', { timeout: 15000 });
        // HYDRATE, do not wait for the network. `networkidle` here was
        // swallowed (`.catch(() => {})`), so it could time out entirely
        // and the click still went ahead — and `waitFor({ state:
        // 'visible' })` proves the button is PAINTED, not that React has
        // attached its onClick. A click on a detached handler does
        // nothing and the test then waits for a dialog that never opens
        // (#748; the same shape cost #993 three retries on two PRs).
        await waitForHydration(authedPage, '#add-evidence-btn');
        const listUrl = authedPage.url();

        await authedPage.click('#add-evidence-btn');

        await expect(authedPage.locator('#upload-form')).toBeVisible({
            timeout: 10000,
        });
        expect(authedPage.url()).toBe(listUrl);

        await authedPage.click('#upload-evidence-cancel-btn');
        await expect(authedPage.locator('#upload-form')).toBeHidden({ timeout: 5000 });
    });

    test('submit is disabled until a file is attached', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/evidence`);
        await authedPage.reload({ waitUntil: 'domcontentloaded' });
        const openBtn = authedPage.locator('#add-evidence-btn').first();
        await openBtn.waitFor({ state: 'visible', timeout: 15_000 });
        // HYDRATE, do not wait for the network. `networkidle` here was
        // swallowed (`.catch(() => {})`), so it could time out entirely
        // and the click still went ahead — and `waitFor({ state:
        // 'visible' })` proves the button is PAINTED, not that React has
        // attached its onClick. A click on a detached handler does
        // nothing and the test then waits for a dialog that never opens
        // (#748; the same shape cost #993 three retries on two PRs).
        await waitForHydration(authedPage, '#add-evidence-btn');
        await openBtn.click();
        await expect(authedPage.locator('#upload-form')).toBeVisible({
            timeout: 60_000,
        });

        await expect(authedPage.locator('#submit-upload-btn')).toBeDisabled();

        await authedPage.click('#upload-evidence-cancel-btn');
        await expect(authedPage.locator('#upload-form')).toBeHidden({ timeout: 5000 });
    });

    test('attaching a file and submitting POSTs to /evidence/uploads', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/evidence`);
        await authedPage.reload({ waitUntil: 'domcontentloaded' });
        const openBtn = authedPage.locator('#add-evidence-btn').first();
        await openBtn.waitFor({ state: 'visible', timeout: 15_000 });
        // HYDRATE, do not wait for the network. `networkidle` here was
        // swallowed (`.catch(() => {})`), so it could time out entirely
        // and the click still went ahead — and `waitFor({ state:
        // 'visible' })` proves the button is PAINTED, not that React has
        // attached its onClick. A click on a detached handler does
        // nothing and the test then waits for a dialog that never opens
        // (#748; the same shape cost #993 three retries on two PRs).
        await waitForHydration(authedPage, '#add-evidence-btn');
        await openBtn.click();
        await expect(authedPage.locator('#upload-form')).toBeVisible({
            timeout: 60_000,
        });

        const uid = Date.now().toString(36);
        const filename = `modal-evidence-${uid}.txt`;
        const payload = Buffer.from(`Epic 54 evidence upload ${uid}\n`);

        await authedPage.setInputFiles('#file-input', {
            name: filename,
            mimeType: 'text/plain',
            buffer: payload,
        });
        await authedPage.fill('#upload-title-input', `Modal Evidence ${uid}`);

        await expect(authedPage.locator('#submit-upload-btn')).toBeEnabled();

        const [response] = await Promise.all([
            authedPage.waitForResponse(
                (r) =>
                    r.url().includes('/api/t/') &&
                    r.url().includes('/evidence/uploads') &&
                    r.request().method() === 'POST',
            ),
            authedPage.click('#submit-upload-btn'),
        ]);
        expect(
            response.status(),
            'POST /evidence/uploads succeeded',
        ).toBeLessThan(400);

        await expect(authedPage.locator('#upload-form')).toBeHidden({
            timeout: 10000,
        });
        await expect(authedPage.locator('#evidence-table')).toContainText(
            `Modal Evidence ${uid}`,
            { timeout: 15000 },
        );
    });

    test('Cancel closes the modal and leaves the list untouched', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/evidence`);
        await authedPage.reload({ waitUntil: 'domcontentloaded' });
        const openBtn = authedPage.locator('#add-evidence-btn').first();
        await openBtn.waitFor({ state: 'visible', timeout: 15_000 });
        // HYDRATE, do not wait for the network. `networkidle` here was
        // swallowed (`.catch(() => {})`), so it could time out entirely
        // and the click still went ahead — and `waitFor({ state:
        // 'visible' })` proves the button is PAINTED, not that React has
        // attached its onClick. A click on a detached handler does
        // nothing and the test then waits for a dialog that never opens
        // (#748; the same shape cost #993 three retries on two PRs).
        await waitForHydration(authedPage, '#add-evidence-btn');
        await openBtn.click();
        await expect(authedPage.locator('#upload-form')).toBeVisible({
            timeout: 60_000,
        });

        await authedPage.click('#upload-evidence-cancel-btn');

        await expect(authedPage.locator('#upload-form')).toBeHidden({ timeout: 5000 });
        await expect(authedPage.locator('#evidence-table')).toBeVisible();
    });
});

