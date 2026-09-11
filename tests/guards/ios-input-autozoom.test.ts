/**
 * A focusable text control is at least 16px on a phone.
 *
 * iOS Safari ZOOMS THE PAGE whenever a focused input has a font-size under
 * 16px. It is not configurable and not a preference — it is what Safari does.
 * The zoom shrinks the visual viewport, so whatever the field sits in
 * overflows the screen horizontally and its text clips mid-word.
 *
 * Reported from a field phone as "typing a new task name breaks the whole
 * page", with a screenshot showing the Нова задача sheet magnified and its
 * Bulgarian copy cut off at the right edge. Two earlier fixes — `svh` units
 * and the soft-keyboard lift — were real defects and neither could touch
 * this one, because both are about VERTICAL space and this is horizontal.
 *
 * SIZES THAT TRIGGER IT, all of which were live:
 *     text-[0.76rem]   12.16px   the shared input rung
 *     text-sm          14px      textarea
 *     text-xs          12px
 *
 * THE FIX IS TYPE SIZE, NOT A VIEWPORT LOCK. `maximumScale: 1` in the
 * viewport meta also stops the zoom, by removing pinch-zoom from everyone —
 * an accessibility affordance this app deliberately keeps at scale 5. So the
 * floor is per-control and applies only below the breakpoint, leaving the
 * designed desktop density untouched.
 *
 * This is the same shape as the `min-h-[44px] md:min-h-7` touch-target floor
 * already in `input.tsx`: two independent iOS minimums, one of which had been
 * applied and the other not.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/** Controls a finger taps into and a soft keyboard opens for. */
const TEXT_CONTROLS = [
    'src/components/ui/input.tsx',
    'src/components/ui/textarea.tsx',
    'src/components/ui/combobox/index.tsx',
];

/** Tailwind sizes below the 16px iOS threshold. */
const UNDER_16 = /\btext-(xs|sm)\b|\btext-\[(0?\.\d+)rem\]/g;

/** rem value of a Tailwind size token, or null if it is not a size. */
export function remOf(token: string): number | null {
    if (token === 'text-xs') return 0.75;
    if (token === 'text-sm') return 0.875;
    if (token === 'text-base') return 1;
    const m = /^text-\[(\d*\.?\d+)rem\]$/.exec(token);
    return m ? Number(m[1]) : null;
}

/**
 * A size token is SAFE if it is >= 1rem, or if it is breakpoint-scoped
 * (`md:text-sm`) — a breakpoint prefix means it applies above the phone,
 * where Safari's focus-zoom does not apply.
 */
function stripComments(src: string): string {
    return src
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .map((l) => (/^\s*\*/.test(l) ? '' : l))
        .join('\n');
}

/**
 * Only the EDITABLE ELEMENT's own classes matter.
 *
 * iOS zooms on focus of an input or textarea — not on a 12px label, a hint,
 * an error line or a dropdown option row, all of which legitimately sit below
 * 16px and all of which the first version of this guard flagged. So the scan
 * is scoped to:
 *
 *   · every `cva(...)` call (where a control's base + size variants live);
 *   · every `<input …>` / `<textarea …>` JSX tag;
 *   · any `const NAME = "…"` whose NAME is referenced inside one of those,
 *     because the shared rung is declared outside the cva that uses it.
 */
