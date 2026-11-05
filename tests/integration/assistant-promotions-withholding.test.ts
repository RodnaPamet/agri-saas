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
});
