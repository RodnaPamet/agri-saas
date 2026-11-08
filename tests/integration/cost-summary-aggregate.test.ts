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
/**
 * A THIRD farm, for the spelling fold (#2707).
 *
 * Its own tenant on purpose: folding «EURO» into «EUR» changes what the MINE
 * rows sum to, so seeding a spelling there would have silently rewritten §1
 * and §3's expected totals — and a test suite you have to re-baseline to add
 * a case is one that stops telling you when a total changed for a real reason.
 */
const SPELLINGS = `t-${TAG}-spellings`;
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
    await makeTenant(SPELLINGS, `${TAG}-spellings`);
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

    // THE SPELLING FARM (#2707). «Валута» was free text before the EUR-only
    // save path, so one currency is stored under several labels — the owner's
    // own «Торове» read «11 119,50 EUR и 10,00 EURO». Five euro spellings,
    // one with padding and one lower-case, plus a BGN row as the control.
    await cost(SPELLINGS, 'FERTILIZER', '100.00', 'EUR', '2026-09-10');
    await cost(SPELLINGS, 'FERTILIZER', '10.00', 'EURO', '2026-09-11');
    await cost(SPELLINGS, 'FERTILIZER', '1.00', 'euros', '2026-09-12');
    await cost(SPELLINGS, 'FERTILIZER', '0.50', ' € ', '2026-09-13');
    await cost(SPELLINGS, 'FERTILIZER', '0.25', '', '2026-09-14');
    await cost(SPELLINGS, 'FERTILIZER', '400.00', 'BGN', '2026-09-15');
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.costEntry.deleteMany({ where: { tenantId: { in: [MINE, THEIRS, SPELLINGS] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.tenant.deleteMany({ where: { id: { in: [MINE, THEIRS, SPELLINGS] } } });
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

    describe('§9 one currency is one row, however it was spelled (#2707)', () => {
        const spellingCtx = () => makeRequestContext('ADMIN', { tenantId: SPELLINGS, userId });

        it('folds every euro spelling into a single EUR row', async () => {
            // The defect: `GROUP BY "currency"` on a free-text column split one
            // currency across its labels, so the owner saw «11 119,50 EUR и
            // 10,00 EURO» for one thing. 100 + 10 + 1 + 0.50 + 0.25 = 111.75.
            const s = await getCostSummary(spellingCtx());
            const fert = s.byType.filter((r) => r.category === 'FERTILIZER');
            const eur = fert.filter((r) => r.currency === 'EUR');

            expect(eur).toHaveLength(1);
            expect(eur[0].totalMinor).toBe(11_175);
            expect(eur[0].count).toBe(5);
        });

        it('keeps BGN SEPARATE — the control that makes the fold meaningful', async () => {
            // Without this, a fold that swallowed lev into EUR would satisfy
            // the assertion above perfectly, and the total would be wrong
            // rather than merely split.
            //
            // `canonicalCostCurrency` USED to fold BGN, correctly, because it
            // sat beside `normaliseCostToEur` and that converted the amount at
            // the fixed peg — so this control existed to say that THIS
            // aggregate, which converts nothing, must not copy it. #2793
            // removed both halves and the two now agree, which makes the
            // control redundant on that axis and no less load-bearing: this
            // SQL would still add two different units together if it folded
            // the label, whatever its TypeScript neighbour decides.
            const s = await getCostSummary(spellingCtx());
            const fert = s.byType.filter((r) => r.category === 'FERTILIZER');

            expect(fert.map((r) => r.currency).sort()).toEqual(['BGN', 'EUR']);
            expect(fert.find((r) => r.currency === 'BGN')?.totalMinor).toBe(40_000);
        });

        it('folds in the currencies LIST too, so nothing is reported excluded', async () => {
            // The second half of the defect, and the one a farmer reads: the
            // list drives «не са включени N разхода в EURO», which counted
            // euros among the rows excluded from a euro total.
            const s = await getCostSummary(spellingCtx());

            expect(s.currencies.map((c) => c.currency).sort()).toEqual(['BGN', 'EUR']);
            expect(s.currencies.find((c) => c.currency === 'EUR')?.count).toBe(5);
        });

        it('folds in byMonth and byTypeAndMonth, not only byType', async () => {
            // Four aggregates share the column and each has its own GROUP BY.
            // Fixing one and leaving three is how the charts and the summary
            // would disagree about the same farm.
            const s = await getCostSummary(spellingCtx());

            const monthEur = s.byMonth.filter((r) => r.currency === 'EUR');
            expect(monthEur).toHaveLength(1);
            expect(monthEur[0].totalMinor).toBe(11_175);

            const cellEur = s.byTypeAndMonth.filter(
                (r) => r.category === 'FERTILIZER' && r.currency === 'EUR',
            );
            expect(cellEur).toHaveLength(1);
            expect(cellEur[0].totalMinor).toBe(11_175);
        });
    });
});
