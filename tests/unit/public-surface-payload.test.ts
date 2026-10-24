/**
 * What an anonymous visitor is sent (P6.4, #1813).
 *
 * The numbers are the point of this file. A reader who sees only the code
 * cannot tell whether the subset saves a kilobyte or four hundred, and the
 * decision to do this at all rests on which.
 */
import { readCatalogue } from '../helpers/catalogue';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    isPublicSurface,
    publicSurfaceMessages,
    PUBLIC_SURFACE_NAMESPACES,
    PUBLIC_SURFACE_HEADER,
} from '@/lib/i18n/public-surface';
import { SHARED_NAMESPACES } from '@/lib/i18n/shared-namespaces';

const ROOT = path.resolve(__dirname, '../..');
const load = (locale: string): Record<string, unknown> =>
    readCatalogue(locale);

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('isPublicSurface', () => {
    it('matches the surface and its children', () => {
        expect(isPublicSurface('/f')).toBe(true);
        expect(isPublicSurface('/f/pobeda')).toBe(true);
    });

    it('does NOT match a sibling that shares the spelling', () => {
        // Same boundary rule as `matchesPublicPrefix`. Here the failure
        // direction is mild — a page would get the full payload rather than
        // the slim one, costing bytes and not safety — but a rule that is
        // right for one reason and wrong for another gets copied into the
        // place where it matters.
        expect(isPublicSurface('/fx')).toBe(false);
        expect(isPublicSurface('/fx/admin')).toBe(false);
        expect(isPublicSurface('/f-debug')).toBe(false);
    });

    it('does NOT match the operator app’s own public pages', () => {
        // `isPublicPath` is true for all of these. "Public surface" is the
        // smaller idea: they are part of the app and want its shell.
        for (const p of ['/login', '/register', '/no-tenant', '/tenants', '/invite/abc']) {
            expect(isPublicSurface(p)).toBe(false);
        }
    });
});

describe('publicSurfaceMessages', () => {
    it('keeps the listed namespaces PLUS shared, and drops the rest', () => {
        const all = load('bg');
        const subset = publicSurfaceMessages(all);

        // PUBLIC plus SHARED since #2264. `notFound` moved to `shared` because
        // `src/app/not-found.tsx` renders on every surface, and this trim is
        // what the public page's CLIENT receives — leaving shared out would
        // have fixed the auth surface by breaking the public one.
        expect(Object.keys(subset).sort()).toEqual(
            [...PUBLIC_SURFACE_NAMESPACES, ...SHARED_NAMESPACES].sort(),
        );
        // And it still DROPS: the point of the trim is that `app` never
        // reaches an anonymous visitor.
        expect(Object.keys(subset)).not.toContain('common');
        expect(Object.keys(subset)).not.toContain('commandPalette');
        // The denominator, so a catalogue that collapsed to a handful of
        // namespaces could not make the saving below look impressive.
        expect(Object.keys(all).length).toBeGreaterThan(50);
    });

    it('saves ~400 KB on Bulgarian — the reason this exists', () => {
        const all = load('bg');
        const full = bytes(all);
        const slim = bytes(publicSurfaceMessages(all));

        // Measured 404,981 -> 475. Asserted as bounds rather than exact
        // numbers, so adding a key to the catalogue does not fail this and a
        // regression that re-ships the whole thing does.
        expect(full).toBeGreaterThan(300_000);
        expect(slim).toBeLessThan(5_000);
        expect(full - slim).toBeGreaterThan(290_000);
    });

    it('also slims English, so the win is not one locale’s accident', () => {
        const all = load('en');
        expect(bytes(publicSurfaceMessages(all))).toBeLessThan(5_000);
        expect(bytes(all)).toBeGreaterThan(150_000);
    });

    it('a listed namespace missing from the catalogue is skipped, not emitted as undefined', () => {
        // next-intl rejects an `undefined` namespace at render time, so a typo
        // in the list must degrade to a missing translation rather than a
        // 500 on every public page.
        const subset = publicSurfaceMessages({ publicFarm: { a: 1 } });
        expect('notFound' in subset).toBe(false);
        expect(subset).toEqual({ publicFarm: { a: 1 } });
    });

    it('does not mutate the catalogue it was given', () => {
        const all = load('bg');
        const before = Object.keys(all).length;
        publicSurfaceMessages(all);
        expect(Object.keys(all).length).toBe(before);
    });
});

describe('the middleware bridge', () => {
    it('sets the header for a public surface and not otherwise', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/middleware.ts'), 'utf8');
        // A layout cannot see the pathname, so this bridge is the only way it
        // learns. Asserted in source because the middleware's own Edge
        // behaviour is exercised by the HTTP tests, and what matters here is
        // that the two halves name the SAME header.
        expect(src).toContain('isPublicSurface(pathname)');
        expect(src).toContain('PUBLIC_SURFACE_HEADER');

        const layout = fs.readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8');
        expect(layout).toContain('PUBLIC_SURFACE_HEADER');
        expect(layout).toContain('publicSurfaceMessages');
    });

    it('the header name is one constant, not two strings', () => {
        // The failure this prevents: middleware sets `x-agrent-public-surface`
        // and the layout reads `x-public-surface`, so every render takes the
        // full-catalogue branch and nothing reports it — the page would simply
        // stay slow.
        expect(PUBLIC_SURFACE_HEADER).toBe('x-agrent-public-surface');
        const mw = fs.readFileSync(path.join(ROOT, 'src/middleware.ts'), 'utf8');
        const layout = fs.readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8');
        for (const f of [mw, layout]) {
            expect(f).not.toMatch(/['"]x-agrent-public-surface['"]/);
        }
    });
});
