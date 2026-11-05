/**
 * The `where` clause that is the ENTIRE control — #2665.
 *
 * `Promotion` is a platform-wide catalogue with no `tenantId`, so unlike every
 * other read the assistant performs there is no tenant-isolation policy acting
 * as a backstop. `runTool`'s `assertCanRead` answers "may this person read at
 * all"; a dropped condition in this `where` is not caught one layer down.
 *
 * That is why this is an INTEGRATION suite and not a mocked assertion on the
 * clause. A mock would confirm the object I wrote is the object I wrote; only
 * real rows can show that an unreviewed, expired or ПРЗ promotion does not come
 * back. Each case therefore has a POSITIVE CONTROL in the same test — one row
 * that must be returned — because "nothing came back" and "the read is broken"
 * are otherwise the same observation.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { companyNameKey, listPromotionsForAssistant } from '@/app-layer/usecases/promotions';
import { dayKeyToInstant, farmToday } from '@/lib/calendar-day-key';
import { makeRequestContext } from '../helpers/make-context';

const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `promo-${randomUUID().slice(0, 8)}`;
let tenantId = '';
let companyId = '';
const ids: string[] = [];

/** A promotion row. `publishedAt` and `validTo` default to visible. */
async function promo(opts: {
    title: string;
    published?: boolean;
    validTo?: Date | null;
    ppp?: string | null;
}): Promise<string> {
    const p = await raw.promotion.create({
        data: {
            companyId,
            title: `${TAG} ${opts.title}`,
            category: 'fertilizer',
            publishedAt: opts.published === false ? null : new Date('2026-01-01T00:00:00Z'),
            validTo: opts.validTo === undefined ? new Date('2099-01-01T00:00:00Z') : opts.validTo,
            ...(opts.ppp ? { pppRegistrationNo: opts.ppp } : {}),
        },
        select: { id: true },
    });
    ids.push(p.id);
    return p.id;
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await raw.$connect();
    tenantId = (await raw.tenant.create({ data: { name: TAG, slug: TAG } })).id;
    companyId = (
        await raw.company.create({
            data: { name: `Co ${TAG}`, nameKey: companyNameKey(`Co ${TAG}`) },
            select: { id: true },
        })
    ).id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    // Only what this suite owns. Promotions first — `companyId` restricts.
    await raw.promotion.deleteMany({ where: { id: { in: ids } } });
    await raw.company.deleteMany({ where: { id: companyId } }).catch(() => {});
    await raw.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    await raw.$disconnect();
});

/** Titles this suite created, so other suites' rows cannot decide a result. */
const mine = (rows: Array<{ product: string }>): string[] =>
    rows.filter((r) => r.product.startsWith(TAG)).map((r) => r.product.replace(`${TAG} `, ''));

