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
/**
 * Index of the `>` that closes a JSX tag. A plain indexOf('>') stops at
 * the arrow in `onChange={(e) => …}` and truncates the tag before any
 * className written after it — the region then looks clean because the
 * offending class was never in it.
 */
export function tagEnd(code: string, start: number): number {
    let depth = 0;
    let quote = '';
    for (let i = start; i < code.length; i++) {
        const c = code[i];
        if (quote) { if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) return i;
    }
    return code.length - 1;
}

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
        regions.push(code.slice(start, tagEnd(code, start) + 1));
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

/* ─────────────────────────────────────────────────────────────────────
 * #910 fixed this defect in its Tailwind spelling. It has a SECOND
 * spelling that the original guard structurally could not see: a CSS
 * class. `.input { @apply … text-sm … }` in globals.css put 14px on the
 * login and MFA fields — the first two screens a phone user meets — and
 * on 29 editable elements besides. The guard was green throughout,
 * because it scanned three .tsx files for Tailwind utilities and the
 * offender was neither.
 *
 * So the scan is widened on both axes: every .tsx file (not three), and
 * the stylesheet behind whatever class those files put on an editable
 * element. The class list is DERIVED from the JSX, never enumerated —
 * an enumerated list silently stops covering the thing it was written
 * for the moment someone adds a class to it.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Tree-wide scan, tag-only. `unsafeSizes` also reads every cva() call,
 * which is correct inside a text control's own module and wrong
 * everywhere else — pointed at all 837 .tsx files it flags badge,
 * label, status-badge and typography, none of which can be focused.
 */
/**
 * Input types that open NO keyboard, so Safari never focus-zooms them:
 * a file picker, a checkbox, a colour well, a slider. `type="file"` is
 * not hypothetical — the cost-entry invoice picker carries `text-xs`
 * legitimately, and the first version of this scan demanded it be
 * "fixed" to 16px, which would have changed a visual for no reason.
 */
const NON_TEXT_INPUT =
    /type\s*=\s*["']?(file|checkbox|radio|submit|button|reset|image|hidden|range|color)["']?/;

/** The `cva(...)` body bound to `const NAME = cva(`, or null. */
export function cvaBodyNamed(code: string, name: string): string | null {
    const m = new RegExp(`const\\s+${name}\\s*(?::[^=]+)?=\\s*cva\\(`).exec(code);
    if (!m) return null;
    let depth = 0;
    const start = m.index + m[0].length - 1;
    for (let i = start; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') { depth--; if (depth === 0) return code.slice(start, i + 1); }
    }
    return null;
}

export function unsafeSizesOnTags(src: string): string[] {
    const bad: string[] = [];
    const code = stripComments(src);
    for (const region of controlRegions(src)) {
        if (!/^<(input|textarea)\b/.test(region.trim())) continue;
        if (NON_TEXT_INPUT.test(region)) continue;

        // Also scan any cva() the TAG'S OWN className calls. number-stepper
        // put its 14px in `stepperInputVariants` and left the tag itself
        // size-less, so a tag-only scan read it as clean — the audit found it,
        // this did not. Scoping to the cva the input actually references is
        // what keeps badge/label/typography cva out of range; pulling in every
        // cva in the tree flagged all of those and was wrong.
        const scopes = [region];
        for (const id of region.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
            const body = cvaBodyNamed(code, id[1]);
            if (body) scopes.push(body);
        }
        for (const scope of scopes) {
            for (const m of scope.matchAll(/(?:^|[\s"'`])((?:[a-z]+:)*)(text-(?:xs|sm|base|\[\d*\.?\d+rem\]))/g)) {
                const [, prefix, token] = m;
                if (prefix) continue;
                const rem = remOf(token);
                if (rem !== null && rem < 1) bad.push(token);
            }
        }
    }
    return [...new Set(bad)];
}

const GLOBALS = 'src/app/globals.css';

/** Every .tsx in src/, so a raw <input> cannot hide outside a curated list. */
export function allTsx(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.tsx')) out.push(full);
        }
    };
    walk(path.join(root, 'src'));
    return out;
}

/** Bare class tokens that some .tsx puts on an <input>/<textarea>. */
export function classesOnEditables(src: string): string[] {
    const found: string[] = [];
    for (const region of controlRegions(src)) {
        if (!/^<(input|textarea)\b/.test(region.trim())) continue;
        for (const m of region.matchAll(/className\s*=\s*"([^"]*)"/g)) {
            for (const tok of m[1].split(/\s+/)) {
                if (/^[a-zA-Z][\w-]*$/.test(tok)) found.push(tok);
            }
        }
    }
    return [...new Set(found)];
}

/** The declaration body of `.cls { … }`, or null when no such rule exists. */
export function cssRuleBody(css: string, cls: string): string | null {
    // `m` flag, anchored per line: the rule may follow a COMMENT rather
    // than a closing brace, which a `(?:^|\\})` anchor silently misses —
    // `.input` does exactly that, and the control above caught it.
    const m = new RegExp(`^\\s*\\.${cls}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    return m ? m[1] : null;
}

/** Unprefixed sub-16px sizes inside an @apply body. Same rule as the JSX side. */
export function unsafeInApply(body: string): string[] {
    const bad: string[] = [];
    for (const m of body.matchAll(/(?:^|[\s"'`])((?:[a-z]+:)*)(text-(?:xs|sm|base|\[\d*\.?\d+rem\]))/g)) {
        const [, prefix, token] = m;
        if (prefix) continue;
        const rem = remOf(token);
        if (rem !== null && rem < 1) bad.push(token);
    }
    return [...new Set(bad)];
}

