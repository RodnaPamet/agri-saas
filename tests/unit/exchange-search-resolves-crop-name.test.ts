/**
 * `?q=пшеница` finds a wheat listing (agrent-ios#219).
 *
 * ## The defect
 *
 * `commodity` is stored CANONICAL: `exchange.schemas.ts` runs every write
 * through `normalizeCommodity`, so «пшеница», «Wheat» and «wheat» all persist
 * as `'wheat'`. The search then compared the RAW query against that slug —
 * `{ commodity: { contains: 'пшеница' } }` — which cannot match `'wheat'`.
 *
 * So the product's primary language, searching the product's primary field,
 * found nothing. Reported from the client by agrent-ios; it is not an iOS bug
 * and the web had it too.
 *
 * Regions already had the treatment: the route resolves `searchRegionCodes`
 * via `regionCodesMatchingName`, so «Пловдив» matches a row holding
 * `'Plovdiv'`. Nothing resolved a crop name.
 *
 * ## Why this tests the ROUTE and not the repository
 *
 * The resolution lives in the route — one line turning `q` into
 * `searchCommodities`. A repository test would prove the query honours the
 * filter and say nothing about whether anything POPULATES it, which is the
 * half that was missing. So this mocks the usecase and asserts the FILTERS it
 * receives: the wiring is the subject.
 *
 * `normalizeCommodity` is the same function the write path calls, so the two
 * cannot disagree about what «пшеница» means — that is the property worth
 * having, rather than a second table of translations.
 */
import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
const listActiveListingsMock = jest.fn();
const assertModuleEnabledMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));
jest.mock('@/app-layer/usecases/modules', () => ({
    __esModule: true,
    assertModuleEnabled: (...a: unknown[]) => assertModuleEnabledMock(...a),
}));
jest.mock('@/app-layer/usecases/exchange', () => ({
    __esModule: true,
    listActiveListings: (...a: unknown[]) => listActiveListingsMock(...a),
    createListing: jest.fn(),
}));

import { GET } from '@/app/api/t/[tenantSlug]/exchange/listings/route';

function get(q: string): Promise<Response> {
    const url = `http://localhost/api/t/acme/exchange/listings?q=${encodeURIComponent(q)}`;
    return GET(
        new NextRequest(url) as never,
        { params: Promise.resolve({ tenantSlug: 'acme' }) } as never,
    ) as Promise<Response>;
}

/** The filters the route handed the usecase. */
function filters(): Record<string, unknown> {
    expect(listActiveListingsMock).toHaveBeenCalled();
    return listActiveListingsMock.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue({ tenantId: 'tenant-1', userId: 'user-1', requestId: 'req' });
    assertModuleEnabledMock.mockResolvedValue(undefined);
    listActiveListingsMock.mockResolvedValue({ rows: [], nextCursor: null });
});

describe('exchange search resolves a Bulgarian crop name to its canonical slug', () => {
    it('«пшеница» resolves to wheat', async () => {
        await get('пшеница');
        expect(filters().searchCommodities).toEqual(['wheat']);
    });

    it.each([
        ['Пшеница', 'wheat'],
        ['ПШЕНИЦА', 'wheat'],
        ['слънчоглед', 'sunflower'],
        ['царевица', 'maize'],
        ['ечемик', 'barley'],
    ])('«%s» resolves to %s', async (query, slug) => {
        await get(query);
        expect(filters().searchCommodities).toEqual([slug]);
    });

    it('an English name resolves too, so the two languages agree', async () => {
        await get('Wheat');
        expect(filters().searchCommodities).toEqual(['wheat']);
    });

    it('the raw `contains` is STILL passed — English prefixes must keep working', async () => {
        // `normalizeCommodity` is exact-match only and returns null for 'whe',
        // so the fix is ADDITIVE. Dropping `search` would fix whole Bulgarian
        // words and break English partial ones.
        await get('whe');
        const f = filters();
        expect(f.search).toBe('whe');
        expect(f.searchCommodities).toEqual([]);
    });

    it('control: a non-crop yields an EMPTY list, never [null]', async () => {
        // `{ in: [null] }` matches nothing while LOOKING like a filter, and an
        // empty array is omitted from the OR by the repository. This is what
        // `filter(Boolean)` in the route is for.
        await get('definitely-not-a-crop');
        expect(filters().searchCommodities).toEqual([]);
    });

    it('control: a REGION name still resolves on its own axis', async () => {
        // Proves the two resolvers are independent rather than one shadowing
        // the other — and that this test could tell them apart.
        await get('Пловдив');
        const f = filters();
        expect(f.searchCommodities).toEqual([]);
        expect(f.searchRegionCodes).toEqual(expect.arrayContaining(['BG-16']));
    });
});
