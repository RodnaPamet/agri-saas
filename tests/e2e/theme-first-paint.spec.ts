/**
 * The chosen theme is on the page at FIRST PAINT, not after an effect (P2.4).
 *
 * READ-ONLY spec — navigates the unauthenticated `/login` page. No tenant, no
 * fixtures.
 *
 * ## The defect this spec exists to catch
 *
 * `layout.tsx` used to hard-code `data-theme="dark"` and let `ThemeProvider`
 * correct it from `localStorage` inside a `useEffect`. An effect runs after the
 * first paint, so every `light` / `sunlight` user saw the dark palette render
 * and then flip. That is not a race that sometimes loses — it loses every time,
 * and no amount of client-side cleverness fixes it, because the server cannot
 * read `localStorage`. The fix is two halves, and this spec pins each one
 * separately because they cover different visits:
 *
 *   - a **cookie** the server reads, which covers every visit after the first;
 *   - an **inline `<head>` script**, which covers the first visit, where only
 *     the browser knows `prefers-color-scheme`.
 *
 * Either half alone leaves a real flash, so neither test below is redundant.
 *
 * ## Why 4x CPU throttling
 *
 * On an unthrottled desktop runner, hydration lands so close to the first paint
 * that "the effect corrected it" and "the server got it right" produce almost
 * the same observation — the test would pass on the broken implementation about
 * as often as not. Throttling stretches the gap between parse and hydration,
 * which is exactly the gap a real phone has. It makes the two worlds separable.
 *
 * ## How "before the first paint" is established, and why NOT by clock
 *
 * The obvious measurement is to timestamp each attribute change and compare it
 * to the `first-contentful-paint` entry. Two problems: `MutationObserver`
 * callbacks are microtask-queued, so the timestamp is when the CALLBACK ran,
 * not when the attribute changed; and FCP is itself a reported value with its
 * own quantisation. Both are small, but they make the central assertion a
 * comparison of two fuzzy numbers.
 *
 * `document.readyState` is exact and needs no clock. A `setAttribute` observed
 * while the state is still `'loading'` happened during head parsing — before
 * the body element exists, therefore before any content could be painted. That
 * is a structural argument rather than a measured margin, so it is the primary
 * assertion; the FCP comparison is kept alongside as corroboration and is
 * reported in the failure message.
 *
 * ## The record shapes that make this observable at all
 *
 * An attribute present in the HTML SOURCE when the element is parsed produces
 * NO `attributes` mutation record — it arrives as part of the `childList`
 * record that adds `<html>`. An attribute changed by script produces an
 * `attributes` record. So the two halves of the fix are distinguishable by
 * record TYPE, with no timing involved:
 *
 *   - server got it right  -> childList carries the final value, zero
 *                             `attributes` records
 *   - script corrected it  -> childList carries the default, exactly one
 *                             `attributes` record, during `'loading'`
 *
 * This is also why the cookie test can assert ZERO attribute mutations, which
 * is a much stronger statement than "it ended up correct".
 */
import { test, expect, type Page } from '@playwright/test';
import { safeGoto } from './e2e-utils';

/** Must match `THEME_COOKIE` in `@/lib/theme/theme-cookie`. */
const THEME_COOKIE = 'agrent_theme';

type ThemeLog = {
    /** `<html>`'s attributes as the parser created it — i.e. what the SERVER sent. */
    initial: { theme: string | null; contrast: string | null } | null;
    /** Script-driven changes only. Each one is a potential flash. */
    mutations: {
        attr: string | null;
        to: string | null;
        readyState: string;
        t: number;
    }[];
    fcp: number | null;
    bgPage: string;
};

/**
 * Install the recorder before any page script, and throttle the CPU.
 *
 * The init script runs at document creation, when `document.documentElement`
 * usually does not exist yet — so the observer watches `document` and picks
 * `<html>` up out of the childList record. The `documentElement` branch covers
 * the case where it is already there, because which of the two happens is a
 * detail of the driver rather than something this spec should depend on.
 */
