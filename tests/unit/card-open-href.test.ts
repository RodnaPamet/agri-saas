/**
 * #3063 — `cardOpenHref`, the one part of the card link a rendered test cannot
 * reach.
 *
 * It exists as an exported function because a mutation proved the point: with
 * the extraction inlined in `ChannelFeedClient`, removing the client's
 * contribution entirely left the rendered suite 7 of 7 GREEN. The link
 * rendered correctly from a hand-built prop and nothing checked that the
 * client ever built one.
 *
 * It is also the part I got wrong first time — reaching for `card.url` when
 * the wire shape is `{ kind, payload }` with the payload untyped — which the
 * typecheck caught and a test would have caught sooner.
 */
import { cardOpenHref } from '@/lib/channels/card-text';

describe('cardOpenHref', () => {
    it('returns an http(s) url from the payload — the control', () => {
        expect(cardOpenHref({ url: 'https://example.test/a' })).toBe('https://example.test/a');
        expect(cardOpenHref({ url: 'http://example.test/a' })).toBe('http://example.test/a');
    });

    it('trims, because a trailing newline in a scraped field is normal', () => {
        expect(cardOpenHref({ url: '  https://example.test/a\n' })).toBe('https://example.test/a');
    });

    it('refuses an EMPTY url rather than linking to the current page', () => {
        // The case worth naming: `href=""` resolves to the page you are on, so
        // the link appears to work and does nothing. Worse than absent.
        expect(cardOpenHref({ url: '' })).toBeNull();
        expect(cardOpenHref({ url: '   ' })).toBeNull();
    });

    it('refuses a non-string, because the payload is Record<string, unknown>', () => {
        expect(cardOpenHref({ url: 42 })).toBeNull();
        expect(cardOpenHref({ url: null })).toBeNull();
        expect(cardOpenHref({ url: { href: 'https://example.test' } })).toBeNull();
        expect(cardOpenHref({})).toBeNull();
        expect(cardOpenHref(null)).toBeNull();
        expect(cardOpenHref(undefined)).toBeNull();
    });

    it('refuses a non-http scheme — a contract narrowing, not an XSS remedy', () => {
        // React 19 rewrites a `javascript:` href and the CSP carries no
        // `unsafe-inline`, so this is not the thing standing between the app
        // and an injection. It is the same reasoning as `httpsUrl()` on a
        // payload schema: the field's purpose is a news article, and anything
        // else in it is a fact about the data being wrong.
        for (const bad of [
            'javascript:alert(1)',
            'data:text/html,<script>1</script>',
            'file:///etc/passwd',
            'ftp://example.test/a',
            '//example.test/a',
            'example.test/a',
        ]) {
            expect(cardOpenHref({ url: bad })).toBeNull();
        }
    });

    it('accepts the real NEWS and SCHEME payload shapes', () => {
        // Both kinds carry `url`: a news item's own link, and a scheme's
        // `sourceUrl`. Shaped as the generators write them.
        expect(cardOpenHref({
            tag: 'wheat', title: 'A headline', url: 'https://agri.example/news/1',
            source: 'Agri', publishedAt: '2026-11-16',
        })).toBe('https://agri.example/news/1');
        expect(cardOpenHref({
            title: 'A scheme', url: 'https://mzh.example/scheme/7', day: '2026-11-16',
        })).toBe('https://mzh.example/scheme/7');
    });
});
