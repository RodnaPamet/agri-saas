/**
 * Overlays must not size themselves with `vh`.
 *
 * On iOS Safari `vh` is the LARGE viewport: it deliberately ignores the URL
 * bar and the bottom toolbar, so `max-h-[92vh]` is 92% of an area TALLER
 * than the one the user can see. A bottom sheet capped that way has its top
 * — and often its header — off-screen behind the browser chrome.
 *
 *   vh   large viewport, chrome retracted. Overflows what is visible.
 *   svh  SMALL viewport, chrome shown. Always fits. Use this for overlays.
 *   dvh  dynamic; tracks chrome as it hides and shows. Resizes mid-scroll.
 *   lvh  explicitly the large viewport.
 *
 * This was live: `modal.tsx` capped the mobile drawer at `92vh` while
 * `popover.tsx` had already been fixed to `70svh`. One site corrected, four
 * not — the same partial-rollout shape this repo keeps finding elsewhere.
 *
 * SCOPE, stated precisely rather than aspirationally: every `max-h` / `h`
 * arbitrary value in the UI PRIMITIVES DIRECTORY (`src/components/ui/**`),
 * plus the named overlay surfaces that live outside it. That is wider than
 * "overlays" — it caught a loading-spinner container in `table/table.tsx`
 * that this file's first draft described itself as not covering. A guard
 * whose comment claims a narrower scope than its code has is the same
 * defect as one claiming a wider one; both mislead the next reader.
 *
 * `min-h` is deliberately EXCLUDED. A page section with `min-h-[60vh]` is a
 * layout decision — a minimum that exceeds the visible area is intentional
 * there — and blanket conversion would change unrelated pages.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/** Directories whose components are overlay primitives. */
const OVERLAY_DIRS = ['src/components/ui'];
/** Individual overlay surfaces that live outside the primitives directory. */
const OVERLAY_FILES = [
    'src/components/command-palette/command-palette.tsx',
    'src/components/processes/CanvasCommandPalette.tsx',
];

/**
 * `vh` NOT preceded by a letter — i.e. the large-viewport unit rather than
 * `svh` / `dvh` / `lvh`.
 *
 * The first version used `\bvh\b`, which finds NO word boundary in `92vh`
 * because `2` and `v` are both word characters — so the detector silently
 * matched nothing and the guard passed over a file that did contain `92vh`.
 * Caught by the corrupted-real-file control, which is exactly what that
 * control is for.
 */
const BARE_VH = /(?<![a-z])vh(?![a-z])/;
/** A height cap: `max-h-[…]` or `h-[…]`. Not `min-h-[…]`. */
const HEIGHT_CAP = /(?<!min-)\b(?:max-h|h)-\[([^\]]+)\]/g;

export function offendingCaps(src: string): string[] {
    // Comments stripped first: a docblock explaining why `vh` is wrong must
    // not itself trip the detector. That exact false positive has bitten two
    // other guards in this repo.
    const code = src
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, ''))
        .map((l) => (/^\s*\*/.test(l) ? '' : l))
        .join('\n');
    const hits: string[] = [];
    for (const m of code.matchAll(HEIGHT_CAP)) {
        if (BARE_VH.test(m[1])) hits.push(m[0]);
    }
    return hits;
}

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        // A throw, not a silent return. A renamed directory would empty this
        // selection and every assertion below would pass over nothing.
        throw new Error(`overlay scan root does not exist: ${dir}`);
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
}

function overlaySources(): Array<{ rel: string; src: string }> {
    const files = OVERLAY_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
    for (const rel of OVERLAY_FILES) {
        const abs = path.join(ROOT, rel);
        if (!fs.existsSync(abs)) throw new Error(`overlay file does not exist: ${rel}`);
        files.push(abs);
    }
    return files.map((abs) => ({
        rel: path.relative(ROOT, abs),
        src: fs.readFileSync(abs, 'utf-8'),
    }));
}

