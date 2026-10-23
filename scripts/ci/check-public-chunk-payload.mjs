#!/usr/bin/env node
/**
 * What JS the PUBLIC farm page actually downloads — #1971.
 *
 * ## Why this is not a guard
 *
 * `tests/guards/public-surface-skips-app-chrome.test.ts` asserts which branch of
 * the root layout a component sits in. That is a RENDERING property, and the
 * module graph is not: `src/app/layout.tsx` imports `Providers` STATICALLY, so a
 * chunk from that subtree is in the route's client payload whether or not the
 * branch renders. Measured on #1971: sonner's ~8,895 raw bytes arrive on
 * `/f/{handle}`, a page with no toaster.
 *
 * So the guard's claim and the guard's evidence differ by exactly that chunk,
 * and the difference is invisible to it by construction.
 *
 * ## Why it reads a Lighthouse report rather than a build manifest
 *
 * Because the manifest cannot answer the question. MEASURED 2026-10-23 on a
 * local production build: the client-reference manifests for `/f/[handle]` and
 * for `/login` list **the same 134 clientModules** — identical key sets. The app
 * router writes a GLOBAL client registry per route file, not a per-route payload
 * list, so `clientModules` gives the same answer for every route and has no
 * discriminating power whatsoever. `app-build-manifest.json` does not exist in
 * this Next version, and `build-manifest.json` carries `rootMainFiles` plus a
 * `pages` map holding only `/_app`.
 *
 * The real payload is decided by the RSC flight response at request time, so the
 * only honest source is an actual page load. The Lighthouse `public-farm` leg
 * already performs one, with the `social.public-profile` flag enabled and a
 * seeded `PublicFarmProfile` row, so this reads that run's reports instead of
 * standing up a second browser.
 *
 * Usage:
 *   node scripts/ci/check-public-chunk-payload.mjs [lhrDir] [buildDir]
 *   defaults: .lighthouseci .next
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** lhci writes exactly this shape — the regex `lighthouse-median.mjs` also uses. */
const LHR_REGEX = /^lhr-\d+\.json$/;

/**
 * Libraries only the APPLICATION chrome has any use for.
 *
 * Every marker is a string literal or a generated attribute, never an
 * IDENTIFIER, because minifiers rename identifiers — and each was verified
 * findable in a real production build rather than chosen from the package name.
 * That check is not decoration: it caught two of my own first attempts, and the
 * same two that #1971's measurement used.
 *
 *   - `SWRConfig` is an identifier and appears in NO chunk. Replaced with
 *     `revalidateOnFocus`, a config-option key that survives (12 chunks).
 *   - `floating-ui` appears in no chunk either, and `@floating-ui` IS installed
 *     — it arrives through `@radix-ui/react-popper`. Its dist offers no
 *     distinctive surviving literal: the candidates are `absolute`,
 *     `transform`, `reference`, `floating` and the like, and `floating` alone
 *     matches 37 unrelated chunks. So it is DROPPED rather than guessed at. A
 *     marker that matches a third of the build is worse than no marker, and
 *     `radix` covers it in practice because `@radix-ui/react-popper` is its only
 *     route into this bundle.
 *
 * #1971 reported "no SWRConfig, no floating-ui anywhere in the public page's
 * chunks" as confirmation that #1872 worked. For those two libraries that
 * sentence was unfalsifiable — neither marker can be found anywhere, present or
 * not. The rest of that measurement stands.
 */
export const PROVIDER_ONLY = [
    { name: 'sonner', marker: 'sonner', why: 'toast library; the public page has no toaster' },
    { name: 'cmdk', marker: 'cmdk-', why: 'the palette; it used to open the app search from a stranger’s page' },
    { name: 'radix', marker: 'data-radix', why: 'dialog/popover primitives, all app-only chrome' },
    { name: 'swr', marker: 'revalidateOnFocus', why: 'the persistent cache provider, handed an undefined userId here' },
];

/**
 * `next-intl-client` was on the list above and is NOT app-only — removed (#2225).
 *
 * I wrote its reason as "the next-intl CLIENT runtime; this page is
 * server-rendered", and that is wrong about the layout. `NextIntlClientProvider`
 * is mounted at `src/app/layout.tsx:288`, OUTSIDE the `isPublic` ternary, so it
 * wraps both branches — the public surface gets it with a narrowed message set
 * (`publicSurfaceMessages(allMessages)`, line 119) rather than not at all. The
 * client runtime is therefore the public page's own requirement, not chrome
 * leaking through a static import.
 *
 * Leaving it listed would have been worse than useless: the `why` string tells
 * the next reader to remove something load-bearing, and the layout records what
 * happens when the provider boundary is got wrong — moving `InstallPrompt`
 * outside it "500'd every page with 'NextIntlClientProvider context not
 * found'".
 *
 * So it is not merely dropped from the BASELINE; it is dropped from the
 * POPULATION, because a library that belongs on the page is not a finding about
 * the page.
 */

