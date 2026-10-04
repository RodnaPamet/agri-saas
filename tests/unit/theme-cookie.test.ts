/**
 * The theme reaches the first paint — which is the whole point of P2.4.
 *
 * ── the defect ──
 *
 * `layout.tsx` hard-coded `data-theme="dark"` into the SSR markup, and
 * `ThemeProvider` corrected it from localStorage inside a `useEffect`. An
 * effect runs AFTER the first paint, so every `light` or `sunlight` user
 * watched the dark palette render and then flip. Not a race — a guaranteed
 * flash, and localStorage cannot fix it because the server cannot read it.
 *
 * So: a cookie for the server, and an inline pre-paint script for the first
 * visit where only the browser knows `prefers-color-scheme`. Neither alone is
 * enough, and these cases pin both halves.
 */
import {
    THEMES,
    THEME_COOKIE,
    THEME_COOKIE_MAX_AGE,
    attributesFor,
    isThemeName,
    prePaintThemeScript,
} from '@/lib/theme/theme-cookie';

describe('theme narrowing', () => {
    it('accepts exactly the three themes ThemeProvider cycles', () => {
        expect([...THEMES]).toEqual(['dark', 'light', 'sunlight']);
        for (const t of THEMES) expect(isThemeName(t)).toBe(true);
    });

    it('refuses anything else — the value comes from a COOKIE', () => {
        // A cookie is user-controlled. An unrecognised value must fall back,
        // never reach `data-theme` as-is.
        for (const bad of [null, undefined, '', 'DARK', 'sun', 'light ', 42, {}, 'high']) {
            expect(isThemeName(bad)).toBe(false);
        }
    });
});

describe('attributesFor — sunlight is light PLUS contrast', () => {
    it('dark and light set only data-theme', () => {
        expect(attributesFor('dark')).toEqual({ theme: 'dark', contrast: null });
        expect(attributesFor('light')).toEqual({ theme: 'light', contrast: null });
    });

    it('sunlight sets BOTH, because it is the light palette with an overlay', () => {
        // ADR 0002 OD8: "follow the system theme, plus a high-contrast
        // «Слънце» theme". tokens.css implements that as
        // [data-contrast="high"] layered over the light block — so emitting
        // only `data-theme="sunlight"` would select no palette at all.
        expect(attributesFor('sunlight')).toEqual({ theme: 'light', contrast: 'high' });
    });

    it('never returns `sunlight` as a data-theme value', () => {
        // There is no `[data-theme="sunlight"]` block in tokens.css. If this
        // ever returns one, the theme silently renders as the dark default.
        for (const t of THEMES) {
            expect(['dark', 'light']).toContain(attributesFor(t).theme);
        }
    });
});

describe('the pre-paint script', () => {
    const src = prePaintThemeScript();

    it('is self-contained and synchronous — it must finish before paint', () => {
        expect(src).toMatch(/^\(function\(\)\{/);
        // No awaits, no fetches, no timers: anything asynchronous would paint
        // first and defeat the purpose.
        expect(src).not.toMatch(/await|fetch\(|setTimeout|requestAnimationFrame/);
    });

    it('reads the cookie FIRST, so it agrees with the server seed', () => {
        // Order matters: the server already seeded from the cookie, so
        // checking the cookie first means the common case changes no attribute
        // and triggers no repaint.
        const cookieAt = src.indexOf('document.cookie');
        const storageAt = src.indexOf('localStorage');
        const mediaAt = src.indexOf('prefers-color-scheme');
        expect(cookieAt).toBeGreaterThan(-1);
        expect(storageAt).toBeGreaterThan(cookieAt);
        expect(mediaAt).toBeGreaterThan(storageAt);
    });

    it('still honours the legacy localStorage key, so nobody is reset', () => {
        // The stored choice predates the rename; dropping it would silently
        // reset every existing user's theme.
        expect(src).toContain("localStorage.getItem('inflect:theme')");
    });

    it('writes the cookie, which is what makes a first visit self-correcting', () => {
        expect(src).toContain(THEME_COOKIE + '=');
        expect(src).toContain(`max-age=${THEME_COOKIE_MAX_AGE}`);
        expect(src).toContain('samesite=lax');
        expect(src).toContain('path=/');
    });

    it('compares before writing — the server already seeded the common case', () => {
        // Without this, every page load re-writes the attribute the server just
        // rendered, invalidating style for nothing.
        expect(src).toContain("getAttribute('data-theme')!==th");
    });

    it('applies both attributes for sunlight and clears contrast otherwise', () => {
        expect(src).toContain("setAttribute('data-contrast','high')");
        expect(src).toContain("removeAttribute('data-contrast')");
    });

    it('cannot throw — a theme script must never stop a page rendering', () => {
        // Storage access throws outright in some private-browsing modes.
        expect((src.match(/try\{/g) ?? []).length).toBeGreaterThanOrEqual(2);
        expect((src.match(/catch\(e\)\{/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it('EXECUTES against a document and sets the right attributes', () => {
        // The assertions above are about the source text; this one runs it, so
        // a syntactically valid script that does nothing cannot pass.
        for (const [cookie, wantTheme, wantContrast] of [
            ['sunlight', 'light', 'high'],
            ['light', 'light', null],
            ['dark', 'dark', null],
        ] as const) {
            const el: Record<string, string> = {};
            const doc = {
                cookie: `${THEME_COOKIE}=${cookie}`,
                documentElement: {
                    // `getAttribute` is load-bearing: the script compares before
                    // it writes, so a stub without it throws into the outer
                    // try/catch and silently sets nothing.
                    getAttribute: (k: string) => (k in el ? el[k] : null),
                    setAttribute: (k: string, v: string) => { el[k] = v; },
                    removeAttribute: (k: string) => { delete el[k]; },
                },
            };
            // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- running the emitted script IS the assertion
            new Function('document', 'window', 'localStorage', src)(
                doc,
                { matchMedia: () => ({ matches: false }) },
                { getItem: () => null },
            );
            expect(el['data-theme']).toBe(wantTheme);
            expect(el['data-contrast'] ?? null).toBe(wantContrast);
        }
    });
});
