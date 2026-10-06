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
 * ── P2.9: what it ranges over, and the three things that were wrong ──
 *
 * The P2.3 version asserted "every `--content-*` tone against that theme's
 * `--bg-default` and `--bg-page`" and called those "the two grounds body text
 * actually sits on". Measured against the codebase, they are not:
 *
 *   `bg-muted`  204 uses      `bg-default`  142 uses
 *   `bg-subtle`  81 uses      `bg-elevated`  52 uses      `bg-page` 32 uses
 *
 * `bg-muted` is the MOST used surface in the app and was outside the gate,
 * along with `bg-subtle` and `bg-elevated`. So the ground list is now DERIVED
 * from the token file — every `bg-*` token that is not the inverted surface,
 * the modal scrim, or one of the five status tints — rather than named, which
 * means a new neutral surface joins the gate the day it is declared.
 *
 * Second, a TRANSLUCENT ground is not the colour its `rgba()` suggests, and
 * measuring it raw flatters or damns it arbitrarily. `--bg-subtle` is taupe at
 * 7 percent in light and green at 30 percent in dark; it renders as whatever
 * is underneath it, tinted. Each translucent surface is therefore flattened
 * onto every opaque surface it can sit on (`bg-page`, `bg-default`) and the
 * WORST result gates. Alpha on the TEXT was already composited; alpha on the
 * GROUND was not, and that is the larger of the two effects here.
 *
 * Third, «Слънце» does not inherit from dark. `resolve()` fell back to
 * `tokens.themes.dark`, but `attributesFor('sunlight')` sets
 * `data-theme="light"` AND `data-contrast="high"` on the same element, so the
 * 105 tokens high-contrast does not override come from LIGHT. The same bug
 * was in `scripts/generate-tokens.mjs`, where it had shipped 58 wrong colours
 * into `AgrentTheme.highContrast` for iOS. Both now walk `CASCADE`.
 *
 * ── what is gated, and what is deliberately not ──
 *
 *   · the 10 body tones on every neutral surface, per theme
 *   · each status tone on its own tint (`content-error` on `bg-error`) — the
 *     pair `src/lib/filters/status-colors.ts` emits as `${bg} ${text}`
 *   · `content-inverted` on every solid surface. Its P2.3 docblock said it was
 *     "excluded BY NAME and asserted separately"; there was no separate
 *     assertion anywhere in the repo, so the tone with 36 call sites was
 *     measured by nothing. It is now measured where it actually rides.
 *
 * NOT gated: the social surfaces `bubble-own` / `bubble-other`, and
 * `presence-*` / `unread`. Presence dots and unread badges are non-text
 * graphics (1.4.11 at 3:1), not body text. The bubbles are body text and DO
 * belong here — but they have ZERO call sites today, and two pairs fail:
 * `content-subtle` on `bubble-own` is 4.34:1 in dark and `content-link` on
 * `bubble-own` is 4.45:1 in light, because P2.2 pointed `bubble-own` at the
 * 16-percent gold `--brand-subtle` rather than mint a colour. Fixing that by
 * moving `--brand-default` to suit a surface nothing renders would churn the
 * brand P2.4 just chose. So the exclusion is CONDITIONAL ON THE ABSENCE and
 * the absence is asserted below: the first `bg-bubble-*` in `src/` reddens
 * this file and forces the pair into the gate.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';
import tokens from '../../design/tokens.json';

const ROOT = path.resolve(__dirname, '../..');

type ThemeKey = 'dark' | 'light' | 'highContrast';
const THEMES: ThemeKey[] = ['dark', 'light', 'highContrast'];

/**
 * The inheritance chain each theme has IN THE BROWSER.
 *
 * `[data-theme="light"]` and `[data-contrast="high"]` are both single
 * attribute selectors, so specificity ties and source order decides:
 * tokens.css declares light at line 733 and high-contrast at line 1106, so
 * high-contrast wins for the tokens it declares and light supplies the rest.
 * Mirrors `CASCADE` in `scripts/generate-tokens.mjs`; the cross-check below
 * ties the two together through the generator's committed output rather than
 * trusting that two copies of a constant stay equal.
 */