async function recordFirstPaint(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    await page.addInitScript(() => {
        const log: ThemeLog = {
            initial: null,
            mutations: [],
            fcp: null,
            bgPage: '',
        };
        (window as unknown as { __themeLog: ThemeLog }).__themeLog = log;

        const snapshot = (el: Element) => ({
            theme: el.getAttribute('data-theme'),
            contrast: el.getAttribute('data-contrast'),
        });

        if (document.documentElement) log.initial = snapshot(document.documentElement);

        new MutationObserver((records) => {
            for (const r of records) {
                if (r.type === 'childList') {
                    for (const n of Array.from(r.addedNodes)) {
                        if (n.nodeName === 'HTML' && log.initial === null) {
                            log.initial = snapshot(n as Element);
                        }
                    }
                } else if (r.type === 'attributes' && r.target === document.documentElement) {
                    log.mutations.push({
                        attr: r.attributeName,
                        to: document.documentElement.getAttribute(r.attributeName ?? ''),
                        // Exact, unlike a clock. See the docblock.
                        readyState: document.readyState,
                        t: performance.now(),
                    });
                }
            }
        }).observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-theme', 'data-contrast'],
        });

        new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                if (e.name === 'first-contentful-paint' && log.fcp === null) {
                    log.fcp = e.startTime;
                }
            }
        }).observe({ type: 'paint', buffered: true });
    });
}

/**
 * Read the recorder, plus the palette the attributes actually selected.
 *
 * WAITS for the paint observer to have reported before reading (#1329). The
 * recorder installs a `PerformanceObserver` and this read used to take
 * whatever `log.fcp` held at the moment it ran — but an observer callback is a
 * TASK, so even with `buffered: true` delivering an already-recorded entry,
 * the read can beat the callback. `log.fcp` was then `null` and
 * `expect(log.fcp).not.toBeNull()` failed on a page that had painted
 * perfectly well.
 *
 * That is the whole of #1329, and it is a race in the TEST, not slowness in
 * the product. The ledger entry called it "FIRST PAINT never reported", which
 * is what losing the race looks like from the assertion's side.
 *
 * #1570 gave the spec its retries back on the reasoning that a retry absorbs
 * a flaky instrument. That was right as far as it went — the ledger can now
 * classify it — but it treated the symptom: on #1604 the spec lost the race
 * three times in a row and took the shard down anyway, which a retry cannot
 * fix because each attempt runs the same race.
 *
 * Waiting is the actual remedy: it converts "read once and hope the callback
 * has run" into "read once the instrument has reported". A page that genuinely
 * never paints now fails on the wait with a message saying so, rather than on
 * a null three screens later.
 */
async function readLog(
    page: Page,
    opts: { waitForPaint?: boolean } = {},
): Promise<ThemeLog> {
    // OPT-IN, and scoped to the reads whose assertions depend on `fcp`.
    //
    // My first version waited unconditionally and broke the SECOND read in the
    // first-visit test: `expect(after.mutations…).toHaveLength(1)` got 0. That
    // assertion had never run before — the `fcp` race killed the test on an
    // earlier line — so waiting UNMASKED it rather than merely breaking it,
    // and the spec had two problems hiding behind one failure.
    //
    // The likely mechanism: `recordFirstPaint` installs via `addInitScript`,
    // which re-runs on EVERY navigation, so `__themeLog` is fresh after any
    // re-navigation — mutations empty, `fcp` set again. Waiting for paint in
    // the second read gives a new document time to paint and lands the read on
    // the reset log.
    //
    // I have NOT proven that; it needs a browser to confirm. So the fix is
    // SCOPED rather than built on the guess: only reads that assert `fcp` opt
    // in, and the second read behaves exactly as it did before. That is
    // correct whether or not the explanation above is right, which is the
    // property worth having while the mechanism is still a hypothesis.
    if (opts.waitForPaint) {
        // Bounded, so a page that truly never paints fails loudly rather than
        // hanging to the suite timeout.
        await page.waitForFunction(
            () => (window as unknown as { __themeLog?: ThemeLog }).__themeLog?.fcp != null,
            undefined,
            { timeout: 10_000 },
        );
    }
    // ── A navigation makes this unanswerable; say so, never guess ────────
    //
    // #1621 made this read survive a navigation by waiting for `load` and
    // re-reading. The reasoning given was that the property is
    // document-independent. **It is not.** The first document persists the
    // theme choice, so a reloaded document is served the correct theme and
    // needs no correction — `0` mutations, which is right for that document and
    // wrong for the question being asked. That turned a crash into a confident
    // wrong answer.
    //
    // The cause is removed above (`serviceWorkers: 'block'`), so this should
    // not fire. It stays because a destroyed context here must never again be
    // papered over: if some other navigation appears, the failure should name
    // it rather than resurface as an inexplicable `toHaveLength(0)` three
    // screens later.
    const read = () =>
        page.evaluate(() => {
            const log = (window as unknown as { __themeLog: ThemeLog }).__themeLog;
            log.bgPage = getComputedStyle(document.documentElement)
                .getPropertyValue('--bg-page')
                .trim();
            return log;
        });

    try {
        return await read();
    } catch (err) {
        if (!/Execution context was destroyed/i.test(String(err))) throw err;
        throw new Error(
            'The page navigated while reading __themeLog, so this assertion cannot be ' +
                'evaluated: `addInitScript` re-runs on the new document and its log starts ' +
                'empty, and the first document has already persisted the theme — so the ' +
                'reloaded one needs no correction and reads 0 mutations legitimately. ' +
                'Do NOT re-read the new document (that was #1621 and it produced a wrong ' +
                'answer). Find what navigated. The known cause is the service worker: ' +
                '`ServiceWorkerRegistrar` reloads on `controllerchange`, which ' +
                '`clients.claim()` fires on a first visit — blocked for this spec. ' +
                `Original error: ${String(err)}`,
        );
    }
}

