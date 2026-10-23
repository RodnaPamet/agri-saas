#!/usr/bin/env node
/**
 * Vendor the exact woff2 files Google serves, so the app stops fetching them
 * from a third party at runtime (#779).
 *
 * AUTHOR-TIME ONLY. This reaches the network; it never runs in CI, never runs
 * in the image, and nothing in the build depends on it. What CI checks is the
 * LOCK FILE against the bytes on disk (`tests/unit/fonts/vendored-font-integrity.test.ts`).
 *
 * ## Two modes, and the difference is the whole point
 *
 *   `node scripts/fonts/vendor-fonts.mjs`               → VERIFY. Re-derives
 *      everything and exits 1 on any mismatch with `src/styles/fonts.lock.json`.
 *   `node scripts/fonts/vendor-fonts.mjs --write-lock`  → WRITE. Rewrites the
 *      lock.
 *
 * Without that split, re-vendoring would regenerate BOTH the files and their
 * hashes, so a silently-changed font program would produce a green diff. With
 * it, a bytes change has to be written deliberately and shows up as a lock
 * diff in review. This makes the change VISIBLE, not impossible — that is the
 * honest limit of the mechanism.
 *
 * ## One variable file per subset, not one per weight
 *
 * MEASURED 2026-10-23: the css2 response for the requested weight set declares
 * 72 `@font-face` blocks pointing at **17 distinct URLs**. Each is one variable
 * file per (family, subset) carrying the whole `wght` axis, reused by every
 * weight of that family:
 *
 *   Onest cyrillic 500 / 600 / 700  ->  ...gNMKW3F-SZuj7xmb-HY6EQ.woff2
 *   that file's axes: [('wght', 100.0, 400.0, 900.0)]
 *
 * This script used to fetch `face.url` once per FACE and write a file per face,
 * so it downloaded 17 files 72 times and wrote 72 copies: 1,950,912 B on disk
 * for 431,792 B of distinct font program (#2199). The disk cost was the smaller
 * half -- a different filename is a different URL, so a page rendering Onest at
 * 500, 600 and 700 fetched the same 15,860 B three times under three names.
 *
 * So a file is named per (family, subset) and fetched once per URL. The WEIGHT
 * stays in the name when a group's weights genuinely resolve to different URLs,
 * which no family does today; keeping that branch means a future family that
 * ships static per-weight instances vendors correctly instead of silently
 * collapsing every weight onto one weight's bytes.
 *
 * `fonts.css` still declares all 72 faces with their discrete `font-weight`
 * values. An identical `src` on several faces is ONE fetch, and the browser's
 * weight matching and variable-axis clamping are then bit-for-bit unchanged.
 * Collapsing those 72 declarations into 17 ranged ones WOULD change rendering
 * -- `font-[560]` would stop rounding to 600 -- and is #2199's Fix B,
 * deliberately not taken here.
 *
 * ## Why the whole weight set, even the unused weights
 *
 * MEASURED: the requested weight SET decides which file Google serves.
 *   Onest `wght@500;600;700` → 33760 B (variable font)
 *   Onest `wght@600`         → 15412 B (static instance)
 * Inter is stable across `300..800` and `300..700` (same file both ways).
 *
 * So trimming Onest's unused weights would swap the font PROGRAM, not just
 * drop bytes — a different rasteriser path and potentially different metrics.
 * This vendors exactly what `globals.css` requested before self-hosting, so
 * the program is unchanged and the metric capture stays valid. Trimming is its
 * own change with its own measurement.
 *
 * ## Why a Chrome User-Agent
 *
 * `fonts.googleapis.com` content-negotiates on UA: an unknown agent gets ttf,
 * a modern Chrome gets woff2. We want the woff2 the browser actually loads.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/** EXACTLY the set `src/app/globals.css` requested before self-hosting. */
const FAMILIES = [
    { family: 'Bricolage Grotesque', weights: [500, 600, 700] },
    { family: 'Onest', weights: [500, 600, 700] },
    { family: 'Inter', weights: [300, 400, 500, 600, 700, 800] },
];

