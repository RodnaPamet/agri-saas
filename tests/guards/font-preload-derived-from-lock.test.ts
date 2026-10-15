/**
 * The font preload is DERIVED, bounded, and nonce-free.
 *
 * Three independent ways this can go wrong, none of which show on screen:
 *
 *  1. A STALE HREF. `scripts/fonts/vendor-fonts.mjs` names each file from the
 *     css2 response, so an upstream subset change renames it. A hardcoded
 *     preload then points at a 404 — which costs a request, warms nothing, and
 *     is invisible because `font-display: swap` paints the fallback either way.
 *  2. AN EMPTY SET. A derivation that matches nothing renders zero `<link>`
 *     elements. The page looks perfect. `weight` in the lock is a STRING
 *     (`"400"`); matching on the number 400 selects nothing, which is exactly
 *     how this was first written.
 *  3. AN UNBOUNDED SET. All 72 faces are 1,950,912 bytes. Preloading them
 *     would be strictly WORSE than preloading none — it front-loads ~2 MB of
 *     blocking requests for glyphs the page will never render.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { preloadFaces } from '@/lib/fonts/preload';

const ROOT = path.resolve(__dirname, '../..');
const lock = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src/styles/fonts.lock.json'), 'utf8'),
) as { faces: Array<{ file: string; bytes: number; subset: string }> };

/** Every face the preload asks for, across the locales the product ships. */
const LOCALES = ['en', 'bg'] as const;

describe('font preload is derived from the lock', () => {
    it.each(LOCALES)('%s resolves a NON-EMPTY set — control on everything below', (locale) => {
        // Without this, every assertion below is satisfied by selecting
        // nothing, and the page renders correctly while preloading nothing.
        expect(preloadFaces(locale).length).toBeGreaterThan(0);
    });

    it.each(LOCALES)('%s preloads only files that exist on disk', (locale) => {
        for (const face of preloadFaces(locale)) {
            const rel = face.href.replace(/^\//, '');
            expect(fs.existsSync(path.join(ROOT, 'public', rel))).toBe(true);
        }
    });

    it.each(LOCALES)('%s preloads only files the lock knows about', (locale) => {
        const known = new Set(lock.faces.map((f) => `/fonts/${f.file}`));
        for (const face of preloadFaces(locale)) {
            expect(known.has(face.href)).toBe(true);
        }
    });

    it('bg adds the Cyrillic cut; en does not carry it', () => {
        // The subsets are unicode-range split, so a Latin page never downloads
        // the Cyrillic file. Shipping it to `en` would be pure waste; omitting
        // it from `bg` would leave the product's primary language swapping.
        const bg = preloadFaces('bg').map((f) => f.href);
        const en = preloadFaces('en').map((f) => f.href);
        expect(bg.some((h) => h.includes('cyrillic'))).toBe(true);
        expect(en.some((h) => h.includes('cyrillic'))).toBe(false);
    });

    it('the preload budget stays a fraction of the full face set', () => {
        const all = lock.faces.reduce((n, f) => n + f.bytes, 0);
        for (const locale of LOCALES) {
            const preloaded = preloadFaces(locale).reduce((n, f) => n + f.bytes, 0);
            // 150 KB against 1.9 MB. The number is a ceiling, not a target —
            // its job is to make "preload everything" fail rather than to
            // track the current figure (67,004 bytes for bg today).
            expect(preloaded).toBeLessThan(150_000);
            expect(preloaded).toBeLessThan(all / 4);
        }
    });

    it('the rendered link carries crossOrigin and NO nonce', () => {
        const layout = fs.readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8');
        const start = layout.indexOf('rel="preload"');
        expect(start).toBeGreaterThan(-1);
        const tag = layout.slice(start, start + 400);

        // Fonts are fetched in CORS mode even same-origin; a preload whose mode
        // differs from the real request is fetched TWICE.
        expect(tag).toContain('crossOrigin="anonymous"');
        // A font preload is governed by font-src, not script-src. A nonce here
        // would also shift the window csp-webpack-nonce-bridge-hydration scans.
        expect(tag).not.toContain('nonce');
    });

    it('preloads the HEADING face, not only the body face', () => {
        // #1814: the public farm page's LCP element is a `<Heading>`, which
        // renders `font-heading font-semibold` — Onest 600. Only Inter 400 was
        // preloaded, so the heading painted in the fallback at FCP and
        // re-painted when Onest arrived; measured as a one-second FCP->LCP gap
        // with CLS at 0.000, so nothing was moving.
        for (const locale of ['bg', 'en']) {
            const hrefs = preloadFaces(locale).map((f) => f.href);
            expect(hrefs.some((h) => h.includes('onest') && h.includes('600'))).toBe(true);
            expect(hrefs.some((h) => h.includes('inter') && h.includes('400'))).toBe(true);
        }
    });

    it('asks for the heading face BEFORE the body face', () => {
        // Preload order is request priority, and the heading is what the
        // metric watches. Asserted rather than left to the array literal,
        // because a reorder that looks cosmetic would undo the point.
        for (const locale of ['bg', 'en']) {
            const hrefs = preloadFaces(locale).map((f) => f.href);
            const heading = hrefs.findIndex((h) => h.includes('onest'));
            const body = hrefs.findIndex((h) => h.includes('inter'));
            expect(heading).toBeGreaterThanOrEqual(0);
            expect(heading).toBeLessThan(body);
        }
    });

    it('the Cyrillic heading cut exists, so a bg heading is not a fallback', () => {
        // Onest carries `cyrillic`; `Bricolage Grotesque` — the other display
        // face in the lock — does NOT. If the heading family ever changed to
        // one without that subset, every Bulgarian heading would silently
        // render in a fallback face, which no preload assertion would catch.
        const cyrillicHeading = lock.faces.filter(
            (f) => f.file.includes('onest') && f.subset === 'cyrillic',
        );
        expect(cyrillicHeading.length).toBeGreaterThan(0);
    });
});
