/**
 * Integration test: market-prices-pull upsert idempotence, against a real DB.
 *
 * The EC HTTP clients are injected (deps.fetchCereal / deps.fetchOilseed) so
 * no network is touched; the DB client is the test-DB client (deps.db). The
 * core invariant: running the pull TWICE with identical source data produces
 * an IDENTICAL row count — the (source,commodity,region,stage) series unique
 * and the (seriesId,date) point unique make every write idempotent.
 */
import { runMarketPricesPull } from '@/app-layer/jobs/market-prices-pull';
import type { EcObservation } from '@/lib/market/ec-agrifood-client';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const wheatObs: EcObservation = {
    memberStateCode: 'BG',
    productName: 'Common wheat',
    stage: 'Delivered to port',
    market: 'Varna',
    beginDate: '06/01/2025',
    price: 178,
    unit: 'EUR/t',
    currency: 'EUR',
};

const sunflowerObs: EcObservation = {
    memberStateCode: 'BG',
    productName: 'Sunflower seed',
    stage: 'CIF',
    market: 'Dobrich',
    beginDate: '06/01/2025',
    price: 512,
    unit: 'BGN/t',
    currency: 'BGN',
};

// Only return records for the requested product; the oilseed fetch returns the
// sunflower record (the job filters productName === 'Sunflower seed').
const deps = {
    fetchCereal: async (args: { productCodes: string[] }): Promise<EcObservation[]> =>
        args.productCodes.includes('BLTPAN') ? [wheatObs] : [],
    fetchOilseed: async (): Promise<EcObservation[]> => [sunflowerObs],
};

