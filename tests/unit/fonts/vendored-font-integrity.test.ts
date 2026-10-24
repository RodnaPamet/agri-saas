/**
 * Vendored web fonts — integrity and descriptor parity (#779).
 *
 * The app self-hosts the exact woff2 files `fonts.googleapis.com` serves.
 * `scripts/fonts/vendor-fonts.mjs` fetches them; this test is what keeps them
 * honest afterwards, and it runs OFFLINE — it never touches the network, so it
 * cannot itself reintroduce the dependency it exists to remove.
 *
 * What it pins, and why each one can fail independently:
 *
 *  1. **Bytes match the lock.** A font swapped, truncated or re-optimised in
 *     place changes text metrics silently. The lock is the only record of what
 *     was measured.
 *  2. **`fonts.css` declares exactly the locked faces**, with the SAME
 *     `unicode-range`. That descriptor is load-bearing twice: it stops a
 *     Latin page downloading the Cyrillic file, and it is what makes
 *     `document.fonts.load(spec, text)` a per-subset probe in the E2E
 *     detector.
 *  3. **Every declared file exists, and every shipped file is declared.**
 *     Both directions — an orphan file ships dead weight into the image; a
 *     missing one is a 404 the CSS cannot report.
 *  4. **No remote URL survives in the CSS.** The point of the change.
 *  5. **One file per (family, subset), never one per weight (#2199).** Each
 *     vendored woff2 is a variable font carrying the whole `wght` axis, and
 *     Google serves one URL for all weights of a family -- so a file per
 *     weight is the same bytes under N names. That cost 1,950,912 B on disk
 *     for 431,792 B of program, and, because a different filename is a
 *     different URL, made a 3-weight page fetch the same file three times.
 *     Asserted as "no two shipped files have the same bytes", which is the
 *     property, rather than as a filename pattern, which is the symptom.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const LOCK_PATH = path.join(ROOT, 'src/styles/fonts.lock.json');
const CSS_PATH = path.join(ROOT, 'src/styles/fonts.css');
const FONT_DIR = path.join(ROOT, 'public/fonts');

interface LockedFace {
    file: string;
    family: string;
    subset: string;
    style: string;
    weight: string;
    unicodeRange: string;
    bytes: number;
    sha256: string;
}

const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as {
    source: string;
    faces: LockedFace[];
};
const css = readFileSync(CSS_PATH, 'utf8');

/** Parse the generated `@font-face` blocks back out of the CSS. */
function parseDeclared(source: string) {
    const out: { family: string; weight: string; file: string; unicodeRange: string }[] = [];
    for (const [, body] of source.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
        const pick = (k: string) => (body.match(new RegExp(`${k}:\\s*([^;]+);`)) ?? [])[1]?.trim();
        out.push({
            family: (pick('font-family') ?? '').replace(/^['"]|['"]$/g, ''),
            weight: pick('font-weight') ?? '',
            file: ((body.match(/url\('\/fonts\/([^']+)'\)/) ?? [])[1] ?? ''),
            unicodeRange: pick('unicode-range') ?? '',
        });
    }
    return out;
}

const declared = parseDeclared(css);

describe('vendored fonts — the lock is the record of what was measured', () => {
    it('locks a non-trivial number of faces (guards against an empty lock passing everything)', () => {
        // Without this, an emptied lock would make every `.each` below vacuous
        // — zero cases, all green. The count is deliberately a floor, not an
        // equality: adding a weight should not fail this test, it should fail
        // the byte checks if the bytes are wrong.
        expect(lock.faces.length).toBeGreaterThan(20);
    });

    /**
     * Once per FILE, not once per face. Since #2199 six Inter faces name one
     * file, so a per-face loop ran the same byte comparison six times under
     * six identical test names — 72 cases over 17 files, where a failure named
     * a filename that six cases shared.
     *
     * The per-face half that is NOT redundant is asserted separately below:
     * that every face naming a file agrees with the others about its bytes.
     */
    const lockedByFile = new Map(lock.faces.map((f) => [f.file, f]));

    it.each([...lockedByFile.keys()].sort().map((f) => [f] as const))(
        '%s matches its locked sha256 and byte length',
        (file) => {
            const face = lockedByFile.get(file)!;
            const p = path.join(FONT_DIR, file);
            expect(existsSync(p)).toBe(true);
            const bytes = readFileSync(p);
            expect(bytes.byteLength).toBe(face.bytes);
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(face.sha256);
        },
    );

    it('every face naming a file agrees with the others about its bytes', () => {
        // The lock records bytes + sha256 PER FACE while a file is shared, so
        // the two can disagree inside the lock itself — and the per-file check
        // above reads whichever face it happened to index. A hand-edit that
        // changed one face's sha256 would otherwise be invisible.
        const seen = new Map<string, { bytes: number; sha256: string }>();
        for (const face of lock.faces) {
            const prev = seen.get(face.file);
            if (!prev) {
                seen.set(face.file, { bytes: face.bytes, sha256: face.sha256 });
                continue;
            }
            expect({ file: face.file, bytes: face.bytes, sha256: face.sha256 }).toEqual({
                file: face.file,
                bytes: prev.bytes,
                sha256: prev.sha256,
            });
        }
        // Not vacuous: there must BE shared files for this to range over
        // anything. 72 faces over 17 files today.
        expect(lock.faces.length).toBeGreaterThan(seen.size);
    });
});

describe('fonts.css declares exactly the locked faces', () => {
    /**
     * ── ONE FACE PER FILE, CARRYING THE AXIS RANGE ── #2203
     *
     * This used to assert one `@font-face` per LOCKED FACE — 72 of them, each
     * pinned to a discrete `font-weight`. That pinning clamps the variable
     * `wght` axis to `[w, w]`, so `font-[560]` on every button in the product
     * rendered at 600. Measured in Chromium against this repo's own
     * `inter-latin.woff2`, with the faces' load status asserted so a silent
     * fallback could not be mistaken for a result:
     *
     *     pinned   40px  400:266.406  500:272.406  550:272.406  560:272.406  600:272.406  700:274.406
     *     ranged   40px  400:266.406  500:272.406  550:271.406  560:271.406  600:272.406  700:274.406
     *
     * Everything from 500 to 600 collapsed onto one width; with the range,
     * 550/560/570 get their own. Owner ruled on 2026-10-24 to honour the
     * requested weight, so the generator emits one face per FILE whose
     * `font-weight` is the span of that file's locked weights.
     *
     * The assertions below are STRONGER than the count they replace, not
     * weaker, and that matters because the lazy way to fix a test that fails
     * on an intended change is to delete it. The old one checked a number;
     * these check that every locked weight is inside its file's declared
     * range, that the endpoints are exactly the group's own min and max — so a
     * range wider than the vendored set fails — and that the `unicode-range`
     * still matches the lock face for face.
     */
    const byFile = new Map<string, LockedFace[]>();
    for (const f of lock.faces) {
        if (!byFile.has(f.file)) byFile.set(f.file, []);
        byFile.get(f.file)!.push(f);
    }

    it('declares one @font-face per FILE, not per weight', () => {
        // The denominator beside the claim: 72 locked faces, 17 files.
        expect({ declared: declared.length, files: byFile.size, lockedFaces: lock.faces.length })
            .toEqual({ declared: byFile.size, files: byFile.size, lockedFaces: lock.faces.length });
        expect(declared.length).toBeLessThan(lock.faces.length);
    });

    it.each([...byFile.entries()].map(([file, faces]) => [file, faces] as const))(
        '%s declares exactly its locked weight span, with the locked unicode-range',
        (file, faces) => {
            const d = declared.find((x) => x.file === file);
            expect(d).toBeDefined();

            const weights = faces.map((f) => Number(f.weight)).sort((a, b) => a - b);
            const min = weights[0];
            const max = weights[weights.length - 1];
            // `500` for a single-weight group, `500 700` otherwise — a
            // `500 500` would be legal and would say less than `500`.
            expect(d!.weight).toBe(min === max ? `${min}` : `${min} ${max}`);

            // Every locked weight must be INSIDE the declared range, which is
            // the property the clamp broke.
            for (const w of weights) {
                expect({ file, weight: w, inRange: w >= min && w <= max })
                    .toEqual({ file, weight: w, inRange: true });
            }

            // One `unicode-range` per file, and it must be the one the lock
            // records for every face in the group — a group whose faces
            // disagreed could not be collapsed at all.
            const ranges = [...new Set(faces.map((f) => f.unicodeRange))];
            expect(ranges).toHaveLength(1);
            expect(d!.unicodeRange).toBe(ranges[0]);

            // And the family, so a collapse cannot merge two families onto one
            // file.
            const families = [...new Set(faces.map((f) => f.family))];
            expect(families).toHaveLength(1);
            expect(d!.family).toBe(families[0]);
        },
    );

    it('ships no font file that the CSS does not declare, and declares none it does not ship', () => {
        const onDisk = readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2')).sort();
        // DISTINCT: 72 faces reference 17 files since #2199, so comparing the
        // raw reference list against the directory would fail on the sharing
        // this change exists to introduce.
        const referenced = [...new Set(declared.map((d) => d.file))].sort();
        expect(onDisk).toEqual(referenced);
    });
});

describe('one file per (family, subset) — no weight duplicates (#2199)', () => {
    const onDisk = readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2'));
    const digest = (f: string) =>
        createHash('sha256').update(readFileSync(path.join(FONT_DIR, f))).digest('hex');

    it('no two shipped files carry the same bytes', () => {
        // The property, not the filename pattern. A future family that really
        // does ship static per-weight instances keeps the weight in its name
        // and still passes, because its files differ.
        const byDigest = new Map<string, string[]>();
        for (const f of onDisk) {
            const d = digest(f);
            byDigest.set(d, [...(byDigest.get(d) ?? []), f]);
        }
        const dupes = [...byDigest.values()].filter((g) => g.length > 1);
        expect(dupes).toEqual([]);
    });

    it('[fonts] reports what ships against what the CSS declares', () => {
        // A reading, not a gate — the assertions above are the gate. Printed
        // so a population quietly growing back is visible (#1879).
        const bytes = onDisk.reduce(
            (n, f) => n + readFileSync(path.join(FONT_DIR, f)).byteLength,
            0,
        );
        console.log(
            `[fonts] ${onDisk.length} file(s), ${bytes} B on disk; `
                + `${lock.faces.length} locked face(s) referencing `
                + `${new Set(declared.map((d) => d.file)).size} distinct file(s)`,
        );
        expect(onDisk.length).toBeGreaterThan(10);
        expect(lock.faces.length).toBeGreaterThan(onDisk.length);
    });

    it('every locked face points at a file that exists', () => {
        for (const face of lock.faces) {
            expect({ file: face.file, exists: existsSync(path.join(FONT_DIR, face.file)) })
                .toEqual({ file: face.file, exists: true });
        }
    });
});

describe('the CSS reaches no third party', () => {
    /**
     * Comments stripped first. The generated header legitimately NAMES the
     * origin it vendored from, and a comment cannot cause a fetch — asserting
     * over the whole file would fail on prose while proving nothing extra.
     * What matters is that no RULE references a remote host.
     */
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

    it('contains no remote URL in any rule', () => {
        expect(rules).not.toMatch(/https?:\/\//);
        expect(rules).not.toContain('fonts.googleapis.com');
        expect(rules).not.toContain('fonts.gstatic.com');
    });

    it('the comment-stripping does not make that vacuous', () => {
        // If the stripper ever ate the rules too, the assertion above would
        // pass over an empty string. Pin that it did not.
        expect(rules).toContain('@font-face');
        expect(rules.length).toBeGreaterThan(css.length / 2);
    });

    it('every src is a same-origin /fonts/ path', () => {
        const srcs = [...css.matchAll(/src:\s*url\(([^)]+)\)/g)].map((m) => m[1]);
        // One per FILE since #2203 collapsed the per-weight faces, not one per
        // locked face. Counted against the distinct files the lock names, so
        // this stays a real denominator rather than becoming `srcs.length`
        // compared with itself.
        const lockedFiles = new Set(lock.faces.map((f) => f.file));
        expect(srcs.length).toBe(lockedFiles.size);
        expect(srcs.length).toBeGreaterThan(0);
        for (const s of srcs) expect(s).toMatch(/^'\/fonts\/[^']+\.woff2'$/);
    });
});
