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
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

import { chromium } from 'playwright';

import {
    extractZarnoBorsaRows,
    isZarnoBorsaLocked,
    ZarnoBorsaRawRow,
} from '../src/lib/market/zarnoborsa-extract';
import { parseZarnoBorsaRows } from '../src/lib/market/zarnoborsa-parse';

const LOGIN_URL = 'https://zarnoborsa.com/?c=SFForms&a=SiteLogin&FH=loginForm';
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

        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
        /*
         * Fill and submit the real form rather than POSTing its fields. The
         * session is only held when the browser performs the submission —
         * that is the measured difference between this working and a curl
         * that gets a greeting and then a redirect to `/login`.
         */
        await page.fill('#loginForm input[name=email]', email);
        await page.fill('#loginForm input[name=passwd]', password);
        await Promise.all([
            page.waitForLoadState('domcontentloaded'),
            page.click('#loginForm button[type=submit]'),
        ]);

        for (const p of PAGES) {
            await page.goto(p.url, { waitUntil: 'domcontentloaded' });
            /*
             * Both of these run IN THE PAGE. `extractZarnoBorsaRows` is
             * written against the standard DOM API for exactly this, and
             * Playwright stringifies it — which is why it references nothing
             * outside its own body. The fixture tests run the same function
             * under jsdom, so what they exercise is what executes here.
             */
            const locked = await page.evaluate(isZarnoBorsaLocked, undefined as never)
                .catch(() => true);
            const rows = await page.evaluate(extractZarnoBorsaRows, undefined as never);

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

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

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
