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

    const entries = [];
    const blocks = [];
    for (const face of faces) {
        const bytes = await fetchBytes(face.url);
        const file = `${slug(face.family)}-${face.subset}-${face.weight}.woff2`;
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
        blocks.push({ face, file, bytes });
    }
    entries.sort((a, b) => a.file.localeCompare(b.file));

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
    for (const { file, bytes } of blocks) await writeFile(path.join(OUT_DIR, file), bytes);

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

    console.log(`Wrote ${entries.length} faces to public/fonts/, plus the lock and fonts.css.`);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
