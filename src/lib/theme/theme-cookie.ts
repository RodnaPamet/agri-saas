/**
 * The theme, in a cookie the SERVER can read.
 *
 * ── the flash this exists to remove ──
 *
 * `ThemeProvider` resolved the theme from `localStorage` and
 * `prefers-color-scheme` inside a `useEffect`, and `layout.tsx` hard-coded
 * `data-theme="dark"` into the SSR markup. An effect runs AFTER the first
 * paint, so every user whose theme is `light` or `sunlight` saw the dark
 * palette painted and then flipped. Not a race — a guaranteed flash.
 *
 * localStorage cannot fix it: the server cannot read it. A cookie can, so the
 * server seeds the right attributes and the first paint is already correct.
 *
 * ── why the pre-paint script still exists alongside this ──
 *
 * The cookie is absent on a first visit, and then only the browser knows
 * `prefers-color-scheme`. The inline script in `<head>` covers that case
 * before paint and writes the cookie, so the SECOND request is
 * server-correct. Cookie for the server, script for the first visit; neither
 * alone is enough.
 */

/** The three themes `ThemeProvider` cycles through. */
export const THEMES = ['dark', 'light', 'sunlight'] as const;
export type ThemeName = (typeof THEMES)[number];

/**
 * Deliberately NOT the `inflect:theme` localStorage key.
 *
 * The `inflect:` prefix is a leftover from the pre-rename product. The
 * localStorage key keeps its old name so existing users do not lose their
 * choice on upgrade; the cookie gets the current one.
 */
export const THEME_COOKIE = 'agrent_theme';

/** One year. A theme is a preference, not a session. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Narrow an untrusted value (cookie, localStorage, DB column) to a theme. */
export function isThemeName(v: unknown): v is ThemeName {
    return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

/**
 * The `data-theme` / `data-contrast` pair a theme resolves to.
 *
 * `sunlight` is the light palette PLUS the high-contrast overlay — it sets
 * both attributes so it inherits every light token and only the contrast
 * overrides apply on top. ADR 0002 OD8 is where that comes from: "follow the
 * system theme, plus a high-contrast «Слънце» theme".
 */
export function attributesFor(
    theme: ThemeName,
): { theme: 'dark' | 'light'; contrast: 'high' | null } {
    if (theme === 'sunlight') return { theme: 'light', contrast: 'high' };
    return { theme, contrast: null };
}

/**
 * The inline script that runs BEFORE the first paint.
 *
 * Returned as a string so `layout.tsx` can emit it with the request nonce.
 * Order is cookie, then localStorage, then the OS preference — the cookie
 * first because it is what the server just used to seed the markup, so
 * agreeing with it means no attribute change and therefore no repaint.
 *
 * It writes the cookie on every run, which is what makes a first visit
 * self-correcting: the server gets it right from the next request onward.
 *
 * Each attribute is COMPARED before it is written. `setAttribute` invalidates
 * style and queues a mutation even when the value is unchanged, and on the
 * common path — cookie present, server already seeded from it — every write
 * here would be writing back exactly what is in the markup.
 *
 * Wrapped in try/catch throughout. Storage access throws outright in some
 * private-browsing modes, and a theme script must never be the reason a page
 * fails to render.
 */
export function prePaintThemeScript(): string {
    return `(function(){try{
var T=['dark','light','sunlight'];
var m=document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=([^;]*)/);
var t=m&&T.indexOf(decodeURIComponent(m[1]))>-1?decodeURIComponent(m[1]):null;
if(!t){try{var s=localStorage.getItem('inflect:theme');if(T.indexOf(s)>-1)t=s;}catch(e){}}
if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}
var e=document.documentElement;
var th=t==='sunlight'?'light':t,ct=t==='sunlight'?'high':null;
if(e.getAttribute('data-theme')!==th)e.setAttribute('data-theme',th);
if(ct){if(e.getAttribute('data-contrast')!==ct)e.setAttribute('data-contrast','high');}
else e.removeAttribute('data-contrast');
document.cookie='${THEME_COOKIE}='+encodeURIComponent(t)+';path=/;max-age=${THEME_COOKIE_MAX_AGE};samesite=lax';
}catch(e){}})();`;
}