const CASCADE: Record<ThemeKey, ThemeKey[]> = {
    dark: ['dark'],
    light: ['light', 'dark'],
    highContrast: ['highContrast', 'light', 'dark'],
};

interface Rgba { r: number; g: number; b: number; a: number }

type ThemeTokens = Record<string, { value: string } | undefined>;
const themed = (t: ThemeKey): ThemeTokens => tokens.themes[t] as ThemeTokens;

/** Resolve a token through `var()` chains, following the theme's cascade. */
function resolve(theme: ThemeKey, name: string, seen = new Set<string>()): string | null {
    if (seen.has(name)) throw new Error(`token cycle at --${name}`);
    seen.add(name);
    let tok: { value: string } | undefined;
    for (const t of CASCADE[theme]) {
        const candidate = themed(t)[name];
        if (candidate) { tok = candidate; break; }
    }
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

/** The opaque surfaces a translucent surface can be painted on top of. */
const OPAQUE_BASES = ['bg-page', 'bg-default'] as const;

const STATUS_TONES = ['success', 'warning', 'error', 'info', 'attention'] as const;

/** Tones that deliberately ride a ground other than the page. */
const RIDES_BRIGHT_SURFACES = new Set(['content-inverted']);

/**
 * Surfaces those tones ride: the inverted surface and the solid status chips.
 *
 * DERIVED, because the status family is not symmetric — there are five tints
 * (`bg-success` … `bg-attention`) but only four solid chips: `attention` has
 * no `-emphasis`. Listing the five by hand is how the first version of this
 * gate failed, and a hand-maintained list would also miss the day one is
 * added.
 */
const SOLID_SURFACES = [
    'bg-inverted',
    ...Object.keys(tokens.themes.dark).filter((n) => /^bg-.*-emphasis$/.test(n)),
];

function contentTones(): string[] {
    return Object.keys(tokens.themes.dark)
        .filter((n) => n.startsWith('content-'))
        .filter((n) => !RIDES_BRIGHT_SURFACES.has(n));
}

/**
 * The neutral surface ramp, DERIVED rather than listed.
 *
 * Every `bg-*` token except the inverted surface (which carries
 * `content-inverted`, gated separately), the modal scrim, and the ten status
 * surfaces (five tints, five solid chips — each gated against its own tone).
 * What is left is the ramp any body tone can land on.
 */
function neutralSurfaces(): string[] {
    const excluded = new Set([
        'bg-overlay',
        ...STATUS_TONES.map((s) => `bg-${s}`),
        ...SOLID_SURFACES,
    ]);
    return Object.keys(tokens.themes.dark)
        .filter((n) => n.startsWith('bg-'))
        .filter((n) => !excluded.has(n));
}

/**
 * Every colour a surface can actually render as, in this theme.
 *
 * Opaque: itself. Translucent: itself flattened onto each opaque base it can
 * sit on — more than one answer, and the worst is the one that gates.
 */
function groundsFor(theme: ThemeKey, surface: string): Array<{ rgba: Rgba; via: string }> {
    const raw = resolve(theme, surface);
    const p = raw ? parse(raw) : null;
    if (!p) return [];
    if (p.a >= 1) return [{ rgba: { ...p, a: 1 }, via: raw as string }];
    return OPAQUE_BASES.map((base) => {
        const b = parse(resolve(theme, base) as string) as Rgba;
        return { rgba: over(p, { ...b, a: 1 }), via: `${raw} over --${base}` };
    });
}

interface Pair { theme: string; tone: string; surface: string; r: number; detail: string }

function measure(theme: ThemeKey, tone: string, surface: string): Pair[] {
    const raw = resolve(theme, tone);
    const fg = raw ? parse(raw) : null;
    const grounds = groundsFor(theme, surface);
    if (!fg || grounds.length === 0) {
        return [{
            theme, tone, surface, r: 0,
            detail: `unresolvable — tone=${raw ?? 'missing'}, grounds=${grounds.length}`,
        }];
    }
    return grounds.map((g) => ({
        theme, tone, surface, r: ratio(fg, g.rgba),
        detail: `${raw} on ${g.via}`,
    }));
}

function gate(label: string, pairs: Pair[], floor: number): void {
    // Printed on the way past, not only on failure: a gate that reports
    // "clean" without saying over what is indistinguishable from one that
    // looked at nothing.
    console.log(`[contrast] ${label}: ${pairs.length} pair(s) measured (floor ${floor})`);
    // An empty selection passes every assertion below it, so the population
    // carries a floor of its own and the count is printed either way.
    if (pairs.length < floor) {
        throw new Error(
            `${label}: measured only ${pairs.length} pair(s), expected at least ${floor}. ` +
                `A check that scans nothing reports "clean".`,
        );
    }
    const failures = pairs.filter((p) => p.r < AA);
    if (failures.length > 0) {
        throw new Error(
            `${label}: ${failures.length} of ${pairs.length} pair(s) below WCAG AA ${AA}:1.\n` +
                `A token comment claiming a ratio is not a measurement — the ground can move ` +
                `underneath it, which is what GAP-CI-77 was:\n  ` +
                failures
                    .map((f) => `${f.theme} --${f.tone} on --${f.surface}: ${f.r.toFixed(2)}:1 — ${f.detail}`)
                    .join('\n  '),
        );
    }
    expect(failures).toEqual([]);
}

describe('WCAG AA contrast, all three themes', () => {
    it('the inputs are real — themes, tones and grounds all resolve', () => {
        // An empty tone list or an unresolvable ground would make every
        // assertion below pass over nothing.
        expect(THEMES.length).toBe(3);
        expect(Object.keys(CASCADE).sort()).toEqual([...THEMES].sort());
        expect(contentTones().length).toBeGreaterThanOrEqual(10);

        // The ramp is derived, so assert WHAT it derived: five surfaces today,
        // and the two the P2.3 gate named must still be among them.
        const ramp = neutralSurfaces();
        expect(ramp).toContain('bg-default');
        expect(ramp).toContain('bg-page');
        expect(ramp.length).toBeGreaterThanOrEqual(5);
        expect(ramp).toEqual(
            expect.arrayContaining(['bg-page', 'bg-default', 'bg-muted', 'bg-subtle', 'bg-elevated']),
        );

        // The solid list is derived too — four status chips plus the inverted
        // surface. `attention` has no `-emphasis`, so five would be wrong.
        expect(SOLID_SURFACES).toContain('bg-inverted');
        expect(SOLID_SURFACES.length).toBeGreaterThanOrEqual(5);
        for (const s of ['success', 'warning', 'error', 'info']) {
            expect(SOLID_SURFACES).toContain(`bg-${s}-emphasis`);
        }
        // No surface may be in both populations, or a failure would be
        // reported twice and a gap could hide in the overlap.
        expect(ramp.filter((n) => SOLID_SURFACES.includes(n))).toEqual([]);

        for (const theme of THEMES) {
            for (const g of [...ramp, ...SOLID_SURFACES, ...STATUS_TONES.map((s) => `bg-${s}`)]) {
                const v = resolve(theme, g);
                expect(`${theme}/${g}=${v ?? 'MISSING'}`).not.toContain('MISSING');
                expect(`${theme}/${g} parses=${parse(v as string) !== null}`).toContain('true');
                expect(groundsFor(theme, g).length).toBeGreaterThanOrEqual(1);
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

    it('CONTROL: a translucent ground is flattened, and that changes the answer', () => {
        // `--bg-subtle` is the case this was wrong about. If `groundsFor`
        // stopped flattening, it would return ONE ground at the raw rgba
        // channels, and `content-subtle` in light would read ~1.4:1 instead
        // of ~4.8:1 — the measurement would collapse, not merely drift.
        const light = parse(resolve('light', 'bg-subtle') as string) as Rgba;
        expect(light.a).toBeLessThan(1);

        const grounds = groundsFor('light', 'bg-subtle');
        expect(grounds).toHaveLength(OPAQUE_BASES.length);
        for (const g of grounds) {
            expect(g.rgba.a).toBe(1);
            // Flattening a 7-percent taupe onto an off-white page lands near
            // white, nowhere near the raw taupe channels.
            expect(g.rgba.r).toBeGreaterThan(200);
            expect(g.via).toContain(' over --bg-');
        }

        // Deliberately a RELATIVE assertion, not `flattened > 4.5`: that
        // threshold would restate the gate below, so reverting a token value
        // would fail this control too and the two signals would stop being
        // separable. What this control owns is that flattening MOVES the
        // answer by a lot — here, more than double.
        const tone = parse(resolve('light', 'content-subtle') as string) as Rgba;
        const flattened = ratio(tone, grounds[0].rgba);
        const raw = ratio(tone, { ...light, a: 1 });
        expect(flattened / raw).toBeGreaterThan(2);
        expect(raw).toBeLessThan(2);

        // An opaque surface yields exactly one ground and is NOT flattened.
        const opaque = groundsFor('light', 'bg-default');
        expect(opaque).toHaveLength(1);
        expect(opaque[0].via).not.toContain(' over ');
    });

    it('CONTROL: «Слънце» inherits from LIGHT, not from dark', () => {
        // The discriminating tokens are the ones high-contrast does NOT
        // override. `content-inverted` is one, and dark and light disagree
        // about it, so a dark fallback is visible rather than a coin flip.
        expect(themed('highContrast')['content-inverted']).toBeUndefined();
        const darkValue = resolve('dark', 'content-inverted');
        const lightValue = resolve('light', 'content-inverted');
        expect(darkValue).not.toEqual(lightValue);
        expect(resolve('highContrast', 'content-inverted')).toEqual(lightValue);

        // And it is not a one-off: count the tokens where the two models
        // disagree, so a regression to `?? dark` is reported with a number.
        const names = Object.keys(tokens.themes.dark);
        const divergent = names.filter((n) => {
            const viaLight = resolve('highContrast', n);
            const own = themed('highContrast')[n];
            if (own) return false;
            return viaLight !== resolve('dark', n);
        });
        expect(divergent.length).toBeGreaterThanOrEqual(50);
        expect(divergent).toContain('bg-inverted');
        expect(divergent).toContain('content-inverted');
    });

    it('CONTROL: the generator resolved «Слънце» the same way', () => {
        // Two copies of a cascade constant can agree with each other while
        // both disagree with what shipped. So read the generator's COMMITTED
        // output and check the arm it emitted for iOS.
        const swift = fs.readFileSync(path.join(ROOT, 'design/Tokens.swift'), 'utf8');
        expect(swift).toContain('highContrast <- light <- dark');

        const arm = (fn: string, theme: string): Rgba => {
            const body = new RegExp(
                `static func ${fn}\\(_ theme: AgrentTheme\\) -> Color \\{[\\s\\S]*?\\n    \\}`,
            ).exec(swift);
            if (!body) throw new Error(`Tokens.swift has no colour func ${fn}`);
            const m = new RegExp(
                `case \\.${theme}: return Color\\(red: ([\\d.]+), green: ([\\d.]+), blue: ([\\d.]+), opacity: ([\\d.]+)\\)`,
            ).exec(body[0]);
            if (!m) throw new Error(`Tokens.swift has no .${theme} arm for ${fn}`);
            return { r: Number(m[1]) * 255, g: Number(m[2]) * 255, b: Number(m[3]) * 255, a: Number(m[4]) };
        };

        for (const [fn, token] of [
            ['contentInverted', 'content-inverted'],
            ['bgInverted', 'bg-inverted'],
            ['bgSuccessEmphasis', 'bg-success-emphasis'],
        ] as const) {
            const want = parse(resolve('highContrast', token) as string) as Rgba;
            const got = arm(fn, 'highContrast');
            expect(`${token}: r=${Math.round(got.r)}`).toBe(`${token}: r=${Math.round(want.r)}`);
            expect(`${token}: g=${Math.round(got.g)}`).toBe(`${token}: g=${Math.round(want.g)}`);
            expect(`${token}: b=${Math.round(got.b)}`).toBe(`${token}: b=${Math.round(want.b)}`);
        }
    });

    it('every body tone clears AA on every neutral surface, in every theme', () => {
        const ramp = neutralSurfaces();
        const tones = contentTones();
        const pairs = THEMES.flatMap((theme) =>
            ramp.flatMap((surface) => tones.flatMap((tone) => measure(theme, tone, surface))),
        );
        // 3 themes x 5 surfaces x 10 tones = 150, plus an extra ground per
        // translucent surface = 170 today. The floor is the PRODUCT, which
        // catches a tone or ground that stops RESOLVING — but note it is
        // computed from `ramp.length`, so narrowing the ramp lowers the floor
        // with it and this gate still passes. Measured: narrowing back to
        // P2.3's two grounds gives 60 pairs against a floor of 60. The teeth
        // against a shrinking POPULATION are therefore the explicit
        // membership assertions in the inputs test above, not this number.
        gate('body tones on the neutral ramp', pairs, THEMES.length * ramp.length * tones.length);
    });

    it('every status tone clears AA on its own tint, in every theme', () => {
        // The pair `status-colors.ts` emits together as `${bg} ${text}`.
        const pairs = THEMES.flatMap((theme) =>
            STATUS_TONES.flatMap((s) => measure(theme, `content-${s}`, `bg-${s}`)),
        );
        gate('status tone on its own tint', pairs, THEMES.length * STATUS_TONES.length);
    });

    it('content-inverted clears AA on every solid surface, in every theme', () => {
        // P2.3 said this was "asserted separately". It was not asserted at
        // all, in any file, while carrying 36 call sites.
        const pairs = THEMES.flatMap((theme) =>
            SOLID_SURFACES.flatMap((surface) => measure(theme, 'content-inverted', surface)),
        );
        gate('content-inverted on solid surfaces', pairs, THEMES.length * SOLID_SURFACES.length);
    });

    it('the social bubble surfaces are still unused — the moment they are not, gate them', () => {
        // Why they are out of the gate at all is in the docblock. This is the
        // teeth: the exclusion is conditional on an absence, so assert the
        // absence rather than trusting it.
        //
        // Via `collectSourceFiles`, not a hand-rolled walk — it throws on an
        // empty result, so the collector cannot be gutted into reporting a
        // clean absence (#865). The floor is set near the live population
        // rather than at 1, so an exclude or extension filter that ate most
        // of `src/` is a failure and not a quiet pass.
        const files = collectSourceFiles({
            roots: ['src'],
            extensions: ['.ts', '.tsx', '.css'],
            floor: 1500,
        });

        const used: string[] = [];
        for (const f of files) {
            const text = fs.readFileSync(f, 'utf8');
            for (const m of text.matchAll(/\b(?:bg|text|border|fill|stroke|ring)-bubble-(own|other)\b/g)) {
                used.push(`${path.relative(ROOT, f)}: ${m[0]}`);
            }
        }
        if (used.length > 0) {
            throw new Error(
                `${used.length} use(s) of a bubble surface utility appeared in src/. The bubble ` +
                    `surfaces are excluded from the contrast gate ONLY because nothing renders ` +
                    `them. Two pairs fail AA on --bubble-own (dark --content-subtle 4.34:1, ` +
                    `light --content-link 4.45:1, both from the 16% gold --brand-subtle P2.2 ` +
                    `pointed it at). Fix those in design/tokens.json and add the bubble ` +
                    `surfaces to the gate above:\n  ` + used.join('\n  '),
            );
        }
        expect(used).toEqual([]);
    });
});
