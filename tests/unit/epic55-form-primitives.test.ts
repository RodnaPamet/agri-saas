/**
 * Epic 55 — shared form primitive contracts.
 *
 * Node-env Jest source-inspects each primitive so the whole set stays
 * on one consistent vocabulary:
 *
 *   - CVA-backed variants (no ad-hoc Tailwind cocktails).
 *   - Semantic tokens everywhere (no raw neutral-/blue-/slate- palette).
 *   - Radix primitive under the hood where one exists (Checkbox /
 *     RadioGroup / Switch / Label).
 *   - Accessibility wiring: aria-invalid, aria-describedby, aria-required,
 *     role="alert" error hint, htmlFor-linked label.
 *
 * Adding a new primitive? Add its file path to the SHARED_CONTRACT
 * list below — the token + CVA assertions run automatically.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const INPUT_SRC = read('src/components/ui/input.tsx');
const TEXTAREA_SRC = read('src/components/ui/textarea.tsx');
const LABEL_SRC = read('src/components/ui/label.tsx');
const CHECKBOX_SRC = read('src/components/ui/checkbox.tsx');
const RADIO_SRC = read('src/components/ui/radio-group.tsx');
const SWITCH_SRC = read('src/components/ui/switch.tsx');
const SCROLL_SRC = read('src/components/ui/scroll-container.tsx');
const FIELD_SRC = read('src/components/ui/form-field.tsx');

// ─── Shared "every primitive must..." assertions ─────────────────

interface PrimitiveSurface {
    label: string;
    src: string;
    /**
     * The primitives with semantic-token palettes only. Radix-backed
     * ones expose a styled Root + maybe Indicator — both should live
     * entirely on tokens.
     */
    tokenized: boolean;
    /** Does this primitive declare a `cva(` block? */
    cva: boolean;
}

const SHARED_CONTRACT: PrimitiveSurface[] = [
    { label: 'Input', src: INPUT_SRC, tokenized: true, cva: true },
    { label: 'Textarea', src: TEXTAREA_SRC, tokenized: true, cva: true },
    { label: 'Label', src: LABEL_SRC, tokenized: true, cva: true },
    { label: 'Checkbox', src: CHECKBOX_SRC, tokenized: true, cva: true },
    { label: 'RadioGroup', src: RADIO_SRC, tokenized: true, cva: true },
    { label: 'Switch', src: SWITCH_SRC, tokenized: true, cva: true },
    { label: 'FormField', src: FIELD_SRC, tokenized: true, cva: false },
];