test.describe('theme reaches the first paint', () => {
    // ── The service worker RELOADS the page mid-test (#1329) ─────────────
    //
    // Found in the code, not guessed. `ServiceWorkerRegistrar` is mounted in
    // the ROOT layout, so it runs on `/login` like everywhere else. It listens
    // for `controllerchange` and calls `window.location.reload()`. On a FIRST
    // VISIT there is no worker yet, so `public/sw.js` installs, activates and
    // calls `self.clients.claim()` — which fires `controllerchange` on this
    // page — and the registrar reloads it.
    //
    // That is the navigation these tests kept losing to, and it explains why it
    // was intermittent in exactly this spec: `recordFirstPaint` throttles the
    // CPU 4x, so whether the worker finishes activating before the two reads
    // complete is a race this spec is uniquely slow at.
    //
    // It cost two wrong fixes. #1610 saw `expect(log.fcp).not.toBeNull()` fail
    // and waited for the paint observer — right about the observer, and it then
    // unmasked the second read. #1621 saw `Execution context was destroyed` and
    // made the read survive a navigation by re-reading the NEW document, on the
    // stated reasoning that the property was document-independent. It is NOT:
    // the first document persists the theme choice, so the reloaded document
    // gets the right theme from the server and needs NO correction — `0`
    // mutations, which is correct for that document and wrong for the question.
    // So #1621 turned a crash into a confident wrong answer, which is worse.
    //
    // Blocking the worker removes the cause rather than coping with it. These
    // tests are about whether the THEME reaches the first paint; the worker is
    // irrelevant to that and was corrupting the measurement. The PWA's own
    // behaviour is covered by the offline specs, which is where it belongs.
    test.use({ serviceWorkers: 'block' });


    // RETRIES ARE ON, deliberately, and this comment is why — the opposite of
    // what used to be here (#1570).
    //
    // `test.describe.configure({ retries: 0 })` sat here with no explanation.
    // The three tests below load a page and read `PerformanceObserver` paint
    // entries: no writes, no outbox, no fixtures (note the import is
    // `@playwright/test`, not `./fixtures`). So a retry cannot leave anything
    // half-done, which is the only reason the offline and mobile specs turn
    // retries off — a retry after a delivered outbox item cannot restore the
    // pre-delivery state, and would hide a real exactly-once defect.
    //
    // What the opt-out actually did: the first test below is in
    // `tests/e2e/known-flakes.json` (#1329) because the paint instrument
    // sometimes reports no FCP at all. The ledger's whole mechanism is that a
    // retry absorbs the flake and `ci.yml` downgrades the recovered flake to a
    // `::notice`. With retries off there is no recovered attempt to classify,
    // so the failure was terminal: spec → shard → `E2E` → **main red**, which
    // is exactly what happened on `9267966bc` (1 failed, 89 passed, zero retry
    // attempts).
    //
    // A flaky instrument on a read-only measurement is the textbook case for a
    // retry. Do not turn these off again without saying what a retry would
    // leave behind; `known-flake-ledger.test.ts` now fails if a ledgered test
    // sits in a no-retry block, so the combination cannot come back silently.

    test('a returning user: the SERVER paints their theme, zero corrections', async ({
        page,
        browserName,
        baseURL,
    }) => {
        // `Emulation.setCPUThrottlingRate` is a CDP command.
        test.skip(browserName !== 'chromium', 'CPU throttling needs CDP');

        await page.context().addCookies([
            { name: THEME_COOKIE, value: 'light', url: baseURL! },
        ]);
        await recordFirstPaint(page);
        await safeGoto(page, '/login');

        const log = await readLog(page, { waitForPaint: true });

        // The attribute arrived WITH the markup. This is the assertion that
        // fails if the cookie read is removed from `layout.tsx` — the server
        // would send `dark` and the inline script would have to correct it.
        expect(log.initial).toEqual({ theme: 'light', contrast: null });

        // ...and nothing ever changed it. A flash is impossible, not merely
        // unobserved. Printing the records makes a failure self-describing.
        expect(
            log.mutations,
            `expected no post-markup attribute changes; fcp=${log.fcp}`,
        ).toEqual([]);

        expect(await page.getAttribute('html', 'data-theme')).toBe('light');
        expect(log.bgPage).not.toBe('');
    });

    test('a first visit: the inline script corrects it DURING head parsing', async ({
        page,
        browserName,
    }) => {
        test.skip(browserName !== 'chromium', 'CPU throttling needs CDP');

        // No cookie and no localStorage: a genuinely first visit, where the
        // only signal is the OS preference. The server cannot see it, so it
        // sends its `dark` default and the inline script must fix it.
        await page.emulateMedia({ colorScheme: 'light' });
        await recordFirstPaint(page);
        await safeGoto(page, '/login');

        const log = await readLog(page, { waitForPaint: true });

        expect(log.initial).toEqual({ theme: 'dark', contrast: null });

        const themeChanges = log.mutations.filter((m) => m.attr === 'data-theme');
        expect(
            themeChanges.map((m) => `${m.to}@${m.readyState}`),
            `mutations=${JSON.stringify(log.mutations)} fcp=${log.fcp}`,
        ).toEqual(['light@loading']);

        // The corroborating clock reading. Kept because it is the measurement
        // a reader expects to see, and because a `readyState` of `'loading'`
        // with a timestamp AFTER fcp would mean one of the two instruments is
        // lying and the whole result should be distrusted.
        expect(log.fcp).not.toBeNull();
        expect(themeChanges[0].t).toBeLessThan(log.fcp!);

        // And it is a real repaint-free switch: hydration must not change it
        // back. `ThemeProvider` prefers what is already on the document
        // precisely so this stays at one mutation, not three.
        await page.waitForLoadState('load');
        const after = await readLog(page);
        expect(after.mutations.filter((m) => m.attr === 'data-theme')).toHaveLength(1);
    });

    test('sunlight seeds BOTH attributes, and the palette actually differs', async ({
        page,
        browserName,
        baseURL,
    }) => {
        test.skip(browserName !== 'chromium', 'CPU throttling needs CDP');

        await page.context().addCookies([
            { name: THEME_COOKIE, value: 'sunlight', url: baseURL! },
        ]);
        await recordFirstPaint(page);
        await safeGoto(page, '/login');

        const sun = await readLog(page);

        // `sunlight` is the LIGHT palette plus a contrast overlay — there is no
        // `[data-theme="sunlight"]` block in tokens.css, so emitting the raw
        // name would select no palette and silently render dark.
        expect(sun.initial).toEqual({ theme: 'light', contrast: 'high' });
        expect(sun.mutations).toEqual([]);

        // Grounding: without this, every assertion above is about an attribute
        // string and would pass just as well if the attribute selected nothing.
        const dark = await page.evaluate(() => {
            document.documentElement.setAttribute('data-theme', 'dark');
            document.documentElement.removeAttribute('data-contrast');
            return getComputedStyle(document.documentElement)
                .getPropertyValue('--bg-page')
                .trim();
        });
        expect(sun.bgPage).not.toBe('');
        expect(dark).not.toBe('');
        expect(sun.bgPage).not.toBe(dark);
    });
});
