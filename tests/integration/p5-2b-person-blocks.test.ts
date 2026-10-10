/**
 * P5.2b — the person-block usecases against the live policies (#1593).
 *
 * `tests/integration/p5-1-trust-safety-rls.test.ts` already proves the four
 * `UserBlock` policy arms with raw SQL. This suite proves the USECASES use
 * them correctly, which is a different claim and the one that broke in P5.2a's
 * sibling: a policy can be perfect while the product reaches it through the
 * wrong runner and sees nothing.
 *
 * ## Why every assertion is a count or a code
 *
 * Under RLS a DELETE whose policy is unsatisfied affects ZERO rows and returns
 * normally — measured in P5.1. So "it did not throw" is never evidence here,
 * and `unblockPerson` returns a count precisely so the route can tell "yours,
 * removed" from "not yours, silently refused".
 *
 * ## And why the positives assert NON-zero
 *
 * `app.user_id` is unset outside `runInUserContext`, and then every arm
 * matches nothing. A suite asserting only "no more than their own" would pass
 * on a module that read zero rows for everybody.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { blockPerson, unblockPerson, listOwnBlocks } from '@/app-layer/usecases/person-blocks';
import type { UserContext } from '@/app-layer/types';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const ALICE = `u-p52b-alice-${randomUUID()}`;
const BOB = `u-p52b-bob-${randomUUID()}`;
const CAROL = `u-p52b-carol-${randomUUID()}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

describeFn('P5.2b — person blocks through the usecases (#1593)', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    afterEach(async () => {
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "UserBlock" WHERE "blockerUserId" = ANY($1::text[])
                                        OR "blockedUserId" = ANY($1::text[])`,
            [ALICE, BOB, CAROL],
        );
    });

    afterAll(async () => { await globalPrisma.$disconnect(); });

    it('a person blocks another, and it lands', async () => {
        const r = await blockPerson(ctxFor(ALICE), BOB);
        expect(r).toEqual({ blocked: true, alreadyBlocked: false });
        // Read back on the privileged path, because the point is the ROW, not
        // what the usecase said about it.
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "UserBlock"
             WHERE "blockerUserId" = $1 AND "blockedUserId" = $2`, ALICE, BOB,
        );
        expect(Number(rows[0].n)).toBe(1);
    });

    it('is idempotent — twice is one row, and the age does not move', async () => {
        const first = await blockPerson(ctxFor(ALICE), BOB);
        expect(first.alreadyBlocked).toBe(false);
        const before = await globalPrisma.$queryRawUnsafe<Array<{ c: Date }>>(
            `SELECT "createdAt" AS c FROM "UserBlock"
             WHERE "blockerUserId" = $1 AND "blockedUserId" = $2`, ALICE, BOB,
        );

        const second = await blockPerson(ctxFor(ALICE), BOB);
        expect(second.alreadyBlocked).toBe(true);

        const after = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint; c: Date }>>(
            `SELECT COUNT(*)::bigint AS n, MIN("createdAt") AS c FROM "UserBlock"
             WHERE "blockerUserId" = $1 AND "blockedUserId" = $2`, ALICE, BOB,
        );
        expect(Number(after[0].n)).toBe(1);
        // The reason this is not an `upsert`: the only updatable column is
        // `createdAt`, so an upsert would move the block's age on a second
        // press. "When did I block them" is a thing a person asks.
        expect(after[0].c.getTime()).toBe(before[0].c.getTime());
    });

    it('refuses a self-block in the application — no policy can express it', async () => {
        // `blockerUserId = blockedUserId = me` satisfies the INSERT arm
        // perfectly, so the database cannot refuse this. A self-block would
        // hide every thread the person is a party to from themselves.
        await expect(blockPerson(ctxFor(ALICE), ALICE)).rejects.toMatchObject({
            code: 'BLOCK_SELF',
        });
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "UserBlock" WHERE "blockerUserId" = $1`, ALICE,
        );
        expect(Number(rows[0].n)).toBe(0);
    });

    describe('listing', () => {
        it('shows the blocks you MADE', async () => {
            await blockPerson(ctxFor(ALICE), BOB);
            const mine = await listOwnBlocks(ctxFor(ALICE));
            // Non-zero: an unset session variable also yields zero.
            expect(mine.length).toBeGreaterThan(0);
            expect(mine.map((b) => b.blockedUserId)).toContain(BOB);
        });

        it('does NOT show blocks made AGAINST you — the silent-block rule', async () => {
            await blockPerson(ctxFor(ALICE), BOB);
            // Bob is blocked by Alice. The SELECT policy ADMITS him to that
            // row — it has to, because enforcement runs in his context and a
            // row he cannot see cannot refuse him — so this is the product
            // half of the rule, not the database's.
            const bobsView = await listOwnBlocks(ctxFor(BOB));
            expect(bobsView).toEqual([]);

            // And the control: the policy really does admit him, so the
            // assertion above is the FILTER working rather than RLS hiding it.
            // Without this, removing the `where` would still look correct.
            const admitted = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "UserBlock"
                 WHERE "blockerUserId" = $1 AND "blockedUserId" = $2`, ALICE, BOB,
            );
            expect(Number(admitted[0].n)).toBe(1);
        });
    });

    describe('unblocking', () => {
        it('the blocker removes their own block', async () => {
            await blockPerson(ctxFor(ALICE), BOB);
            const r = await unblockPerson(ctxFor(ALICE), BOB);
            expect(r.removed).toBe(1);
        });

        it('a third party removes NOTHING, and it does not raise', async () => {
            await blockPerson(ctxFor(ALICE), BOB);
            // Carol tries to lift Alice's block. The DELETE policy names the
            // blocker, so this affects zero rows and returns normally — which
            // is why the route turns 0 into a 404 rather than trusting the
            // absence of an error.
            const r = await unblockPerson(ctxFor(CAROL), BOB);
            expect(r.removed).toBe(0);
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "UserBlock"
                 WHERE "blockerUserId" = $1 AND "blockedUserId" = $2`, ALICE, BOB,
            );
            expect(Number(rows[0].n)).toBe(1);
        });

        it('the BLOCKED party cannot lift the block on themselves', async () => {
            // The case the split policies exist for: Bob can SEE the row and
            // must not be able to delete it. A single USING clause would have
            // governed DELETE too and let him unblock himself.
            await blockPerson(ctxFor(ALICE), BOB);
            const r = await unblockPerson(ctxFor(BOB), BOB);
            expect(r.removed).toBe(0);
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "UserBlock"
                 WHERE "blockerUserId" = $1 AND "blockedUserId" = $2`, ALICE, BOB,
            );
            expect(Number(rows[0].n)).toBe(1);
        });

        it('lifting a block that never existed removes nothing', async () => {
            const r = await unblockPerson(ctxFor(ALICE), CAROL);
            expect(r.removed).toBe(0);
        });
    });

    it('a block is DIRECTIONAL — A blocking B says nothing about B blocking A', async () => {
        await blockPerson(ctxFor(ALICE), BOB);
        // Bob may block Alice back, and it is a separate row.
        const r = await blockPerson(ctxFor(BOB), ALICE);
        expect(r.alreadyBlocked).toBe(false);
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "UserBlock"
             WHERE ("blockerUserId" = $1 AND "blockedUserId" = $2)
                OR ("blockerUserId" = $2 AND "blockedUserId" = $1)`, ALICE, BOB,
        );
        expect(Number(rows[0].n)).toBe(2);
    });
});
