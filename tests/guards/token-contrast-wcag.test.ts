/**
 * Every text tone clears WCAG AA against the grounds it is used on, in all
 * three themes.
 *
 * ── why this is executed rather than claimed ──
 *
 * The token comments carry contrast numbers — "AA, 7.7:1 on bg-default",
 * "4.31:1 and 2.80:1 respectively", "AAA on white". Every one was measured by
 * hand at some point and then frozen into a comment, where it cannot notice
 * that the ground moved underneath it. GAP-CI-77 is the worked example: the
 * grounds changed to green cards and two tiers silently dropped below 4.5:1.
 *
 * ── what it ranges over, and what it does not ──
 *
 * For each theme, every `--content-*` tone against that theme's `--bg-default`
 * and `--bg-page`. Those are the two grounds body text actually sits on; the
 * full cartesian product of 130 tokens would be mostly meaningless pairs and
 * would bury the real ones.
 *
 * `content-inverted` is excluded BY NAME and asserted separately: it exists to
 * ride bright surfaces (the gold primary button), so measuring it against the
 * dark ground would fail by design.
 *
 * Alpha is composited onto the ground before measuring. An `rgba(...)` tone at
 * 30 percent is not the colour its hex suggests, and comparing the raw channel
 * values would flatter every translucent token in the file.
 */
import tokens from '../../design/tokens.json';

type ThemeKey = 'dark' | 'light' | 'highContrast';
const THEMES: ThemeKey[] = ['dark', 'light', 'highContrast'];

interface Rgba { r: number; g: number; b: number; a: number }

/** Resolve a token through `var()` chains, falling back to dark. */
function resolve(theme: ThemeKey, name: string, seen = new Set<string>()): string | null {
    if (seen.has(name)) throw new Error(`token cycle at --${name}`);
    seen.add(name);
    const themed = tokens.themes[theme] as Record<string, { value: string }>;
    const tok = themed[name] ?? (tokens.themes.dark as Record<string, { value: string }>)[name];
    if (!tok) return null;
    const m = /^var\(--([a-z0-9-]+)\)$/.exec(tok.value.trim());
    return m ? resolve(theme, m[1], seen) : tok.value.trim();
}

function parse(value: string): Rgba | null {
    const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value);
    if (hex) {
        let h = hex[1];
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
            a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
        };
    }
    const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
    if (rgba) {
        return {
            r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]),
            a: rgba[4] === undefined ? 1 : Number(rgba[4]),
        };
    }
    return null;
}

/** Composite a translucent tone onto its ground — alpha changes the answer. */
function over(fg: Rgba, bg: Rgba): Rgba {
    return {
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
    };
}

/** WCAG 2.x relative luminance. */
function luminance({ r, g, b }: Rgba): number {
    const ch = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function ratio(fg: Rgba, bg: Rgba): number {
    const a = luminance(over(fg, bg));
    const b = luminance(bg);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;
const GROUNDS = ['bg-default', 'bg-page'] as const;

/** Tones that deliberately ride a ground other than the page. */
const RIDES_BRIGHT_SURFACES = new Set(['content-inverted']);

function contentTones(): string[] {
    return Object.keys(tokens.themes.dark)
        .filter((n) => n.startsWith('content-'))
        .filter((n) => !RIDES_BRIGHT_SURFACES.has(n));
}

describe('WCAG AA contrast, all three themes', () => {
    it('the inputs are real — themes, tones and grounds all resolve', () => {
        // An empty tone list or an unresolvable ground would make every
        // assertion below pass over nothing.
        expect(THEMES.length).toBe(3);
        expect(contentTones().length).toBeGreaterThanOrEqual(9);
        for (const theme of THEMES) {
            for (const g of GROUNDS) {
                const v = resolve(theme, g);
                expect(`${theme}/${g}=${v ?? 'MISSING'}`).not.toContain('MISSING');
                expect(`${theme}/${g} parses=${parse(v as string) !== null}`).toContain('true');
            }
        }
    });

    it('CONTROL: the maths agrees with WCAG on known pairs', () => {
        const white = parse('#FFFFFF') as Rgba;
        const black = parse('#000000') as Rgba;
        // Black on white is the canonical 21:1.
        expect(ratio(black, white)).toBeCloseTo(21, 1);
        expect(ratio(white, white)).toBeCloseTo(1, 2);
        // And alpha must MATTER: white at 30% over white is still 1:1, but
        // black at 30% over white is far below black's own 21:1.
        const black30 = { ...black, a: 0.3 };
        expect(ratio(black30, white)).toBeCloseTo(2.11, 2);
        // And per channel, so a bug in ONE of r/g/b cannot hide inside a
        // tolerance — a partial-compositing mutation survived the earlier
        // version of this case for exactly that reason.
        expect(over(black30, white)).toEqual({
            r: 178.5, g: 178.5, b: 178.5, a: 1,
        });
    });

    describe.each(THEMES)('%s', (theme) => {
        it.each(GROUNDS)(`every content tone clears AA on %s`, (ground) => {
            const bg = parse(resolve(theme, ground) as string) as Rgba;
            const failures: string[] = [];
            for (const tone of contentTones()) {
                const raw = resolve(theme, tone);
                const fg = raw ? parse(raw) : null;
                if (!fg) {
                    failures.push(`--${tone}: unresolvable (${raw ?? 'missing'})`);
                    continue;
                }
                const r = ratio(fg, bg);
                if (r < AA) {
                    failures.push(`--${tone} on --${ground}: ${r.toFixed(2)}:1 (need ${AA}:1) — ${raw}`);
                }
            }
            if (failures.length > 0) {
                throw new Error(
                    `${theme}: ${failures.length} tone(s) below WCAG AA on --${ground}.\n` +
                        `A token comment claiming a ratio is not a measurement — the ground can move ` +
                        `underneath it, which is what GAP-CI-77 was:\n  ` +
                        failures.join('\n  '),
                );
            }
            expect(failures).toEqual([]);
        });
    });
});
