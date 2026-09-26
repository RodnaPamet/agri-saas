/**
 * The insurance lead's quote is the SERVER's, and a retry is exactly-once.
 *
 * Executing tests against a real database, because both guarantees are a
 * unique index doing its job plus a pre-check racing it. A structural test
 * asserting "the usecase takes an idempotencyKey" would pass with the column
 * missing, and one asserting "it stores quoteJson" would pass against a
 * usecase that stored whatever the client sent.
 *
 * The isolation case is the security property of this change. `InsuranceLead`
 * is NOT tenant-scoped and carries NO RLS — `inquirerTenantId` on the replay
 * lookup is the only thing standing between one farm's Idempotency-Key and
 * another farm's lead.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createInsuranceLead } from '@/app-layer/usecases/insurance';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `ilq-${randomUUID().slice(0, 8)}`;
const TENANT_A = `${TAG}-a`;
const TENANT_B = `${TAG}-b`;
let ownerA = '';
let ownerB = '';

async function seedTenant(id: string, slug: string): Promise<string> {
    await prisma.tenant.upsert({
        where: { id },
        update: {},
        create: { id, name: id, slug },
    });
    const email = `${slug}-owner@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId: id, userId: u.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    ownerA = await seedTenant(TENANT_A, `${TAG}-a`);
    ownerB = await seedTenant(TENANT_B, `${TAG}-b`);
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.insuranceLead.deleteMany({
        where: { inquirerTenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await prisma.$disconnect();
});

const QUOTE = {
    productKey: 'wheat',
    areaDca: 1000,
    sumInsuredCents: 10_000_000,
    instalments: 3,
};

describeFn('the lead carries a server-computed quote', () => {
    it('recomputes the premium and stores a snapshot, ignoring nothing the client sent', async () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT_A, tenantSlug: `${TAG}-a`, userId: ownerA });
        const lead = await createInsuranceLead(ctx, { parcelId: `${TAG}-p1`, quote: QUOTE });

        const stored = await prisma.insuranceLead.findUnique({ where: { id: lead.id } });
        const q = stored?.quoteJson as Record<string, unknown>;

        // Reference case A, to the cent.
        expect(q.premiumCents).toBe(1_000_000);
        expect(q.instalmentsCents).toEqual([333_334, 333_333, 333_333]);
        expect(q.premiumPerDcaCents).toBe(1_000);
        expect(q.tariffBp).toBe(1000);
        expect(q.engineVersion).toBe(1);
        expect(typeof q.computedAt).toBe('string');
        expect(q.currencySymbol).toBe('€');
    });

    it('stores an empty message when the body carried only a quote', async () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT_A, tenantSlug: `${TAG}-a`, userId: ownerA });
        const lead = await createInsuranceLead(ctx, { parcelId: `${TAG}-p2`, quote: QUOTE });
        const stored = await prisma.insuranceLead.findUnique({ where: { id: lead.id } });
        expect(stored?.message).toBe('');
    });

    it('rejects an impossible quote as a 400, never a 500', async () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT_A, tenantSlug: `${TAG}-a`, userId: ownerA });
        await expect(
            createInsuranceLead(ctx, {
                parcelId: `${TAG}-p3`,
                quote: { ...QUOTE, areaDca: 0 },
            }),
        ).rejects.toMatchObject({ status: 400 });
    });

    it('a message-only lead still works and stores no quote', async () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT_A, tenantSlug: `${TAG}-a`, userId: ownerA });
        const lead = await createInsuranceLead(ctx, {
            parcelId: `${TAG}-p4`,
            message: 'Please quote this parcel',
        });
        const stored = await prisma.insuranceLead.findUnique({ where: { id: lead.id } });
        expect(stored?.quoteJson).toBeNull();
        expect(stored?.message).toBe('Please quote this parcel');
    });
});

describeFn('Idempotency-Key makes a retry exactly-once', () => {
    it('replaying the same key returns the ORIGINAL lead and creates no second row', async () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT_A, tenantSlug: `${TAG}-a`, userId: ownerA });
        const key = `key-${randomUUID()}`;
        const first = await createInsuranceLead(ctx, { parcelId: `${TAG}-p5`, quote: QUOTE }, key);
        const second = await createInsuranceLead(ctx, { parcelId: `${TAG}-p5`, quote: QUOTE }, key);

        expect(second.id).toBe(first.id);
        const rows = await prisma.insuranceLead.findMany({
            where: { inquirerTenantId: TENANT_A, clientMutationId: key },
        });
        expect(rows).toHaveLength(1);
    });

    it('two requests racing past the pre-check still make ONE lead', async () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT_A, tenantSlug: `${TAG}-a`, userId: ownerA });
        const key = `race-${randomUUID()}`;
        // Fired together so both can pass the findFirst before either inserts;
        // the unique index is what has to hold, not the pre-check.
        const [a, b] = await Promise.all([
            createInsuranceLead(ctx, { parcelId: `${TAG}-p6`, quote: QUOTE }, key),
            createInsuranceLead(ctx, { parcelId: `${TAG}-p6`, quote: QUOTE }, key),
        ]);
        expect(a.id).toBe(b.id);
        const rows = await prisma.insuranceLead.findMany({
            where: { inquirerTenantId: TENANT_A, clientMutationId: key },
        });
        expect(rows).toHaveLength(1);
    });

    it('omitting the key keeps repeat asks working — NULLs are distinct', async () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT_A, tenantSlug: `${TAG}-a`, userId: ownerA });
        const one = await createInsuranceLead(ctx, { parcelId: `${TAG}-p7`, quote: QUOTE });
        const two = await createInsuranceLead(ctx, { parcelId: `${TAG}-p7`, quote: QUOTE });
        // The 2026-09-24 decision: a farmer may re-ask with a corrected land
        // size. The new unique must not resurrect the cap that was dropped.
        expect(two.id).not.toBe(one.id);
    });

    it('THE SECURITY PROPERTY: one tenant\'s key never returns another tenant\'s lead', async () => {
        const key = `shared-${randomUUID()}`;
        const ctxA = makeRequestContext('OWNER', { tenantId: TENANT_A, tenantSlug: `${TAG}-a`, userId: ownerA });
        const ctxB = makeRequestContext('OWNER', { tenantId: TENANT_B, tenantSlug: `${TAG}-b`, userId: ownerB });

        const leadA = await createInsuranceLead(ctxA, { parcelId: `${TAG}-p8`, quote: QUOTE }, key);
        const leadB = await createInsuranceLead(ctxB, { parcelId: `${TAG}-p8`, quote: QUOTE }, key);

        // InsuranceLead has no RLS. If the replay lookup ever loses its
        // inquirerTenantId filter, tenant B is handed tenant A's lead id here
        // and this is the only test that would notice.
        expect(leadB.id).not.toBe(leadA.id);
        const a = await prisma.insuranceLead.findUnique({ where: { id: leadA.id } });
        const b = await prisma.insuranceLead.findUnique({ where: { id: leadB.id } });
        expect(a?.inquirerTenantId).toBe(TENANT_A);
        expect(b?.inquirerTenantId).toBe(TENANT_B);
    });
});