/**
 * Known residue, each with the reason it is tolerated. SHRINK-ONLY: an entry
 * that stops being observed is a FAILURE, not a tidy-up, because a baseline
 * naming something absent silently excuses whatever lands there next.
 *
 * `sonner` is here rather than fixed because the fix is a `next/dynamic` import
 * of `Providers`, which costs the whole application surface a lazy chunk
 * boundary on first paint to save ~3 KB of transfer on one page. #1971 measured
 * that trade and judged it not worth taking on its own.
 *
 * **`cmdk` is gone; `radix` is not, and this check is what established the
 * difference (#2225).** `providers.tsx` imports the palette through
 * `next/dynamic` and the provider from its own module rather than the barrel
 * that re-exports both. I predicted both libraries would leave, dropped both
 * from this baseline, and the check failed with "radix reaches the public
 * page" — so the prediction was half right and the baseline is corrected here.
 *
 * MEASURED after the change: 25 script URLs where there were 27, and
 * `on the public page: radix, sonner, swr` — no cmdk.
 *
 * Radix was never only the palette's. Traced over the static graph, it has
 * three sites and none is the command palette:
 *
 *   components/ui/modal.tsx    -> @radix-ui/react-dialog, react-visually-hidden
 *   components/ui/tooltip.tsx  -> @radix-ui/react-tooltip
 *
 * Both are mount-time UI primitives inside the `Providers` subtree —
 * `TooltipProvider` is mounted directly — so they go only if all of `Providers`
 * goes lazy, which the owner declined on 2026-10-23 because it would put SWR
 * config and the toaster behind a second request on every app page load.
 *
 * `swr` stays for the same reason: `SWRPersistenceProvider` is needed at mount.
 *
 * **Why I got radix wrong is worth recording.** My import tracer's regex
 * matched only SINGLE-quoted specifiers, and `tooltip.tsx` writes
 * `from "@radix-ui/react-tooltip"` with double quotes. That one assumption hid
 * 358 of 426 reachable modules — the graph I reported as "96 before, 68 after"
 * was an artefact of the quote style, not a measurement. The direction was
 * real; the numbers were not.
 *
 * **The history: these were here because the first CI run found them, and #1971
 * said they were absent.** That issue reports "Confirmed absent, so #1872 did do its
 * job: no MISSING_MESSAGE, no SWRConfig, no cmdk-, no data-radix" — and this
 * check, run against a real `public-farm` page load, found all four:
 *
 *   radix  27156-….js, 95891-….js
 *   cmdk   58750-….js, layout-….js
 *   swr    82696-….js, 90901-….js
 *
 * **All four arrive through ONE static import** — `src/app/layout.tsx`'s
 * `./providers` (#2225, traced over the static graph): sonner directly, cmdk and
 * radix via `components/command-palette`, swr via `SWRPersistenceProvider`. So
 * the `next/dynamic` fix #1971 rejected on arithmetic computed for 8,895 bytes
 * of sonner would remove FOUR libraries across six chunks, which is the
 * recomputation #2225 asks for.
 *
 * None of those is in `rootMainFiles` (webpack / react-dom / main-app, which
 * every route loads and no layout change can reach), so this is not
 * shared-runtime noise — `layout-….js` is the root layout's own chunk. Whether
 * that is a regression since 2026-10-16 or a gap the original measurement
 * missed is #2225; the baseline records what IS, so the
 * check can start failing on a SIXTH library instead of staying red about five.
 *
 * Which is the honest limit of a baseline this size: it no longer proves the
 * public surface is clean, only that it is not getting dirtier.
 */
export const BASELINE = new Set(['sonner', 'swr', 'radix']);

export function lhrFiles(dir) {
    if (!existsSync(dir)) throw new Error(`no Lighthouse report directory at ${dir}`);
    const files = readdirSync(dir).filter((f) => LHR_REGEX.test(f));
    if (files.length === 0) throw new Error(`${dir} holds no lhr-*.json — nothing was measured`);
    return files.map((f) => path.join(dir, f));
}

/**
 * Script URLs from every run, UNIONED.
 *
 * Unioned rather than taken from one report because a single run can miss a late
 * chunk, and a payload check that under-reports fails toward green. A missing
 * `network-requests` audit THROWS: otherwise "no scripts found" and "the audit
 * moved" are the same observation, and one of them looks clean.
 */
export function scriptUrlsFromLhrs(files) {
    const urls = new Set();
    let audited = 0;
    for (const f of files) {
        const lhr = JSON.parse(readFileSync(f, 'utf8'));
        const audit = lhr?.audits?.['network-requests'];
        if (!audit) throw new Error(`${path.basename(f)} has no 'network-requests' audit`);
        const items = audit?.details?.items;
        if (!Array.isArray(items)) {
            throw new Error(`${path.basename(f)}: network-requests carries no items array`);
        }
        audited += 1;
        for (const it of items) {
            if (it?.resourceType === 'Script' && typeof it.url === 'string') urls.add(it.url);
        }
    }
    if (urls.size === 0) {
        throw new Error(`no Script requests across ${audited} report(s) — a real page load has some`);
    }
    return { urls: [...urls].sort(), audited };
}

