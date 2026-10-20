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
 * Ids created after the cursor, oldest first, for this tenant and user.
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
                createdAt: { gt: cursor.createdAt },
            },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take: REPLAY_LIMIT,
        });
        return rows.map((r) => r.id);
    });
}
