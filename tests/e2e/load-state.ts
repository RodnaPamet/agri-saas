/**
 * The #2313 load-state probe, in its OWN module.
 *
 * Not in `e2e-utils` deliberately. That module imports `@/lib/prisma` for a
 * single helper, which pulls in `src/env.ts` and throws at import time without
 * a configured environment — so anything importing it needs a database to
 * LOAD, never mind to run. A probe that only reads the DOM should not, and its
 * positive control could not run at all while it did.
 *
 * Nothing here touches the network, the database or the app. Given a `Page`,
 * it reads that page.
 */
import { expect, type Page } from '@playwright/test';

/**
 * Why a page that loaded is not showing what a test waited for (#2313).
 *
 * The counterpart to `describeNavDelta`, for the failures that have no
 * navigation in them. `ciso-portfolio`'s ledgered case does a `safeGoto`
 * document load and then waits on two locators; when that times out,
 * Playwright says "locator not visible" and nothing else, which is why the
 * entry accumulated occurrences for weeks without a shape.
 *
 * The question this answers is which of three worlds the failure is in, and
 * they want different fixes:
 *
 *   1. **Never loaded** — `readyState` is not `complete`, or `responseEnd` is
 *      missing. A slow or failed document fetch.
 *   2. **Loaded, never hydrated** — the document is complete and the server
 *      markup is there, but React has not taken over. The element may exist
 *      and be inert, or a client-only branch may not have rendered it.
 *   3. **Loaded and hydrated, element genuinely absent** — then it is not a
 *      flake at all: the page really did render without it, and the cause is
 *      upstream (a role, a permission, an empty list).
 *
 * `present` vs `visible` is the discriminator between (2) and (3): a locator
 * that is in the DOM but not visible is a different failure from one that was
 * never rendered, and `toBeVisible` cannot tell them apart in its message.
 */
async function describeLoadState(page: Page, selectors: string[]): Promise<string> {
    try {
        const st = await page.evaluate((sels) => {
            const nav = performance.getEntriesByType('navigation')[0] as
                | PerformanceNavigationTiming
                | undefined;
            const round = (n: number | undefined) =>
                typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;
            return {
                url: window.location.pathname,
                readyState: document.readyState,
                navType: nav?.type ?? 'unknown',
                responseEndMs: round(nav?.responseEnd),
                domContentLoadedMs: round(nav?.domContentLoadedEventEnd),
                loadEventMs: round(nav?.loadEventEnd),
                // Hydration: Next streams its payload into these. Absent means
                // the client bundle never took over, which is world (2).
                hasNextData: !!document.querySelector('script#__NEXT_DATA__')
                    || !!document.querySelector('script[id^="__NEXT"]'),
                bodyChildren: document.body?.children.length ?? 0,
                h1: document.querySelector('h1')?.textContent?.trim().slice(0, 48) ?? null,
                found: sels.map((sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return `${sel}=ABSENT`;
                    const r = el.getBoundingClientRect();
                    const cs = window.getComputedStyle(el);
                    const visible =
                        r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'
                        && cs.display !== 'none';
                    return `${sel}=${visible ? 'visible' : 'PRESENT-but-hidden'}`;
                }),
            };
        }, selectors);
        return (
            `  url / h1          : ${st.url} / ${JSON.stringify(st.h1)}\n`
            + `  readyState        : ${st.readyState}   navType: ${st.navType}\n`
            + `  timing (ms)       : responseEnd ${st.responseEndMs}, DCL ${st.domContentLoadedMs},`
            + ` load ${st.loadEventMs}\n`
            + `  hydration payload : ${st.hasNextData ? 'present' : 'ABSENT'}`
            + `   <- ABSENT with a complete document is "loaded, never hydrated"\n`
            + `  body children     : ${st.bodyChildren}\n`
            + `  locators          : ${st.found.join('  |  ')}`
            + `   <- ABSENT vs PRESENT-but-hidden separates "never rendered" from "rendered, not shown"\n`
        );
    } catch (e) {
        return `  load state        : probe failed (${String(e)})\n`;
    }
}

/**
 * Await a locator, and on timeout re-throw with the page's load state attached.
 *
 * The assertion is unchanged — same locator, same timeout, same pass/fail. Only
 * the failure MESSAGE grows, which is the whole point: this spec's occurrences
 * have been unreadable, not wrong.
 */
export async function expectVisibleWithLoadState(
    page: Page,
    selector: string,
    opts: { timeout?: number; alsoReport?: string[] } = {},
): Promise<void> {
    try {
        await expect(page.locator(selector).first()).toBeVisible({
            timeout: opts.timeout ?? 30_000,
        });
    } catch (err) {
        const report = [selector, ...(opts.alsoReport ?? [])];
        throw new Error(
            `${(err as Error).message}\n`
                + `--- #2313 load diagnostics ---\n`
                + (await describeLoadState(page, report)),
        );
    }
}
