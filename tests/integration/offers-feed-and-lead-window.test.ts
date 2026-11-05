/**
 * «Оферти»: the feed's day-keyed window, and the lead gate that did not use it
 * (#2725).
 *
 * DB-backed because both findings are about what the DATABASE holds versus what
 * the wire says. A mocked Prisma hands back whatever `Date` it was given, so it
 * cannot tell a farm-zone day key from a UTC one — the same blindness that let
 * three readers ship ciphertext (#2723).
 */
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prisma } from '@/lib/prisma';
import { listActivePromotions, createPromotionLead, companyNameKey } from '@/app-layer/usecases/promotions';
import { CreatePromotionSchema } from '@/app-layer/schemas/promotion-admin.schemas';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { dayKeyToInstant } from '@/lib/calendar-day-key';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `off-${randomUUID().slice(0, 8)}`;

let tenantId = '';
let userId = '';
let companyId = '';
const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

/** «2 Nov 2026» as the console's DatePicker stores it — LOCAL midnight in Sofia. */
const NOV_2_LOCAL_MIDNIGHT = new Date('2026-11-02T00:00:00+02:00');

async function makePromotion(opts: {
    suffix: string;
    publishedAt: Date | null;
    validFrom?: Date | null;
    validTo?: Date | null;
}) {
    return (await prisma.promotion.create({
        data: {
            companyId,
            title: `${TAG}-${opts.suffix}`,
            category: 'fertilizer',
            publishedAt: opts.publishedAt,
            validFrom: opts.validFrom ?? null,
            validTo: opts.validTo ?? null,
        },
    })).id;
}

