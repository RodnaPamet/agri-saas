/**
 * The cost summary is EXACT, tenant-scoped, and never blends currencies.
 *
 * Executing against a real database, because every property here is a
 * `$queryRaw` doing its job. A unit test with a mocked Prisma would assert the
 * SQL string is spelled a certain way and prove nothing about what Postgres
 * returns — and the one property that matters most, tenant scoping, is
 * expressible only against real rows belonging to two farms.
 *
 * Raw SQL BYPASSES the application-layer tenantId filter that every ordinary
 * Prisma call in this repo gets. RLS is the backstop; the `WHERE "tenantId"`
 * in the usecase is the control. So the second tenant below is not decoration:
 * delete that clause and §2 is the test that reddens.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { getCostSummary } from '@/app-layer/usecases/cost-summary';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `csum-${randomUUID().slice(0, 8)}`;
const MINE = `t-${TAG}-mine`;
const THEIRS = `t-${TAG}-theirs`;
let userId = '';

async function makeTenant(id: string, slug: string) {
    await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug } });
}

async function cost(
    tenantId: string,
    category: string,
    amount: string,
    currency: string,
    incurredOn: string,
    extra: Record<string, unknown> = {},
) {
    await prisma.costEntry.create({
        data: {
            tenantId,
            category: category as never,
            amount: amount as never,
            currency,
            incurredOn: new Date(`${incurredOn}T00:00:00.000Z`),
            ...extra,
        },
    });
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await makeTenant(MINE, `${TAG}-mine`);
    await makeTenant(THEIRS, `${TAG}-theirs`);
    const email = `${TAG}@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userId = u.id;

    // MY farm: two currencies, two months, two categories, one soft-deleted.
    await cost(MINE, 'FERTILIZER', '1111.50', 'EUR', '2026-09-10');
    await cost(MINE, 'FERTILIZER', '888.50', 'EUR', '2026-09-20');
    await cost(MINE, 'FERTILIZER', '100.00', 'EUR', '2026-10-05');
    await cost(MINE, 'FUEL', '250.25', 'EUR', '2026-10-11');
    await cost(MINE, 'FUEL', '400.00', 'BGN', '2026-10-12');
    await cost(MINE, 'FUEL', '999.99', 'EUR', '2026-10-13', { deletedAt: new Date() });

    // ANOTHER farm, same shapes. Must never appear in my totals.
    await cost(THEIRS, 'FERTILIZER', '5000.00', 'EUR', '2026-09-10');
    await cost(THEIRS, 'FUEL', '7000.00', 'EUR', '2026-10-11');
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.costEntry.deleteMany({ where: { tenantId: { in: [MINE, THEIRS] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.tenant.deleteMany({ where: { id: { in: [MINE, THEIRS] } } });
    await prisma.$disconnect();
});

describeFn('cost summary aggregate', () => {
    const ctx = () => makeRequestContext('ADMIN', { tenantId: MINE, userId });

    it('§1 totals are EXACT integer minor units, with no float drift', async () => {
        const s = await getCostSummary(ctx());
        const eurFert = s.byType.find((r) => r.category === 'FERTILIZER' && r.currency === 'EUR');
        // 1111.50 + 888.50 + 100.00 = 2100.00 -> 210000 cents, exactly.
        // The .50s are the point: a float path would land on 209999.99…
        expect(eurFert?.totalMinor).toBe(210_000);
        expect(Number.isInteger(eurFert?.totalMinor)).toBe(true);
        expect(eurFert?.count).toBe(3);
    });

    it('§2 another farm’s costs are ABSENT — the raw SQL is tenant-scoped', async () => {
        const s = await getCostSummary(ctx());
        // Positive control first: my own rows ARE here, so an empty result
        // cannot pass this test by accident.
        expect(s.byType.length).toBeGreaterThan(0);
        const all = s.byType.reduce((n, r) => n + r.totalMinor, 0);
        // Mine total 2100.00 EUR + 250.25 EUR + 400.00 BGN = 275_025 minor
        // units across currencies. Theirs would add 1_200_000.
        expect(all).toBe(275_025);
        // And the other farm's distinctive figures appear nowhere.
        expect(s.byType.some((r) => r.totalMinor === 500_000)).toBe(false);
        expect(s.byType.some((r) => r.totalMinor === 700_000)).toBe(false);
    });

    it('§3 currencies are grouped, never blended', async () => {
        const s = await getCostSummary(ctx());
        const fuel = s.byType.filter((r) => r.category === 'FUEL');
        // Two rows, not one summed row — there is no FX table in this repo.
        expect(fuel).toHaveLength(2);
        expect(fuel.find((r) => r.currency === 'EUR')?.totalMinor).toBe(25_025);
        expect(fuel.find((r) => r.currency === 'BGN')?.totalMinor).toBe(40_000);
        expect(s.currencies.map((c) => c.currency).sort()).toEqual(['BGN', 'EUR']);
    });

    it('§4 a soft-deleted cost is excluded', async () => {
        const s = await getCostSummary(ctx());
        const fuelEur = s.byType.find((r) => r.category === 'FUEL' && r.currency === 'EUR');
        // 999.99 was deleted; including it would make this 125_024.
        expect(fuelEur?.totalMinor).toBe(25_025);
        expect(fuelEur?.count).toBe(1);
    });

    it('§5 months bucket by incurredOn as YYYY-MM', async () => {
        const s = await getCostSummary(ctx());
        const sep = s.byMonth.filter((r) => r.month === '2026-09');
        const oct = s.byMonth.filter((r) => r.month === '2026-10');
        expect(sep).toHaveLength(1);
        expect(sep[0].totalMinor).toBe(200_000);
        // October: 100.00 + 250.25 EUR, and 400.00 BGN as its own row.
        expect(oct.find((r) => r.currency === 'EUR')?.totalMinor).toBe(35_025);
        expect(oct.find((r) => r.currency === 'BGN')?.totalMinor).toBe(40_000);
    });

    it('§6 byTypeAndMonth is consistent with both other groupings', async () => {
        const s = await getCostSummary(ctx());
        // The property that stops two graphs on one screen disagreeing: the
        // finest grouping must re-sum to each coarser one.
        const sumOf = (rows: { totalMinor: number }[]) => rows.reduce((n, r) => n + r.totalMinor, 0);
        expect(sumOf(s.byTypeAndMonth)).toBe(sumOf(s.byType));
        expect(sumOf(s.byTypeAndMonth)).toBe(sumOf(s.byMonth));
        const sepFert = s.byTypeAndMonth.find(
            (r) => r.category === 'FERTILIZER' && r.month === '2026-09' && r.currency === 'EUR',
        );
        expect(sepFert?.totalMinor).toBe(200_000);
        expect(sepFert?.count).toBe(2);
    });

    it('§7 the category filter narrows every grouping', async () => {
        const s = await getCostSummary(ctx(), { categories: ['FUEL'] as never });
        expect(s.byType.every((r) => r.category === 'FUEL')).toBe(true);
        expect(s.byTypeAndMonth.every((r) => r.category === 'FUEL')).toBe(true);
        // ...and it is not simply returning nothing.
        expect(s.byType.length).toBe(2);
    });

    it('§8 the date window narrows, inclusively at both ends', async () => {
        const s = await getCostSummary(ctx(), {
            from: new Date('2026-09-20T00:00:00.000Z'),
            to: new Date('2026-10-05T00:00:00.000Z'),
        });
        // 888.50 on the 20th and 100.00 on the 5th — both boundary rows in.
        const fert = s.byType.find((r) => r.category === 'FERTILIZER');
        expect(fert?.totalMinor).toBe(98_850);
        expect(fert?.count).toBe(2);
    });
});
