/**
 * Button label-centering guardrail (2026-05-31).
 *
 * User report: button-styled practices rendered with their text label
 * off-centre / untidy. The Button primitive centres its WHOLE content
 * unit `[icon][gap][label]` via `justify-center` + hug-content (no
 * forced width), so `+ Asset` reads as a tidy centred unit. There are
 * NO balance ghosts — an earlier ghost approach (which centred the
 * label alone and padded the opposite edge with an invisible mirror)
 * was reverted 2026-05-31 on user feedback because it widened buttons
 * with one-sided blank space.
 *
 * This guard has three parts:
 *
 *   1. PRIMITIVE CONTRACT — locks button.tsx so the centring
 *      mechanism (justify-center, no balance ghosts, label wrapper
 *      left-aligns only under `shortcut`) cannot be silently
 *      refactored away. Because every button in the product flows
 *      through this one primitive, locking it here keeps all current
 *      AND future buttons centred.
 *
 *   2. CALL-SITE SCAN — no `<Button>` may pass a className that
 *      overrides the centred layout with a label-shifting class
 *      (`justify-start` / `justify-between` / `justify-end` /
 *      `text-left` / `text-right`). tailwind-merge keeps the LAST
 *      conflicting class, so such an override would defeat the
 *      primitive's centring. `w-full` menu/list buttons are carved
 *      out (left-aligned by convention).
 *
 *   3. PRACTICE-STATUS TRIGGER — hugs its content (no fixed-width void).
 *
 * Behavioural companion (asserts the DOM mechanism per prop shape):
 * tests/rendered/button-label-centering.test.tsx.
 *
 * NOTE on select/combobox triggers: the Combobox primitive renders a
 * deliberately LEFT-aligned trigger (value left, chevron right) — the
 * conventional select shape — via its own internal `justify-start`,
 * NOT via a `<Button className>` override, so it is out of this scan's
 * scope by construction. The practice-status void the user reported was
 * a fixed-width (`w-40`) misuse at one call site, removed so the
 * trigger hugs its content (no void); it is not a primitive defect.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('Button label centering', () => {
    describe('1. Button primitive keeps the centring mechanism', () => {
        const src = read('src/components/ui/button.tsx');

        it('enabled layout (cva base) centres via justify-center', () => {
            const variants = read('src/components/ui/button-variants.ts');
            // The cva base array begins with the layout line.
            expect(variants).toMatch(/inline-flex items-center justify-center/);
        });

        it('disabled-branch layout also centres via justify-center', () => {
            // The disabled/loading branch is a cn-only fallback that
            // does NOT route through the cva variant, so it carries its
            // own justify-center — must move in lockstep.
            expect(src).toMatch(/flex items-center justify-center gap-tight whitespace-nowrap/);
        });

        it('renders NO balance ghosts (the content unit is centred as a whole)', () => {
            // The reverted ghost approach padded the opposite edge with
            // an invisible icon mirror. The current rule centres the
            // whole [icon][label] unit, so neither ghost may return —
            // they reintroduce one-sided blank space.
            expect(src).not.toMatch(/data-icon-balance-ghost/);
            expect(src).not.toMatch(/data-right-balance-ghost/);
        });

        it('label wrapper only left-aligns under `shortcut` (otherwise centred)', () => {
            // The only sanctioned text-left on the label wrapper is the
            // shortcut path (command-palette pattern). A bare,
            // unconditional text-left on the wrapper would left-align
            // every label.
            expect(src).toMatch(/shortcut\s*&&\s*"flex-1 text-left"/);
        });

        it('the ::before AND ::after pseudo-overlays are positioned absolute in the cva base', () => {
            // 2026-05-31 root cause of the persistent "text not centred"
            // report: Tailwind auto-adds `content:""` to a pseudo as soon
            // as ANY `before:`/`after:` utility is used. Without explicit
            // positioning that pseudo is `position:static` → an in-flow
            // 0-width FLEX ITEM. Combined with the button's `gap`, a
            // static ::before pushes the label right (+~4px), a static
            // ::after pushes it left — on solid/glass variants where the
            // surface recipe didn't position its own pseudo. The cva base
            // (`carbonStates`) MUST anchor both pseudos absolute so they
            // never join the flex line. This is the load-bearing centring
            // invariant — do not remove without re-proving centring in a
            // real build (jsdom can't catch it; it only shows under the
            // compiled Tailwind cascade).
            const variants = read('src/components/ui/button-variants.ts');
            const base = variants.slice(
                variants.indexOf('const carbonStates'),
                variants.indexOf('];', variants.indexOf('const carbonStates')),
            );
            expect(base).toMatch(/before:content-\[''\][\s\S]*before:absolute[\s\S]*before:inset-0/);
            expect(base).toMatch(/after:content-\[''\][\s\S]*after:absolute[\s\S]*after:inset-0/);
        });
    });

    describe('2. No <Button> call site overrides the centred layout', () => {
        // Label-shifting Tailwind classes that, applied to a Button's
        // className, override the primitive's justify-center (last
        // conflicting class wins under tailwind-merge) and push the
        // label off-centre.
        const FORBIDDEN =
            /\b(justify-start|justify-between|justify-end|text-left|text-right)\b/;

        // Carve-out: a FULL-WIDTH button (`w-full`) that left-aligns is
        // the conventional menu / action-list item shape (icon + label
        // hugging the leading edge in a vertical stack — Linear /
        // Notion style). That is a deliberate, distinct intent from the
        // header / status practices the centring contract governs, so a
        // forbidden class on a `w-full` button is allowed. A fixed- or
        // content-width button that left-aligns is the bug class (the
        // reported practice-status void was effectively `w-40
        // justify-start`).
        const WIDTH_FULL = /\bw-full\b/;

        // Documented per-file exceptions — file → reason. Empty today;
        // add an entry with a written reason only if a non-`w-full`
        // call site legitimately needs a non-centred label (prefer
        // fixing the design instead).
        const ALLOWED_CALLSITE_OVERRIDES: Record<string, string> = {};

        // Walk src/app + src/components for *.tsx.
        const walk = (dir: string): string[] => {
            const abs = path.join(ROOT, dir);
            if (!fs.existsSync(abs)) return [];
            const out: string[] = [];
            for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
                const rel = path.join(dir, entry.name);
                if (entry.isDirectory()) out.push(...walk(rel));
                else if (entry.name.endsWith('.tsx')) out.push(rel);
            }
            return out;
        };

        const files = [...walk('src/app'), ...walk('src/components')];

        // Extract the opening tag text for each `<Button …>` occurrence,
        // tracking brace depth + quotes so a `>` inside `{…}` or a
        // string doesn't terminate the tag early. Self-closing and
        // children forms both stop at the opening tag's closing `>`.
        const buttonOpeningTags = (s: string): string[] => {
            const tags: string[] = [];
            const re = /<Button(?=[\s/>])/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(s)) !== null) {
                let i = m.index + m[0].length;
                let depth = 0;
                let quote: string | null = null;
                for (; i < s.length; i++) {
                    const c = s[i];
                    if (quote) {
                        if (c === quote) quote = null;
                        continue;
                    }
                    if (c === '"' || c === "'" || c === '`') {
                        quote = c;
                        continue;
                    }
                    if (c === '{') depth++;
                    else if (c === '}') depth--;
                    else if (c === '>' && depth === 0) break;
                }
                tags.push(s.slice(m.index, i + 1));
            }
            return tags;
        };

        it('found Button call sites to scan (sanity)', () => {
            const total = files.reduce(
                (n, f) => n + buttonOpeningTags(read(f)).length,
                0,
            );
            expect(total).toBeGreaterThan(20);
        });

        it('no Button className shifts the label off-centre', () => {
            const violations: string[] = [];
            for (const file of files) {
                if (file in ALLOWED_CALLSITE_OVERRIDES) continue;
                const src = read(file);
                for (const tag of buttonOpeningTags(src)) {
                    // Only inspect className / textWrapperClassName
                    // segments — a forbidden token elsewhere (e.g. an
                    // aria-label string) is not a layout override.
                    const classAttrs = [
                        ...tag.matchAll(
                            /(?:className|textWrapperClassName)=\{?["'`]([^"'`]*)["'`]/g,
                        ),
                    ].map((mm) => mm[1]);
                    for (const cls of classAttrs) {
                        if (FORBIDDEN.test(cls) && !WIDTH_FULL.test(cls)) {
                            violations.push(
                                `${file}: <Button> className contains a label-shifting class without w-full → "${cls.trim()}"`,
                            );
                        }
                    }
                }
            }
            expect(violations).toEqual([]);
        });
    });

    describe('3. Practice-status trigger hugs content (no fixed-width void)', () => {
        it('does not pin the status combobox to a fixed width', () => {
            const page = read(
                'src/app/t/[tenantSlug]/(app)/practices/[practiceId]/page.tsx',
            );
            const idx = page.indexOf('id="practice-status-select"');
            expect(idx).toBeGreaterThan(-1);
            // Inspect the Combobox element around the status select.
            const start = page.lastIndexOf('<Combobox', idx);
            const end = page.indexOf('/>', idx);
            const block = page.slice(start, end);
            // A fixed `w-NN` in buttonProps reintroduces the void the
            // user reported. matchTriggerWidth + a fixed width is the
            // exact anti-pattern; require the trigger to hug content.
            expect(block).not.toMatch(/className:\s*['"][^'"]*\bw-\d/);
            expect(block).not.toMatch(/matchTriggerWidth/);
        });
    });
});
