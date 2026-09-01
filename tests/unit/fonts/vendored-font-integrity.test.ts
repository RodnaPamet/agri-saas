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

    it.each(lock.faces.map((f) => [f.file, f] as const))(
        '%s matches its locked sha256 and byte length',
        (file, face) => {
            const p = path.join(FONT_DIR, file);
            expect(existsSync(p)).toBe(true);
            const bytes = readFileSync(p);
            expect(bytes.byteLength).toBe(face.bytes);
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(face.sha256);
        },
    );
});

describe('fonts.css declares exactly the locked faces', () => {
    it('declares one @font-face per locked face', () => {
        expect(declared.length).toBe(lock.faces.length);
    });

    it.each(lock.faces.map((f) => [f.file, f] as const))(
        '%s is declared with the locked family, weight and unicode-range',
        (file, face) => {
            const d = declared.find((x) => x.file === file);
            expect(d).toBeDefined();
            expect(d!.family).toBe(face.family);
            expect(d!.weight).toBe(face.weight);
            // Verbatim: this is what scopes the download per script AND what
            // the E2E detector probes per subset.
            expect(d!.unicodeRange).toBe(face.unicodeRange);
        },
    );

    it('ships no font file that the CSS does not declare', () => {
        const onDisk = readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2')).sort();
        const referenced = declared.map((d) => d.file).sort();
        expect(onDisk).toEqual(referenced);
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
        expect(srcs.length).toBe(lock.faces.length);
        for (const s of srcs) expect(s).toMatch(/^'\/fonts\/[^']+\.woff2'$/);
    });
});
