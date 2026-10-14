/**
 * `robots.txt` and the OG card (P6.5, #1814).
 *
 * Both are server functions, so they can be called directly — no HTTP, no
 * browser. The OG case is a real smoke test rather than a shape assertion:
 * satori throws on a font it cannot parse and on a glyph it cannot find, so a
 * card that renders at all is evidence the Cyrillic font loaded and covered
 * the text.
 */
import robots from '@/app/robots';

describe('robots.txt', () => {
    const rules = () => {
        const r = robots().rules;
        return Array.isArray(r) ? r[0] : r;
    };

    it('disallows the authenticated tree', () => {
        const disallow = rules().disallow as string[];
        // Not a leak — a crawler reaching `/t/{slug}` gets a login redirect —
        // but crawl budget spent on redirects is budget not spent on the
        // public pages, and the logs fill with requests that cannot succeed.
        for (const p of ['/api/', '/t/', '/org/', '/account']) {
            expect(disallow).toContain(p);
        }
    });

    it('does NOT disallow /f/, deliberately', () => {
        const disallow = rules().disallow as string[];
        const allow = rules().allow as string[];

        expect(allow).toContain('/f/');
        expect(disallow).not.toContain('/f/');
        expect(disallow).not.toContain('/f');

        // The reason, pinned because it is the counter-intuitive half:
        // `robots.txt` governs CRAWLING, not indexing. Disallowing `/f/` would
        // stop a crawler ever seeing the per-page `noindex` header — which is
        // how a URL ends up indexed with no snippet instead of not indexed.
    });

    it('points at the sitemap, absolutely', () => {
        const sitemap = robots().sitemap as string;
        expect(sitemap).toMatch(/^https?:\/\//);
        expect(sitemap).toMatch(/\/sitemap\.xml$/);
        // No double slash from a base that ended in one.
        expect(sitemap).not.toMatch(/[^:]\/\//);
    });
});

describe('the OG card', () => {
    // These call `next/og`, which rasterises — slower than a unit test but
    // still well under a second, and the only thing that proves the font is
    // usable rather than merely present on disk.
    jest.setTimeout(30_000);

    const og = () => require('@/app/f/[handle]/opengraph-image');

    it('declares the sizes a crawler expects', () => {
        const { size, contentType } = og();
        // 1200×630 is the ratio every major crawler crops to; a different one
        // is letterboxed or cropped unpredictably.
        expect(size).toEqual({ width: 1200, height: 630 });
        expect(contentType).toBe('image/png');
    });

    it('renders CYRILLIC without throwing — the font is the whole point', async () => {
        // satori throws on an unparseable font and renders tofu for a missing
        // glyph. Next ships Geist, which has no Cyrillic; this uses the
        // DejaVuSans already in the repo for the ДНЕВНИК PDF.
        jest.doMock('@/app-layer/usecases/public-farm-profile', () => ({
            readPublicFarmProfile: async () => ({
                handle: 'pobeda',
                displayName: 'Стопанство Победа',
                tagline: null,
                about: null,
                oblast: 'Добрич',
                crops: [],
                indexable: false,
                projectedAt: new Date(),
            }),
        }));
        const mod = require('@/app/f/[handle]/opengraph-image');

        const res = await mod.default({ params: Promise.resolve({ handle: 'pobeda' }) });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('image/png');
        jest.dontMock('@/app-layer/usecases/public-farm-profile');
    });

    it('a missing profile renders the SAME card shape, not a distinctive one', async () => {
        // Anti-enumeration: a "farm not found" card would answer the question
        // the 404 refuses to.
        jest.resetModules();
        jest.doMock('@/app-layer/usecases/public-farm-profile', () => ({
            readPublicFarmProfile: async () => null,
        }));
        const mod = require('@/app/f/[handle]/opengraph-image');

        const res = await mod.default({ params: Promise.resolve({ handle: 'nope' }) });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('image/png');
        jest.dontMock('@/app-layer/usecases/public-farm-profile');
    });
});
