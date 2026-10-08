/**
 * The farm switcher list: whose farms, which farms, and in what order.
 *
 * ## The three clauses, and why each gets its own case
 *
 * `listMyFarms` is four lines of Prisma, and every one of its predicates is a
 * property somebody can delete without any test noticing unless it is asserted
 * separately:
 *
 *   userId                     — someone else's farms must never appear
 *   status: 'ACTIVE'           — a deactivated member is not a member
 *   tenant: { deletedAt: null } — a REMOVED farm must not appear
 *   orderBy createdAt asc      — `farms[0]` is a documented contract
 *
 * The third is the one the request that prompted this route did not mention,
 * and the easiest to lose: soft-deleting a tenant sets only `Tenant.deletedAt`
 * and deliberately leaves memberships ACTIVE, so a removed farm still has live
 * memberships pointing at it. Drop the clause and the switcher offers farms
 * that 404 at the tenant resolver — a failure that looks like a broken app
 * rather than a stale list.
 *
 * The ordering is asserted because `farms[0]` is promised to equal the farm
 * `GET /api/auth/me` names, which is how a native client reconciles this list
 * with the farm it opens on a fresh install.
 *
 * ## Why the fixtures are built with the bare client
 *
 * `listMyFarms` reads the GLOBAL prisma deliberately — `TenantMembership`'s RLS
 * is tenant-scoped with no person clause, so a read with no tenant bound
 * returns zero rows silently. Fixtures therefore must not be subject to a
 * policy either, or a passing test would prove only that both sides were
 * equally blind.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { listMyFarms } from '@/app-layer/usecases/my-farms';
import { hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const APP_DB_URL = process.env.DATABASE_URL ?? DB_URL;
const verifier = new PrismaClient({ adapter: new PrismaPg({ connectionString: APP_DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const RUN = randomUUID().slice(0, 8);
const ME = `u-farms-${randomUUID()}`;
const SOMEONE_ELSE = `u-other-${randomUUID()}`;

/** Tenants are created oldest-first so membership order is deterministic. */
const OLDEST = `t-farms-1-${randomUUID()}`;
const MIDDLE = `t-farms-2-${randomUUID()}`;
const NEWEST = `t-farms-3-${randomUUID()}`;
const REMOVED = `t-farms-del-${randomUUID()}`;
const DEACTIVATED = `t-farms-off-${randomUUID()}`;
const NOT_MINE = `t-farms-other-${randomUUID()}`;

async function makeUser(id: string): Promise<void> {
    const email = `${id}@example.test`;
    await verifier.user.create({
        data: { id, email, emailHash: hashForLookup(email, 'email'), name: id },
    });
}

async function makeTenant(id: string, deleted = false): Promise<void> {
    await verifier.tenant.create({
        data: { id, name: id, slug: id, ...(deleted ? { deletedAt: new Date() } : {}) },
    });
}

/** `createdAt` is explicit so ordering is a fact rather than a race. */
async function join(
    userId: string,
    tenantId: string,
    opts: { role?: 'OWNER' | 'ADMIN' | 'READER'; status?: 'ACTIVE' | 'DEACTIVATED'; at: Date },
): Promise<void> {
    await verifier.tenantMembership.create({
        data: {
            tenantId,
            userId,
            role: opts.role ?? 'OWNER',
            status: opts.status ?? 'ACTIVE',
            createdAt: opts.at,
        },
    });
}

describeFn('listMyFarms — the farm switcher list', () => {
    beforeAll(async () => {
        await verifier.$connect();
        await makeUser(ME);
        await makeUser(SOMEONE_ELSE);
        for (const t of [OLDEST, MIDDLE, NEWEST, DEACTIVATED, NOT_MINE]) await makeTenant(t);
        await makeTenant(REMOVED, true);

        // Deliberately inserted out of order, so a passing ordering assertion
        // cannot be an artefact of insertion sequence.
        await join(ME, MIDDLE, { at: new Date('2026-02-01T00:00:00Z') });
        await join(ME, NEWEST, { at: new Date('2026-03-01T00:00:00Z'), role: 'ADMIN' });
        await join(ME, OLDEST, { at: new Date('2026-01-01T00:00:00Z') });
        await join(ME, REMOVED, { at: new Date('2025-12-01T00:00:00Z') });
        await join(ME, DEACTIVATED, { at: new Date('2025-11-01T00:00:00Z'), status: 'DEACTIVATED' });
        await join(SOMEONE_ELSE, NOT_MINE, { at: new Date('2025-01-01T00:00:00Z') });
    });

    afterAll(async () => {
        await verifier.$disconnect();
    });

    it('returns my active farms, oldest membership FIRST', async () => {
        const farms = await listMyFarms(ME);
        expect(farms.map((f) => f.id)).toEqual([OLDEST, MIDDLE, NEWEST]);
        // Non-empty first: "contains no wrong farm" passes on an empty list.
        expect(farms.length).toBeGreaterThan(0);
    });

    it('`farms[0]` is the oldest — the contract /me is reconciled against', async () => {
        const farms = await listMyFarms(ME);
        expect(farms[0].id).toBe(OLDEST);
    });

    it('a REMOVED farm is excluded even though the membership is still ACTIVE', async () => {
        // The clause the original request did not mention. The membership is
        // live and the tenant is soft-deleted, which is exactly the state
        // `deleteTenantUnderOrg` leaves behind.
        const farms = await listMyFarms(ME);
        expect(farms.map((f) => f.id)).not.toContain(REMOVED);

        // ...and the fixture really is in that state, or this proves nothing.
        const m = await verifier.tenantMembership.findFirst({
            where: { userId: ME, tenantId: REMOVED },
            select: { status: true },
        });
        expect(m?.status).toBe('ACTIVE');
        const t = await verifier.tenant.findUnique({
            where: { id: REMOVED },
            select: { deletedAt: true },
        });
        expect(t?.deletedAt).not.toBeNull();
    });

    it('a DEACTIVATED membership is excluded', async () => {
        const farms = await listMyFarms(ME);
        expect(farms.map((f) => f.id)).not.toContain(DEACTIVATED);
    });

    it('another person’s farm never appears', async () => {
        const mine = await listMyFarms(ME);
        expect(mine.map((f) => f.id)).not.toContain(NOT_MINE);

        // ...and that farm IS reachable for its own member, so the absence
        // above is scoping rather than a fixture that never landed.
        const theirs = await listMyFarms(SOMEONE_ELSE);
        expect(theirs.map((f) => f.id)).toEqual([NOT_MINE]);
    });

    it('carries the role IN THAT FARM, not a global one', async () => {
        const farms = await listMyFarms(ME);
        const byId = Object.fromEntries(farms.map((f) => [f.id, f.role]));
        expect(byId[OLDEST]).toBe('OWNER');
        expect(byId[NEWEST]).toBe('ADMIN');
    });

    it('a person with no farms gets an empty array, not an error', async () => {
        const nobody = `u-none-${randomUUID()}`;
        await makeUser(nobody);
        await expect(listMyFarms(nobody)).resolves.toEqual([]);
    });
});
