/**
 * The share kit's composition — P6.7 (#1816).
 *
 * `viber://` is handled by an installed app, so no test here can confirm a
 * forward opens. What breaks silently is the COMPOSITION: a mis-encoded
 * Cyrillic farm name does not fail, it forwards mojibake, and the farmer
 * discovers it after sending.
 *
 * Note the trap in testing that. `decodeURIComponent` on an UNENCODED
 * Cyrillic string returns it unchanged, so a round-trip assertion passes
 * perfectly well against a function that forgot to encode at all. Every
 * encoding case below therefore also asserts the encoded form DIFFERS from
 * the raw one and carries percent-escapes.
 */
const mockEnv: { APP_URL?: string; NEXTAUTH_URL?: string } = {
    APP_URL: 'https://app.agrent.bg',
};
jest.mock('@/env', () => ({
    get env() {
        return mockEnv;
    },
}));

import { publicProfileUrl, viberForwardUrl, shareKit } from '@/lib/public-profile/share-links';

const NAME = 'Стопанство Победа';

beforeEach(() => {
    mockEnv.APP_URL = 'https://app.agrent.bg';
    mockEnv.NEXTAUTH_URL = undefined;
});

describe('publicProfileUrl', () => {
    it('is the one definition every share surface uses', () => {
        expect(publicProfileUrl('pobeda')).toBe('https://app.agrent.bg/f/pobeda');
    });

    it('does not double the slash when the base carries one', () => {
        // `APP_URL` is operator-configured, so a trailing slash is a matter of
        // taste rather than a bug — and `//f/pobeda` would be a different path.
        mockEnv.APP_URL = 'https://app.agrent.bg/';
        expect(publicProfileUrl('pobeda')).toBe('https://app.agrent.bg/f/pobeda');
    });

    it('falls back to NEXTAUTH_URL, as getAppBaseUrl does', () => {
        mockEnv.APP_URL = undefined;
        mockEnv.NEXTAUTH_URL = 'https://staging.agrent.bg';
        expect(publicProfileUrl('pobeda')).toBe('https://staging.agrent.bg/f/pobeda');
    });
});

describe('viberForwardUrl', () => {
    it('percent-encodes a Cyrillic message', () => {
        const encoded = viberForwardUrl(NAME);
        const text = encoded.slice('viber://forward?text='.length);

        // The discriminator. Without these two, the round-trip below passes
        // against a function that returned the raw string.
        expect(text).not.toBe(NAME);
        expect(text).toMatch(/%[0-9A-F]{2}/);

        expect(decodeURIComponent(text)).toBe(NAME);
    });

    it('encodes the characters that would otherwise end the query', () => {
        // `&` and `#` are the ones that silently truncate a forwarded message
        // — everything after them would be dropped or read as another param.
        const text = viberForwardUrl('Победа & Co #1').slice('viber://forward?text='.length);
        expect(text).not.toContain('&');
        expect(text).not.toContain('#');
        expect(decodeURIComponent(text)).toBe('Победа & Co #1');
    });

    it('encodes the em dash the message uses', () => {
        expect(viberForwardUrl('a — b')).toContain('%E2%80%94');
    });

    it('is the forward intent, not a send', () => {
        // `forward` opens the contact picker; a scheme that sent on tap would
        // be a share the farmer did not choose a recipient for.
        expect(viberForwardUrl('x')).toMatch(/^viber:\/\/forward\?text=/);
    });
});

describe('shareKit', () => {
    it('gives the QR the bare url, NOT the message', () => {
        // A camera opens what it finds. A scanner handed
        // `Стопанство Победа — https://…` either opens nothing or searches
        // for the whole string, and the person holding the printed card has
        // no way to tell which.
        const kit = shareKit('pobeda', NAME);
        expect(kit.qrValue).toBe('https://app.agrent.bg/f/pobeda');
        expect(kit.qrValue).not.toContain(NAME);
        expect(kit.qrValue).not.toContain('—');
    });

    it('puts the url LAST, where chat clients preview it', () => {
        const kit = shareKit('pobeda', NAME);
        expect(kit.message).toBe('Стопанство Победа — https://app.agrent.bg/f/pobeda');
        expect(kit.message.endsWith(kit.url)).toBe(true);
    });

    it('the Viber link carries exactly the message, so a copy matches a forward', () => {
        const kit = shareKit('pobeda', NAME);
        const text = kit.viber.slice('viber://forward?text='.length);
        expect(decodeURIComponent(text)).toBe(kit.message);
    });

    it('all three surfaces agree on the url', () => {
        // The whole reason this is one module: a QR, a forward and a copied
        // link that resolved differently would be three ways to reach a farm
        // and two of them wrong — and the printed one cannot be corrected.
        const kit = shareKit('pobeda', NAME);
        expect(kit.qrValue).toBe(kit.url);
        expect(decodeURIComponent(kit.viber)).toContain(kit.url);
        expect(kit.message).toContain(kit.url);
    });
});
