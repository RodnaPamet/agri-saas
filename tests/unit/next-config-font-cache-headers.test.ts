/**
 * `/fonts/*` is served with long-lived immutable caching (#779).
 *
 * EXECUTING, not a source grep: it calls the real `headers()` from
 * `next.config.js` and inspects what it returns. A guard matching the file's
 * text would pass over a rule that Next never applies — e.g. one placed after
 * a broader `source: '/(.*)'` that already matched, or one with a malformed
 * path pattern.
 *
 * Run with `--runTestsByPath` if invoking directly; jest otherwise treats a
 * positional path as a filter and runs the whole suite.
 */
import nextConfig from '../../next.config.js';

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

describe('next.config headers — /fonts/*', () => {
    let rules: HeaderRule[];

    beforeAll(async () => {
        const cfg = nextConfig as unknown as { headers: () => Promise<HeaderRule[]> };
        rules = await cfg.headers();
    });

    it('returns a non-empty rule set (guards against a vacuous pass)', () => {
        // Every assertion below is a `.find()`. An empty array would make them
        // all report "undefined", which is a different failure message than
        // "the rule is missing" — this separates the two.
        expect(Array.isArray(rules)).toBe(true);
        expect(rules.length).toBeGreaterThan(0);
    });

    it('has a /fonts/ rule that precedes the catch-all', () => {
        const fontIdx = rules.findIndex((r) => r.source.startsWith('/fonts/'));
        const catchAllIdx = rules.findIndex((r) => r.source === '/(.*)');
        expect(fontIdx).toBeGreaterThanOrEqual(0);
        // Ordering is load-bearing in Next's header matching: a later rule
        // does not replace an earlier one, so a font rule buried after the
        // catch-all would still apply, but keeping it first documents intent
        // and avoids the reader having to know that.
        if (catchAllIdx >= 0) expect(fontIdx).toBeLessThan(catchAllIdx);
    });

    it('sets a year-long immutable Cache-Control on the fonts', () => {
        const rule = rules.find((r) => r.source.startsWith('/fonts/'));
        const cc = rule?.headers.find((h) => h.key.toLowerCase() === 'cache-control');
        expect(cc).toBeDefined();
        expect(cc!.value).toContain('immutable');
        expect(cc!.value).toMatch(/max-age=31536000/);
        expect(cc!.value).toContain('public');
    });

    it('matches nested paths, not just the top level', () => {
        // `/fonts/:path*` matches `/fonts/a.woff2` AND any future subdirectory.
        // `/fonts/:path` (no star) would silently miss the latter.
        const rule = rules.find((r) => r.source.startsWith('/fonts/'));
        expect(rule!.source).toBe('/fonts/:path*');
    });
});
