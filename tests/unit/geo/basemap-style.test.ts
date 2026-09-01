/**
 * Unit tests — basemap style resolution (`@/lib/geo/basemap-style`).
 *
 * This is NET-NEW coverage of a decision that has always shipped untested.
 * Before the extraction, `resolveBasemapStyle` lived inside MapCanvas and
 * `grep -rn 'DEMO_STYLE|resolveBasemapStyle|demotiles' tests/` returned
 * exactly one hit — a comment. The rendered MapCanvas suite could not have
 * covered it either: its `Map` stub discards `mapStyle` entirely.
 *
 * Two of the three branches below are asserted here for the FIRST time:
 *   • the keyless demotiles fallback, which is a live PRODUCTION path (the
 *     published image is built with an empty NEXT_PUBLIC_MAPTILER_KEY — #781);
 *   • the MapTiler branch with the style id unset, which resolves to
 *     `maps/undefined/style.json` without the in-code `?? 'hybrid'`.
 *
 * `@/env` is jest-mapped to a `process.env` Proxy and the resolver reads env
 * at CALL time, so plain env mutation is enough — no `jest.isolateModules`,
 * no module-registry gymnastics. That is precisely what the extraction bought.
 */
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import {
    DEMO_STYLE,
    buildFixtureBasemapStyle,
    resolveBasemapStyle,
} from '@/lib/geo/basemap-style';

const KEYS = [
    'NEXT_PUBLIC_MAPTILER_KEY',
    'NEXT_PUBLIC_MAP_BASEMAP_STYLE',
    'NEXT_PUBLIC_MAP_BASEMAP_FIXTURE',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
});

afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe('resolveBasemapStyle', () => {
    it('falls back to the keyless demotiles style when no MapTiler key is set', () => {
        expect(resolveBasemapStyle()).toBe(DEMO_STYLE);
        // Pinned as a literal on purpose: this exact URL is what the deployed
        // image requests, so a silent edit is a production change.
        expect(DEMO_STYLE).toBe('https://demotiles.maplibre.org/style.json');
    });

    it('defaults the MapTiler style id to hybrid when the style var is unset', () => {
        process.env.NEXT_PUBLIC_MAPTILER_KEY = 'k';
        // zod's `.default('hybrid')` fires under NEITHER SKIP_ENV_VALIDATION=1
        // nor the jest env mock, so without the in-code `?? 'hybrid'` this
        // resolves to `maps/undefined/style.json` — a broken basemap that
        // nothing would have caught.
        expect(resolveBasemapStyle()).toBe(
            'https://api.maptiler.com/maps/hybrid/style.json?key=k',
        );
    });

    it('honours an explicit MapTiler style id', () => {
        process.env.NEXT_PUBLIC_MAPTILER_KEY = 'k';
        process.env.NEXT_PUBLIC_MAP_BASEMAP_STYLE = 'satellite';
        expect(resolveBasemapStyle()).toBe(
            'https://api.maptiler.com/maps/satellite/style.json?key=k',
        );
    });

    it('lets the E2E fixture win even when a MapTiler key is present', () => {
        // Precedence matters: a CI runner that happens to carry a key must
        // still stay hermetic, so the fixture branch comes first.
        process.env.NEXT_PUBLIC_MAPTILER_KEY = 'k';
        process.env.NEXT_PUBLIC_MAP_BASEMAP_FIXTURE = '1';
        expect(resolveBasemapStyle()).toEqual(buildFixtureBasemapStyle());
    });

    it('ignores a fixture flag that is not exactly "1"', () => {
        process.env.NEXT_PUBLIC_MAP_BASEMAP_FIXTURE = '0';
        expect(resolveBasemapStyle()).toBe(DEMO_STYLE);
    });
});

describe('buildFixtureBasemapStyle', () => {
    it('is a style MapLibre itself accepts', () => {
        // MapCanvas registers no `onError`, so an invalid style would fail
        // SILENTLY — a blank map with a green suite. This runs MapLibre's own
        // validator, the same package version maplibre-gl resolves.
        expect(validateStyleMin(buildFixtureBasemapStyle())).toEqual([]);
    });

    it('references no URL at all — the hermeticity property, executed', () => {
        const serialised = JSON.stringify(buildFixtureBasemapStyle());
        expect(serialised).not.toContain('://');
        const style = buildFixtureBasemapStyle() as Record<string, unknown>;
        // `glyphs` and `sprite` are the two style fields that fetch on their
        // own; the demotiles style declares `glyphs`, which is the request a
        // naive stub misses.
        expect(style.glyphs).toBeUndefined();
        expect(style.sprite).toBeUndefined();
        expect(style.sources).toEqual({});
    });
});
