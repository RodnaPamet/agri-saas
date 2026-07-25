/**
 * Mobile forms — FAB launches the create flow (@mobile).
 *
 * READ-ONLY (shared seeded tenant). On a phone viewport (mobile-android /
 * mobile-iphone, both < md) the page header's "+" is augmented by a
 * floating action button (FAB) for the primary create flow. Proves:
 *   1. The FAB is visible on a key list page (md:hidden → shown < md).
 *   2. Tapping it launches the create flow as a bottom drawer (the <Modal>
 *      primitive renders a Vaul drawer on mobile) with the pinned footer's
 *      primary action reachable — i.e. Save isn't buried.
 *
 * The farm-tasks queue is the exception: its FAB jumps to the field map, so
 * its create-drawer + reachable-Save contract is exercised from the header
 * "Task" button (which stays visible at phone width) instead of the FAB.
 *
 * The keyboard-aware footer + the drag/dirty-guard are unit/rendered-tested
 * (hard to drive a soft keyboard in Playwright); this covers the launch +
 * reachable-Save contract end-to-end.
 */
import { test, expect } from '@playwright/test';
import { safeGoto, loginAndGetTenant } from '../e2e-utils';

test.describe('mobile forms — FAB launches create @mobile', () => {
    let tenantSlug: string;

    test.beforeEach(async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
    });

    test('the Tasks create button opens the create drawer with a reachable Save', async ({
        page,
    }) => {
        await safeGoto(page, `/t/${tenantSlug}/farm-tasks`);
        const main = page.getByRole('main');
        await expect(
            main.getByRole('heading', { name: 'Tasks', level: 1 }),
        ).toBeVisible({ timeout: 30_000 });

        // The farm-tasks FAB is repurposed to jump to the field map, so the
        // create flow is launched from the header "Task" button (visible at
        // phone width — the page-header action cluster is not md:hidden).
        const createBtn = main.locator('#new-farm-task-btn');
        await expect(createBtn).toBeVisible({ timeout: 30_000 });

        // Tap it → the create modal opens as a bottom drawer (role=dialog).
        await createBtn.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: 15_000 });

        // The pinned footer's primary action is present + reachable — Save
        // is never buried even before scrolling the form.
        await expect(
            dialog.getByRole('button', { name: 'Create task' }),
        ).toBeVisible({ timeout: 15_000 });
    });

    // Roadmap-6 P4 — the FAB rollout. The mobile create-in-thumb-zone
    // pattern now covers the remaining standard entity list pages
    // (locations / inventory / planning / exchange), not just the three
    // original surfaces. Each page mounts the SAME <Fab> primitive that
    // opens the page's primary create flow as a bottom drawer (role=dialog).
    const FAB_PAGES = ['locations', 'inventory', 'planning', 'exchange'] as const;

    for (const slug of FAB_PAGES) {
        test(`the ${slug} FAB opens the create flow as a drawer`, async ({
            page,
        }) => {
            await safeGoto(page, `/t/${tenantSlug}/${slug}`);

            // The mobile FAB is shown (md:hidden → visible at phone width).
            const fab = page.getByTestId('fab');
            await expect(fab).toBeVisible({ timeout: 30_000 });

            // ≥44px thumb target (the FAB is a 56px circle — well over floor).
            const fabBox = await fab.boundingBox();
            expect(fabBox, `${slug} FAB has a measurable box`).not.toBeNull();
            expect(
                fabBox!.height,
                `${slug} FAB is a ≥44px touch target`,
            ).toBeGreaterThanOrEqual(44);

            // Tap it → the primary create flow opens as a bottom drawer.
            await fab.click();
            await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
        });
    }

    test('primary md targets meet the 44px thumb floor on mobile', async ({
        page,
    }) => {
        // (1) A DEFAULT-size (md) header Button — the crop-plan "Plan"
        //     create button carries a stable id. On mobile the button-
        //     variants `md` size floors at min-h-[44px]; desktop stays h-9.
        await safeGoto(page, `/t/${tenantSlug}/planning`);
        const planBtn = page.getByRole('main').locator('#new-crop-plan-btn');
        await expect(planBtn).toBeVisible({ timeout: 30_000 });
        const planBox = await planBtn.boundingBox();
        expect(planBox, 'plan button has a measurable box').not.toBeNull();
        expect(
            planBox!.height,
            'default md Button floors at 44px on mobile',
        ).toBeGreaterThanOrEqual(44);

        // (2) A DEFAULT-size (md) Input — the locations create form's Name
        //     field. Same responsive floor as the Button (R20-PR-A parity).
        await safeGoto(page, `/t/${tenantSlug}/locations`);
        await page.getByTestId('fab').click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: 15_000 });
        const nameInput = dialog.getByRole('textbox').first();
        await expect(nameInput).toBeVisible({ timeout: 15_000 });
        const inputBox = await nameInput.boundingBox();
        expect(inputBox, 'name input has a measurable box').not.toBeNull();
        expect(
            inputBox!.height,
            'default md Input floors at 44px on mobile',
        ).toBeGreaterThanOrEqual(44);
    });
});
