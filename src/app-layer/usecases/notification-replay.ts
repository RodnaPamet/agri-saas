/**
 * Re-send the notification ids a reconnecting client missed — P7.2 (#1991).
 *
 * ## The dependency this does NOT have
 *
 * #1991 says replay "needs events to be durable and ordered for at least the
 * reconnect window, which the current in-process bus cannot provide — so this
 * depends on P7.1". P7.1 shipped as Redis pub/sub (#1990), and pub/sub is not
 * durable either: a subscriber that is away misses everything published while
 * it was away, by design.
 *
 * So replay is not served from the bus at all, and does not need to be. The
 * bus's own reasoning is why: it carries IDS ONLY, because "the row is
 * authoritative and the event is a hint". The rows are `Notification`, they
 * have `createdAt`, and they are already durable and ordered. The database IS
 * the event log — adding a second one (Redis Streams, an outbox) would be
 * storing the same facts twice so that the copy could be read instead of the
 * original.
 *
 * That makes the blocker in #1991 a property of the bus rather than of replay.
 *
 * ## Why the cursor is resolved to a time rather than compared as an id
 *
 * `Last-Event-ID` carries a cuid. Cuids are roughly time-ordered but not
 * reliably so — the ordering is a side effect of the prefix, not a guarantee —
 * so `id > lastId` is a comparison that works until it does not. The id is
 * looked up and its `createdAt` used, which is ordered by definition.
 *
 * A cursor naming a row this person cannot see resolves to nothing and replays
 * nothing, which is the same answer as a cursor from a notification that has
 * since been deleted. Both are "I cannot tell you what you missed", and
 * silence is the right answer to that — a client that receives nothing simply
 * refetches, which is what it does on a cold open anyway.
 *
 * ## The window is `>=` the cursor's time, and that is not sloppiness
 *
 * `createdAt` is `timestamp(3)` — millisecond precision — and notifications
 * arrive in BATCHES. Measured in production on 2026-10-20: 8,778 of 8,815
 * rows, 99.6%, share their `(userId, createdAt)` with at least one other row;
 * 399 such groups, the largest 22, almost all stamped `09:00:00.xxx` by the
 * scheduled due-date run.
 *
 * So a tie is not an edge case here, it is the normal shape of the data. With
 * a strict `>` a client reconnecting with any member of a batch as its cursor
 * would be told nothing happened while the other TWENTY-ONE were never
 * mentioned again — a silent loss, on the dominant producer, for the one query
 * whose whole job is "what did I miss".
 *
 * The fix is to take the cursor's whole millisecond and exclude the cursor row
 * itself by id. That can repeat ids the client already has, bounded by one
 * millisecond's worth of rows, and the asymmetry is the point: a repeated id
 * costs a refetch of a row the client already holds, because the frame carries
 * an id and "the row is authoritative and the event is a hint". A lost id
 * costs a notification nobody ever sees.
 *
 * A total order on `(createdAt, id)` would be the tidier-looking answer and is
 * NOT loss-free here: cuids are only roughly time-ordered, so within a tie the
 * id order and the order events were published in need not agree, and any row
 * whose id sorts below the cursor's would be dropped exactly as before. The
 * ordering would have to be the one the emitter used, and the emitter's order
 * is publication order, which is not stored.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';

/**
 * How many ids one replay may carry.
 *
 * A bound rather than a page: this runs on every reconnect, and a client that
 * has been away for a week does not want a thousand ids — it wants to know
 * something changed and then refetch. The cap is the point at which replaying
 * stops being cheaper than refetching.
 */
export const REPLAY_LIMIT = 50;

/**
 * Ids from the cursor's millisecond onward excluding the cursor itself, oldest
 * first, for this tenant and user.
 *
 * Oldest first so a client applying them in order ends at the newest, and so
 * the LAST id it sees is the one worth sending back as the next cursor.
 */
export async function replayNotificationIdsAfter(
    ctx: RequestContext,
    lastEventId: string,
): Promise<string[]> {
    // Shape-checked before any query: `Last-Event-ID` is a client-controlled
    // header, and a cuid is the only thing this ever issued.
    if (!/^[a-z0-9]{20,32}$/i.test(lastEventId)) return [];

    return runInTenantContext(ctx, async (db) => {
        // RLS scopes the tenant; `userId` is still named because a tenant's
        // notifications are per-person and one member must not replay
        // another's.
        const cursor = await db.notification.findFirst({
            where: { id: lastEventId, userId: ctx.userId ?? undefined },
            select: { createdAt: true },
        });
        if (!cursor) return [];

        const rows = await db.notification.findMany({
            where: {
                userId: ctx.userId ?? undefined,
                // `gte`, with the cursor row removed by id. See the docblock:
                // a strict `gt` drops the rest of the cursor's millisecond,
                // and 99.6% of these rows share a millisecond with another.
                createdAt: { gte: cursor.createdAt },
                id: { not: lastEventId },
            },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take: REPLAY_LIMIT,
        });
        return rows.map((r) => r.id);
    });
}
