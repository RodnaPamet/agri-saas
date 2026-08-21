/**
 * The commercial restriction is enforced IN THE PULL JOB, not just in the
 * predicate that backs it.
 *
 * `tests/unit/restricted-price-sources.test.ts` proves `isPriceSourceAllowed`
 * answers correctly. That is necessary and not sufficient: a predicate nobody
 * calls is the `safe-url.ts` defect this session already found once — a
 * security helper written, unit-tested, and wired to nothing.
 *
 * So this file drives the real `runMarketPricesPull` with a restricted
 * `EC_AGRIFOOD_BASE_URL` and asserts the URL never reaches the client.
 */

const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({
    get env() {
        return mockEnv;
    },
}));

const warn = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => warn(...a), info: jest.fn(), error: jest.fn() },
}));

import { runMarketPricesPull } from '@/app-layer/jobs/market-prices-pull';

/**
 * Minimal DB stub. `MarketDbClient` is
 * `Pick<PrismaClient, 'marketPriceSeries' | 'marketPricePoint' | 'exchangeListing'>`
 * — exactly three models, so the stub is small and its shape is checked by the
 * job itself rather than guessed.
 */
function fakeDb() {
    return {
        marketPriceSeries: {
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockResolvedValue({ id: 's1' }),
        },
        marketPricePoint: {
            upsert: jest.fn().mockResolvedValue({}),
        },
        exchangeListing: {
            findMany: jest.fn().mockResolvedValue([]),
        },
    } as never;
}

beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    warn.mockReset();
});

async function runWith(baseUrl: string | undefined) {
    mockEnv.EC_AGRIFOOD_BASE_URL = baseUrl;
    const fetchCereal = jest.fn().mockResolvedValue([]);
    const fetchOilseed = jest.fn().mockResolvedValue([]);
    await runMarketPricesPull(
        {},
        {
            db: fakeDb(),
            fetchCereal,
            fetchOilseed,
            fetchAv: jest.fn().mockResolvedValue([]),
            fetchBarchart: jest.fn().mockResolvedValue([]),
            fetchDiesel: jest.fn().mockResolvedValue([]),
            fetchFertilizer: jest.fn().mockResolvedValue([]),
            sleep: async () => {},
        },
    );
    return { fetchCereal, fetchOilseed };
}

describe('market-prices-pull — restricted source screening', () => {
    it('passes an ALLOWED override through to the client', async () => {
        // The control. Without it, "the restricted URL did not arrive" would
        // also pass against a job that ignores the override entirely.
        const { fetchCereal } = await runWith('https://ec.europa.eu/agrifood/api');
        expect(fetchCereal).toHaveBeenCalled();
        const opts = fetchCereal.mock.calls[0]?.slice(-1)[0];
        expect(JSON.stringify(opts)).toContain('ec.europa.eu');
    });

    it('does NOT pass a restricted override to the client', async () => {
        const { fetchCereal } = await runWith('https://agroportal.bg/agrifood/api');
        expect(fetchCereal).toHaveBeenCalled();
        // The job still runs — a misconfigured override must not take down the
        // unrelated sources in the same pull.
        const opts = JSON.stringify(fetchCereal.mock.calls[0]?.slice(-1)[0] ?? {});
        expect(opts).not.toContain('agroportal');
    });

    it('logs which restriction was tripped, and which env var did it', async () => {
        await runWith('https://agroportal.bg/agrifood/api');
        const hit = warn.mock.calls.find(
            (c) => c[0] === 'market_prices.restricted_source_skipped',
        );
        expect(hit).toBeDefined();
        expect(hit![1]).toMatchObject({
            envVar: 'EC_AGRIFOOD_BASE_URL',
            restrictedHost: 'agroportal.bg',
        });
    });

    it('logs nothing when the override is allowed', async () => {
        await runWith('https://ec.europa.eu/agrifood/api');
        expect(
            warn.mock.calls.filter(
                (c) => c[0] === 'market_prices.restricted_source_skipped',
            ),
        ).toHaveLength(0);
    });
});
