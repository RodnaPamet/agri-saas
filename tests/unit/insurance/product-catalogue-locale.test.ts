/**
 * The catalogue's language is DECLARED, never negotiated.
 *
 * This is the guard against a future "improvement" that adds `Accept-Language`
 * back, so it is worth stating why that would be a regression rather than a
 * nicety.
 *
 * The native client is Bulgarian by DECLARATION, not by what the handset
 * reports, and its owner's device reports `en_BG` — English language, Bulgarian
 * region, an ordinary thing for a person to set. A catalogue that negotiated
 * from that header would return English product names onto an otherwise entirely
 * Bulgarian screen. That client already carries two CI guards against exactly
 * that class of defect (one rejecting English date spellings, one forcing every
 * commodity name through its own resolver); a header-negotiated catalogue walks
 * the same defect in through a door neither guard watches.
 *
 * So: `?locale=` wins, the `NEXT_LOCALE` cookie is the only fallback (it is also
 * a declaration — the user picked it in this product), and `Accept-Language` is
 * ignored even when it is the ONLY thing present.
 */
import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
const listMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));
jest.mock('@/app-layer/usecases/insurance', () => ({
    __esModule: true,
    listInsuranceProducts: (...a: unknown[]) => listMock(...a),
}));

import { GET } from '@/app/api/t/[tenantSlug]/insurance/products/route';

/** The locale the route resolved, as handed to the usecase. */
async function localeFor(url: string, headers: Record<string, string> = {}): Promise<string> {
    listMock.mockResolvedValue({ engineVersion: 1, currencySymbol: '€', products: [] });
    const req = new NextRequest(url, { headers });
    await GET(req, { params: Promise.resolve({ tenantSlug: 'acme' }) } as never);
    return listMock.mock.calls.at(-1)?.[1] as string;
}

const BASE = 'http://localhost/api/t/acme/insurance/products';

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue({ tenantId: 't1', userId: 'u1', requestId: 'r1' });
});

describe('an explicit ?locale wins', () => {
    it.each([['bg'], ['en']])('honours ?locale=%s', async (locale) => {
        expect(await localeFor(`${BASE}?locale=${locale}`)).toBe(locale);
    });

    it('beats a conflicting Accept-Language outright', async () => {
        expect(await localeFor(`${BASE}?locale=bg`, { 'Accept-Language': 'en-US,en;q=0.9' })).toBe('bg');
    });

    it('beats a conflicting cookie too', async () => {
        expect(await localeFor(`${BASE}?locale=bg`, { cookie: 'NEXT_LOCALE=en' })).toBe('bg');
    });

    it('ignores an unsupported value rather than trusting it', async () => {
        // `de` is not in LOCALES; falling through is right, echoing it is not.
        expect(await localeFor(`${BASE}?locale=de`)).toBe('en');
    });
});

describe('Accept-Language is IGNORED, which is the point', () => {
    it('does not follow it even when it is the only signal', async () => {
        expect(await localeFor(BASE, { 'Accept-Language': 'bg-BG,bg;q=0.9' })).toBe('en');
    });

    it('does not follow the en_BG shape that prompted this rule', async () => {
        // English language, Bulgarian region — the owner's actual device. Under
        // negotiation this returns English onto a Bulgarian screen.
        expect(await localeFor(BASE, { 'Accept-Language': 'en-BG,en;q=0.9' })).toBe('en');
        // …and the mirror: a Bulgarian header must not override a declared `en`.
        expect(await localeFor(`${BASE}?locale=en`, { 'Accept-Language': 'bg' })).toBe('en');
    });

    it('lets the cookie win over it, because a cookie is a declaration', async () => {
        expect(
            await localeFor(BASE, { cookie: 'NEXT_LOCALE=bg', 'Accept-Language': 'en-US' }),
        ).toBe('bg');
    });
});

describe('with nothing declared', () => {
    it('answers English, so a client wanting Bulgarian must say so', async () => {
        expect(await localeFor(BASE)).toBe('en');
    });
});
