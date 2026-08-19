/**
 * @mobile — offline optimistic-lock conflict resolution.
 *
 * A mark queued offline replays after a supervisor changed the job. The server
 * rejects the stale write (409 STALE_DATA) instead of clobbering, the outbox
 * parks it, and the field panel surfaces a keep-mine / take-server moment. The
 * regression class: a stale queued edit silently overwriting newer server
 * state with no one told.
 *
 * Mutating spec → isolated empty tenant; seeds via ag-fixtures.
 */
import { test, expect } from './fixtures';
import { agPrisma, seedSprayScenario } from './ag-fixtures';

test('@mobile a stale offline mark surfaces the conflict resolver', async ({ authedPage, isolatedTenant }) => {
    const slug = isolatedTenant.tenantSlug;
    const api = authedPage.request;
    const prisma = agPrisma();
    try {
        const sc = await seedSprayScenario(
            api, prisma, slug, isolatedTenant.tenantId, isolatedTenant.ownerUserId,
            { dose: 1, opening: 1000 },
        );

        await authedPage.goto(`/t/${slug}/field/${sc.taskId}`);
        await expect(authedPage.getByRole('button', { name: 'Done' }).first()).toBeVisible({ timeout: 30_000 });

        // The first line (createdAt asc → matches the first Done button).
        const op = await (await api.get(`/api/t/${slug}/field-operations/${sc.taskId}`)).json();
        const lineId = op.lines[0].id as string;

        // A supervisor changes that line on the server (version 0 → 1). The page
        // still holds the version it loaded — no revalidation is triggered.
        const patch = await api.patch(
            `/api/t/${slug}/field-operations/${sc.taskId}/parcels/${lineId}`,
            { data: { status: 'SKIPPED' } },
        );
        expect(patch.ok()).toBeTruthy();

        // Offline: mark the same line Done — queued at the now-stale version.
        await authedPage.context().setOffline(true);
        await authedPage.getByRole('button', { name: 'Done' }).first().click();
        await expect(authedPage.getByTestId('offline-pending-count')).toHaveText('1 change saved on this phone');

        // Reconnect → the replay 409s → the conflict resolver appears (NOT a
        // silent clobber).
        await authedPage.context().setOffline(false);
        await expect(
            authedPage.getByText('This job changed while you were offline'),
        ).toBeVisible({ timeout: 20_000 });

        // Resolve by taking the server's state → the banner clears.
        await authedPage.getByRole('button', { name: 'Use server' }).click();
        await expect(
            authedPage.getByText('This job changed while you were offline'),
        ).toBeHidden({ timeout: 20_000 });

        // Server truth is the supervisor's SKIPPED — the stale DONE never won.
        const after = await (await api.get(`/api/t/${slug}/field-operations/${sc.taskId}`)).json();
        const line = (after.lines as Array<{ id: string; status: string }>).find((l) => l.id === lineId);
        expect(line?.status).toBe('SKIPPED');
    } finally {
        await prisma.$disconnect();
    }
});
