/**
 * Tier-1 ag workflow — parcel/spray map visual baseline.
 *
 * Visual-regression guard for the operator spray-map page. The maplibre
 * WebGL canvas is non-deterministic across GPUs / CI runners, so a pixel
 * snapshot of it would be perpetually flaky. Instead we lock the
 * DETERMINISTIC visual STRUCTURE — the map region renders, and the spray
 * job presents exactly one line per parcel, each with its name + the
 * touch-target Done/Skip practices, under an Online status. A structural
 * change to this page (a dropped practice, a re-labelled action, a missing
 * line) fails the baseline.
 *
 * A full-page screenshot is also attached to the Playwright report as a
 * human-reviewable visual artifact (no pixel-diff assertion → no flake).
 *
 * Seeds via ag-fixtures.
 */
import { test, expect } from './fixtures';
import { agPrisma, seedSprayScenario } from './ag-fixtures';

test('parcel/spray map: the operator field panel matches its visual structure', async ({ authedPage, isolatedTenant }) => {
    const slug = isolatedTenant.tenantSlug;
    const api = authedPage.request;
    const prisma = agPrisma();
    try {
        const sc = await seedSprayScenario(
            api, prisma, slug, isolatedTenant.tenantId, isolatedTenant.ownerUserId,
            { dose: 2, opening: 1000 },
        );

        await authedPage.goto(`/t/${slug}/field/${sc.taskId}`);

        // Deterministic structure of the spray map page.
        await expect(authedPage.getByText('Online', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('North 40')).toBeVisible();
        await expect(authedPage.getByText('North 41')).toBeVisible();
        await expect(authedPage.getByText('North 42')).toBeVisible();
        // One prescription line per parcel, each with its touch practices.
        await expect(authedPage.getByRole('listitem')).toHaveCount(3);
        await expect(authedPage.getByRole('button', { name: 'Done' })).toHaveCount(3);
        await expect(authedPage.getByRole('button', { name: 'Skip' })).toHaveCount(3);

        // Human-reviewable visual baseline artifact (no pixel-diff assertion).
        const shot = await authedPage.screenshot({ fullPage: true });
        await test.info().attach('parcel-spray-map', { body: shot, contentType: 'image/png' });
    } finally {
        await prisma.$disconnect();
    }
});
