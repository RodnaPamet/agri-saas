/**
 * @mobile — offline journal-entry create (the manifest promise: "log work,
 * online or off").
 *
 * A field operator authors a journal entry with no signal: the create is
 * enqueued in the outbox (OfflineSyncBar shows it "queued"), and on reconnect
 * the service worker replays it — carrying its outbox id as the Idempotency-Key
 * so the server dedupes the delivery. The regression class: a journal note
 * silently dropped offline, or delivered twice on a flaky reconnect.
 *
 * Mutating spec → isolated empty tenant.
 */
import { test, expect } from './fixtures';

test('@mobile journal entry created offline queues and delivers exactly once', async ({ authedPage, isolatedTenant }) => {
    const slug = isolatedTenant.tenantSlug;
    const api = authedPage.request;
    const title = `Scouted aphids ${Date.now()}`;

    await authedPage.goto(`/t/${slug}/journal`);
    await expect(authedPage.getByText('No journal entries yet')).toBeVisible();

    // Open the create modal WHILE ONLINE so its lazy chunk + catalog fetches
    // land — then we cut the network before submitting.
    await authedPage.getByRole('button', { name: 'Add entry' }).click();
    await expect(authedPage.locator('#journal-entry-title')).toBeVisible();

    // Go offline and log the entry (title-only — no signal needed).
    await authedPage.context().setOffline(true);
    await authedPage.locator('#journal-entry-title').fill(title);
    await authedPage.locator('#journal-entry-submit').click();

    // The modal closes; the outbox holds it and the sync bar shows it queued.
    await expect(authedPage.locator('#journal-entry-title')).toBeHidden();
    await expect(authedPage.getByText('Offline', { exact: true })).toBeVisible();
    await expect(authedPage.getByTestId('offline-pending-count')).toHaveText('1 change saved on this phone');
    // The optimistic row shows the just-logged entry immediately.
    await expect(authedPage.getByText(title)).toBeVisible();

    // Reconnect → the outbox drains; the queue clears.
    await authedPage.context().setOffline(false);
    await expect(authedPage.getByTestId('offline-pending-count')).toBeHidden({ timeout: 20_000 });

    // Server truth: the entry was delivered EXACTLY ONCE (no duplicate row).
    await expect
        .poll(async () => {
            const entries = (await (await api.get(`/api/t/${slug}/journal`)).json()) as Array<{ title: string }>;
            return entries.filter((e) => e.title === title).length;
        }, { timeout: 20_000 })
        .toBe(1);
});
