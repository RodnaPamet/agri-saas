/**
 * A concurrent `openExchangeThread` returns the thread, not a 409 (#1415).
 *
 * ## The defect
 *
 * The function documented itself as idempotent on (listing, inquirer) and
 * relied on a catch that did not exist. Read-then-create with no conflict
 * handling: two overlapping opens both miss the read, both insert, and the
 * loser violates `@@unique([listingId, inquirerUserId])`. Reported from the
 * client side by agrent-ios — a double-tap on rural LTE is the normal way a
 * user retries, and this is the FIRST action in the messaging flow.
 *
 * ## Why `createMany({ skipDuplicates })` and not catch-and-reread
 *
 * The obvious fix is wrong here, and wrong in a worse direction than the bug.
 * `openExchangeThread` runs inside `runInTenantContext`, which IS a
 * `$transaction`, and **a P2002 inside an interactive PostgreSQL transaction
 * aborts the whole transaction** — a caught JS error does not un-poison an
 * aborted PG transaction. So the reread after the catch would itself fail and
 * the caller would get a 500 instead of a 409. `notifications/task-due.ts` and
 * `notifications/agro.ts` both carry that lesson.
 *
 * ## Why TWO tests
 *
 * The concurrency test is realistic but cannot GUARANTEE the conflict path
 * executes: `Promise.all` may still SERIALISE the two calls, in which case the second
 * takes the read-first fast path and never reaches the insert. Its assertions
 * hold either way — which is exactly what makes it insufficient on its own, a
 * test that passes whether or not the branch it targets ran.
 *
 * So the second test drives the conflict DETERMINISTICALLY at the mechanism
 * level, and asserts the thing the concurrency test cannot see: that the
 * transaction is still usable afterwards. Against `create` that query fails;
 * against `createMany({ skipDuplicates })` it does not.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { openExchangeThread } from '@/app-layer/usecases/exchange-messaging';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SELLER_T = `t-exr-seller-${randomUUID()}`;
const BUYER_T = `t-exr-buyer-${randomUUID()}`;
const U_CREATOR = `u-exr-creator-${randomUUID()}`;
const U_OPENER = `u-exr-opener-${randomUUID()}`;

async function makeUser(id: string, tenantId: string, role: 'OWNER' | 'ADMIN' | 'EDITOR') {
    await globalPrisma.user.create({
        data: { id, email: `${id}@example.test`, emailHash: `hash-${id}`, name: id },
    });
    await globalPrisma.tenantMembership.create({
        data: { id: `tm-${id}`, tenantId, userId: id, role, status: 'ACTIVE' },
    });
}

let listingId = '';

describeFn('openExchangeThread survives a concurrent open (#1415)', () => {
    beforeAll(async () => {
        for (const t of [SELLER_T, BUYER_T]) {
            await globalPrisma.tenant.create({ data: { id: t, name: t, slug: t } });
        }
        await makeUser(U_CREATOR, SELLER_T, 'EDITOR');
        await makeUser(U_OPENER, BUYER_T, 'EDITOR');

        listingId = `l-exr-${randomUUID()}`;
        await globalPrisma.exchangeListing.create({
            data: {
                id: listingId,
                sellerTenantId: SELLER_T,
                sellerUserId: U_CREATOR,
                side: 'SELL',
                commodity: 'Wheat',
                quantityTonnes: 25,
                regionCode: 'BG-16',
                regionName: 'Plovdiv',
                lat: 42.15,
                lon: 24.75,
            },
        });
    }, 120_000);

    afterAll(async () => {
        await globalPrisma.$disconnect();
    });

    it('two overlapping opens yield ONE thread and ONE audit row', async () => {
        const ctx = makeRequestContext('EDITOR', {
            userId: U_OPENER,
            tenantId: BUYER_T,
            requestId: `req-${U_OPENER}`,
        });

        // Both started before either is awaited. Against the pre-#1415 code the
        // loser REJECTS with P2002, so `Promise.all` rejecting is the
        // regression signal — that is this test's mutation proof.
        const [a, b] = await Promise.all([
            openExchangeThread(ctx, listingId),
            openExchangeThread(ctx, listingId),
        ]);

        expect(a.id).toBe(b.id);
        // Exactly one call may claim the creation, whichever way the two
        // interleaved. This holds for a genuine race AND for a serialised pair.
        expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

        const rows = await globalPrisma.exchangeThread.findMany({
            where: { listingId, inquirerUserId: U_OPENER },
            select: { id: true },
        });
        expect(rows).toHaveLength(1);

        // The audit trail is hash-chained, so a CREATE row for a creation that
        // did not happen is worse than a missing one. Exactly one.
        const audits = await globalPrisma.auditLog.count({
            // NOTE the column is `entity`, not `entityType` — `logEvent`'s PARAMETER
            // is `entityType` and it maps to the `entity` column, which is an easy
            // way to write a query that validates against nothing.
            where: { entity: 'ExchangeThread', entityId: a.id, action: 'CREATE' },
        });
        expect(audits).toBe(1);
    });

    it('the conflicting insert leaves the transaction USABLE — the half the race test cannot see', async () => {
        // Deterministic: the row already exists, so the insert below definitely
        // conflicts. `Promise.all` above cannot guarantee that.
        const existing = await globalPrisma.exchangeThread.findFirst({
            where: { listingId, inquirerUserId: U_OPENER },
            select: { id: true },
        });
        expect(existing).not.toBeNull();

        await globalPrisma.$transaction(async (tx) => {
            const result = await tx.exchangeThread.createMany({
                data: [{
                    listingId,
                    inquirerTenantId: BUYER_T,
                    inquirerUserId: U_OPENER,
                }],
                skipDuplicates: true,
            });
            // ON CONFLICT DO NOTHING: absorbed, nothing thrown.
            expect(result.count).toBe(0);

            // THE assertion. With `create` the P2002 would have aborted this
            // transaction and this query would fail — "current transaction is
            // aborted, commands ignored until end of transaction block".
            const stillWorks = await tx.exchangeThread.findFirst({
                where: { listingId, inquirerUserId: U_OPENER },
                select: { id: true },
            });
            expect(stillWorks?.id).toBe(existing!.id);
        });
    });
});