describeFn('the assistant promotions read withholds what it must', () => {
    it('§1 an UNREVIEWED promotion never comes back — with a reviewed control', async () => {
        /*
         * The owner's review of an AI read of a supplier leaflet is the whole
         * safeguard in #2664. A tool that quoted an unreviewed row would
         * silently undo it — so this is the condition whose absence would be
         * worst, and the control is what proves the read works at all.
         */
        await promo({ title: 'reviewed' });
        await promo({ title: 'draft', published: false });

        const out = await listPromotionsForAssistant(
            makeRequestContext('EDITOR', { tenantId, userId: 'u1' }),
            { limit: 10 },
        );

        expect(mine(out.rows)).toContain('reviewed');
        expect(mine(out.rows)).not.toContain('draft');
    });

    it('§2 an EXPIRED promotion never comes back; an open-ended one does', async () => {
        // "Expired ones are never used" is the owner's wording. Unset is NOT
        // expired — a promotion with no end date is open, not stale.
        await promo({ title: 'expired', validTo: new Date('2020-01-01T00:00:00Z') });
        await promo({ title: 'openended', validTo: null });

        const out = await listPromotionsForAssistant(
            makeRequestContext('EDITOR', { tenantId, userId: 'u1' }),
            { limit: 10 },
        );

        expect(mine(out.rows)).not.toContain('expired');
        expect(mine(out.rows)).toContain('openended');
    });

    it('§3 a ПРЗ is WITHHELD while its Art 66 wording is unconfigured', async () => {
        /*
         * `PPP_ADVERTISING_SAFETY_BG` is unset in the test environment, which
         * is also how it ships: the authoritative Bulgarian text is a БАБХ or
         * legal question, and a plausible paraphrase would be the exact
         * failure the disclosure module exists to prevent.
         *
         * Absent wording therefore means every ПРЗ is withheld. A missing
         * value costs a feature; the other direction costs a breach.
         *
         * The non-ПРЗ control in the same test is what separates "the
         * predicate works" from "the read returned nothing".
         */
        await promo({ title: 'fertiliser' });
        await promo({ title: 'pesticide', ppp: 'BG-12345' });

        const out = await listPromotionsForAssistant(
            makeRequestContext('EDITOR', { tenantId, userId: 'u1' }),
            { limit: 10 },
        );

        expect(mine(out.rows)).toContain('fertiliser');
        expect(mine(out.rows)).not.toContain('pesticide');
    });

    it('§4 the product narrowing is LEXICAL, and an empty narrowing is not an empty catalogue', async () => {
        /*
         * The tool's description tells the model to call again without a
         * product rather than concluding there are none — so the distinction
         * has to be real: narrowing to a word nothing matches must return
         * nothing while the unnarrowed read still returns rows.
         */
        await promo({ title: 'калий' });

        const ctx = makeRequestContext('EDITOR', { tenantId, userId: 'u1' });
        const narrowed = await listPromotionsForAssistant(ctx, {
            product: 'нещонесъществуващо',
            limit: 10,
        });
        const wide = await listPromotionsForAssistant(ctx, { limit: 10 });

        expect(mine(narrowed.rows)).toEqual([]);
        expect(mine(wide.rows).length).toBeGreaterThan(0);
    });
    it('§5 a campaign is live for the WHOLE of its last day, in the FARM zone', async () => {
        /*
         * The fourth consumer of #2752's floor, and the only one that speaks
         * to a farmer in prose rather than rendering a feed.
         *
         * `validTo` is a calendar DAY stored as its UTC-midnight label, and
         * until #2756 it was compared against the INSTANT — so a campaign
         * whose last day was today was withheld from the assistant for the
         * whole of that day, while the admin console still called it ACTIVE.
         * The three instants below are the three readings that differed:
         *
         *   03:00 Sofia on the last day  old: WITHHELD   new: live
         *   23:59 Sofia on the last day  old: WITHHELD   new: live
         *   00:01 Sofia the day after    old: WITHHELD   new: WITHHELD
         *
         * The last two are two minutes apart in wall time and straddle the
         * boundary, which is what makes the pair worth more than either: a
         * floor computed in UTC rather than in the farm zone gives both the
         * SAME day label, so the refuse case fails under it. It is therefore
         * a control on the ZONE as well as on the comparison.
         */
        const lastDay = '2026-06-15';
        await promo({ title: 'lastday', validTo: dayKeyToInstant(lastDay) });
        // The positive control, open-ended, so "withheld" and "the read is
        // broken" stay distinguishable at every one of the three instants.
        await promo({ title: 'alwayson', validTo: null });

        const earlyOnLastDay = new Date('2026-06-15T00:00:01Z');
        const lateOnLastDay = new Date('2026-06-15T20:59:00Z');
        const justAfter = new Date('2026-06-15T21:01:00Z');

        // The premise, asserted rather than assumed: these instants only mean
        // what the comment says while the farm is on Sofia time. A zone change
        // must fail here, not silently re-aim the test at a different pair.
        expect(farmToday(earlyOnLastDay)).toBe(lastDay);
        expect(farmToday(lateOnLastDay)).toBe(lastDay);
        expect(farmToday(justAfter)).toBe('2026-06-16');

        const ctx = makeRequestContext('EDITOR', { tenantId, userId: 'u1' });
        const early = await listPromotionsForAssistant(ctx, { limit: 10, now: earlyOnLastDay });
        const late = await listPromotionsForAssistant(ctx, { limit: 10, now: lateOnLastDay });
        const after = await listPromotionsForAssistant(ctx, { limit: 10, now: justAfter });

        // Live for the whole of the last day — both ends of it.
        expect(mine(early.rows)).toContain('lastday');
        expect(mine(late.rows)).toContain('lastday');
        // And gone the moment the farm's day turns over.
        expect(mine(after.rows)).not.toContain('lastday');

        // Controls: the read itself works at all three instants, so the single
        // absence above is about the window and not about the query.
        expect(mine(early.rows)).toContain('alwayson');
        expect(mine(late.rows)).toContain('alwayson');
        expect(mine(after.rows)).toContain('alwayson');
    });
});
