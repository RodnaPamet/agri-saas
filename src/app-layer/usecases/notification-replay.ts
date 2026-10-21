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
 * 399 such groups, the largest 22, almost all stamped `09:00:00.xxx`.
 *
 * The producer is the LOW_STOCK sweep, not the due-date run this comment first
 * named: by type, `LOW_STOCK` is 8,778 of the 8,815 rows, `TASK_ASSIGNED` 16,
 * `GENERAL` 13 and `EXCHANGE_MESSAGE` 8. Worth having right, because it says
 * what shape the ties take — one sweep writing every affected row for one
 * person in a single statement, rather than unrelated notifications happening
 * to collide on a millisecond.
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

/** One replayed id and the farm it belongs to. */
export interface ReplayedId {
    id: string;
    tenantId: string;
}

/**
 * Ids from the cursor's millisecond onward excluding the cursor itself, oldest
 * first, across EVERY farm the person belongs to — #2085.
 *
 * Oldest first so a client applying them in order ends at the newest, and so
 * the LAST id it sees is the one worth sending back as the next cursor.
 *
 * ## Why this fans out instead of taking one tenant
 *
 * `Notification`'s RLS policy is the single arm
 * `"tenantId" = current_setting('app.tenant_id', true)`, so one tenant context
 * can only ever see one farm's rows — and a person-scoped context, which sets
 * `app.user_id` and deliberately no tenant, reads ZERO rows SILENTLY. Neither
 * shape can answer "what did I miss" for somebody in three farms.
 *
 * So the query runs once per farm, in that farm's own context. The alternative
 * considered and rejected was adding a person arm to that policy: it would
 * collapse this to one query and it widens a core table's policy so that any
 * person-scoped context reads notifications across every farm — a bigger
 * change to the security surface than this read deserves.
 *
 * ## The cursor is resolved FIRST, in whichever farm owns it
 *
 * `Last-Event-ID` is one notification id, so it lives in exactly one farm.
 * Resolving it per-farm until found, then querying every farm by TIME, is what
 * makes the window the same for all of them — a per-farm cursor comparison
 * would give each farm a different window and the merge would be meaningless.
 *
 * A cursor naming a row this person cannot see resolves nowhere and replays
 * nothing, which is the same answer as a cursor from a notification that has
 * since been deleted. Both are "I cannot tell you what you missed", and
 * silence is right: a client that receives nothing refetches, as it does on a
 * cold open.
 */
export async function replayNotificationIdsAfter(
    ctx: RequestContext,
    lastEventId: string,
    tenantIds: readonly string[],
): Promise<ReplayedId[]> {
    // Shape-checked before any query: `Last-Event-ID` is a client-controlled
    // header, and a cuid is the only thing this ever issued.
    if (!/^[a-z0-9]{20,32}$/i.test(lastEventId)) return [];
    // No early return for an empty `tenantIds`, deliberately: the cursor loop
    // below iterates nothing, `cursorAt` stays null, and the function returns
    // `[]` on that path. A guard here would read as a check and be dead code —
    // mutating it away changed no test, which is how it was found.

    // ── 1. find the cursor's instant, in whichever farm holds it ──
    //
    // One query per farm, and the guard's usual fix — hoist it out and use one
    // `findMany` with an `in:` filter — is NOT available here. `Notification`'s
    // RLS policy is the single arm
    // `"tenantId" = current_setting('app.tenant_id', true)`, and that setting
    // is per-TRANSACTION: a single query carrying `tenantId IN (…)` would still
    // be scoped by RLS to whichever one tenant the surrounding context set, and
    // would return that farm's rows only. So the separate transactions are what
    // the policy requires, not an accident of how this is written.
    //
    // Bounded by the number of farms a person belongs to, and it BREAKS on the
    // first hit with the active farm placed first by the caller — so the common
    // case is one query. The pathological case is somebody in many farms whose
    // cursor lives in the last one; measured in production on 2026-10-21 the
    // largest membership count is 2, so that is a shape to watch rather than
    // one to pre-optimise. A cap would be the wrong answer: it would silently
    // stop replaying for whichever farms fell outside it.
    let cursorAt: Date | null = null;
    for (const tenantId of tenantIds) { // guardrail-allow: n+1 — RLS requires a transaction per farm; see above
        const found = await runInTenantContext({ ...ctx, tenantId }, (db) =>
            db.notification.findFirst({
                where: { id: lastEventId, userId: ctx.userId ?? undefined },
                select: { createdAt: true },
            }),
        );
        if (found) {
            cursorAt = found.createdAt;
            break;
        }
    }
    if (cursorAt === null) return [];

    // ── 2. everything from that instant on, per farm ──
    //
    // Same reason as above: the per-farm transaction is what RLS requires, so
    // there is no single query to hoist to. Concurrent rather than sequential
    // here because every farm must be read — there is no early exit to gain
    // from — so the wall-clock cost is one query, not N.
    const perTenant = await Promise.all(
        tenantIds.map((tenantId) => // guardrail-allow: n+1 — RLS requires a transaction per farm; see above
            runInTenantContext({ ...ctx, tenantId }, async (db) => {
                const rows = await db.notification.findMany({
                    where: {
                        userId: ctx.userId ?? undefined,
                        createdAt: { gte: cursorAt! },
                        id: { not: lastEventId },
                    },
                    select: { id: true, createdAt: true },
                    orderBy: { createdAt: 'asc' },
                    // Per farm, so the global cap below cannot let one noisy
                    // farm crowd the others out of the window entirely.
                    take: REPLAY_LIMIT,
                });
                return rows.map((r) => ({ id: r.id, createdAt: r.createdAt, tenantId }));
            }),
        ),
    );

    // Merged by time, then bounded once. Sorting before the cap is what makes
    // the cap take the OLDEST across all farms rather than all of one farm's.
    return perTenant
        .flat()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, REPLAY_LIMIT)
        .map(({ id, tenantId }) => ({ id, tenantId }));
}
