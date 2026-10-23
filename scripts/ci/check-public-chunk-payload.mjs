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
    { name: 'next-intl-client', marker: 'MISSING_MESSAGE', why: 'the next-intl CLIENT runtime; this page is server-rendered' },
];

/**
 * Known residue, each with the reason it is tolerated. SHRINK-ONLY: an entry
 * that stops being observed is a FAILURE, not a tidy-up, because a baseline
 * naming something absent silently excuses whatever lands there next.
 *
 * `sonner` is here rather than fixed because the fix is a `next/dynamic` import
 * of `Providers`, which costs the whole application surface a lazy chunk
 * boundary on first paint to save ~3 KB of transfer on one page. #1971 measured
 * that trade and judged it not worth taking on its own. What this check buys is
 * the other half: a heavier static import landing beside `Providers` fails here
 * rather than being found by somebody reading a trace a month later.
 */
export const BASELINE = new Set(['sonner']);

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

/** `/_next/static/chunks/x.js` -> `<buildDir>/static/chunks/x.js`, or null. */
export function resolveChunk(url, buildDir) {
    let pathname;
    try {
        pathname = new URL(url).pathname;
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
