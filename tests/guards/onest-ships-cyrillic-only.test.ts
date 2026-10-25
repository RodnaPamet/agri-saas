/**
 * Onest ships the Cyrillic cuts and nothing else — #1969.
 *
 * A Bulgarian heading used to fetch `onest-latin.woff2` (33,760 B) to render
 * its SPACE: `U+0020` sits in the latin cut's `U+0000-00FF`, and the Cyrillic
 * cut claims no space, digits or basic punctuation. Every multi-word heading in
 * the product paid it, whatever the words were.
 *
 * The fix drops the cut rather than narrowing its `unicode-range`, because a
 * farm called `Победа 2024` or `Победа OOD` would be straight back to fetching
 * it — digits and latin letters are in the same range and have real shapes.
 * `scripts/fonts/vendor-fonts.mjs` carries the full reasoning.
 *
 * ## Why the concrete facts are asserted, not derived from `NOT_SHIPPED`
 *
 * The obvious shape — read `NOT_SHIPPED` and check each entry is absent — is
 * VACUOUS the moment somebody empties the constant: zero entries, zero
 * assertions, green. So the subsets #1969 is actually about are named as
 * literals here. The constant is checked too, but only for the other failure
 * direction: an exemption that has outlived its target.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
/**
 * ONE constant for both the absence probes and the proof that the path is
 * real. Two separate literals let the probes be aimed at a directory holding
 * no fonts while a hardcoded proof kept passing — measured: that mutation
 * survived, so every absence below was being read from nowhere.
 */
const FONT_DIR = path.join(ROOT, 'public/fonts');
const fontPath = (file: string) => path.join(FONT_DIR, file);
const lock = JSON.parse(read('src/styles/fonts.lock.json')) as {
    faces: { file: string; family: string; subset: string; bytes: number }[];
};

/**
 * Read one export from the vendoring script.
 *
 * `spawnSync` because jest cannot `require` an `.mjs`; the same shape as
 * `tests/unit/fonts/vendor-fonts-verdict.test.ts`, which carries the longer
 * explanation. Importing the module must not run the vendoring — that script
 * guards `main()` behind an entry check precisely so this is safe.
 */