describe('Epic 55 — shared form primitives: token + CVA discipline', () => {
    describe.each(SHARED_CONTRACT)('$label', (surface) => {
        it('uses the cn() util', () => {
            expect(surface.src).toMatch(/from ["']@\/lib\/cn["']/);
        });

        if (surface.cva) {
            it('declares a CVA variants block', () => {
                expect(surface.src).toMatch(/cva\(/);
                expect(surface.src).toMatch(
                    /from ["']class-variance-authority["']/,
                );
            });
        }

        if (surface.tokenized) {
            it('paints on semantic tokens (no legacy neutral/blue/slate palette)', () => {
                // Legacy Dub palette: neutral-*, blue-*, slate-*. The one
                // allowed exception is `bg-black` inside primitives'
                // internal overlays — but form primitives don't need it.
                for (const forbidden of [
                    /\bbg-neutral-\d/,
                    /\btext-neutral-\d/,
                    /\bborder-neutral-\d/,
                    /\bbg-blue-\d/,
                    /\btext-blue-\d/,
                    /\bbg-slate-\d/,
                    /\btext-slate-\d/,
                    /\bbg-white\b/,
                    /\btext-black\b/,
                ]) {
                    expect(surface.src).not.toMatch(forbidden);
                }
            });
        }
    });
});

// ─── Input ───────────────────────────────────────────────────────

describe('Input — contract', () => {
    it('forwards refs', () => {
        expect(INPUT_SRC).toMatch(/React\.forwardRef/);
        expect(INPUT_SRC).toMatch(/Input\.displayName\s*=\s*["']Input["']/);
    });

    it('exposes size, invalid, error, description props', () => {
        expect(INPUT_SRC).toMatch(/size\?:\s*["']sm["'][\s\S]*?["']md["'][\s\S]*?["']lg["']|size:\s*\{/);
        expect(INPUT_SRC).toMatch(/invalid\?:\s*boolean/);
        expect(INPUT_SRC).toMatch(/error\?:\s*string/);
        expect(INPUT_SRC).toMatch(/description\?:\s*string/);
    });

    it('auto-wires aria-invalid and aria-describedby', () => {
        expect(INPUT_SRC).toMatch(/aria-invalid=\{effectiveInvalid/);
        expect(INPUT_SRC).toMatch(/aria-describedby=\{describedBy\}/);
    });

    it('renders error hint with role="alert" + aria-live', () => {
        expect(INPUT_SRC).toMatch(/role=["']alert["']/);
        expect(INPUT_SRC).toMatch(/aria-live=["']polite["']/);
    });

    it('keeps the password visibility toggle', () => {
        expect(INPUT_SRC).toMatch(/isPasswordVisible/);
        expect(INPUT_SRC).toMatch(/aria-label=\{[\s\S]*?Hide password[\s\S]*?Show password[\s\S]*?\}/);
    });

    it('exports inputVariants for composition', () => {
        expect(INPUT_SRC).toMatch(/export\s+const\s+inputVariants/);
    });
});

// ─── Textarea ────────────────────────────────────────────────────

describe('Textarea — contract', () => {
    it('forwards refs', () => {
        expect(TEXTAREA_SRC).toMatch(/React\.forwardRef/);
        expect(TEXTAREA_SRC).toMatch(
            /Textarea\.displayName\s*=\s*["']Textarea["']/,
        );
    });

    it('exposes invalid, error, description props', () => {
        expect(TEXTAREA_SRC).toMatch(/invalid\?:\s*boolean/);
        expect(TEXTAREA_SRC).toMatch(/error\?:\s*string/);
        expect(TEXTAREA_SRC).toMatch(/description\?:\s*string/);
    });

    it('auto-wires aria-invalid and aria-describedby', () => {
        expect(TEXTAREA_SRC).toMatch(/aria-invalid=\{effectiveInvalid/);
        expect(TEXTAREA_SRC).toMatch(/aria-describedby=\{describedBy\}/);
    });

    it('renders error hint with role="alert" + aria-live', () => {
        expect(TEXTAREA_SRC).toMatch(/role=["']alert["']/);
        expect(TEXTAREA_SRC).toMatch(/aria-live=["']polite["']/);
    });
});

// ─── Label ───────────────────────────────────────────────────────

describe('Label — contract', () => {
    it('wraps @radix-ui/react-label', () => {
        expect(LABEL_SRC).toMatch(/from ["']@radix-ui\/react-label["']/);
    });

    it('uses the content-emphasis semantic token', () => {
        expect(LABEL_SRC).toMatch(/text-content-emphasis/);
    });

    it('has a peer-disabled rule so disabled controls dim the label', () => {
        expect(LABEL_SRC).toMatch(/peer-disabled:/);
    });
});

// ─── Checkbox ────────────────────────────────────────────────────

describe('Checkbox — contract', () => {
    it('wraps @radix-ui/react-checkbox', () => {
        expect(CHECKBOX_SRC).toMatch(
            /from ["']@radix-ui\/react-checkbox["']/,
        );
    });

    it('paints the checked state on brand-emphasis tokens', () => {
        expect(CHECKBOX_SRC).toMatch(
            /data-\[state=checked\]:bg-brand-emphasis/,
        );
        expect(CHECKBOX_SRC).toMatch(
            /data-\[state=indeterminate\]:bg-brand-emphasis/,
        );
    });

    it('exposes a size variant (sm / md / lg)', () => {
        expect(CHECKBOX_SRC).toMatch(/sm:\s*["']h-4 w-4["']/);
        expect(CHECKBOX_SRC).toMatch(/md:\s*["']h-5 w-5["']/);
        expect(CHECKBOX_SRC).toMatch(/lg:\s*["']h-6 w-6["']/);
    });

    it('surfaces an invalid prop with data-invalid + aria-invalid wiring', () => {
        expect(CHECKBOX_SRC).toMatch(/invalid\?:\s*boolean/);
        expect(CHECKBOX_SRC).toMatch(/data-invalid=\{/);
        expect(CHECKBOX_SRC).toMatch(/aria-invalid=\{/);
        expect(CHECKBOX_SRC).toMatch(/data-\[invalid\]:border-border-error/);
    });
});

// ─── RadioGroup ──────────────────────────────────────────────────

describe('RadioGroup — contract', () => {
    it('wraps @radix-ui/react-radio-group', () => {
        expect(RADIO_SRC).toMatch(
            /from ["']@radix-ui\/react-radio-group["']/,
        );
    });

    it('drops the legacy border-primary / text-primary classes', () => {
        // Scan runtime string literals (cva base class lists + className
        // strings) rather than docstrings.
        const stringLiterals = RADIO_SRC.match(/["'][^"'\n]*["']/g) ?? [];
        for (const lit of stringLiterals) {
            expect(lit).not.toMatch(/\bborder-primary\b/);
            expect(lit).not.toMatch(/\btext-primary\b/);
        }
    });

    it('paints the checked state on brand-emphasis tokens', () => {
        expect(RADIO_SRC).toMatch(
            /data-\[state=checked\]:border-brand-emphasis/,
        );
        expect(RADIO_SRC).toMatch(/bg-brand-emphasis/);
    });

    it('exposes size variants that line up with Checkbox', () => {
        expect(RADIO_SRC).toMatch(/sm:\s*["']h-4 w-4["']/);
        expect(RADIO_SRC).toMatch(/md:\s*["']h-5 w-5["']/);
        expect(RADIO_SRC).toMatch(/lg:\s*["']h-6 w-6["']/);
    });

    it('surfaces invalid state', () => {
        expect(RADIO_SRC).toMatch(/invalid\?:\s*boolean/);
        expect(RADIO_SRC).toMatch(/data-invalid=\{/);
    });
});

// ─── Switch ──────────────────────────────────────────────────────

describe('Switch — contract', () => {
    it('wraps @radix-ui/react-switch', () => {
        expect(SWITCH_SRC).toMatch(/from ["']@radix-ui\/react-switch["']/);
    });

    it('declares track + thumb CVA blocks', () => {
        expect(SWITCH_SRC).toMatch(/switchTrackVariants\s*=\s*cva\(/);
        expect(SWITCH_SRC).toMatch(/switchThumbVariants\s*=\s*cva\(/);
    });

    it('paints the checked state on brand-emphasis', () => {
        expect(SWITCH_SRC).toMatch(
            /data-\[state=checked\]:bg-brand-emphasis/,
        );
    });

    it('preserves the disabledTooltip affordance from the legacy API', () => {
        expect(SWITCH_SRC).toMatch(/disabledTooltip/);
        expect(SWITCH_SRC).toMatch(/<Tooltip content=\{disabledTooltip\}>/);
    });

    it('exposes a clean size API (no trackDimensions / thumbDimensions grab-bag)', () => {
        // Check the props surface, not the docstring — the rationale
        // block intentionally names the legacy knobs it replaced.
        expect(SWITCH_SRC).not.toMatch(/trackDimensions\?:/);
        expect(SWITCH_SRC).not.toMatch(/thumbDimensions\?:/);
        expect(SWITCH_SRC).not.toMatch(/thumbTranslate\?:/);
    });

    it('surfaces invalid state', () => {
        expect(SWITCH_SRC).toMatch(/invalid\?:\s*boolean/);
    });
});

// ─── ScrollContainer ─────────────────────────────────────────────

describe('ScrollContainer — tokenised gradient', () => {
    it('no longer uses the hardcoded `from-white` gradient in className', () => {
        // Docstring may reference it historically; scan className strings only.
        const classNameMatches = SCROLL_SRC.match(/className="[^"]*"/g) ?? [];
        for (const cls of classNameMatches) {
            expect(cls).not.toMatch(/from-white/);
        }
    });

    it('fades on the bg-default semantic token', () => {
        expect(SCROLL_SRC).toMatch(/from-bg-default/);
    });
});

// ─── FormField ───────────────────────────────────────────────────

describe('FormField — composition + a11y', () => {
    it('imports the shared <Label> primitive', () => {
        expect(FIELD_SRC).toMatch(/from ["']\.\/label["']/);
    });

    it('uses React.useId to derive a stable control id', () => {
        expect(FIELD_SRC).toMatch(/React\.useId\(\)/);
    });

    it('links the label to the control via htmlFor', () => {
        expect(FIELD_SRC).toMatch(/htmlFor=\{controlId\}/);
    });

    it('chains the aria-describedby with description + error ids', () => {
        expect(FIELD_SRC).toMatch(/aria-describedby/);
        expect(FIELD_SRC).toMatch(/-description/);
        expect(FIELD_SRC).toMatch(/-error/);
    });

    it('sets aria-invalid on the child control when error is present', () => {
        expect(FIELD_SRC).toMatch(
            /["']aria-invalid["']:\s*hasError\s*\?\s*true/,
        );
    });

    it('sets aria-required when required', () => {
        expect(FIELD_SRC).toMatch(
            /["']aria-required["']:\s*required/,
        );
    });

    it('renders the required marker via the RequiredMarker primitive', () => {
        // Roadmap-4 PR-4 — the asterisk markup moved into
        // <RequiredMarker>. The wrapper now mounts the primitive
        // when `required` is true; aria-hidden + text-content-error
        // shape is asserted on the primitive itself by
        // tests/guards/required-marker-discipline.test.ts.
        expect(FIELD_SRC).toMatch(/from\s+["']\.\/required-marker["']/);
        expect(FIELD_SRC).toMatch(/required\s*&&\s*<RequiredMarker\s*\/>/);
    });

    it('delegates error rendering to <FormError> (which carries role=alert + aria-live)', () => {
        // After Prompt 3 the role="alert" + aria-live="polite" live on
        // FormError. FormField simply renders <FormError>.
        expect(FIELD_SRC).toMatch(/<FormError\b/);
    });

    it('supports horizontal and vertical orientations', () => {
        expect(FIELD_SRC).toMatch(/orientation\?:\s*["']vertical["']/);
        expect(FIELD_SRC).toMatch(/["']horizontal["']/);
    });
});
