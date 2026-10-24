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

/**
 * The whole stylesheet, from the face blocks — extracted for #2200.
 *
 * It was inline in the write path, which made `--accept-descriptors` unable to
 * regenerate it. That mattered: `fonts.css` carries all 72 `unicode-range`
 * declarations and is what the BROWSER reads, so adopting a descriptor in the
 * lock alone left the two disagreeing on three distinct ranges and broke
 * `vendored-font-integrity`. Measured, not predicted — the first version of
 * that flag shipped exactly that and the test caught it.
 */
function renderStylesheet(blocks) {
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
    return `${header}${blocks.map(({ face, file }) => renderFontFace(face, file)).join('\n\n')}\n`;
}


/**
 * ── WHICH AXIS MOVED ── #2200
 *
 * The verify arm used to be one `JSON.stringify` comparison of the whole face
 * array against the lock, and its failure message named a cause it had not
 * checked: "That is a FONT PROGRAM change, not a formatting one." Measured on
 * main 2026-10-23, that verdict was printed for **18 `unicode-range`
 * descriptor diffs and ZERO byte diffs** — all 17 distinct URLs byte-identical
 * to what was locked and metric-captured.
 *
 * The cost was not the failed exit. It was sending the reader to re-run the
 * METRIC CAPTURE — the expensive, careful thing — for a change that cannot
 * move a metric, while being the only thing standing between the next person
 * and a `--write-lock` that would quietly adopt those 18 range changes along
 * with whatever they came for.
 *
 * So the comparison is split into three axes, because they have three
 * different remedies:
 *
 *   - **IDENTITY** (file, family, subset, style, weight) — a face appeared,
 *     vanished or was re-grouped. The filename derivation changed, or Google
 *     split a variable file into per-weight ones. Needs a human reading the
 *     grouping, not a metric capture.
 *   - **PROGRAM** (bytes, sha256) — the font binary changed. This is the case
 *     the metric-capture warning was written for, and the only one that
 *     deserves it.
 *   - **DESCRIPTOR** (unicodeRange) — Google widened a range, usually
 *     following Unicode additions. Byte-identical files, so no metric can
 *     move. `--accept-descriptors` adopts these deliberately.
 *
 * Returned rather than printed so it is testable without a network fetch,
 * which is also why `main()` is guarded below.
 */
export const PROGRAM_FIELDS = ['bytes', 'sha256'];
export const DESCRIPTOR_FIELDS = ['unicodeRange'];
/** Not a diffable field — a change here IS the grouping change. */
export const GROUPING_FIELD = 'file';

/**
 * The join key is the FACE, not the file.
 *
 * `file` is not unique and must not be used: 72 faces resolve to 17 files
 * because a group whose weights all point at one URL is one variable file.
 * Keying on `file` compares a face against an arbitrary sibling sharing its
 * filename, which reported `weight 700 -> 500` on sixteen faces that had not
 * changed at all. Caught by running the real verify rather than by a fixture,
 * because a synthetic fixture with one face per file cannot express the bug.
 */
const faceKey = (e) => [e.family, e.subset, e.style, e.weight].join('\u0000');