describe('the CSS-class spelling of the same defect', () => {
    it('the derivation resolves — a control on the assertion below', () => {
        // If this ever reads 0, the assertion beneath it is vacuous and
        // an empty selection would be reported as a clean PASS.
        const css = fs.readFileSync(path.join(ROOT, GLOBALS), 'utf-8');
        const classes = new Set<string>();
        for (const f of allTsx(ROOT)) {
            for (const c of classesOnEditables(fs.readFileSync(f, 'utf-8'))) classes.add(c);
        }
        const styled = [...classes].filter((c) => cssRuleBody(css, c) !== null);
        expect({
            tsxScanned: allTsx(ROOT).length > 100,
            classFound: styled.includes('input'),
        }).toEqual({ tsxScanned: true, classFound: true });
    });

    it('...and it fires on a CORRUPTED REAL globals.css, not only a fixture', () => {
        const real = fs.readFileSync(path.join(ROOT, GLOBALS), 'utf-8');
        const corrupted = real.replace(
            'px-3 py-2 text-base md:text-sm transition-all',
            'px-3 py-2 text-sm transition-all',
        );
        expect(corrupted).not.toEqual(real); // the anchor still exists
        expect(unsafeInApply(cssRuleBody(corrupted, 'input')!)).toEqual(['text-sm']);
    });

    it('the tag scan spans the WHOLE tag, where indexOf would stop at an arrow', () => {
        // Without this, reverting `tagEnd` to `code.indexOf('>')` passes every
        // other assertion in this file — the scan just silently stops seeing
        // any className written after an event handler. Reverting it hid SEVEN
        // real offenders (CanvasDocumentBar, ProcessInspector x3, WidgetPicker
        // x2, SpatialImportModal) and nothing went red. This is the assertion
        // that makes that revert cost something.
        const tag = '<input onChange={(e) => setX(e)} className="text-xs" />';
        expect(tag.indexOf('>')).toBeLessThan(tag.length - 2); // indexOf IS fooled
        expect(tagEnd(tag, 0)).toBe(tag.length - 1);           // tagEnd is not
        expect(unsafeSizesOnTags(tag)).toEqual(['text-xs']);   // ...so the class is seen
    });

    it('no CSS class used on an editable element sets a phone font-size below 16px', () => {
        const css = fs.readFileSync(path.join(ROOT, GLOBALS), 'utf-8');
        const offenders: string[] = [];
        for (const f of allTsx(ROOT)) {
            for (const cls of classesOnEditables(fs.readFileSync(f, 'utf-8'))) {
                const body = cssRuleBody(css, cls);
                if (!body) continue;
                const bad = unsafeInApply(body);
                if (bad.length) offenders.push(`.${cls} { ${bad.join(' ')} }`);
            }
        }
        expect([...new Set(offenders)]).toEqual([]);
    });

    it('no raw <input>/<textarea> anywhere in src/ sets one either', () => {
        const offenders: string[] = [];
        for (const f of allTsx(ROOT)) {
            const bad = unsafeSizesOnTags(fs.readFileSync(f, 'utf-8'));
            if (bad.length) offenders.push(`${path.relative(ROOT, f)}: ${bad.join(' ')}`);
        }
        expect(offenders).toEqual([]);
    });
});

