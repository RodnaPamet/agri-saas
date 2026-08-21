/**
 * Safe-URL util contract.
 */
import {
    isSafeHref,
    isHttpUrl,
    normaliseHref,
    EXTERNAL_LINK_ATTRS,
} from '@/lib/security/safe-url';

describe('isSafeHref', () => {
    it.each([
        ['https://acme.com', true],
        ['http://acme.com', true],
        ['/t/acme/dashboard', true],
        ['mailto:alice@acme.com', true],
    ])('allows %s', (url, expected) => {
        expect(isSafeHref(url)).toBe(expected);
    });

    it.each([
        'javascript:alert(1)',
        'JavaScript:alert(1)',
        '  javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox("x")',
        'file:///etc/passwd',
    ])('blocks dangerous protocol: %s', (url) => {
        expect(isSafeHref(url)).toBe(false);
    });

    it('blocks null / undefined / empty', () => {
        expect(isSafeHref(null)).toBe(false);
        expect(isSafeHref(undefined)).toBe(false);
        expect(isSafeHref('')).toBe(false);
    });
});

describe('normaliseHref', () => {
    it('returns trimmed URL for safe inputs', () => {
        expect(normaliseHref('  https://acme.com  ')).toBe('https://acme.com');
    });

    it('returns null for unsafe inputs', () => {
        expect(normaliseHref('javascript:alert(1)')).toBeNull();
        expect(normaliseHref(null)).toBeNull();
    });
});

describe('EXTERNAL_LINK_ATTRS', () => {
    it('pairs target=_blank with rel="noopener noreferrer"', () => {
        expect(EXTERNAL_LINK_ATTRS).toEqual({
            target: '_blank',
            rel: 'noopener noreferrer',
        });
    });
});

describe('isHttpUrl — the ingest-boundary check', () => {
    it.each(['https://agro.bg/news/1', 'http://example.com/a?b=c'])(
        'accepts absolute http(s): %s',
        (url) => expect(isHttpUrl(url)).toBe(true),
    );

    it.each([
        'javascript:alert(1)',
        'data:text/html,<script>x</script>',
        'vbscript:msgbox',
        'file:///etc/passwd',
        'ftp://example.com/a',
        'mailto:a@b.com',
    ])('rejects scheme: %s', (url) => expect(isHttpUrl(url)).toBe(false));

    it('rejects RELATIVE urls, unlike isSafeHref', () => {
        // This is the whole reason the two functions both exist. A relative
        // path is normal for an in-app href and meaningless for a value a
        // third-party feed supplied.
        expect(isSafeHref('/dashboard')).toBe(true);
        expect(isHttpUrl('/dashboard')).toBe(false);
    });

    it('rejects empty, null and unparseable input', () => {
        expect(isHttpUrl(null)).toBe(false);
        expect(isHttpUrl(undefined)).toBe(false);
        expect(isHttpUrl('')).toBe(false);
        expect(isHttpUrl('not a url at all')).toBe(false);
    });

    it('tolerates surrounding whitespace', () => {
        expect(isHttpUrl('  https://agro.bg/1  ')).toBe(true);
        // …but not as a way to smuggle a scheme past it.
        expect(isHttpUrl('  javascript:alert(1)')).toBe(false);
    });
});