describeFn('market-prices-pull (integration — real DB)', () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    beforeEach(async () => {
        // Clean slate — global cache tables, no tenant scoping.
        await prisma.marketPricePoint.deleteMany({});
        await prisma.marketPriceSeries.deleteMany({});
    });

    afterAll(async () => {
        await prisma.marketPricePoint.deleteMany({});
        await prisma.marketPriceSeries.deleteMany({});
    });

    it('persists EC series + points and is idempotent across re-runs', async () => {
        const first = await runMarketPricesPull({ source: 'ec' }, { ...deps, db: prisma });
        expect(first.sources).toEqual(['ec']);

        const seriesAfter1 = await prisma.marketPriceSeries.count();
        const pointsAfter1 = await prisma.marketPricePoint.count();
        // wheat/BG + sunflower/BG.
        expect(seriesAfter1).toBe(2);
        expect(pointsAfter1).toBe(2);

        // Second run with identical data — no new rows.
        await runMarketPricesPull({ source: 'ec' }, { ...deps, db: prisma });
        expect(await prisma.marketPriceSeries.count()).toBe(2);
        expect(await prisma.marketPricePoint.count()).toBe(2);
    });

    // ── own-listings index ──────────────────────────────────────────
    //
    // The index is the only path carrying farmer-owned data into Trends, and
    // it was dead: CreateOfferModal seeds Title-Case, TrendCommodity is
    // lowercase, getPriceTrends matches exactly, and nothing normalised. These
    // run against real ExchangeListing rows so the QUERY PREDICATE is exercised
    // — a pure-function test on computeListingsMedianIndex cannot see a `where`
    // clause that lets bids in.
    describe('own-listings index', () => {
        const listingIds: string[] = [];

        async function listing(opts: {
            tenant: string;
            price: number;
            commodity?: string;
            side?: 'SELL' | 'BUY';
            kind?: 'CULTURE' | 'SEEDS';
            expiresAt?: Date | null;
            status?: 'ACTIVE' | 'FULFILLED' | 'WITHDRAWN' | 'EXPIRED';
        }) {
            const row = await prisma.exchangeListing.create({
                data: {
                    sellerTenantId: opts.tenant,
                    // Required FK-less owner column; the index never reads it,
                    // it only counts DISTINCT sellerTenantId.
                    sellerUserId: `${opts.tenant}-user`,
                    side: opts.side ?? 'SELL',
                    kind: opts.kind ?? 'CULTURE',
                    commodity: opts.commodity ?? 'Wheat',
                    quantityTonnes: 100,
                    pricePerTonne: opts.price,
                    priceCurrency: 'EUR',
                    regionCode: 'BG-23',
                    regionName: 'Sofia',
                    lat: 42.7,
                    lon: 23.3,
                    status: opts.status ?? 'ACTIVE',
                    expiresAt: opts.expiresAt ?? null,
                },
                select: { id: true },
            });
            listingIds.push(row.id);
            return row;
        }

        afterEach(async () => {
            if (listingIds.length > 0) {
                await prisma.exchangeListing.deleteMany({ where: { id: { in: listingIds } } });
                listingIds.length = 0;
            }
        });

        async function publishedMedian(): Promise<number | null> {
            await runMarketPricesPull({ source: 'listings' }, { ...deps, db: prisma });
            const series = await prisma.marketPriceSeries.findFirst({
                where: { source: 'listings', commodity: 'wheat' },
                include: { points: true },
            });
            const price = series?.points[0]?.price;
            return price == null ? null : Number(price);
        }

        it('publishes a Title-Case commodity under its canonical slug', async () => {
            // The whole defect in one assertion: production writes 'Wheat',
            // the trends read looks for 'wheat', and the tile showed "—".
            await listing({ tenant: 'ten-a', price: 200 });
            await listing({ tenant: 'ten-b', price: 220 });
            await listing({ tenant: 'ten-c', price: 240 });

            expect(await publishedMedian()).toBe(220);
        });

        it('NEVER pools bids with asks', async () => {
            // ExchangeSide shares the model and the pricePerTonne column, so an
            // unfiltered read averaged opposite sides of a spread into a number
            // describing nothing.
            await listing({ tenant: 'ten-a', price: 200 });
            await listing({ tenant: 'ten-b', price: 220 });
            await listing({ tenant: 'ten-c', price: 240 });
            // Three buyers bidding far below — must not move the ask index.
            await listing({ tenant: 'buy-a', price: 10, side: 'BUY' });
            await listing({ tenant: 'buy-b', price: 12, side: 'BUY' });
            await listing({ tenant: 'buy-c', price: 14, side: 'BUY' });

            expect(await publishedMedian()).toBe(220);
        });

        it('excludes non-CULTURE kinds — seed wheat is not feed wheat', async () => {
            await listing({ tenant: 'ten-a', price: 200 });
            await listing({ tenant: 'ten-b', price: 220 });
            await listing({ tenant: 'ten-c', price: 240 });
            // Seed trades at a large multiple of feed grain.
            await listing({ tenant: 'seed-a', price: 4000, kind: 'SEEDS' });
            await listing({ tenant: 'seed-b', price: 4200, kind: 'SEEDS' });
            await listing({ tenant: 'seed-c', price: 4400, kind: 'SEEDS' });

            expect(await publishedMedian()).toBe(220);
        });

        it('mirrors the marketplace expiry predicate', async () => {
            // The canonical browse read hides past-expiry rows, so an index
            // computed over them cannot be reconciled against the board.
            const past = new Date(Date.now() - 86_400_000);
            await listing({ tenant: 'ten-a', price: 200 });
            await listing({ tenant: 'ten-b', price: 220 });
            await listing({ tenant: 'ten-c', price: 240 });
            await listing({ tenant: 'old-a', price: 900, expiresAt: past });
            await listing({ tenant: 'old-b', price: 950, expiresAt: past });
            await listing({ tenant: 'old-c', price: 990, expiresAt: past });

            expect(await publishedMedian()).toBe(220);
        });

        it('excludes listings that are no longer ACTIVE', async () => {
            await listing({ tenant: 'ten-a', price: 200 });
            await listing({ tenant: 'ten-b', price: 220 });
            await listing({ tenant: 'ten-c', price: 240 });
            await listing({ tenant: 'gone-a', price: 700, status: 'FULFILLED' });
            await listing({ tenant: 'gone-b', price: 750, status: 'WITHDRAWN' });
            await listing({ tenant: 'gone-c', price: 800, status: 'EXPIRED' });

            expect(await publishedMedian()).toBe(220);
        });

        it('gives one tenant one vote however many listings it posts', async () => {
            await listing({ tenant: 'ten-a', price: 200 });
            await listing({ tenant: 'ten-b', price: 220 });
            for (let i = 0; i < 25; i += 1) {
                await listing({ tenant: 'flooder', price: 9999 });
            }
            // Tenant medians [200, 220, 9999] → 220, not 9999.
            expect(await publishedMedian()).toBe(220);
        });
    });

    it('stores the resolved per-series currency (sunflower BG → BGN)', async () => {
        await runMarketPricesPull({ source: 'ec' }, { ...deps, db: prisma });
        const sunflower = await prisma.marketPriceSeries.findFirst({
            where: { commodity: 'sunflower', region: 'BG' },
            include: { points: true },
        });
        expect(sunflower?.currency).toBe('BGN');
        expect(sunflower?.unit).toBe('BGN/t');
        expect(Number(sunflower?.points[0]?.price)).toBe(512);
    });
});
