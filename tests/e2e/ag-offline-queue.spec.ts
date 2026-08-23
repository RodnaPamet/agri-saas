/**
 * Tier-1 ag workflow — offline outbox QUEUE DEPTH + batch flush.
 *
 * Distinct from offline-field-sync.spec.ts (which proves a single
 * mark→queue→sync round-trip): this proves the outbox holds MULTIPLE
 * queued mutations while offline (depth = 3), survives the offline
 * window, and flushes ALL of them on reconnect — after which server
 * truth shows every line DONE and the ledger deducted for each. The
 * regression class: a lost or mis-ordered queued mark = a silently
 * dropped spray record + wrong stock.
 *
 * Mutating spec → isolated empty tenant; seeds via ag-fixtures.
 */
import { test, expect } from './fixtures';
import { agPrisma, seedSprayScenario } from './ag-fixtures';
import { waitForFieldMapWarm } from './e2e-utils';

test('offline queue: three marks queue offline and all flush on reconnect', async ({ authedPage, isolatedTenant }) => {
    const slug = isolatedTenant.tenantSlug;
    const api = authedPage.request;
    const prisma = agPrisma();
    try {
        const sc = await seedSprayScenario(
            api, prisma, slug, isolatedTenant.tenantId, isolatedTenant.ownerUserId,
            { dose: 1, opening: 1000 },
        );

        await authedPage.goto(`/t/${slug}/field/${sc.taskId}`);
        await expect(authedPage.getByText('North 40')).toBeVisible();
        await expect(authedPage.getByRole('button', { name: 'Done' })).toHaveCount(3);

        // The map is lazily imported and sits above these controls, so a
        // visible Done button does not mean its chunk landed (#732).
        await waitForFieldMapWarm(authedPage);

        // Go offline; mark all three lines Done. Each click flips its line
        // DONE optimistically (its Done button disappears) and enqueues a
        // PATCH — the queue depth climbs to 3 with no network.
        await authedPage.context().setOffline(true);
        await expect(authedPage.getByText('Offline', { exact: true })).toBeVisible();
        for (let remaining = 3; remaining > 0; remaining--) {
            await authedPage.getByRole('button', { name: 'Done' }).first().click();
            await expect(authedPage.getByRole('button', { name: 'Done' })).toHaveCount(remaining - 1);
        }
        await expect(authedPage.getByTestId('offline-pending-count')).toHaveText('3 changes saved on this phone');

        // Reconnect → the outbox drains all three; the queue clears.
        await authedPage.context().setOffline(false);
        await expect(authedPage.getByTestId('offline-pending-count')).toBeHidden({ timeout: 20_000 });

        // Server truth: every line DONE + the lot deducted for each spray.
        const op = await (await api.get(`/api/t/${slug}/field-operations/${sc.taskId}`)).json();
        expect(op.progress.done).toBe(3);
        const lot = await (await api.get(`/api/t/${slug}/inventory/lots/${sc.lotId}`)).json();
        expect(lot.quantityOnHand).toBeLessThan(1000);
        const consumptions = (lot.ledger as Array<{ type: string }>).filter((t) => t.type === 'CONSUMPTION');
        expect(consumptions.length).toBe(3);
    } finally {
        await prisma.$disconnect();
    }
});
