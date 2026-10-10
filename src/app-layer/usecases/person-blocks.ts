/**
 * `UserBlock` — one person refusing another (P5.2b, #1593).
 *
 * ## Every operation here runs under `runInUserContext`, and that is the
 * ## opposite of `trust-safety.ts`
 *
 * Worth stating because the two modules sit beside each other and look
 * inconsistent. `ContentReport` has no `app_user` INSERT arm, so a notice must
 * be written on the privileged path. `UserBlock` has all four arms — SELECT
 * (both parties), INSERT, UPDATE and DELETE (blocker only) — so every
 * operation here goes through the person-scoped runner and **the database is
 * the authority on who may do what**, not this file.
 *
 * That is why none of these functions checks "am I the blocker" before
 * writing. The INSERT policy's `WITH CHECK` requires `blockerUserId =
 * current_setting('app.user_id')`, and the DELETE policy's `USING` requires
 * the same, so a forged write is refused with `42501` and a forged delete
 * removes zero rows. A redundant application check would look like the control
 * and would be the thing a future refactor "simplifies" away, leaving the
 * impression that the guard was there.
 *
 * ## A refused DELETE does not raise
 *
 * P5.1's integration suite measured it: with the row visible but the DELETE
 * policy unsatisfied, the statement affects ZERO rows and returns normally.
 * So `unblockPerson` reports the COUNT rather than success, and the route turns
 * 0 into a 404 — otherwise "unblock somebody else's block" would answer 200.
 */
import type { UserContext } from '@/app-layer/types';
import { runInUserContext } from '@/lib/db-context';
import { codedBadRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

export interface PersonBlock {
    blockedUserId: string;
    createdAt: Date;
}

/**
 * Block a person. Idempotent — pressing it twice is one row, not an error.
 *
 * Idempotence is handled by the unique `(blockerUserId, blockedUserId)` and an
 * existence check rather than by `upsert`: an upsert would UPDATE on conflict,
 * and the only updatable column is `createdAt`, so a second press would move
 * the block's age. "When did I block them" is a thing a person asks.
 */
export async function blockPerson(
    ctx: UserContext,
    blockedUserId: string,
): Promise<{ blocked: true; alreadyBlocked: boolean }> {
    if (blockedUserId === ctx.userId) {
        // Refused in the application, not the database, because there is no
        // policy that can express it — `blockerUserId = blockedUserId = me`
        // satisfies the INSERT arm perfectly. A self-block would then hide
        // every thread the person is a party to from themselves, which is a
        // self-inflicted outage that reads as data loss.
        throw codedBadRequest('BLOCK_SELF', 'You cannot block yourself.');
    }

    return runInUserContext(ctx, async (db) => {
        const existing = await db.userBlock.findFirst({
            where: { blockerUserId: ctx.userId, blockedUserId },
            select: { id: true },
        });
        if (existing) return { blocked: true as const, alreadyBlocked: true };

        await db.userBlock.create({
            // `blockerUserId` from the session. The INSERT policy would refuse
            // anything else, so this is belt and braces — but it is the
            // braces: a route that passed a body value here would be refused
            // by Postgres rather than silently honoured.
            data: { blockerUserId: ctx.userId, blockedUserId },
        });

        logger.info('person-blocks.blocked', {
            component: 'person-blocks',
            // The actor, because this is their own action in their own
            // context. The blocked id is NOT logged: it is a third party's
            // identifier in a line about someone else's decision.
            blockerUserId: ctx.userId,
        });

        return { blocked: true as const, alreadyBlocked: false };
    });
}

/**
 * Lift a block.
 *
 * Returns the number of rows removed, which the route maps to 404 on zero.
 * Under RLS a DELETE the policy refuses affects zero rows and does NOT raise,
 * so "did it work" cannot be inferred from the absence of an error.
 */
export async function unblockPerson(
    ctx: UserContext,
    blockedUserId: string,
): Promise<{ removed: number }> {
    return runInUserContext(ctx, async (db) => {
        const result = await db.userBlock.deleteMany({
            where: { blockerUserId: ctx.userId, blockedUserId },
        });
        if (result.count > 0) {
            logger.info('person-blocks.unblocked', {
                component: 'person-blocks',
                blockerUserId: ctx.userId,
            });
        }
        return { removed: result.count };
    });
}

/**
 * The people this person has blocked.
 *
 * Deliberately NOT "and who has blocked me". The SELECT policy admits both
 * sides of a row — it has to, because enforcement runs in the blocked party's
 * context and a row they cannot see cannot refuse them — so the database
 * WOULD return rows naming the caller as `blockedUserId`.
 *
 * Filtering those out here is the product half of the owner's silent-block
 * ruling: the policy must admit the row, and the API must not reveal it. This
 * is the one place in the module where an explicit `where` is load-bearing
 * rather than redundant, and removing it would leak every block against the
 * caller — which is exactly what "never reveal a block to the blocked party"
 * forbids.
 */
export async function listOwnBlocks(ctx: UserContext): Promise<PersonBlock[]> {
    return runInUserContext(ctx, async (db) => {
        const rows = await db.userBlock.findMany({
            // Load-bearing. See the docblock: the policy admits both sides.
            where: { blockerUserId: ctx.userId },
            orderBy: { createdAt: 'desc' },
            take: 500,
            select: { blockedUserId: true, createdAt: true },
        });
        return rows;
    });
}
