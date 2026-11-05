/**
 * «Кой е питал» reads each enquiry inside the farm that wrote it (#2727).
 *
 * DB-backed because the property is an ENCODING, and a mocked Prisma hands
 * back whatever string it was given — so plaintext and ciphertext are the same
 * observation to a double. That is what let three assistant readers ship
 * envelopes (#2723) and what made the Art 15 export hand people `v2:` strings
 * (#2724). Anything whose correctness is "this value is decrypted" needs a
 * real row.
 *
 * TWO FARMS, deliberately. One farm proves nothing: the platform read could be
 * picking up a single bound tenant by luck. Two farms with different DEKs is
 * the arrangement the grouping exists for.
 */
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prisma } from '@/lib/prisma';
import { runInTenantContext } from '@/lib/db-context';
import { listPromotionLeads } from '@/app-layer/usecases/promotion-admin';
import { companyNameKey } from '@/app-layer/usecases/promotions';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `pl2-${randomUUID().slice(0, 8)}`;

const SECRET_A = `Колко е цената за 20 тона? — ${TAG}-A`;
const SECRET_B = `Имате ли доставка до Пловдив? — ${TAG}-B`;

let platformTenantId = '';
let platformUserId = '';
let companyId = '';
let promotionId = '';
const farms: Array<{ tenantId: string; userId: string; leadId: string; secret: string }> = [];

const platformCtx = () =>
    makeRequestContext('ADMIN', {
        userId: platformUserId,
        tenantId: platformTenantId,
        tenantSlug: `${TAG}-platform`,
    });

async function makeFarm(suffix: string, secret: string) {
    const email = `${TAG}-${suffix}@ag.test`;
    const userId = (await prisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: `Stopanin ${suffix}` },
    })).id;
    const tenantId = (await prisma.tenant.create({
        data: { name: `Farm ${suffix} ${TAG}`, slug: `${TAG}-${suffix}` },
    })).id;
    await prisma.tenantMembership.create({
        data: { tenantId, userId, role: 'OWNER', status: 'ACTIVE' },
    });
    // Written INSIDE that farm's context, which is how the real enquiry path
    // writes it — so the row carries that farm's `v2:` envelope and not the
    // global KEK's.
    const ctx = makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-${suffix}` });
    const leadId = await runInTenantContext(ctx, async (db) => {
        const row = await db.promotionLead.create({
            data: {
                promotionId,
                inquirerTenantId: tenantId,
                inquirerUserId: userId,
                requestMessage: secret,
                consentedAt: new Date(),
            },
        });
        return row.id;
    });
    farms.push({ tenantId, userId, leadId, secret });
}

describeFn('#2727 — one promotion’s enquiries, decrypted per farm', () => {
    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        const pEmail = `${TAG}-support@ag.test`;
        platformUserId = (await prisma.user.create({
            data: { email: pEmail, emailHash: hashForLookup(pEmail), name: 'Support' },
        })).id;
        platformTenantId = (await prisma.tenant.create({
            data: { name: `Platform ${TAG}`, slug: `${TAG}-platform` },
        })).id;
        await prisma.tenantMembership.create({
            data: { tenantId: platformTenantId, userId: platformUserId, role: 'ADMIN', status: 'ACTIVE' },
        });
        const cName = `Co ${TAG}`;
        companyId = (await prisma.company.create({
            data: { name: cName, nameKey: companyNameKey(cName) },
        })).id;
        promotionId = (await prisma.promotion.create({
            data: { companyId, title: `Promo ${TAG}`, category: 'fertilizer' },
        })).id;
        await makeFarm('a', SECRET_A);
        await makeFarm('b', SECRET_B);
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) return;
        const ids = [platformTenantId, ...farms.map((f) => f.tenantId)];
        await prisma.$executeRawUnsafe(`DELETE FROM "PromotionLead" WHERE "promotionId" = $1`, promotionId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Promotion" WHERE "id" = $1`, promotionId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Company" WHERE "id" = $1`, companyId).catch(() => {});
        for (const t of ids) {
            await prisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, t).catch(() => {});
            await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, t).catch(() => {});
        }
        for (const u of [platformUserId, ...farms.map((f) => f.userId)]) {
            await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, u).catch(() => {});
        }
    });

    it('POSITIVE CONTROL — the rows really are encrypted under their own farm', async () => {
        // Without this, "the platform read returned plaintext" is also what a
        // write that never encrypted looks like. Read the stored BYTES with a
        // tenantless privileged read: they must be envelopes.
        const raw = await prisma.$queryRawUnsafe<Array<{ message: string }>>(
            `SELECT message FROM "PromotionLead" WHERE "promotionId" = $1`,
            promotionId,
        );
        expect(raw).toHaveLength(2);
        for (const r of raw) expect(r.message).toMatch(/^v2:/);
    });

    it('returns BOTH farms’ messages as plaintext, not envelopes', async () => {
        const leads = await listPromotionLeads(platformCtx(), promotionId);
        expect(leads).toHaveLength(2);
        const byId = new Map(leads.map((l) => [l.id, l]));
        for (const f of farms) {
            const got = byId.get(f.leadId);
            expect(got).toBeDefined();
            // Equality, not just "no envelope": a null or an empty string would
            // satisfy a prefix check and tell an operator nothing.
            expect(got!.message).toBe(f.secret);
        }
    });

    it('names the farm and the person who asked', async () => {
        const leads = await listPromotionLeads(platformCtx(), promotionId);
        const farmsNamed = leads.map((l) => l.farm).sort();
        expect(farmsNamed).toEqual([`Farm a ${TAG}`, `Farm b ${TAG}`]);
        expect(leads.every((l) => l.person !== null)).toBe(true);
    });

    it('ONE lead per farm per promotion — which is why farm order coincides here', async () => {
        // THIS TEST REPLACED ONE THAT COULD NOT FAIL, and the reason is worth
        // keeping. It was called "indexed by id, so farm order cannot scramble
        // the messages", and a mutation to a POSITIONAL join reddened nothing.
        //
        // `readContentPerTenant` returns a flat array in FARM order — order of
        // first appearance among the rows handed to it. With exactly one lead
        // per farm, that is always the row order, so positional and
        // id-indexed agree and no fixture of this query can tell them apart.
        // The scramble the old name warned about needs a farm with TWO leads
        // on one promotion, and `@@unique([promotionId, inquirerTenantId])`
        // makes that impossible.
        //
        // So this pins the CONSTRAINT instead, which is falsifiable: drop the
        // uniqueness and the coincidence goes with it, at which point the
        // id-indexing in `listPromotionLeads` stops being defensive and starts
        // being load-bearing.
        const farmA = farms[0];
        await expect(
            prisma.promotionLead.create({
                data: {
                    promotionId,
                    inquirerTenantId: farmA.tenantId,
                    inquirerUserId: farmA.userId,
                    requestMessage: 'second enquiry from the same farm',
                    consentedAt: new Date(),
                },
            }),
        ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('scopes to ONE promotion — the `where` is the only control', async () => {
        const other = (await prisma.promotion.create({
            data: { companyId, title: `Other ${TAG}`, category: 'seeds' },
        })).id;
        try {
            expect(await listPromotionLeads(platformCtx(), other)).toEqual([]);
        } finally {
            await prisma.$executeRawUnsafe(`DELETE FROM "Promotion" WHERE "id" = $1`, other).catch(() => {});
        }
    });
});