const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT_DIR = path.join(ROOT, 'public/fonts');
const LOCK = path.join(ROOT, 'src/styles/fonts.lock.json');
const CSS_OUT = path.join(ROOT, 'src/styles/fonts.css');

function css2Url() {
    const families = FAMILIES.map(
        (f) => `family=${f.family.replace(/ /g, '+')}:wght@${f.weights.join(';')}`,
    ).join('&');
    return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

/**
 * Parse Google's css2 response into face descriptors.
 *
 * Each `@font-face` is preceded by a `/* subset *\/` comment; the subset is
 * what makes the filename meaningful and is how the integrity test can tell a
 * cyrillic face from a latin one without decoding the font.
 */
function parseCss2(css) {
    const faces = [];
    const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*@font-face\s*\{([\s\S]*?)\}/g;
    for (const [, subset, body] of css.matchAll(re)) {
        const pick = (k) => (body.match(new RegExp(`${k}:\\s*([^;]+);`)) ?? [])[1]?.trim();
        faces.push({
            subset,
            family: (pick('font-family') ?? '').replace(/^['"]|['"]$/g, ''),
            style: pick('font-style') ?? 'normal',
            weight: pick('font-weight') ?? '400',
            unicodeRange: pick('unicode-range') ?? '',
            url: (body.match(/url\((\S+?)\)/) ?? [])[1],
        });
    }
    return faces;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchText(url) {
    const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA } });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res.text();
}

async function fetchBytes(url) {
    const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA } });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

/**
 * The `@font-face` block, written from the SAME descriptors Google served.
 *
 * `unicode-range` is copied VERBATIM and is load-bearing twice over: it is
 * what keeps a Cyrillic page from downloading the Latin file, and it is what
 * makes `document.fonts.load(spec, text)` a per-SUBSET probe — the detector's
 * backbone. `font-display: swap` matches the `&display=swap` the remote import
 * requested, so first-paint behaviour is unchanged.
 */
function renderFontFace(face, file) {
    return [
        '@font-face {',
        `    font-family: '${face.family}';`,
        `    font-style: ${face.style};`,
        `    font-weight: ${face.weight};`,
        '    font-display: swap;',
        `    src: url('/fonts/${file}') format('woff2');`,
        `    unicode-range: ${face.unicodeRange};`,
        '}',
    ].join('\n');
}

