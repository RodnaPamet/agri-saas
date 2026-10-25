/**
 * A positive control for the #2313 load-state probe.
 *
 * `expectVisibleWithLoadState` only runs its diagnostic on a TIMEOUT, so on a
 * green suite it never executes. An instrument that has never produced output
 * is an instrument nobody has checked — and the failure mode is silent: the
 * next occurrence of `ciso-portfolio`'s flake would print a broken dump, or
 * none, and look exactly like the unreadable occurrences this replaces.
 *
 * So the failure is MANUFACTURED here, on a page this test builds itself. No
 * app, no login, no seed — a `data:` URL whose DOM is known, so the assertions
 * below are about the probe and nothing else.
 */
import { test, expect } from '@playwright/test';
import { expectVisibleWithLoadState } from './e2e-utils';

const PAGE = `data:text/html,<html><body><h1>Probe fixture</h1>`
    + `<div id="present-but-hidden" style="display:none">x</div>`
    + `<div id="shown">y</div></body></html>`;

test.describe('#2313 load-state probe', () => {
    test('a timeout carries the page state, and tells ABSENT from PRESENT-but-hidden', async ({
        page,
    }) => {
        await page.goto(PAGE);

        let message = '';
        try {
            // Never appears, so the probe runs. A short timeout: this test is
            // about the diagnostic, not about waiting.
            await expectVisibleWithLoadState(page, '#never-appears', {
                timeout: 1_000,
                alsoReport: ['#present-but-hidden', '#shown'],
            });
            throw new Error('expected the wait to time out');
        } catch (err) {
            message = (err as Error).message;
        }

        // It fired at all.
        expect(message).toContain('#2313 load diagnostics');
        // And carries the three facts that separate the worlds the issue names.
        expect(message).toContain('readyState');
        expect(message).toContain('hydration payload');
        expect(message).toMatch(/timing \(ms\)/);

        // The discriminator that `toBeVisible` cannot express: a locator that
        // was never rendered reads differently from one that is in the DOM and
        // not shown. If these ever collapse to the same string, the probe has
        // stopped answering the question it exists for.
        expect(message).toContain('#never-appears=ABSENT');
        expect(message).toContain('#present-but-hidden=PRESENT-but-hidden');
        expect(message).toContain('#shown=visible');
    });

    test('the probe does not change a passing assertion', async ({ page }) => {
        // The guarantee that let this be added to a flaky spec at all: same
        // locator, same timeout, same pass. Only a failure message grows.
        await page.goto(PAGE);
        await expect(
            expectVisibleWithLoadState(page, '#shown', { timeout: 5_000 }),
        ).resolves.toBeUndefined();
    });
});
