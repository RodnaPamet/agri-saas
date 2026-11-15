/**
 * #3081 — storing ZarnoBorsa rows, and the three-valued verdict.
 *
 * The verdict is the subject of most of this file. `clean` / `partial` /
 * `unaudited`, and the third exists for the reason #2944 states about the
 * card-health probe: **an empty population produces zero problems, which is
 * byte-identical to a clean result.** A run that saw nothing — lapsed session,
 * moved markup, renumbered products — would otherwise report the same "no bad
 * rows" as a healthy one.
 *
 * With the owner's full-precedence ruling these figures drive the grain
 * calculator and the net-worth number, so a blind scraper and a quiet market
 * must not look alike.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { ZarnoBorsaRow } from '@/lib/market/zarnoborsa-parse';
import {
    ingestZarnoBorsaRows,
    ZARNOBORSA_SOURCE,
    ZARNOBORSA_SOURCE_URL,
} from '@/app-layer/jobs/zarnoborsa-ingest';
import { ZARNOBORSA_EXW_BG, ZARNOBORSA_FOB_BG } from '@/lib/market/zarnoborsa-markets';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

function row(over: Partial<ZarnoBorsaRow> = {}): ZarnoBorsaRow {
    return {
        marketId: ZARNOBORSA_EXW_BG,
        productId: 1007,
        label: 'Пшеница',
        price: '188.65',
        date: '2026-11-14',
        change: '-1.20',
        ...over,
    };
}

async function clear(): Promise<void> {
    const series = await prisma.marketPriceSeries.findMany({
        where: { source: ZARNOBORSA_SOURCE },
        select: { id: true },
    });
    const ids = series.map((s) => s.id);
    if (ids.length > 0) {
        await prisma.marketPricePoint.deleteMany({ where: { seriesId: { in: ids } } });
        await prisma.marketPriceSeries.deleteMany({ where: { id: { in: ids } } });
    }
}

beforeAll(async () => { if (DB_AVAILABLE) await prisma.$connect(); });
afterAll(async () => { if (!DB_AVAILABLE) return; await clear(); await prisma.$disconnect(); });
beforeEach(async () => { if (DB_AVAILABLE) await clear(); });

describeFn('#3081 — the verdict separates "nothing wrong" from "could not see"', () => {
    it('LOCKED OUT writes nothing and reports unaudited, not clean', async () => {
        // The case the whole three-valued verdict exists for: the rows parse
        // perfectly off a paywalled page, so every count would otherwise look
        // healthy while the prices were August's.
        const r = await ingestZarnoBorsaRows([row(), row({ productId: 1006 })], { locked: true });
        expect(r.verdict).toBe('unaudited');
        expect(r.pointsWritten).toBe(0);
        expect(await prisma.marketPriceSeries.count({ where: { source: ZARNOBORSA_SOURCE } }))
            .toBe(0);
    });

    it('ZERO ROWS is unaudited — a blind scraper must not look like a quiet market', async () => {
        const r = await ingestZarnoBorsaRows([], { locked: false });
        expect(r.verdict).toBe('unaudited');
        expect(r.received).toBe(0);
    });

    it('kept rows but NONE mapped is unaudited — that is a renumbering', async () => {
        // Every product id on the Bulgarian table unrecognised is what a
        // renumbering on their side looks like, and it would otherwise read as
        // a clean run that simply had nothing to store.
        const r = await ingestZarnoBorsaRows(
            [row({ productId: 99901 }), row({ productId: 99902 })],
            { locked: false },
        );
        expect(r.verdict).toBe('unaudited');
        expect(r.kept).toBe(2);
        expect(r.mapped).toBe(0);
        expect(r.unmappedProducts).toEqual([99901, 99902]);
    });

    it('PARTIAL when some kept row does not map, naming the ids', async () => {
        // Not a failure — feed wheat, meal and the oils are deliberately
        // unmapped — but not nothing either: an id here that is NOT one of
        // those is a renumbering, and naming them avoids a second
        // investigation.
        const r = await ingestZarnoBorsaRows(
            [row(), row({ productId: 1012, label: 'Слънчогледов Шрот' })],
            { locked: false },
        );
        expect(r.verdict).toBe('partial');
        expect(r.mapped).toBe(1);
        expect(r.unmappedProducts).toEqual([1012]);
        expect(r.pointsWritten).toBe(1);
    });

    it('CLEAN only when every kept row mapped', async () => {
        const r = await ingestZarnoBorsaRows(
            [row(), row({ productId: 1006, label: 'Ечемик', price: '143.43' })],
            { locked: false },
        );
        expect(r.verdict).toBe('clean');
        expect(r.unmappedProducts).toEqual([]);
        expect(r.pointsWritten).toBe(2);
    });
});

describeFn('#3081 — what gets stored', () => {
    it('writes the series with its attribution, and the point on the ROW\'s date', async () => {
        await ingestZarnoBorsaRows([row({ date: '2026-11-14', price: '188.65' })], { locked: false });

        const series = await prisma.marketPriceSeries.findMany({
            where: { source: ZARNOBORSA_SOURCE },
            select: {
                commodity: true, region: true, stage: true, unit: true,
                currency: true, label: true, sourceUrl: true,
                points: { select: { date: true, price: true } },
            },
        });
        expect(series).toHaveLength(1);
        expect(series[0]).toMatchObject({
            commodity: 'wheat', region: 'BG', stage: 'EXW',
            unit: 'EUR/t', currency: 'EUR', label: 'Пшеница',
            // ON THE DATA, so a client renders «Източник: ZarnoBorsa.com»
            // without a second table mapping `source` to a name.
            sourceUrl: ZARNOBORSA_SOURCE_URL,
        });
        expect(series[0].points).toHaveLength(1);
        expect(series[0].points[0].date.toISOString().slice(0, 10)).toBe('2026-11-14');
        // Decimal all the way, never a float.
        expect(series[0].points[0].price.toString()).toBe('188.65');
    });

    it('keys the point on the ROW date, so a stale row lands on ITS day', async () => {
        // The control for the whole design. EXW Украйна carried an «Aug, 03
        // 2026» row on a page we were properly logged into, so keying on the
        // read time would have filed an August price as today's.
        await ingestZarnoBorsaRows([
            row({ date: '2026-11-14', price: '188.65' }),
            row({ date: '2026-08-03', price: '150.00' }),
        ], { locked: false });

        const points = await prisma.marketPricePoint.findMany({
            where: { series: { source: ZARNOBORSA_SOURCE } },
            select: { date: true, price: true },
            orderBy: { date: 'asc' },
        });
        expect(points.map((p) => p.date.toISOString().slice(0, 10)))
            .toEqual(['2026-08-03', '2026-11-14']);
        // Two points on ONE series, not two series.
        expect(await prisma.marketPriceSeries.count({ where: { source: ZARNOBORSA_SOURCE } }))
            .toBe(1);
    });

    it('is IDEMPOTENT — a re-read changes nothing', async () => {
        const rows = [row(), row({ productId: 1006, label: 'Ечемик', price: '143.43' })];
        const first = await ingestZarnoBorsaRows(rows, { locked: false });
        const second = await ingestZarnoBorsaRows(rows, { locked: false });

        expect(second.verdict).toBe(first.verdict);
        expect(await prisma.marketPriceSeries.count({ where: { source: ZARNOBORSA_SOURCE } }))
            .toBe(2);
        expect(await prisma.marketPricePoint.count({ where: { series: { source: ZARNOBORSA_SOURCE } } }))
            .toBe(2);
    });

    it('a CORRECTED price overwrites the same day rather than adding a row', async () => {
        await ingestZarnoBorsaRows([row({ price: '188.65' })], { locked: false });
        await ingestZarnoBorsaRows([row({ price: '190.00' })], { locked: false });

        const points = await prisma.marketPricePoint.findMany({
            where: { series: { source: ZARNOBORSA_SOURCE } },
            select: { price: true },
        });
        expect(points).toHaveLength(1);
        /*
         * They restate a day's price sometimes; the unique on (seriesId, date)
         * makes the latest read authoritative rather than producing two prices
         * for one day.
         *
         * Compared as a DECIMAL, not as a string. `Decimal.toString()`
         * normalises `190.00` to `"190"`, so a string comparison here asserts
         * the formatter rather than the value — which is how this case failed
         * on a correct write. `.equals` is exact decimal arithmetic, so it
         * does not reintroduce a float to dodge a formatting question.
         */
        expect(points[0].price.equals(new Prisma.Decimal('190.00'))).toBe(true);
    });

    it('EXW and FOB are SEPARATE series for the same commodity', async () => {
        await ingestZarnoBorsaRows([
            row({ marketId: ZARNOBORSA_EXW_BG, productId: 1007, price: '188.65' }),
            row({ marketId: ZARNOBORSA_FOB_BG, productId: 1032, label: 'Пшеница 11.5%', price: '205.00' }),
        ], { locked: false });

        const series = await prisma.marketPriceSeries.findMany({
            where: { source: ZARNOBORSA_SOURCE, commodity: 'wheat' },
            select: { stage: true, label: true },
            orderBy: { stage: 'asc' },
        });
        // One commodity, two stages — and the unique tuple includes `stage`,
        // so an EXW price can never overwrite a FOB one.
        expect(series.map((s) => s.stage)).toEqual(['EXW', 'FOB']);
        expect(series.map((s) => s.label)).toEqual(['Пшеница', 'Пшеница 11.5%']);
    });

    it('DISCARDS a region we do not keep', async () => {
        // Bulgaria only, per the owner's narrowing. FOB Russia parses fine and
        // must simply not be stored.
        const r = await ingestZarnoBorsaRows([
            row(),
            row({ marketId: 1055, productId: 1006, label: 'Ечемик' }),
        ], { locked: false });
        expect(r.received).toBe(2);
        expect(r.kept).toBe(1);
        expect(await prisma.marketPriceSeries.count({
            where: { source: ZARNOBORSA_SOURCE, region: { not: 'BG' } },
        })).toBe(0);
    });

    it('follows a RENAMED product label while keeping the series', async () => {
        await ingestZarnoBorsaRows([row({ label: 'Пшеница' })], { locked: false });
        await ingestZarnoBorsaRows([row({ label: 'Пшеница, хлебна' })], { locked: false });

        const series = await prisma.marketPriceSeries.findMany({
            where: { source: ZARNOBORSA_SOURCE },
            select: { id: true, label: true },
        });
        // The IDS are the identity and the label is display, so a rename
        // follows rather than minting a second series — which is exactly why
        // nothing matches on the label.
        expect(series).toHaveLength(1);
        expect(series[0].label).toBe('Пшеница, хлебна');
    });
});