async function main() {
    const write = process.argv.includes('--write-lock');

    const css = await fetchText(css2Url());
    const faces = parseCss2(css).filter((f) => f.url);
    if (faces.length === 0) throw new Error('parsed zero @font-face blocks — did the css2 format change?');

    // Name each face's file from its (family, subset) GROUP rather than from
    // the face, because a group whose weights all point at one URL IS one
    // variable file. Derived from the response, never assumed: a group with
    // several URLs keeps the weight in its filename.
    const groupKey = (f) => `${f.family}|${f.subset}`;
    const urlsByGroup = new Map();
    for (const f of faces) {
        if (!urlsByGroup.has(groupKey(f))) urlsByGroup.set(groupKey(f), new Set());
        urlsByGroup.get(groupKey(f)).add(f.url);
    }
    const fileFor = (f) =>
        urlsByGroup.get(groupKey(f)).size === 1
            ? `${slug(f.family)}-${f.subset}.woff2`
            : `${slug(f.family)}-${f.subset}-${f.weight}.woff2`;

    const distinctUrls = [...new Set(faces.map((f) => f.url))];
    const perWeightGroups = [...urlsByGroup].filter(([, u]) => u.size > 1).map(([k]) => k);
    // `[fonts]` tag so the denominator reaches the step summary (#1879).
    console.log(
        `[fonts] ${faces.length} face(s) over ${distinctUrls.length} distinct URL(s) `
            + `-> ${new Set(faces.map(fileFor)).size} file(s)`,
    );
    console.log(
        `[fonts] groups needing a per-weight filename: ${perWeightGroups.length}`
            + (perWeightGroups.length ? ` (${perWeightGroups.join(', ')})` : ''),
    );

    // ONE fetch per URL. Per-face fetching made 55 of these 72 downloads
    // re-retrievals of bytes already in hand.
    const bytesByUrl = new Map();
    for (const url of distinctUrls) bytesByUrl.set(url, await fetchBytes(url));

    const entries = [];
    const blocks = [];
    for (const face of faces) {
        const bytes = bytesByUrl.get(face.url);
        const file = fileFor(face);
        entries.push({
            file,
            family: face.family,
            subset: face.subset,
            style: face.style,
            weight: face.weight,
            unicodeRange: face.unicodeRange,
            bytes: bytes.byteLength,
            sha256: sha256(bytes),
        });
        blocks.push({ face, file });
    }
    // CODE-UNIT order, never `localeCompare` — this writes a hash-verified
    // lockfile, so its byte order is part of what `--write-lock` freezes.
    // LATENT rather than live today: every vendored filename is drawn from
    // `-.0-9a-z`, where ICU collation and code-unit order happen to agree
    // (measured: 0 inversions across 72 entries). One uppercase letter or
    // underscore in a future font family would diverge them, and the
    // regenerated lock would differ by ordering alone. Same defect this
    // repo's route inventory shipped live.
    entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

    const lock = { source: css2Url(), userAgent: CHROME_UA, faces: entries };

    if (!write) {
        let existing;
        try {
            existing = JSON.parse(await readFile(LOCK, 'utf8'));
        } catch {
            console.error('No lock file. Run with --write-lock to create one.');
            process.exit(1);
        }
        const a = JSON.stringify(existing.faces);
        const b = JSON.stringify(entries);
        if (a !== b) {
            console.error(
                'MISMATCH: what Google serves today differs from src/styles/fonts.lock.json.\n' +
                    'That is a FONT PROGRAM change, not a formatting one. Re-run with\n' +
                    '--write-lock ONLY after re-running the metric capture in\n' +
                    'docs/implementation-notes/2026-09-01-font-self-hosting.md.',
            );
            process.exit(1);
        }
        console.log(`OK — ${entries.length} faces match the lock.`);
        return;
    }

    await mkdir(OUT_DIR, { recursive: true });
    // Drop stale files so a renamed face cannot linger and ship unreferenced.
    for (const f of await readdir(OUT_DIR).catch(() => [])) {
        if (f.endsWith('.woff2') && !entries.some((e) => e.file === f)) {
            await rm(path.join(OUT_DIR, f));
        }
    }
    // Keyed by FILE, so a name shared by several faces is written once rather
    // than once per face with identical bytes.
    const filesToWrite = new Map();
    for (const face of faces) filesToWrite.set(fileFor(face), bytesByUrl.get(face.url));
    for (const [file, bytes] of filesToWrite) await writeFile(path.join(OUT_DIR, file), bytes);

    await writeFile(LOCK, `${JSON.stringify(lock, null, 4)}\n`);

    const header = [
        '/*',
        ' * Self-hosted web fonts (#779) — GENERATED by scripts/fonts/vendor-fonts.mjs.',
        ' *',
        ' * Byte-identical to what fonts.googleapis.com serves, with the descriptors',
        ' * it served, so the font PROGRAM and therefore text metrics are unchanged.',
        ' * Edit the script, not this file.',
        ' *',
        ' * Same-origin matters beyond removing a third party: public/sw.js passes',
        ' * cross-origin requests through untouched, so the remote fonts could never',
        ' * be cached for offline use. An operator with no signal fell back to',
        ' * system-ui for every string. These can be cached.',
        ' */',
        '',
    ].join('\n');
    await writeFile(
        CSS_OUT,
        `${header}${blocks.map(({ face, file }) => renderFontFace(face, file)).join('\n\n')}\n`,
    );

    console.log(
        `Wrote ${filesToWrite.size} file(s) for ${entries.length} faces to public/fonts/, `
            + 'plus the lock and fonts.css.',
    );
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
