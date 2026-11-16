/**
 * Read ZarnoBorsa's two Bulgarian price tables and write them to a JSON file
 * (#3081).
 *
 * ## Why this is a separate process from the ingest
 *
 * A plain fetch cannot hold ZarnoBorsa's session — measured: the login POST
 * answers a greeting and the next request redirects to `/login`, leaving the
 * price pages showing August data. A headless Chromium keeps it. And
 * Playwright may not be in this product's runtime image:
 * `verify-image-deps.mjs` forbids it and exists because `npm prune
 * --omit=dev` CANNOT remove it (`next` declares `@playwright/test` as an
 * optional peerDependency, so npm resolves it through a production edge).
 *
 * So the browser work runs in its own container, on the official Playwright
 * image, and this bundle imports NO Prisma at all. That is the whole reason
 * for the file handoff: a bundle needing both Playwright and Prisma would
 * need a custom image carrying both, and the split costs one JSON file
 * instead.
 *
 * ## What it writes, and what it refuses to write
 *
 * One JSON document: `{ fetchedAt, locked, pages: [...], rows: [...] }`. The
 * ingest half reads it and decides what to store — including refusing
 * everything when `locked` is set, because only THIS process can see the
 * «ЗА ПЪЛЕН ДОСТЪП» banner and no property of the rows distinguishes a
 * paywalled page from a quiet market.
 *
 * It writes the file even on a locked or empty read, deliberately. A missing
 * file and a file saying "I saw nothing" are different findings, and the
 * ingest's `unaudited` verdict depends on being able to tell them apart.
 *
 * Run: `node dist/zarnoborsa-fetch.mjs [--out <path>]`
 */
import { writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

import { chromium } from 'playwright';

import {
    extractZarnoBorsaRows,
    isZarnoBorsaLocked,
    ZarnoBorsaRawRow,
} from '../src/lib/market/zarnoborsa-extract';
import { parseZarnoBorsaRows } from '../src/lib/market/zarnoborsa-parse';

/*
 * THE PAGE THAT HOLDS THE FORM, not the form's action.
 *
 * `/?c=SFForms&a=SiteLogin&FH=loginForm` is where the form POSTS — it is the
 * endpoint, and loading it serves no form at all. The first live run failed
 * with `page.fill: Timeout 30000ms exceeded — waiting for locator('#loginForm
 * input[name=email]')`, which is what a missing form looks like rather than a
 * wrong selector.
 *
 * Measured on the VM 2026-11-16: `https://zarnoborsa.com/login` carries
 * `#loginForm` with `input[name=email]`, `input[name=passwd]` and
 * `#loginForm button[type=submit]`, one of each. The HOMEPAGE carries none of
 * them, so it is not an alternative.
 */
const LOGIN_URL = 'https://zarnoborsa.com/login';
const PAGES = [
    { stage: 'EXW', url: 'https://zarnoborsa.com/markets/exw' },
    { stage: 'FOB', url: 'https://zarnoborsa.com/markets/fob' },
] as const;

/** Where the ingest half looks unless told otherwise. */
export const DEFAULT_OUT = '/var/lib/agrent/zarnoborsa/latest.json';

interface PageReading {
    stage: string;
    url: string;
    locked: boolean;
    rawRows: number;
}

async function main(): Promise<void> {
    const outArg = process.argv.indexOf('--out');
    const out = outArg !== -1 ? process.argv[outArg + 1] : DEFAULT_OUT;

    const email = process.env.ZARNOBORSA_EMAIL;
    const password = process.env.ZARNOBORSA_PASSWORD;
    /*
     * NOT CONFIGURED is not a failure. A self-hosted deployment has no
     * subscription, and exiting non-zero would make its container restart for
     * ever over a feature it does not have. It writes no file, so the ingest
     * reports `unaudited` rather than `clean`.
     */
    if (!email || !password) {
        console.log(JSON.stringify({
            event: 'zarnoborsa.fetch.not_configured',
            // The KEY NAMES, never the values — and never whether one of the
            // two was present, which would narrow a credential.
            missing: 'ZARNOBORSA_EMAIL and/or ZARNOBORSA_PASSWORD',
        }));
        return;
    }

    const browser = await chromium.launch();
    const readings: PageReading[] = [];
    const raw: ZarnoBorsaRawRow[] = [];
    let anyLocked = false;

    try {
        const context = await browser.newContext();
        const page = await context.newPage();

        /*
         * `load`, NOT `domcontentloaded`, and this is the fix that made the
         * whole thing work.
         *
         * `#loginForm` has NO `action` and NO `method` attribute — measured on
         * the VM 2026-11-16 — so submission is entirely JS-driven. With
         * `domcontentloaded` the scripts have not finished binding the submit
         * handler, so the click lands on a button with nothing attached: no
         * POST to `SiteLogin` appears at all, the page simply stays put, and
         * every later symptom is indistinguishable from a wrong password.
         */
        await page.goto(LOGIN_URL, { waitUntil: 'load' });
        /*
         * Fill and submit the real form rather than POSTing its fields. The
         * session is only held when the browser performs the submission —
         * that is the measured difference between this working and a curl
         * that gets a greeting and then a redirect to `/login`.
         */
        await page.fill('#loginForm input[name=email]', email);
        await page.fill('#loginForm input[name=passwd]', password);

        /*
         * WAIT FOR THE LOGIN RESPONSE, not for a load state.
         *
         * The first version raced `waitForLoadState` against the click, which
         * is meaningless — that reports on the navigation already in flight,
         * so it resolved before the POST had landed and the next `goto`
         * superseded an in-flight navigation with `net::ERR_ABORTED`.
         *
         * Waiting for the `SiteLogin` response is the definitive signal: it
         * exists only if the JS handler actually fired, which is the thing
         * that was silently not happening.
         */
        const [loginResponse] = await Promise.all([
            page.waitForResponse((r) => /SiteLogin/i.test(r.url()), { timeout: 30_000 }),
            page.click('#loginForm button[type=submit]'),
        ]);
        await page.waitForLoadState('load');

        /*
         * A POSITIVE CONTROL on the login, because every later symptom of
         * failing it is indistinguishable from a quiet market: the price pages
         * serve the paywalled markup, which parses perfectly.
         *
         * Catching it HERE says "the login failed" rather than "the pages were
         * locked", and those want different responses — one is a credential to
         * fix, the other a subscription to renew.
         *
         * Measured on a successful login: status 200, the browser lands on
         * `?p=profile`, «Здравей» appears, and the form is gone. The form's
         * ABSENCE is the check rather than the greeting, because a greeting is
         * display copy that could be reworded, while a login page that still
         * wants a password is unambiguous.
         */
        /*
         * LET THE LOGIN'S OWN REDIRECT SETTLE before navigating anywhere.
         *
         * A successful login lands on `?p=profile` via a second hop, and that
         * hop is still in flight when the first market `goto` fires. The
         * symptoms walked through three different errors as this was
         * tightened: `net::ERR_ABORTED`, then — once a retry was added —
         * `Navigation to X is interrupted by another navigation to X`, which
         * is the retry racing its own first attempt.
         *
         * `networkidle` is the explicit settle. It is the heavier wait and the
         * right one here: it runs ONCE per session, not per page, and the
         * alternative is a sleep chosen by guesswork.
         */
        await page.waitForLoadState('networkidle').catch(() => { /* settle is best-effort */ });

        const stillOnForm = await page.locator('#loginForm input[name=passwd]').count();
        if (stillOnForm > 0) {
            throw new Error(
                `login did not take (SiteLogin answered ${loginResponse.status()}): `
                + 'the form is still present',
            );
        }

        for (const p of PAGES) {
            /*
             * RETRIED ONCE, because the first navigation after the login
             * reliably fails with `net::ERR_ABORTED` — the login's own
             * navigation is still settling and supersedes it. Measured: the
             * first attempt aborts, the second returns 200.
             *
             * Two attempts rather than a loop: if the second also fails the
             * run should end and say so, not hammer a subscriber site.
             */
            let loaded = false;
            for (let attempt = 0; attempt < 2 && !loaded; attempt += 1) {
                try {
                    await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                    loaded = true;
                } catch (err) {
                    if (attempt === 1) throw err;
                }
            }
            /*
             * Both of these run IN THE PAGE. `extractZarnoBorsaRows` is
             * written against the standard DOM API for exactly this, and
             * Playwright stringifies it — which is why it references nothing
             * outside its own body. The fixture tests run the same function
             * under jsdom, so what they exercise is what executes here.
             */
            // NO ARGUMENT: both functions default to the page's own
            // `document`, because a live Document cannot cross the
            // serialisation boundary. Passing one delivers `undefined`.
            //
            // A failed lock CHECK reads as locked, which is the safe
            // direction: it refuses the read rather than storing prices from
            // a page we could not inspect.
            /*
             * A THROWN check is reported, not silently treated as a paywall.
             *
             * It fails SAFE — an uninspectable page must not have its prices
             * stored — but the first version returned a bare `true`, and that
             * is how a `ReferenceError` inside the stringified function looked
             * exactly like a locked page for a whole run: 110 rows read off
             * two demonstrably unlocked pages and all of them discarded,
             * with the reading saying `locked: true` and nothing saying why.
             */
            let locked: boolean;
            try {
                locked = await page.evaluate(isZarnoBorsaLocked);
            } catch (err) {
                locked = true;
                console.error(JSON.stringify({
                    event: 'zarnoborsa.fetch.lock_check_failed',
                    stage: p.stage,
                    message: err instanceof Error ? err.message.slice(0, 160) : 'unknown',
                }));
            }
            const rows = await page.evaluate(extractZarnoBorsaRows);

            readings.push({ stage: p.stage, url: p.url, locked, rawRows: rows.length });
            if (locked) anyLocked = true;
            raw.push(...rows);
        }
    } finally {
        await browser.close();
    }

    /*
     * ANY page locked locks the whole read. A session that lapsed between the
     * two pages would otherwise store the first page's prices and discard the
     * second's, leaving one stage current and the other stale — which is
     * worse than storing nothing, because the gap is invisible.
     */
    const parsed = parseZarnoBorsaRows(raw);

    const doc = {
        fetchedAt: new Date().toISOString(),
        locked: anyLocked,
        pages: readings,
        skipped: parsed.skipped,
        rows: parsed.rows,
    };

    /*
     * WRITE-THEN-RENAME, because the reader is a different process on its own
     * schedule.
     *
     * A bare `writeFileSync` is not atomic: a read landing mid-write sees a
     * truncated document, and the reader's `unreadable` verdict exists for
     * exactly that. `rename` within the same directory IS atomic on POSIX, so
     * the reader observes either the previous document or the complete new
     * one and never a partial one.
     *
     * The reader keeps handling `unreadable` regardless — this removes the
     * cause we control, not every cause.
     */
    mkdirSync(dirname(out), { recursive: true });
    const tmp = `${out}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(tmp, out);

    // The READING, with its denominators. `rows: 0` alone cannot say whether
    // the page was empty, paywalled or reshaped — so all four numbers go out
    // together, and never a price.
    console.log(JSON.stringify({
        event: 'zarnoborsa.fetch.reading',
        out,
        locked: anyLocked,
        pages: readings,
        rawRows: raw.length,
        parsedRows: parsed.rows.length,
        skipped: parsed.skipped,
    }));
}

main().catch((err: unknown) => {
    // No stack to stdout: a Playwright error can carry the page URL and, on a
    // fill failure, the selector — never the value, but the URL alone is
    // enough to want it out of a shared log.
    console.error(JSON.stringify({
        event: 'zarnoborsa.fetch.failed',
        message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    }));
    process.exitCode = 1;
});
