/**
 * WCAG 1.4.11 non-text contrast, 3:1, for the tokens that draw FOCUS and STATE
 * (#1318).
 *
 * ## Why this is a separate gate from the 4.5:1 one
 *
 * `token-contrast-wcag.test.ts` is text-only by construction: 4.5:1, body text
 * on surfaces, 215 pairs. Nothing in this repo asserted a 3:1 threshold for any
 * token before this file — measured by grep when #1313 widened the text gate,
 * which is how the gap was found. A focus indicator is not text, so it was in
 * no population at all.
 *
 * ## The scope is deliberately NARROW, and that is the whole design
 *
 * 1.4.11 covers "visual information required to identify a component state",
 * and explicitly EXEMPTS boundaries that are not required to identify anything.
 * At the time of writing, 20 of 54 boundary/indicator pairs sat under 3:1 — and
 * most of those are decorative separators that must NOT be "fixed":
 * `--border-subtle` is the repo's documented default for exactly that role
 * ("structural separators … if you have to ask, the answer is subtle"), and
 * darkening every divider in the product to satisfy a threshold that does not
 * apply to them would be a visual regression justified by a misread of the
 * criterion.
 *
 * So this gate polices the tokens that genuinely carry state:
 *
 *   - `--ring` / `--focus-ring` — the focus indicator. `focus-visible:ring-ring`
 *     has 46 call sites; a focus indicator is squarely in scope, and WCAG 2.2's
 *     2.4.13 is stricter still.
 *   - `--border-emphasis` — reserved BY CONVENTION for state ("selected card,
 *     active panel, focused field, hovered click target"), which is what puts it
 *     in scope. If that convention ever changes, this entry should change with
 *     it rather than the token being quietly exempted.
 *
 * Adding a token here is a claim that it identifies a state. Removing one is a
 * claim that it does not — and both belong in a diff someone reads.
 *
 * ## The caveat the measurement cannot see
 *
 * Each mark is treated as sitting directly on its surface. That is right for
 * the common rendering here — a ring drawn as a box-shadow with
 * `ring-offset-*` painted in the surface colour — and wrong for a ring drawn
 * over an adjacent border or a tinted chip. This is a static token-level gate,
 * the same class of evidence as the text one: right about the common case,
 * and no substitute for a browser on the exceptional one.
 */
import tokens from '../../design/tokens.json';

type ThemeKey = 'dark' | 'light' | 'highContrast';
interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

/** Resolution order per theme — must match `scripts/generate-tokens.mjs`. */
const CASCADE: Record<ThemeKey, ThemeKey[]> = {
    dark: ['dark'],
    light: ['light', 'dark'],
    highContrast: ['highContrast', 'light', 'dark'],
};

const THEMES = (tokens as { themes: Record<string, Record<string, { value?: string }>> }).themes;

function resolve(theme: ThemeKey, name: string): string | null {
    for (const layer of CASCADE[theme]) {
        const entry = THEMES[layer]?.[name];
        if (entry && typeof entry.value === 'string') return entry.value;
    }
    return null;
}

function parse(value: string): Rgba | null {
    const v = value.trim();
    const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
    if (fn) {
        const parts = fn[1].split(',').map((p) => p.trim());
        if (parts.length < 3) return null;
        return {
            r: Number(parts[0]),
            g: Number(parts[1]),
            b: Number(parts[2]),
            a: parts.length > 3 ? Number(parts[3]) : 1,
        };
    }
    const hex = v.replace(/^#/, '');
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    if (!/^[0-9a-f]{6}$/i.test(full)) return null;
    return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
        a: 1,
    };
}

/** Composite a translucent mark over its opaque ground. */
function over(fg: Rgba, bg: Rgba): Rgba {
    return {
        r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
        g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
        b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
        a: 1,
    };
}

function luminance({ r, g, b }: Rgba): number {
    const f = (c: number) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(fg: Rgba, bg: Rgba): number {
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
}

/** Tokens that identify a STATE, and so fall inside 1.4.11. */
const INDICATOR_TOKENS = ['ring', 'focus-ring', 'border-emphasis'] as const;
/** The opaque grounds those marks are drawn on. */
const GROUNDS = ['bg-page', 'bg-default'] as const;
const THRESHOLD = 3;

const PAIRS: Array<{ theme: ThemeKey; token: string; ground: string }> = [];
for (const theme of Object.keys(CASCADE) as ThemeKey[]) {
    for (const token of INDICATOR_TOKENS) {
        for (const ground of GROUNDS) {
            PAIRS.push({ theme, token, ground });
        }
    }
}

describe('WCAG 1.4.11 — focus and state indicators reach 3:1', () => {
    it('resolves a non-trivial population (sanity)', () => {
        // A resolver that silently returned null for everything would make
        // every assertion below vacuous. Prove the pairs resolve before
        // trusting any verdict about them.
        const resolved = PAIRS.filter(
            (p) => resolve(p.theme, p.token) && resolve(p.theme, p.ground),
        );
        expect(resolved.length).toBe(PAIRS.length);
        // eslint-disable-next-line no-console -- the denominator IS the output
        console.log(`[nontext-contrast] ${resolved.length} indicator/ground pairs at ${THRESHOLD}:1`);
    });

    it.each(PAIRS)('$theme: --$token on --$ground', ({ theme, token, ground }) => {
        const markRaw = resolve(theme, token);
        const groundRaw = resolve(theme, ground);
        const mark = markRaw && parse(markRaw);
        const bg = groundRaw && parse(groundRaw);
        expect(mark).not.toBeNull();
        expect(bg).not.toBeNull();

        const measured = ratio(over(mark as Rgba, bg as Rgba), bg as Rgba);
        if (measured < THRESHOLD) {
            throw new Error(
                `${theme}: --${token} on --${ground} is ${measured.toFixed(2)}:1, ` +
                    `below WCAG 1.4.11's ${THRESHOLD}:1.\n` +
                    `  mark   ${markRaw}\n  ground ${groundRaw}\n` +
                    `If this token no longer identifies a STATE, remove it from ` +
                    `INDICATOR_TOKENS and say why — do not darken a decorative ` +
                    `separator to satisfy a criterion that does not apply to it.`,
            );
        }
    });

    it('the threshold can FAIL — positive control', () => {
        // Without this, a resolver or compositor bug that made everything
        // measure high would pass forever. A deliberately invisible mark must
        // be reported.
        const bg = parse('#FFFFFF') as Rgba;
        const invisible = parse('rgba(255, 255, 255, 0.05)') as Rgba;
        expect(ratio(over(invisible, bg), bg)).toBeLessThan(THRESHOLD);
    });
});