/* ─────────────────────────────────────────────────────────────────────
 * CONTENTEDITABLE, and why inheritance is not a defence.
 *
 * The journal entry body is a Tiptap `EditorContent` — a contenteditable
 * div, which Safari focus-zooms exactly like an <input>. It escaped every
 * assertion above for three independent reasons, each sufficient on its
 * own:
 *
 *   1. it is neither <input> nor <textarea>, so the tag scan never saw it;
 *   2. its class lives in a JS object (`editorProps.attributes.class`),
 *      not a `className=` attribute, so the class scan never saw it;
 *   3. it declared NO size at all and INHERITED `Modal.Body`'s `text-sm`
 *      (14px) — and an element with no size class looks clean to any
 *      check that only reads the element's own classes.
 *
 * (3) is the general lesson: inheritance is invisible to a per-element
 * scan, and tracing every ancestor chain statically is not tractable. So
 * the rule inverts — a text-entry surface MUST DECLARE its own phone-safe
 * size. Declaring it is cheap; proving what it inherits is not.
 *
 * `prose-sm` sat on this element looking like a font-size. It is inert:
 * @tailwindcss/typography is not installed and not in tailwind.config.js,
 * so every `prose*` class in this repo produces no CSS. A class that
 * looks load-bearing and is not is worse than no class.
 * ───────────────────────────────────────────────────────────────────── */

/** Class strings applied to a contenteditable surface. */
export function contentEditableClasses(src: string): string[] {
    const code = stripComments(src);
    const out: string[] = [];

    // Tiptap/ProseMirror: editorProps: { attributes: { class: '…' } }
    //
    // Balanced braces, not a character budget. The first spelling capped the
    // block at 400 chars and matched NOTHING here — stripped comment lines
    // leave blank indentation that pushes the real block past any such cap,
    // and the detector then reported zero offenders as a clean pass. The
    // control above is what caught it.
    for (const m of code.matchAll(/attributes\s*:\s*\{/g)) {
        const open = code.indexOf('{', m.index!);
        let depth = 0;
        let end = open;
        for (let i = open; i < code.length; i++) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        const block = code.slice(open + 1, end);
        const cls = /\bclass\s*:\s*([\s\S]*?),\s*(?:['"`]?[\w-]+['"`]?\s*:|$)/.exec(block);
        if (cls) out.push(cls[1]);
    }
    // Plain JSX contenteditable
    for (const m of code.matchAll(/<[A-Za-z][\w.]*\b[^>]*\bcontentEditable\b/g)) {
        const end = tagEnd(code, m.index!);
        out.push(code.slice(m.index!, end + 1));
    }
    return out;
}

/** Does a class string declare an UNPREFIXED size of at least 16px? */
export function declaresPhoneSafeSize(cls: string): boolean {
    for (const m of cls.matchAll(
        /(?:^|[\s"'`])((?:[a-z]+:)*)(text-(?:xs|sm|base|lg|xl|\[\d*\.?\d+rem\]))/g,
    )) {
        const [, prefix, token] = m;
        if (prefix) continue;
        const rem = token === 'text-lg' || token === 'text-xl' ? 1.25 : remOf(token);
        if (rem !== null && rem >= 1) return true;
    }
    return false;
}

describe('contenteditable surfaces declare their own phone font-size', () => {
    it('the detector finds the editors that exist — a control on the assertion below', () => {
        // Without this, a detector that matches nothing reports zero
        // offenders and passes. RichTextEditor is the known population.
        const src = fs.readFileSync(
            path.join(ROOT, 'src/components/ui/RichTextEditor.tsx'),
            'utf-8',
        );
        expect(contentEditableClasses(src).length).toBeGreaterThan(0);
    });

    it('...and it rejects the inherit-only spelling that shipped', () => {
        // The exact string that was live, which looked fine and was not.
        expect(
            declaresPhoneSafeSize("'prose prose-sm prose-invert max-w-none p-4 focus:outline-none'"),
        ).toBe(false);
        // A breakpoint-scoped size is NOT a phone size.
        expect(declaresPhoneSafeSize("'md:text-base'")).toBe(false);
        expect(declaresPhoneSafeSize("'text-base md:text-sm'")).toBe(true);
    });

    it('every contenteditable in src/ declares an unprefixed >=16px size', () => {
        const offenders: string[] = [];
        for (const f of allTsx(ROOT)) {
            for (const cls of contentEditableClasses(fs.readFileSync(f, 'utf-8'))) {
                if (!declaresPhoneSafeSize(cls)) {
                    offenders.push(`${path.relative(ROOT, f)}: ${cls.trim().slice(0, 72)}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('prose* classes are inert here, so none of them may stand in for a size', () => {
        // If the typography plugin is ever installed, `prose-sm` starts
        // setting 0.875rem and silently re-breaks every editor relying on
        // the sibling `text-base`. This assertion is the tripwire.
        const cfg = fs.readFileSync(path.join(ROOT, 'tailwind.config.js'), 'utf-8');
        expect(cfg.includes('@tailwindcss/typography')).toBe(false);
    });
});
