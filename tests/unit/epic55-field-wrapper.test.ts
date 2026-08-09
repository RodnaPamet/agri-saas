/**
 * Epic 55 Prompt 3 — field-wrapper architecture contract.
 *
 * Node-env Jest source-inspects the full field-wrapper stack:
 *
 *   1. <FormDescription> — canonical muted hint primitive.
 *   2. <FormError>       — canonical error alert primitive.
 *   3. <FieldGroup>      — grid/vertical layout primitive with optional
 *                          section header and a11y `role="group"`.
 *   4. <FormField>       — composes the three above with Label + control
 *                          and auto-wires a11y props into the child.
 *
 * Standardised rules asserted:
 *   - One canonical gap system (gap-1.5 inside a field, gap-4 between
 *     fields in a group by default).
 *   - Error state takes precedence over description in the hint slot.
 *   - Description uses `text-content-muted`; error uses
 *     `text-content-error` + `role="alert"` + `aria-live="polite"`.
 *   - FieldGroup with `title` renders `role="group"` + `aria-labelledby`.
 *   - FormField uses FormDescription / FormError under the hood so
 *     styling changes stay in one place.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const DESC_SRC = read('src/components/ui/form-description.tsx');
const ERR_SRC = read('src/components/ui/form-error.tsx');
const GROUP_SRC = read('src/components/ui/field-group.tsx');
const FIELD_SRC = read('src/components/ui/form-field.tsx');

// ─── Shared token + CVA discipline ──────────────────────────────

interface Surface {
    label: string;
    src: string;
}

const ALL: Surface[] = [
    { label: 'FormDescription', src: DESC_SRC },
    { label: 'FormError', src: ERR_SRC },
    { label: 'FieldGroup', src: GROUP_SRC },
    { label: 'FormField', src: FIELD_SRC },
];

describe('Epic 55 — field-wrapper architecture: token discipline', () => {
    describe.each(ALL)('$label', (surface) => {
        it('is a client component', () => {
            expect(surface.src).toMatch(/^"use client"/);
        });

        it('uses the cn util', () => {
            expect(surface.src).toMatch(/from ["']@\/lib\/cn["']/);
        });

        it('paints on semantic tokens only', () => {
            const classStrings = surface.src.match(/["'][^"'\n]*["']/g) ?? [];
            for (const cls of classStrings) {
                if (!/\b(bg|text|border|ring)-/.test(cls)) continue;
                expect(cls).not.toMatch(/\bbg-neutral-\d/);
                expect(cls).not.toMatch(/\btext-neutral-\d/);
                expect(cls).not.toMatch(/\bbg-blue-\d/);
                expect(cls).not.toMatch(/\btext-blue-\d/);
                expect(cls).not.toMatch(/\bbg-slate-\d/);
                expect(cls).not.toMatch(/\btext-slate-\d/);
                expect(cls).not.toMatch(/\bbg-white\b/);
            }
        });
    });
});

// ─── FormDescription ────────────────────────────────────────────

describe('FormDescription', () => {
    it('renders as a <p> with the canonical muted rhythm', () => {
        expect(DESC_SRC).toMatch(/<p/);
        expect(DESC_SRC).toMatch(/mt-1\.5/);
        expect(DESC_SRC).toMatch(/text-xs/);
        expect(DESC_SRC).toMatch(/text-content-muted/);
    });

    it('forwards refs and exposes a data attribute for selectors', () => {
        expect(DESC_SRC).toMatch(/React\.forwardRef</);
        expect(DESC_SRC).toMatch(/data-form-description/);
        expect(DESC_SRC).toMatch(
            /FormDescription\.displayName\s*=\s*["']FormDescription["']/,
        );
    });

    it('accepts id + html attrs so FormField can chain it into aria-describedby', () => {
        expect(DESC_SRC).toMatch(
            /HTMLAttributes<HTMLParagraphElement>/,
        );
    });
});

// ─── FormError ──────────────────────────────────────────────────

describe('FormError', () => {
    it('renders with role="alert" + aria-live="polite"', () => {
        expect(ERR_SRC).toMatch(/role=["']alert["']/);
        expect(ERR_SRC).toMatch(/aria-live=["']polite["']/);
    });

    it('uses the error-tone semantic token', () => {
        expect(ERR_SRC).toMatch(/text-content-error/);
        expect(ERR_SRC).toMatch(/text-xs/);
        expect(ERR_SRC).toMatch(/mt-1\.5/);
    });

    it('renders nothing when children is empty', () => {
        expect(ERR_SRC).toMatch(/children\s*!==\s*undefined/);
        expect(ERR_SRC).toMatch(/children\s*!==\s*null/);
        expect(ERR_SRC).toMatch(/children\s*!==\s*false/);
        expect(ERR_SRC).toMatch(/children\s*!==\s*""/);
        expect(ERR_SRC).toMatch(/if \(!hasContent\) return null;/);
    });

    it('supports an explicit `visible` prop for state-driven hiding', () => {
        expect(ERR_SRC).toMatch(/visible\?:\s*boolean/);
        expect(ERR_SRC).toMatch(/if \(!visible\) return null;/);
    });

    it('forwards refs + exposes a data attribute', () => {
        expect(ERR_SRC).toMatch(/React\.forwardRef</);
        expect(ERR_SRC).toMatch(/data-form-error/);
        expect(ERR_SRC).toMatch(
            /FormError\.displayName\s*=\s*["']FormError["']/,
        );
    });
});

// ─── FieldGroup ─────────────────────────────────────────────────

describe('FieldGroup', () => {
    it('renders as a <section> with data-field-group', () => {
        expect(GROUP_SRC).toMatch(/<section/);
        expect(GROUP_SRC).toMatch(/data-field-group/);
    });

    it('exposes columns (1 | 2 | 3) and gap (sm | md | lg) props', () => {
        expect(GROUP_SRC).toMatch(/columns\?:\s*1\s*\|\s*2\s*\|\s*3/);
        expect(GROUP_SRC).toMatch(
            /gap\?:\s*["']sm["']\s*\|\s*["']md["']\s*\|\s*["']lg["']/,
        );
    });

    it('uses a responsive grid for multi-column layouts', () => {
        expect(GROUP_SRC).toMatch(/grid-cols-1["']/);
        expect(GROUP_SRC).toMatch(/sm:grid-cols-2/);
        expect(GROUP_SRC).toMatch(/lg:grid-cols-3/);
    });

    it('default gap is md (gap-default = 16 px after v2-PR-2) — matches form rhythm', () => {
        expect(GROUP_SRC).toMatch(/gap\s*=\s*["']md["']/);
        // Post-v2-PR-2: the FieldGroup `md` size resolves to the
        // semantic `gap-default` token (16 px), not the raw `gap-4`.
        expect(GROUP_SRC).toMatch(/md:\s*["']gap-default["']/);
    });

    it('renders a section heading that links via aria-labelledby', () => {
        expect(GROUP_SRC).toMatch(/titleAs\?:\s*["']h2["']\s*\|\s*["']h3["']\s*\|\s*["']h4["']/);
        expect(GROUP_SRC).toMatch(/role=\{hasTitle\s*\?\s*["']group["']\s*:\s*undefined\}/);
        expect(GROUP_SRC).toMatch(/aria-labelledby=\{headingId\}/);
    });

    it('uses FormDescription under the section title', () => {
        expect(GROUP_SRC).toMatch(/from ["']\.\/form-description["']/);
        expect(GROUP_SRC).toMatch(/<FormDescription/);
    });

    it('title uses emphasis token; heading id is stable via React.useId', () => {
        expect(GROUP_SRC).toMatch(/text-content-emphasis/);
        expect(GROUP_SRC).toMatch(/React\.useId\(\)/);
    });
});

// ─── FormField (composition) ────────────────────────────────────

describe('FormField — composition with FormDescription + FormError', () => {
    it('imports FormDescription + FormError internally', () => {
        expect(FIELD_SRC).toMatch(/from ["']\.\/form-description["']/);
        expect(FIELD_SRC).toMatch(/from ["']\.\/form-error["']/);
    });

    it('delegates description rendering to FormDescription', () => {
        expect(FIELD_SRC).toMatch(
            /<FormDescription\s+id=\{descriptionId\}>/,
        );
    });

    it('delegates error rendering to FormError', () => {
        expect(FIELD_SRC).toMatch(/<FormError\s+id=\{errorId\}>\{error\}/);
    });

    it('still auto-wires id, aria-describedby, aria-invalid, aria-required, invalid', () => {
        expect(FIELD_SRC).toMatch(/["']aria-describedby["']:\s*describedBy/);
        expect(FIELD_SRC).toMatch(
            /["']aria-invalid["']:\s*hasError\s*\?\s*true/,
        );
        expect(FIELD_SRC).toMatch(/["']aria-required["']:\s*required/);
        expect(FIELD_SRC).toMatch(/invalid:\s*hasError\s*\|\|/);
    });

    it('error takes precedence over description in the hint slot', () => {
        // Description only renders when `!hasError`; error only renders
        // when `hasError`. Rules encoded in one ternary-shaped check.
        expect(FIELD_SRC).toMatch(/description\s*&&\s*!hasError/);
        expect(FIELD_SRC).toMatch(/hasError\s*&&\s*\(\s*<FormError/);
    });

    it('gap-1.5 inside a vertical field — one canonical rhythm', () => {
        expect(FIELD_SRC).toMatch(/flex flex-col gap-1\.5/);
    });

    it('renders required asterisk via RequiredMarker primitive', () => {
        // Roadmap-4 PR-4 — the asterisk markup moved into
        // <RequiredMarker>. The wrapper now mounts the primitive
        // when `required` is true; aria-hidden + text-content-error
        // shape is asserted on the primitive itself by
        // tests/guards/required-marker-discipline.test.ts.
        expect(FIELD_SRC).toMatch(/from\s+["']\.\/required-marker["']/);
        expect(FIELD_SRC).toMatch(/required\s*&&\s*<RequiredMarker\s*\/>/);
    });

    it('supports vertical (default) and horizontal orientations', () => {
        expect(FIELD_SRC).toMatch(
            /orientation\?:\s*["']vertical["']\s*\|\s*["']horizontal["']/,
        );
        expect(FIELD_SRC).toMatch(
            /orientation\s*=\s*["']vertical["']/,
        );
    });
});

// ─── Composition with every shared control primitive ───────────

describe('FormField — composes with every Epic 55 control', () => {
    // The wrapper relies on each control accepting the standard
    // injected props. Smoke-test each primitive's source file for
    // matching prop acceptance so the full stack stays coherent.

    const INPUT_SRC = read('src/components/ui/input.tsx');
    const TEXTAREA_SRC = read('src/components/ui/textarea.tsx');
    const CHECKBOX_SRC = read('src/components/ui/checkbox.tsx');
    const RADIO_SRC = read('src/components/ui/radio-group.tsx');
    const SWITCH_SRC = read('src/components/ui/switch.tsx');
    const COMBOBOX_SRC = read('src/components/ui/combobox/index.tsx');

    const controls = [
        { label: 'Input', src: INPUT_SRC },
        { label: 'Textarea', src: TEXTAREA_SRC },
        { label: 'Checkbox', src: CHECKBOX_SRC },
        { label: 'RadioGroupItem', src: RADIO_SRC },
        { label: 'Switch', src: SWITCH_SRC },
        { label: 'Combobox', src: COMBOBOX_SRC },
    ];

    it.each(controls)('$label accepts an `invalid` prop', ({ src }) => {
        expect(src).toMatch(/invalid\?:\s*boolean/);
    });
});