export function controlRegions(src: string): string[] {
    const code = stripComments(src);
    const regions: string[] = [];

    for (const m of code.matchAll(/\bcva\(/g)) {
        let depth = 0;
        let i = m.index! + m[0].length - 1;
        const start = i;
        for (; i < code.length; i++) {
            if (code[i] === '(') depth++;
            else if (code[i] === ')') { depth--; if (depth === 0) break; }
        }
        regions.push(code.slice(start, i + 1));
    }

    for (const m of code.matchAll(/<(input|textarea)\b/g)) {
        const start = m.index!;
        const end = code.indexOf('>', start);
        regions.push(code.slice(start, end === -1 ? code.length : end + 1));
    }

    // Pull in constants the regions reference by name.
    const joined = regions.join('\n');
    for (const m of code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*((?:"[^"]*"|`[^`]*`|\s|\+)+);/g)) {
        const [, name, value] = m;
        if (new RegExp(`\\b${name}\\b`).test(joined)) regions.push(value);
    }
    return regions;
}

export function unsafeSizes(src: string): string[] {
    const bad: string[] = [];
    for (const region of controlRegions(src)) {
        for (const m of region.matchAll(/(?:^|[\s"'`])((?:[a-z]+:)*)(text-(?:xs|sm|base|\[\d*\.?\d+rem\]))/g)) {
            const [, prefix, token] = m;
            if (prefix) continue; // breakpoint- or state-scoped: not the phone default
            const rem = remOf(token);
            if (rem !== null && rem < 1) bad.push(token);
        }
    }
    return [...new Set(bad)];
}

describe('text controls do not trigger iOS focus-zoom', () => {
    it('the control list resolves — a control on the assertion below', () => {
        // Without this a renamed file empties the selection and every
        // assertion passes over nothing.
        for (const rel of TEXT_CONTROLS) {
            expect({ rel, exists: fs.existsSync(path.join(ROOT, rel)) }).toEqual({
                rel,
                exists: true,
            });
        }
        expect(TEXT_CONTROLS.length).toBeGreaterThanOrEqual(3);
    });

    it('...and the detector separates the safe forms from the unsafe', () => {
        // Fires on an unprefixed sub-16px size ON THE EDITABLE ELEMENT
        expect(unsafeSizes('<input className="text-sm" />')).toEqual(['text-sm']);
        expect(unsafeSizes('<textarea className="text-xs" />')).toEqual(['text-xs']);
        // ...including through a const the control's cva references
        expect(
            unsafeSizes('const RUNG = "px-2.5 text-[0.76rem]";\nconst v = cva([RUNG]);'),
        ).toEqual(['text-[0.76rem]']);

        // ...and stays quiet on every correct form
        for (const ok of [
            '<input className="text-base md:text-[0.76rem]" />',
            '<input className="text-base sm:text-sm" />',
            '<textarea className="text-base" />',
            '// text-sm would zoom on iOS',
        ]) {
            expect({ ok, hits: unsafeSizes(ok) }).toEqual({ ok, hits: [] });
        }

        // ...and does NOT flag copy around the control. A 12px label, hint,
        // error line or option row is fine — iOS zooms on FOCUS of an
        // editable element, nothing else. The first version of this guard
        // flagged all four and would have forced a pointless type sweep.
        for (const bystander of [
            '<label className="text-xs text-content-muted">Заглавие</label>',
            '<p className="mt-1.5 text-xs text-content-error">{error}</p>',
            '<CommandItem className="px-3 py-2 text-sm">{option}</CommandItem>',
        ]) {
            expect({ bystander, hits: unsafeSizes(bystander) }).toEqual({ bystander, hits: [] });
        }
    });

    it('...and it fires on a CORRUPTED REAL FILE, not only a fixture', () => {
        const real = fs.readFileSync(path.join(ROOT, 'src/components/ui/input.tsx'), 'utf-8');
        const corrupted = real.replace('text-base md:text-[0.76rem]', 'text-[0.76rem]');
        expect(corrupted).not.toEqual(real);
        expect(unsafeSizes(corrupted)).toContain('text-[0.76rem]');
    });

    it('no text control sets a phone font-size below 16px', () => {
        const offenders = TEXT_CONTROLS.flatMap((rel) =>
            unsafeSizes(fs.readFileSync(path.join(ROOT, rel), 'utf-8')).map(
                (tok) => `${rel}  ${tok}  — add a breakpoint prefix, or raise to text-base`,
            ),
        );
        expect(offenders).toEqual([]);
    });

    it('the viewport still permits pinch-zoom, so the fix stays in the type scale', () => {
        // If someone "fixes" a future instance with maximumScale: 1, this is
        // the assertion that should stop them.
        const layout = fs.readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf-8');
        const scale = /maximumScale:\s*(\d+)/.exec(layout);
        expect({ found: Boolean(scale), value: scale ? Number(scale[1]) : 0 }).toEqual({
            found: true,
            value: 5,
        });
    });
});
