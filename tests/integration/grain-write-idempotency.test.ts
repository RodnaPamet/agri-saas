/**
 * The two grain writes the calculator makes are exactly-once.
 *
 * A `CostEntry` and a `YieldRecord` are financial records. The offline outbox
 * replays a queued write whenever a response is lost — which on rural LTE is
 * the ordinary case, not the exotic one — and before this neither create
 * deduped on anything. `Idempotency-Key` was not merely undocumented on these
 * routes, it was IGNORED: idempotency in this codebase is per-usecase (journal,
 * farm-task, field-operation, inventory) and there is no middleware.
 *
 * So a retry booked the same cost twice. Silently, because both writes
 * succeed — the only thing that moves is net worth, the figure the whole
 * calculator exists to produce.
 *
 * These are EXECUTING tests against a real database, because the guarantee is
 * a unique index doing its job plus a pre-check racing it. A structural test
 * asserting "the usecase takes an idempotencyKey" would pass with the column
 * missing.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createCostEntry } from '@/app-layer/usecases/cost-entry';
import { createYieldRecord } from '@/app-layer/usecases/yield-record';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `gwi-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let ownerId = '';

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: TENANT_ID, slug: TAG },
    });
    const email = `${TAG}-owner@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    ownerId = u.id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: ownerId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "CostEntry" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "YieldRecord" WHERE "tenantId" = $1`, TENANT_ID);
        });
    } catch {
        /* globalSetup handles reset */
    }
    await prisma.$disconnect();
});

const ctx = () => makeRequestContext('OWNER', { userId: ownerId, tenantId: TENANT_ID, tenantSlug: TAG });

const costInput = () => ({
    category: 'FUEL' as const,
    amount: 1234.5,
    currency: 'BGN',
    incurredOn: '2026-09-22',
});

const yieldInput = () => ({
    harvestedAt: '2026-09-22',
    grossTonnes: 12.5,
    moisturePct: 14,
    areaHa: 3,
});

describeFn('grain writes are exactly-once (DB)', () => {
    describe('cost entries', () => {
        it('the same Idempotency-Key books ONE cost, and returns the original', async () => {
            const key = `k-${randomUUID()}`;
            const first = await createCostEntry(ctx(), costInput(), key);
            const replay = await createCostEntry(ctx(), costInput(), key);

            expect(replay.id).toBe(first.id);
            const rows = await prisma.costEntry.count({
                where: { tenantId: TENANT_ID, clientMutationId: key },
            });
            expect(rows).toBe(1);
        });

        it('the replay answer is the SAME SHAPE as the first, not a bare row', async () => {
            // The defect this guards is the one measured on `setTaskStatus`:
            // a dedupe that returns the stored row hands the retry a different
            // payload than the first attempt — and the retry is the path that
            // only runs when the connection is bad.
            const key = `k-${randomUUID()}`;
            const first = await createCostEntry(ctx(), costInput(), key);
            const replay = await createCostEntry(ctx(), costInput(), key);

            expect(Object.keys(replay).sort()).toEqual(Object.keys(first).sort());
            // `amount` is a NUMBER because toDto runs it through dec(). A bare
            // Prisma row would hand back a Decimal here, which serialises as a
            // string — a plausible wrong figure rather than a decode error.
            expect(typeof replay.amount).toBe('number');
            expect(replay.amount).toBe(1234.5);
        });

        it('CONCURRENT replays of one key still book only one', async () => {
            // The pre-check alone cannot do this: both callers miss it and both
            // insert. The unique index is what makes the loser lose, and the
            // P2002 backstop is what turns its 500 into the winner's row.
            const key = `k-${randomUUID()}`;
            const [a, b] = await Promise.all([
                createCostEntry(ctx(), costInput(), key),
                createCostEntry(ctx(), costInput(), key),
            ]);
            expect(a.id).toBe(b.id);
            const rows = await prisma.costEntry.count({
                where: { tenantId: TENANT_ID, clientMutationId: key },
            });
            expect(rows).toBe(1);
        });

        it('CONTROL: no key still books every call', async () => {
            // Without this the suite would pass if creation were broken
            // outright, and it pins that the dedupe is opt-in — an ordinary
            // online write is unconstrained because every NULL is distinct.
            const before = await prisma.costEntry.count({ where: { tenantId: TENANT_ID } });
            await createCostEntry(ctx(), costInput());
            await createCostEntry(ctx(), costInput());
            const after = await prisma.costEntry.count({ where: { tenantId: TENANT_ID } });
            expect(after - before).toBe(2);
        });
    });

    describe('yield records', () => {
        it('the same Idempotency-Key books ONE yield, and returns the original', async () => {
            const key = `k-${randomUUID()}`;
            const first = await createYieldRecord(ctx(), yieldInput(), key);
            const replay = await createYieldRecord(ctx(), yieldInput(), key);

            expect(replay!.id).toBe(first.id);
            const rows = await prisma.yieldRecord.count({
                where: { tenantId: TENANT_ID, clientMutationId: key },
            });
            expect(rows).toBe(1);
        });

        it('the replay carries the DERIVED fields, not just the columns', async () => {
            // `tPerHa` is computed by toDto and is not a column, so a dedupe
            // returning the stored row loses it entirely. The typechecker
            // caught this during development; this keeps it caught.
            const key = `k-${randomUUID()}`;
            const first = await createYieldRecord(ctx(), yieldInput(), key);
            const replay = await createYieldRecord(ctx(), yieldInput(), key);

            expect(Object.keys(replay!).sort()).toEqual(Object.keys(first).sort());
            expect(typeof replay!.tPerHa).toBe('number');
            expect(replay!.tPerHa).toBe(first.tPerHa);
        });

        it('CONTROL: no key still books every call', async () => {
            const before = await prisma.yieldRecord.count({ where: { tenantId: TENANT_ID } });
            await createYieldRecord(ctx(), yieldInput());
            await createYieldRecord(ctx(), yieldInput());
            const after = await prisma.yieldRecord.count({ where: { tenantId: TENANT_ID } });
            expect(after - before).toBe(2);
        });
    });
});
