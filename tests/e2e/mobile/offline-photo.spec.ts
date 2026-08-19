/**
 * Mobile offline journal photo — queue the BYTES, upload on reconnect (@mobile).
 *
 * ISOLATED / MUTATING tenant (e2e-isolation convention). Seeds its OWN
 * journal entry via the authenticated API.
 *
 * Proves the Roadmap-6 P2 contract at a phone viewport: an operator attaches a
 * field photo with NO signal — the downscaled BYTES are queued in the outbox
 * (IndexedDB), not lost to a dead blob: preview — and on reconnect the photo
 * uploads EXACTLY ONCE (the per-item idempotency key dedupes any replay).
 *
 *   1. Open the entry's Photos tab online (SW registers).
 *   2. Go OFFLINE. Pick a photo → the sync bar shows it queued (no upload yet).
 *   3. Go back ONLINE → the queue flushes; the photo attaches once and appears
 *      in the list. A single LogEntryFile row = exactly-once.
 *
 * Runs under the mobile device matrix. retries:0 + a per-test cap keep it
 * fast + cheap.
 */
import { test, expect } from '../fixtures';

// A minimal valid 1x1 PNG — small enough to pass downscale untouched, real
// enough for createImageBitmap to decode in the browser.
const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64',
);

test.describe('mobile offline journal photo @mobile', () => {
    test.describe.configure({ retries: 0 });

    test('capture offline → uploads exactly once on reconnect', async ({ authedPage, isolatedTenant }) => {
        test.setTimeout(120_000);
        const page = authedPage;
        const slug = isolatedTenant.tenantSlug;
        const api = page.request; // cookie-authenticated after signInAs

        // ── Seed a journal entry ─────────────────────────────────────────
        const entryRes = await api.post(`/api/t/${slug}/journal`, {
            data: { type: 'OBSERVATION', title: 'Leaf spot check' },
        });
        expect(entryRes.ok(), `create entry: ${entryRes.status()}`).toBeTruthy();
        const entryId = (await entryRes.json()).id as string;

        // Count the actual multipart uploads that hit the server.
        let uploadPosts = 0;
        page.on('request', (req) => {
            if (req.method() === 'POST' && req.url().includes(`/journal/${entryId}/files`)) uploadPosts += 1;
        });

        // ── Open the Photos tab online (registers the service worker) ────
        await page.goto(`/t/${slug}/journal/${entryId}`);
        await page.evaluate(async () => {
            if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
        });
        const main = page.getByRole('main');
        await main.getByRole('tab', { name: 'Photos' }).click();
        await expect(main.locator('#journal-photos')).toBeVisible({ timeout: 15_000 });

        // ── Go OFFLINE, then attach a photo — it must QUEUE, not upload ──
        await page.context().setOffline(true);

        await main.locator('input[accept="image/*,application/pdf"]').setInputFiles({
            name: 'leaf.png',
            mimeType: 'image/png',
            buffer: PNG_1x1,
        });

        // The sync bar surfaces the queued photo distinctly.
        await expect(main.getByTestId('offline-pending-photos')).toHaveText('1 photo saved on this phone', { timeout: 15_000 });
        expect(uploadPosts, 'no upload while offline').toBe(0);

        // ── Reconnect → the queue flushes and the photo attaches once ────
        await page.context().setOffline(false);
        // Nudge the flush (the online-event handler also fires this).
        await page.evaluate(() => window.dispatchEvent(new Event('online')));

        // The photo appears in the list (live-refresh on drain).
        await expect(main.getByText('leaf.png').first()).toBeVisible({ timeout: 30_000 });
        // Queued indicator clears.
        await expect(main.getByTestId('offline-pending-photos')).toHaveCount(0);

        // Exactly-once: only ONE LogEntryFile row exists for this entry.
        const listRes = await api.get(`/api/t/${slug}/journal/${entryId}`);
        expect(listRes.ok()).toBeTruthy();
        const files = ((await listRes.json()).files ?? []) as unknown[];
        expect(files.length, 'exactly one attached photo').toBe(1);
    });
});