function readExport(name: string): any {
    const script = path.join(ROOT, 'scripts/fonts/vendor-fonts.mjs');
    const program = `
        const m = await import(${JSON.stringify('file://' + path.join(ROOT, 'scripts/fonts/vendor-fonts.mjs'))});
        process.stdout.write(JSON.stringify(m[process.argv[1]]));
    `;
    const r = spawnSync('node', ['--input-type=module', '-e', program, name], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`reading ${name} from ${script} exited ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout);
}

/** The cuts this product does not render in Onest. Literals, deliberately. */
const DROPPED = ['latin', 'latin-ext', 'math', 'symbols', 'vietnamese'] as const;

describe('Onest ships cyrillic only (#1969)', () => {
    it('declares no Onest face for a dropped cut, and no such file ships', () => {
        // Comments stripped: this file's own prose names `onest-latin.woff2`,
        // and so does the generated stylesheet's header. A comment hit would
        // mean the opposite of a defect — the pattern was removed.
        const css = blankNonCode(read('src/styles/fonts.css'));

        // Each named file is probed directly rather than picked out of a
        // directory listing. A listing that came back empty — wrong path, empty
        // directory — would make `listing.includes(file)` false for every one of
        // them, and this test would pass having checked nothing.
        //
        // (The listing call is avoided by NAME as well: the detector in
        // `file-collection-is-not-silently-empty.test.ts` matches its pattern
        // against raw source, so naming that function even in a comment records
        // this file as a hand-rolled collector.)
        for (const subset of DROPPED) {
            const file = `onest-${subset}.woff2`;
            expect({ subset, inCss: css.includes(file) }).toEqual({ subset, inCss: false });
            expect({ subset, onDisk: existsSync(fontPath(file)) }).toEqual({
                subset,
                onDisk: false,
            });
            expect(lock.faces.some((f) => f.family === 'Onest' && f.subset === subset)).toBe(false);
        }
        // An absence is only evidence if the path is real, and it must be the
        // SAME path the probes used — hence `fontPath` for both. Two separate
        // literals let a mutation aim the probes at an empty directory while a
        // hardcoded proof kept passing; that mutation survived until this line
        // was derived from `FONT_DIR` too.
        expect(existsSync(fontPath('onest-cyrillic.woff2'))).toBe(true);
    });

    it('still ships the cuts a Bulgarian UI actually needs', () => {
        // The other failure direction: a trim that took the Cyrillic with it
        // would make every heading system-ui and pass the test above.
        for (const subset of ['cyrillic', 'cyrillic-ext']) {
            const face = lock.faces.find((f) => f.family === 'Onest' && f.subset === subset);
            expect(face).toBeDefined();
            expect(existsSync(fontPath(face!.file))).toBe(true);
        }
    });

    /**
     * The load-bearing premise, re-tested rather than trusted.
     *
     * Dropping the cut costs nothing ONLY because a latin glyph in a heading
     * falls back to Inter, which every `bg` page already preloads. Remove Inter
     * from the heading stack, or stop preloading its latin cut, and the saving
     * silently becomes a 48,256 B cost with headings rendered in system-ui.
     * Nothing else in the suite would notice.
     */
    it('the Inter fallback that makes this free is still in place', () => {
        // Declared in TWO places, which must agree — a stack fixed in one is
        // the defect this covers.
        const sites: [string, string][] = [
            ['tailwind.config.js', blankNonCode(read('tailwind.config.js'))],
            ['src/styles/tokens.css', blankNonCode(read('src/styles/tokens.css'))],
        ];
        for (const [name, src] of sites) {
            const stack = src.match(/(?:heading:|--font-heading:)\s*([^;\]]+)/)?.[1] ?? '';
            const onest = stack.indexOf('Onest');
            const inter = stack.indexOf('Inter');
            expect({ site: name, hasOnest: onest >= 0, hasInter: inter >= 0 }).toEqual({
                site: name,
                hasOnest: true,
                hasInter: true,
            });
            // Inter must come AFTER Onest: before it, Onest never renders at all.
            expect({ site: name, interAfterOnest: inter > onest }).toEqual({
                site: name,
                interAfterOnest: true,
            });
        }

        // And Inter's latin cut must be both shipped and preloaded for bg.
        const interLatin = lock.faces.find((f) => f.family === 'Inter' && f.subset === 'latin');
        expect(interLatin).toBeDefined();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { preloadFaces } = require('../../src/lib/fonts/preload');
        const hrefs = preloadFaces('bg').map((f: { href: string }) => f.href);
        expect(hrefs).toContain(`/fonts/${interLatin!.file}`);
    });

    it('every exemption in NOT_SHIPPED still names a family the lock carries', () => {
        // An exemption for a family nothing ships is an excuse that outlived
        // its target — the same check #2323's guard makes for its own list.
        //
        // Read through a child process, not `require`: jest cannot import an
        // `.mjs` at all ("Must use import to load ES Module"). This is the
        // idiom `tests/unit/fonts/vendor-fonts-verdict.test.ts` already uses
        // for this same script, and it reads the real binding rather than
        // parsing the literal out of the source text.
        const NOT_SHIPPED = readExport('NOT_SHIPPED');
        // A failed extraction yields `{}`, and every loop below would then be
        // vacuous — so the subject is asserted to exist before it is used.
        expect(Object.keys(NOT_SHIPPED).length).toBeGreaterThan(0);
        const families = new Set(lock.faces.map((f) => f.family));
        for (const family of Object.keys(NOT_SHIPPED)) {
            expect({ family, shipped: families.has(family) }).toEqual({ family, shipped: true });
        }
        // And it must still cover the cuts this issue is about, so a re-vendor
        // cannot quietly restore them.
        expect([...NOT_SHIPPED.Onest].sort()).toEqual([...DROPPED].sort());
    });
});
