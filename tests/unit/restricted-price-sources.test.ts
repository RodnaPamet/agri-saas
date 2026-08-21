/**
 * Commercial restrictions on price sources are enforced, not documented.
 *
 * agroportal.bg's price content sits under an exclusive brokerage partnership
 * (confirmed by the maintainer, 2026-08-21). That is a **commercial**
 * constraint: nothing about the site stops us fetching it, and no error would
 * ever be raised if we did. So the only thing that can hold it is code.
 *
 * Before this it was held by a sentence — first in an unmerged WIP branch,
 * then in a comment in `@/lib/news/feeds`, which is the wrong file. That one
 * governs the NEWS feed list; the restriction is about PRICE data, and the two
 * are separate pipelines with separate sources. The comment sat beside code
 * that could not violate it, while the code that could had nothing.
 *
 * The exposure is real: four price-source URLs are operator-settable via env,
 * each documented as "point it at a mirror/proxy".
 *
 * ── Scope, so this is not over-read ──────────────────────────────────
 *
 * PRICE ingestion only. Whether agroportal.bg's *news* RSS is separately
 * permissible has not been established — `feeds.ts` excludes it for an
 * unrelated technical reason (it serves HTML, not a feed).
 */

import {
    isPriceSourceAllowed,
    restrictedHostOf,
    RESTRICTED_PRICE_HOSTS,
} from '@/lib/market/restricted-sources';

describe('isPriceSourceAllowed', () => {
    it('refuses the restricted host', () => {
        expect(isPriceSourceAllowed('https://agroportal.bg/prices.xlsx')).toBe(false);
    });

    it.each([
        'https://www.agroportal.bg/x',
        'https://api.agroportal.bg/v1/prices',
        'http://AGROPORTAL.BG/UPPER',
        'https://agroportal.bg./trailing-dot',
    ])('refuses subdomains, casing and a trailing dot: %s', (url) => {
        expect(isPriceSourceAllowed(url)).toBe(false);
    });

    it('does NOT refuse a lookalike that merely contains the name', () => {
        // The failure mode of a naive `includes()` check: these are different
        // registrable domains and blocking them would be wrong.
        expect(isPriceSourceAllowed('https://agroportal.bg.example.com/x')).toBe(true);
        expect(isPriceSourceAllowed('https://notagroportal.bg/x')).toBe(true);
        expect(isPriceSourceAllowed('https://example.com/?ref=agroportal.bg')).toBe(true);
    });

    it.each([
        'https://ec.europa.eu/agrifood/api',
        'https://thedocs.worldbank.org/pink-sheet.xlsx',
    ])('allows the real price sources: %s', (url) => {
        expect(isPriceSourceAllowed(url)).toBe(true);
    });

    it('allows empty/absent input — the override simply is not set', () => {
        expect(isPriceSourceAllowed(undefined)).toBe(true);
        expect(isPriceSourceAllowed(null)).toBe(true);
        expect(isPriceSourceAllowed('')).toBe(true);
    });

    it('allows an unparseable URL rather than reporting the wrong reason', () => {
        // Shape is already validated by `z.string().url()` in src/env.ts.
        // Failing here would log a commercial-restriction reason for a
        // malformed-URL problem.
        expect(isPriceSourceAllowed('not a url')).toBe(true);
    });
});

describe('restrictedHostOf', () => {
    it('names which restriction was tripped, for the operator log', () => {
        expect(restrictedHostOf('https://api.agroportal.bg/x')).toBe('agroportal.bg');
    });

    it('returns null for an allowed source', () => {
        expect(restrictedHostOf('https://ec.europa.eu/x')).toBeNull();
    });
});

describe('the restriction list itself', () => {
    it('is non-empty and lowercase', () => {
        // A silently emptied list would make every assertion above pass
        // vacuously — the same shape as the k6 threshold that took CI down.
        expect(RESTRICTED_PRICE_HOSTS.length).toBeGreaterThan(0);
        for (const h of RESTRICTED_PRICE_HOSTS) {
            expect(h).toBe(h.toLowerCase());
            expect(h).not.toMatch(/^https?:|\//);
        }
    });

    it('still contains the host this was written for', () => {
        expect(RESTRICTED_PRICE_HOSTS).toContain('agroportal.bg');
    });
});