describe('overlays size themselves with svh, not vh', () => {
    const sources = overlaySources();

    it('the scan found overlay sources — a control on the emptiness below', () => {
        expect(sources.length).toBeGreaterThan(40);
        expect(sources.map((s) => s.rel)).toEqual(
            expect.arrayContaining([
                'src/components/ui/modal.tsx',
                'src/components/ui/popover.tsx',
                'src/components/command-palette/command-palette.tsx',
            ]),
        );
    });

    it('...and the detector distinguishes the units — a control on the assertion', () => {
        // Fires on the broken unit
        expect(offendingCaps('<div className="max-h-[92vh]" />')).toEqual(['max-h-[92vh]']);
        expect(offendingCaps('className="h-[min(85vh,680px)]"')).toEqual(['h-[min(85vh,680px)]']);
        // ...and stays quiet on every correct one
        for (const ok of [
            '<div className="max-h-[92svh]" />',
            '<div className="max-h-[92dvh]" />',
            '<div className="max-h-[min(50svh,250px)]" />',
            // min-h is out of scope on purpose
            '<div className="min-h-[60vh]" />',
            // and a comment explaining the rule must not trip it
            '// never use max-h-[92vh] on an overlay',
        ]) {
            expect({ ok, hits: offendingCaps(ok) }).toEqual({ ok, hits: [] });
        }
    });

    it('...and it fires on a CORRUPTED REAL FILE, not only on a fixture', () => {
        // A control fed only hand-made input proves nothing about the path
        // that executes.
        const real = fs.readFileSync(path.join(ROOT, 'src/components/ui/modal.tsx'), 'utf-8');
        const corrupted = real.replace('max-h-[92svh]', 'max-h-[92vh]');
        expect(corrupted).not.toEqual(real);
        expect(offendingCaps(corrupted)).toEqual(['max-h-[92vh]']);
    });

    it('no TEST pins the broken unit into an overlay source', () => {
        // Three tests asserted the literal `vh` string against overlay source
        // — filter-primitives, modal-primitive and sheet-popover — and each
        // one held the bug in place. A test ratchets a defect IN as readily as
        // it ratchets one out, and a source assertion is the strongest form:
        // it makes fixing the source a test failure.
        //
        // They were found ONE CI RUN AT A TIME, because the first sweep matched
        // guessed spellings (`max-h-[NNvh]`) rather than the thing itself, and
        // missed `--sheet-height:85vh` and `max-h-\[min\(85vh,680px\)\]`.
        // Blacklisting spellings loses to the spelling you did not think of —
        // the same mistake as banning `head -1` and meeting `head -n 1`.
        //
        // Scope: `toMatch` / `toContain` only. A fixture STRING containing
        // `vh` is legitimate — this file is full of them — so the trigger is
        // asserting it, not mentioning it.
        const testFiles = walk(path.join(ROOT, 'tests'))
            .filter((f) => !f.endsWith('overlay-viewport-units.test.ts'));
        const pinned: string[] = [];
        for (const abs of testFiles) {
            const rel = path.relative(ROOT, abs);
            // The offline lane owns its own surfaces; a `60vh` map container
            // there is not an overlay and is not this guard's business.
            if (rel.includes('/offline/') || rel.includes('offline-')) continue;
            const src = fs.readFileSync(abs, 'utf-8');
            src.split('\n').forEach((line, i) => {
                if (!/\.(toMatch|toContain)\(/.test(line)) return;
                if (/^\s*(\/\/|\*)/.test(line)) return;
                if (BARE_VH.test(line)) pinned.push(`${rel}:${i + 1}  ${line.trim().slice(0, 70)}`);
            });
        }
        expect(pinned).toEqual([]);
    });

    it('no overlay caps its height with the large-viewport unit', () => {
        const offenders = sources.flatMap(({ rel, src }) =>
            offendingCaps(src).map((cap) => `${rel}  ${cap}`),
        );
        expect(offenders).toEqual([]);
    });
});