/**
 * `/_next/static/chunks/x.js` -> `<buildDir>/static/chunks/x.js`, or null.
 *
 * The pathname is DECODED, and that is not cosmetic. An app-router dynamic
 * segment is a literal `[handle]` on disk and percent-encoded in the URL, so
 * the public route's own page chunk arrives as
 * `/_next/static/chunks/app/f/%5Bhandle%5D/page-<hash>.js`. Without decoding it
 * resolves to nothing — and the chunk most likely to carry route-specific code
 * is then the one chunk never scanned. Found on this check's first CI run,
 * which reported it as an unresolved URL rather than skipping it.
 */
export function resolveChunk(url, buildDir) {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(url).pathname);
    } catch {
        return null;
    }
    const m = /^\/_next\/(.*)$/.exec(pathname);
    if (!m) return null;
    const p = path.join(buildDir, m[1]);
    return existsSync(p) && statSync(p).isFile() ? p : null;
}

/** Which markers exist anywhere in the build — their absence proves nothing otherwise. */
export function findableMarkers(buildDir) {
    const dir = path.join(buildDir, 'static', 'chunks');
    if (!existsSync(dir)) throw new Error(`no chunk directory at ${dir} — was the app built?`);
    const files = [];
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) files.push(p);
        }
    };
    walk(dir);
    const found = new Set();
    for (const f of files) {
        const text = readFileSync(f, 'utf8');
        for (const { name, marker } of PROVIDER_ONLY) {
            if (text.includes(marker)) found.add(name);
        }
    }
    return { found, scanned: files.length };
}

/** The whole verdict, as data, so a test can drive it without a process exit. */
export function classify({ urls, audited, buildDir }) {
    const resolved = [];
    const unresolved = [];
    for (const u of urls) {
        const p = resolveChunk(u, buildDir);
        if (p) resolved.push({ url: u, file: p });
        else unresolved.push(u);
    }

    const present = new Map();
    for (const { url, file } of resolved) {
        const text = readFileSync(file, 'utf8');
        for (const lib of PROVIDER_ONLY) {
            if (text.includes(lib.marker)) {
                present.set(lib.name, [...(present.get(lib.name) ?? []), path.basename(url)]);
            }
        }
    }

    const { found: findable, scanned } = findableMarkers(buildDir);
    const problems = [];

    if (unresolved.length) {
        problems.push(
            `${unresolved.length} script URL(s) did not resolve under ${buildDir}, so they were `
                + `never scanned:\n  ${unresolved.join('\n  ')}`,
        );
    }

    // The half that fails OPEN without a control: rename a minified marker or
    // drop a library, and every "not on the public page" assertion becomes
    // vacuously true.
    const unfindable = PROVIDER_ONLY.filter((l) => !findable.has(l.name)).map((l) => l.name);
    if (unfindable.length) {
        problems.push(
            `CONTROL FAILED — these markers appear NOWHERE in the build, so their absence from the `
                + `public page proves nothing: ${unfindable.join(', ')}. Either the library is gone `
                + `(remove it from PROVIDER_ONLY) or its marker was renamed (fix the marker).`,
        );
    }

    for (const [name, chunks] of present) {
        if (BASELINE.has(name)) continue;
        const lib = PROVIDER_ONLY.find((l) => l.name === name);
        problems.push(
            `${name} reaches the public page (${chunks.join(', ')}) — ${lib.why}. Either keep it `
                + `off this route, or add it to BASELINE with the reason it stays.`,
        );
    }

    for (const name of BASELINE) {
        if (!present.has(name)) {
            problems.push(
                `BASELINE names ${name} but it is no longer on the public page. Remove it — a `
                    + `baseline entry for something absent excuses whatever lands there next.`,
            );
        }
    }

    return { audited, urls, resolved, unresolved, present, findable, scanned, problems };
}

function main() {
    const lhrDir = process.argv[2] ?? '.lighthouseci';
    const buildDir = process.argv[3] ?? '.next';
    const files = lhrFiles(lhrDir);
    const { urls, audited } = scriptUrlsFromLhrs(files);
    const r = classify({ urls, audited, buildDir });

    console.log(
        `[public-payload] ${r.audited} report(s), ${r.urls.length} script URL(s), `
            + `${r.resolved.length} resolved under ${buildDir}, ${r.unresolved.length} unresolved`,
    );
    console.log(
        `[public-payload] findable in the build: ${[...r.findable].sort().join(', ') || 'NONE'} `
            + `(${r.scanned} chunk file(s) scanned)`,
    );
    console.log(
        `[public-payload] on the public page: ${[...r.present.keys()].sort().join(', ') || 'none'}`,
    );

    if (r.problems.length) {
        for (const p of r.problems) console.error(`::error::public payload: ${p}`);
        process.exit(1);
    }
    console.log('[public-payload] OK — no NEW provider-only library on the public page.');
}

const INVOKED_DIRECTLY =
    process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (INVOKED_DIRECTLY) {
    try {
        main();
    } catch (err) {
        console.error(`::error::public payload: ${err.message}`);
        process.exit(1);
    }
}