export function classifyLockDiff(locked, computed) {
    const index = (list) => new Map(list.map((e) => [faceKey(e), e]));
    const was = index(locked);
    const now = index(computed);
    const describe = (e) => `${e.family} ${e.subset} ${e.style} ${e.weight}`;

    const added = computed.filter((e) => !was.has(faceKey(e))).map(describe);
    const removed = locked.filter((e) => !now.has(faceKey(e))).map(describe);

    const program = [];
    const descriptor = [];
    const identity = [];
    for (const e of computed) {
        const old = was.get(faceKey(e));
        if (!old) continue;
        // A face that kept its identity but changed FILE was re-grouped: a
        // variable file split into per-weight ones, or the reverse.
        if (String(old[GROUPING_FIELD]) !== String(e[GROUPING_FIELD])) {
            identity.push({
                file: describe(e),
                field: GROUPING_FIELD,
                was: old[GROUPING_FIELD],
                now: e[GROUPING_FIELD],
            });
        }
        for (const [fields, bucket] of [
            [PROGRAM_FIELDS, program],
            [DESCRIPTOR_FIELDS, descriptor],
        ]) {
            for (const f of fields) {
                if (String(old[f]) !== String(e[f])) {
                    bucket.push({
                        file: `${describe(e)} (${e.file})`,
                        // The bare filename too, because several faces share one file
                        // and a count of "files changed" must not count faces.
                        rawFile: e.file,
                        field: f,
                        was: old[f],
                        now: e[f],
                    });
                }
            }
        }
    }

    // ORDER, separately. The lock is byte-compared elsewhere and its sort is
    // part of what `--write-lock` freezes, so a pure re-ordering is a real
    // difference — and one that would otherwise hide inside "nothing else
    // moved" and read as a clean verify.
    const orderChanged =
        added.length === 0
        && removed.length === 0
        && locked.map((e) => `${e.file}|${faceKey(e)}`).join('\u0001')
            !== computed.map((e) => `${e.file}|${faceKey(e)}`).join('\u0001');

    return {
        added,
        removed,
        identity,
        program,
        descriptor,
        orderChanged,
        clean:
            added.length === 0
            && removed.length === 0
            && identity.length === 0
            && program.length === 0
            && descriptor.length === 0
            && !orderChanged,
    };
}

/**
 * One line per diff, windowed on the part that CHANGED.
 *
 * A plain head-truncation is useless here and was measured to be: a
 * `unicode-range` descriptor is ~400 characters and the widening Google
 * applied sits at the end, so `was:` and `now:` printed identical first-88
 * characters and the reader learned nothing. The window is computed from the
 * common prefix and suffix instead, so the output shows `U+1F100-1F1AD` next
 * to `U+1F100-1F1AE` whatever their offset.
 */
export function windowDiff(was, now, context = 30) {
    const a = String(was ?? '(absent)');
    const b = String(now ?? '(absent)');
    if (a === b) return { was: a, now: b };
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
    let tail = 0;
    while (
        tail < a.length - head
        && tail < b.length - head
        && a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
        tail += 1;
    }
    const cut = (v) => {
        const from = Math.max(0, head - context);
        const to = Math.min(v.length, v.length - tail + context);
        return (from > 0 ? '...' : '') + v.slice(from, to) + (to < v.length ? '...' : '');
    };
    return { was: cut(a), now: cut(b) };
}

function renderDiffs(diffs, limit = 24) {
    const show = diffs.slice(0, limit).map((d) => {
        const { was, now } = windowDiff(d.was, d.now);
        return `    ${d.file} · ${d.field}\n      was: ${was}\n      now: ${now}`;
    });
    if (diffs.length > limit) show.push(`    ... and ${diffs.length - limit} more`);
    return show.join('\n');
}

/**
 * The MESSAGE for a diff, as a pure function — #2200.
 *
 * Split out of `main()` deliberately. The defect this issue reports is not a
 * wrong comparison, it is a wrong VERDICT printed over a correct comparison:
 * the old arm compared everything at once and then asserted "that is a FONT
 * PROGRAM change" for eighteen descriptor diffs and zero byte diffs. So the
 * mapping from bucket to message is the thing most worth a test, and a test
 * cannot reach it while it lives inside a function that fetches from Google
 * first.
 *
 * Ordered by REMEDY, not by severity. Identity first because a re-grouping
 * changes what every other comparison is even about; program next because it
 * is the one that owes a metric capture; descriptors last because they are
 * cheap and need a decision rather than work.
 */