describeFn('#2725 — the offers feed and the lead window', () => {
    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        const email = `${TAG}@ag.test`;
        userId = (await prisma.user.create({
            data: { email, emailHash: hashForLookup(email), name: 'Offer Reader' },
        })).id;
        tenantId = (await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
        await prisma.tenantMembership.create({
            data: { tenantId, userId, role: 'OWNER', status: 'ACTIVE' },
        });
        const companyName = `Co ${TAG}`;
        companyId = (await prisma.company.create({
            data: { name: companyName, nameKey: companyNameKey(companyName) },
        })).id;
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) return;
        await prisma.$executeRawUnsafe(`DELETE FROM "PromotionLead" WHERE "inquirerTenantId" = $1`, tenantId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Notification" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Promotion" WHERE "companyId" = $1`, companyId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Company" WHERE "id" = $1`, companyId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    });

    it('serves the window as FARM-zone day keys, where a UTC slice would be a day early', async () => {
        // THE DISCRIMINATING ASSERTION. The console's DatePicker writes local
        // midnight, so «2 Nov» is stored as 2026-11-01T22:00:00Z — and
        // `toISOString().slice(0, 10)`, the idiom used five times elsewhere in
        // this repo, yields 2026-11-01. A day earlier than the web displays,
        // because `formatDate` renders through the farm zone.
        //
        // Asserting only "it equals 2026-11-02" would pass under either
        // implementation on a machine running in UTC+2 if the value were a
        // Date; pinning the naive result as DIFFERENT is what makes this test
        // about the mechanism rather than about the runner's clock.
        expect(NOV_2_LOCAL_MIDNIGHT.toISOString().slice(0, 10)).toBe('2026-11-01');

        const id = await makePromotion({
            suffix: 'daykey',
            publishedAt: new Date('2026-01-01T00:00:00Z'),
            validFrom: NOV_2_LOCAL_MIDNIGHT,
            validTo: new Date('2099-12-31T00:00:00+02:00'),
        });
        const offers = await listActivePromotions(ctx());
        const row = offers.find((o) => o.id === id);
        expect(row).toBeDefined();
        expect(row!.validFrom).toBe('2026-11-02');
        expect(row!.validTo).toBe('2099-12-31');
    });

    it('the write schemas STRIP mediaUrl, so no operator can point it off-site', async () => {
        // The guarantee a native client depends on: it fetches `mediaUrl` with
        // the person's bearer, so an absolute URL would carry that credential
        // to a third party. `promotionImageServeUrl` is the only producer, and
        // this is why — the field cannot be written through the API at all.
        const parsed = CreatePromotionSchema.parse({
            companyId: 'c-1',
            title: 'x',
            category: 'fertilizer',
            mediaUrl: 'https://evil.example/pixel.png',
        });
        expect(parsed).not.toHaveProperty('mediaUrl');
    });

    describe('the lead gate uses the FEED predicate, not publishedAt alone', () => {
        // The comment on that gate claimed "a draft or EXPIRED promotion must
        // not accept leads" and tested `publishedAt` by itself, while
        // `visibleWhere` tests three things. So an expired campaign was off the
        // feed and still accepting leads.
        const lead = (promotionId: string) =>
            createPromotionLead(ctx(), { promotionId, message: 'Колко е цената?', consent: true });

        it('POSITIVE CONTROL — a published, in-window offer still accepts a lead', async () => {
            // Without this, "refuse everything" satisfies every assertion below.
            const id = await makePromotion({
                suffix: 'live',
                publishedAt: new Date('2026-01-01T00:00:00Z'),
                validFrom: new Date('2026-01-01T00:00:00Z'),
                validTo: new Date('2099-12-31T00:00:00Z'),
            });
            await expect(lead(id)).resolves.toMatchObject({ id: expect.any(String) });
        });

        it('an EXPIRED offer is PROMOTION_NOT_AVAILABLE — the case the old gate missed', async () => {
            const id = await makePromotion({
                suffix: 'expired',
                publishedAt: new Date('2026-01-01T00:00:00Z'),
                validTo: new Date('2026-02-01T00:00:00Z'),
            });
            await expect(lead(id)).rejects.toMatchObject({ code: 'PROMOTION_NOT_AVAILABLE' });
        });

        it('an offer that has not STARTED is PROMOTION_NOT_AVAILABLE too', async () => {
            const id = await makePromotion({
                suffix: 'future',
                publishedAt: new Date('2026-01-01T00:00:00Z'),
                validFrom: new Date('2099-01-01T00:00:00Z'),
            });
            await expect(lead(id)).rejects.toMatchObject({ code: 'PROMOTION_NOT_AVAILABLE' });
        });

        it('an UNPUBLISHED offer is PROMOTION_NOT_AVAILABLE', async () => {
            const id = await makePromotion({ suffix: 'draft', publishedAt: null });
            await expect(lead(id)).rejects.toMatchObject({ code: 'PROMOTION_NOT_AVAILABLE' });
        });

        it('an unknown id is PROMOTION_NOT_FOUND — a DIFFERENT fact', async () => {
            // The two were one uncoded 404 until #2725. Separating them leaks
            // nothing: `Promotion` is a global catalogue every farm sees
            // identically, so there is nothing tenant-private to enumerate.
            await expect(lead(`${TAG}-no-such-promotion`)).rejects.toMatchObject({
                code: 'PROMOTION_NOT_FOUND',
            });
        });
    });

    describe('#2752 — the feed honours the window as DAYS, through the real query', () => {
        // These exercise `visibleWhere` by calling `listActivePromotions`, which
        // the unit suite's agreement test deliberately does NOT: that one
        // re-implements the predicate in memory, so it pins the two definitions
        // against each other and cannot notice the query changing underneath.
        // `agrent backend-2`'s #2745 is the cautionary case — a proof whose
        // doubles all drove one branch read as several confirmations.
        //
        // `listActivePromotions` takes `now`, so the boundary is reachable
        // without touching the clock.
        const LAST_DAY = '2026-11-30';
        const FIRST_DAY = '2026-11-02';

        let windowed = '';
        beforeAll(async () => {
            if (!DB_AVAILABLE) return;
            windowed = await makePromotion({
                suffix: 'windowed',
                publishedAt: new Date('2026-01-01T00:00:00Z'),
                validFrom: dayKeyToInstant(FIRST_DAY),
                validTo: dayKeyToInstant(LAST_DAY),
            });
        });

        const idsAt = async (iso: string) =>
            (await listActivePromotions(ctx(), { now: new Date(iso) })).map((o) => o.id);

        it('is VISIBLE on the last minute of its last day — the defect', async () => {
            expect(await idsAt('2026-11-30T23:59:00+02:00')).toContain(windowed);
        });

        it('is VISIBLE on the first minute of its first day', async () => {
            expect(await idsAt('2026-11-02T00:01:00+02:00')).toContain(windowed);
        });

        it('is NOT visible the day before it starts', async () => {
            expect(await idsAt('2026-11-01T23:30:00+02:00')).not.toContain(windowed);
        });

        it('is NOT visible the day after it ends', async () => {
            expect(await idsAt('2026-12-01T00:01:00+02:00')).not.toContain(windowed);
        });

        it('ACCEPTS a lead consented to late on the last day — consumer 4', async () => {
            // `createPromotionLead` is the fourth consumer of `visibleWhere`,
            // and the only one that passes something other than `now`: it
            // passes `consentedAt`. So #2752 changed ITS question too, from
            // "was the offer live at the instant they consented" to "on the day
            // they consented" — strictly more permissive, and wanted, because a
            // farmer who can SEE an offer must be able to ask about it and
            // those two disagreed for the last day of every campaign.
            //
            // Pinned here because that surface's semantics would otherwise be
            // held by a comment alone. `agrent backend-2` identified the change
            // in review; this is the half that makes it checkable.
            const id = await makePromotion({
                suffix: 'lastday-lead',
                publishedAt: new Date('2026-01-01T00:00:00Z'),
                validFrom: dayKeyToInstant('2026-11-02'),
                validTo: dayKeyToInstant('2026-11-30'),
            });
            await expect(
                createPromotionLead(
                    ctx(),
                    { promotionId: id, message: 'Още ли е валидна офертата?', consent: true },
                    { now: new Date('2026-11-30T23:50:00+02:00') },
                ),
            ).resolves.toMatchObject({ id: expect.any(String) });
        });

        it('still REFUSES one consented to the day after it ends', async () => {
            // The other side of the same boundary: more permissive by a day is
            // the change, not open-ended.
            const id = await makePromotion({
                suffix: 'afterend-lead',
                publishedAt: new Date('2026-01-01T00:00:00Z'),
                validTo: dayKeyToInstant('2026-11-30'),
            });
            await expect(
                createPromotionLead(
                    ctx(),
                    { promotionId: id, message: 'Още ли е валидна?', consent: true },
                    { now: new Date('2026-12-01T00:10:00+02:00') },
                ),
            ).rejects.toMatchObject({ code: 'PROMOTION_NOT_AVAILABLE' });
        });

        it('serves the window back as the DAY KEYS it was given', async () => {
            const rows = await listActivePromotions(ctx(), { now: new Date('2026-11-15T12:00:00+02:00') });
            const row = rows.find((r) => r.id === windowed);
            expect(row).toBeDefined();
            expect(row!.validFrom).toBe(FIRST_DAY);
            expect(row!.validTo).toBe(LAST_DAY);
        });
    });
});
