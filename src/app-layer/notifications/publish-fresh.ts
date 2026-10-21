/**
 * Publish freshly-inserted notifications to the SSE bus, by ROW ID — #2142.
 *
 * ## What was wrong with the id
 *
 * Four modules published `{ id: row.dedupeKey }`. The reason was mechanical:
 * `createMany` returns a count and never ids, and `createMany` is required
 * rather than `create` because a duplicate `dedupeKey` raises P2002, which
 * poisons an interactive Postgres transaction for every statement after it.
 *
 * It did not matter until P7.2 made the frame's id a CURSOR. `serialiseFrame`
 * puts a notification frame's id on the SSE `id:` line, `EventSource`
 * populates `Last-Event-ID` from it, and `replayNotificationIdsAfter` resolves
 * that value by looking it up as a `Notification.id`. A dedupeKey matches no
 * row, so it lands on the documented silent arm — "a cursor naming a row this
 * person cannot see resolves to nothing and replays nothing".
 *
 * That reasoning is right for its intended case, a deleted notification. It is
 * the wrong answer here, because nothing is missing: the row exists and the
 * client simply holds an identifier that cannot name it. So a client whose
 * newest frame came from any of these paths carried a cursor that could never
 * resolve, and a reconnect in that state replayed nothing no matter what had
 * arrived. It recovered on the next frame carrying a real id, which made the
 * window bounded and silent.
 *
 * ## Why not `createManyAndReturn`, which would need no read at all
 *
 * It exists on this client (Prisma 7.10) and returns the inserted rows with
 * their ids, which would make this helper unnecessary. It does **not** accept
 * `skipDuplicates` — checked against the generated types rather than assumed —
 * and that option is load-bearing: a duplicate `dedupeKey` would raise P2002,
 * which poisons an interactive Postgres transaction for every statement after
 * it. Dedupe collapse is the normal case on these paths, not an edge, so the
 * one-statement version is unavailable and the read-back is the price.
 *
 * ## The read is inside the transaction; only the publish is deferred
 *
 * `dedupeKey` is unique and indexed, so this is one indexed read per batch —
 * and it has to happen HERE rather than inside the `afterCommit` callback,
 * because the `db` handle a caller passes is transaction-scoped and is not
 * usable once that transaction has committed. The ids are captured in the
 * closure; the publish is what waits.
 *
 * ## Why one helper rather than four fixes
 *
 * The four sites had the same five lines and the same mistake, and one of them
 * carried a comment describing behaviour the code did not have: task-due.ts
 * said the id "would normally come from Prisma's return, but `createMany`
 * doesn't return ids; we omit it from the event", while the code passed a
 * dedupeKey. A fourth copy is a fourth chance for the comment and the code to
 * disagree.
 */
import type { PrismaClient } from '@prisma/client';

import { publishNotificationEvent } from '@/lib/notifications/notification-bus';
import { afterCommit } from '@/lib/db/after-commit';
import { logger } from '@/lib/observability/logger';

/** The minimum a caller must know about a row it just wrote. */
export interface FreshNotificationRow {
    tenantId: string;
    userId: string;
    dedupeKey: string;
}

/**
 * Resolve the ids of rows just inserted and publish one frame per row.
 *
 * Call only when the insert actually created rows — a `createMany` whose count
 * was 0 means the dedupeKey collapsed a duplicate, and the original was
 * already published.
 *
 * @returns how many rows were resolved and will be published. A shortfall is
 *          logged rather than thrown: the notification row is written either
 *          way, and failing the caller over a missing bus frame would trade a
 *          durable record for a live one.
 */
export async function publishFreshNotifications(
    db: Pick<PrismaClient, 'notification'>,
    effect: string,
    rows: ReadonlyArray<FreshNotificationRow>,
): Promise<number> {
    if (rows.length === 0) return 0;

    const found = await db.notification.findMany({
        where: { dedupeKey: { in: rows.map((r) => r.dedupeKey) } },
        select: { id: true, dedupeKey: true },
        // Bounded by the input, so a shared dedupeKey cannot make this read
        // the whole table.
        take: rows.length,
    });
    const idByKey = new Map(found.map((f) => [f.dedupeKey, f.id]));

    const resolved: Array<{ tenantId: string; userId: string; id: string }> = [];
    for (const row of rows) {
        const id = idByKey.get(row.dedupeKey);
        // Written and immediately unreadable — possible only if something
        // deleted it between the two statements. Skipped rather than published
        // with an invented id, which would put the broken cursor back.
        if (id) resolved.push({ tenantId: row.tenantId, userId: row.userId, id });
    }

    if (resolved.length < rows.length) {
        logger.warn('notify.frame_id_unresolved', {
            component: 'notifications',
            effect,
            wrote: rows.length,
            resolved: resolved.length,
        });
    }

    if (resolved.length > 0) {
        afterCommit(effect, () => {
            for (const r of resolved) {
                publishNotificationEvent(r.tenantId, r.userId, { id: r.id });
            }
        });
    }

    return resolved.length;
}