export function verdictFor(diff) {
    if (diff.added.length || diff.removed.length || diff.identity.length) {
        return {
            kind: 'identity',
            message:
                'MISMATCH (IDENTITY): the set or grouping of faces changed, not just their\n'
                + 'contents. A face appeared or vanished, or a group that was one variable\n'
                + 'file is now per-weight (or the reverse). Read the grouping before\n'
                + 'anything else — a metric capture cannot answer this.\n'
                + (diff.added.length ? `  added:   ${diff.added.join(', ')}\n` : '')
                + (diff.removed.length ? `  removed: ${diff.removed.join(', ')}\n` : '')
                + (diff.identity.length ? `${renderDiffs(diff.identity)}\n` : ''),
        };
    }
    if (diff.program.length) {
        return {
            kind: 'program',
            message:
                'MISMATCH (FONT PROGRAM): a vendored file\u2019s bytes differ from what was\n'
                + 'locked and measured. This is the case the metric capture exists for.\n'
                + 'Re-run with --write-lock ONLY after re-running the capture in\n'
                + 'docs/implementation-notes/2026-09-01-font-self-hosting.md.\n'
                + `${renderDiffs(diff.program)}\n`
                + (diff.descriptor.length
                    ? `  (${diff.descriptor.length} descriptor diff(s) are also present and are `
                      + 'not the headline here.)\n'
                    : ''),
        };
    }
    if (diff.descriptor.length) {
        return {
            kind: 'descriptor',
            message:
                `MISMATCH (DESCRIPTORS ONLY): ${diff.descriptor.length} descriptor field(s) moved `
                + 'and\nEVERY program is byte-identical to the lock. Google has widened a\n'
                + 'unicode-range, which no metric can move — do NOT re-run the metric capture\n'
                + 'for this.\n'
                + `${renderDiffs(diff.descriptor)}\n`
                + '\nAdopting it is a DECISION, not a formality: a wider range makes the\n'
                + 'browser fetch that subset for codepoints it currently lets fall through to\n'
                + 'the next face, and a narrower-than-upstream range leaves a codepoint\n'
                + 'Google intends for this subset served by nothing.\n'
                + 'When you have decided: node scripts/fonts/vendor-fonts.mjs --accept-descriptors\n'
                + 'which rewrites ONLY these fields and refuses if any sha256 has moved.',
        };
    }
    if (diff.orderChanged) {
        return {
            kind: 'order',
            message:
                'MISMATCH (ORDER): the same faces, the same bytes, a different sequence. The\n'
                + 'lock\u2019s sort order is part of what --write-lock freezes, so this is real\n'
                + 'rather than cosmetic — most likely the filename sort met a character where\n'
                + 'code-unit order and collation disagree. Fix the sort, do not adopt the\n'
                + 'reordering.',
        };
    }
    return { kind: 'ok', message: '' };
}

async function main() {
    const write = process.argv.includes('--write-lock');
    const acceptDescriptors = process.argv.includes('--accept-descriptors');
    if (write && acceptDescriptors) {
        throw new Error(
            '--write-lock and --accept-descriptors are mutually exclusive: the first rewrites '
                + 'everything including hashes, the second rewrites descriptors ONLY and refuses '
                + 'if a hash moved. Picking both would defeat the second.',
        );
    }

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

    // `!write && !acceptDescriptors` — the second term is load-bearing and was
    // missing. With `--accept-descriptors` the verify arm ran first, printed
    // its descriptor message and exited 1, so the flag was unreachable DEAD
    // CODE that looked implemented. Found by running it, not by reading it.
    if (!write && !acceptDescriptors) {
        let existing;
        try {
            existing = JSON.parse(await readFile(LOCK, 'utf8'));
        } catch {
            console.error('No lock file. Run with --write-lock to create one.');
            process.exit(1);
        }
        const diff = classifyLockDiff(existing.faces, entries);

        // The DENOMINATORS, printed whether this passes or fails — #2200. A
        // verify that passed because it compared nothing must be
        // distinguishable from one that passed on 17 matching files, and
        // "OK — 72 faces match" alone cannot tell you which.
        const urlCount = new Set(entries.map((e) => e.sha256)).size;
        console.log(
            `[fonts] compared ${entries.length} face(s) over ${urlCount} distinct program(s) `
                + `against ${existing.faces.length} locked face(s)`,
        );

        const verdict = verdictFor(diff);
        if (verdict.kind !== 'ok') {
            console.error(verdict.message);
            process.exit(1);
        }
        console.log(
            `OK — ${entries.length} faces match the lock on identity, program and descriptors.`,
        );
        return;
    }

    if (acceptDescriptors) {
        /**
         * Rewrite the lock's DESCRIPTORS and nothing else — #2200.
         *
         * The point is that adopting an upstream range widening should be
         * cheap and reviewable, and should NOT be reachable by the same lever
         * that adopts a changed font binary. So this refuses on any identity
         * or program difference rather than resolving it: if a hash moved, the
         * metric capture is owed and `--write-lock` is the tool.
         *
         * It writes the lock AND `fonts.css`, because the stylesheet carries all
         * 72 `unicode-range` declarations and is what the browser actually
         * reads — updating the lock alone left the two disagreeing on three
         * distinct ranges and broke `vendored-font-integrity`. Measured: the
         * first version of this flag did exactly that.
         *
         * It writes no font FILES, which is the invariant worth stating: the
         * binaries are asserted unchanged, so the diff a reviewer sees is the
         * ranges and nothing else.
         */
        let existing;
        try {
            existing = JSON.parse(await readFile(LOCK, 'utf8'));
        } catch {
            throw new Error('No lock file. --accept-descriptors updates a lock; it cannot create one.');
        }
        const diff = classifyLockDiff(existing.faces, entries);
        if (diff.added.length || diff.removed.length || diff.identity.length || diff.program.length) {
            throw new Error(
                '--accept-descriptors REFUSED: this is not a descriptors-only change.\n'
                    + `  added: ${diff.added.length}  removed: ${diff.removed.length}  `
                    + `identity: ${diff.identity.length}  program: ${diff.program.length}\n`
                    + 'Run the verify (no flag) to see which axis moved, and use --write-lock\n'
                    + 'only after the metric capture if a program really changed.',
            );
        }
        if (diff.descriptor.length === 0) {
            console.log('Nothing to accept — descriptors already match the lock.');
            return;
        }
        const now = new Map(entries.map((e) => [e.file, e]));
        const faces = existing.faces.map((e) => ({ ...e, unicodeRange: now.get(e.file).unicodeRange }));
        // Asserted rather than assumed: the whole premise of this flag is that
        // the binaries did not move, so prove it against what is being written
        // rather than against what was compared a moment ago.
        for (const e of faces) {
            const fresh = now.get(e.file);
            if (e.sha256 !== fresh.sha256 || e.bytes !== fresh.bytes) {
                throw new Error(`--accept-descriptors would have changed ${e.file}'s program — refusing.`);
            }
        }
        await writeFile(LOCK, `${JSON.stringify({ ...existing, faces }, null, 4)}\n`);
        await writeFile(CSS_OUT, renderStylesheet(blocks));
        console.log(
            `Accepted ${diff.descriptor.length} descriptor change(s) across `
                + `${diff.descriptor.length} face(s) in `
                + `${new Set(diff.descriptor.map((d) => d.rawFile)).size} `
                + 'distinct file(s). Wrote the lock and fonts.css; every sha256 asserted '
                + 'unchanged and no font file written.',
        );
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

    await writeFile(CSS_OUT, renderStylesheet(blocks));

    console.log(
        `Wrote ${filesToWrite.size} file(s) for ${entries.length} faces to public/fonts/, `
            + 'plus the lock and fonts.css.',
    );
}

/**
 * Guarded, so the comparison above is importable without a network fetch —
 * #2200. Measured while adding the classifier: a bare `await import()` of this
 * file ran `main()`, hit Google's css2 endpoint and printed a mismatch, which
 * makes the pure function untestable and an accidental import expensive.
 */
const INVOKED_DIRECTLY =
    process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (INVOKED_DIRECTLY) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}
