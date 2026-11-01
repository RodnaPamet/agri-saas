/**
 * «Какво помни асистентът» — the person's own view of their memory (#2671).
 *
 * Four verbs: list, forget one, forget all, edit one. The assistant's own
 * reads and the extraction are separate; this file is the CONTROL surface the
 * owner asked for ("see and delete"), and it is person-scoped rather than
 * tenant-scoped because the memory is one per person across their farms.
 *
 * ## Reads go through `runInUserContext`; writes do not
 *
 * The read uses the user runner so the `memory_fact_owner_read_user` policy
 * arm is actually exercised — defence in depth, and the same arrangement
 * P5.2a uses for a reporter reading their own notice back.
 *
 * Every WRITE goes through the privileged client with `userId` supplied by the
 * caller's session, because `AssistantMemoryFact` deliberately has no
 * `app_user` INSERT/UPDATE/DELETE arm. A caller who could write directly could
 * forge a fact about somebody else or resurrect one they deleted. The `where`
 * clause carrying `userId` is therefore not belt-and-braces — it IS the
 * authorisation, exactly as in `promotion-disclosure`'s inverted arrangement.
 *
 * ## «Изтрий» is a TOMBSTONE, not a delete — rule 5
 *
 * `forget` sets `deletedAt` and keeps the row. That is what lets the extractor
 * refuse to re-learn the same point from the same evidence; a hard delete
 * would let the next conversation that mentioned it undo the person's
 * decision, and «Изтрий» would not stick.
 *
 * It also means the Art 15 export and the erasure sweep still see the row,
 * which is correct: the registry classifies the MODEL, and a tombstoned fact
 * is still data held about the person until the account goes.
 */
import { prisma } from '@/lib/prisma';
import { runInUserContext } from '@/lib/db-context';
import { codedNotFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { PrismaClient } from '@prisma/client';

/**
 * One remembered point as a CLIENT sees it.
 *
 * No `sourceQuote` and no `sourceConversationId`. The evidence is kept
 * server-side (rule 7) because rules 4 and 5 need it, and showing a person the
 * sentence a point was derived from invites "where did you get that" without
 * helping them decide whether to delete it. `rememberedAt` is ISO-8601 and
 * unformatted: the client formats dates, the server does not pre-format one.
 */
export interface RememberedPoint {
    id: string;
    text: string;
    rememberedAt: string;
}

/**
 * The most a person may see at once.
 *
 * The profile is BOUNDED by design — rule 8 clamps what reaches the prompt to
 * roughly 3 KB — so a list longer than this means the extractor is
 * accumulating rather than superseding, which is a defect rather than a page
 * to scroll. Returning a bounded list keeps that visible instead of hiding it
 * behind pagination.
 */
export const REMEMBERED_POINT_LIMIT = 50;

/** The longest an edited point may be, matching what the extractor emits. */
export const REMEMBERED_POINT_MAX_CHARS = 280;

function toPoint(row: { id: string; text: string; sourceAt: Date }): RememberedPoint {
    return { id: row.id, text: row.text, rememberedAt: row.sourceAt.toISOString() };
}

/** This person's live profile, newest first. */
export async function listRememberedPoints(userId: string): Promise<RememberedPoint[]> {
    const rows = await runInUserContext({ userId } as never, (db) =>
        (db as PrismaClient).assistantMemoryFact.findMany({
            where: { userId, deletedAt: null },
            select: { id: true, text: true, sourceAt: true },
            orderBy: { sourceAt: 'desc' },
            take: REMEMBERED_POINT_LIMIT,
        }),
    );
    return rows.map(toPoint);
}

/**
 * «Изтрий» one point. Idempotent, and a point that is not this person's is
 * reported as NOT FOUND rather than as forbidden — a 403 would confirm the id
 * exists, which is the posture P5.2b uses for the same reason.
 */
export async function forgetRememberedPoint(userId: string, id: string): Promise<void> {
    const { count } = await prisma.assistantMemoryFact.updateMany({
        // `userId` in the WHERE is the authorisation, not a filter.
        where: { id, userId, deletedAt: null },
        data: { deletedAt: new Date() },
    });
    if (count === 0) throw codedNotFound('MEMORY_POINT_NOT_FOUND', 'That remembered point was not found.');
}

/** «Изтрий всичко». Returns how many were forgotten, so the UI can say. */
export async function forgetAllRememberedPoints(userId: string): Promise<number> {
    const { count } = await prisma.assistantMemoryFact.updateMany({
        where: { userId, deletedAt: null },
        data: { deletedAt: new Date() },
    });
    return count;
}

/**
 * Edit a point — rule 6. `editedByPerson` is what stops the extractor
 * rewriting it afterwards, so setting it is the whole point of this verb
 * rather than a side effect of changing the text.
 *
 * The text is SANITISED on the way in like any other stored prose, and it
 * re-enters the prompt on every later answer — so this is typed text going
 * into the model's context and falls under the same fencing the live question
 * gets. A person editing their own point cannot escalate anything (rule 2: a
 * remembered point is data and authorises nothing), but it can still carry an
 * instruction-shaped sentence, and the prompt builder must treat it as data.
 */
export async function editRememberedPoint(
    userId: string,
    id: string,
    text: string,
): Promise<RememberedPoint> {
    const clean = sanitizePlainText(text);
    // `sanitizePlainText` TRIMS since #1825, so a whitespace-only edit is
    // empty here rather than truthy — which is why this check is after it.
    if (!clean) {
        throw codedNotFound('MEMORY_POINT_EMPTY', 'A remembered point cannot be empty.');
    }
    const { count } = await prisma.assistantMemoryFact.updateMany({
        where: { id, userId, deletedAt: null },
        data: {
            text: clean.slice(0, REMEMBERED_POINT_MAX_CHARS),
            editedByPerson: true,
            /*
             * The EVIDENCE becomes their correction — rules 3, 4 and 6 meeting.
             *
             * Not a detail: an edited point whose `sourceQuote` still held the
             * superseded sentence would be MISLEADING evidence, and rules 4
             * and 5 are built on reading it. "The latest statement wins" means
             * the latest statement IS the evidence, and rule 3 says a point
             * may only be learned from the person's own words — a correction
             * they typed is the purest case of that.
             *
             * It also means the extractor cannot later re-derive the OLD point
             * from the old quote, which is rule 5's property arriving for
             * free: the evidence it would have matched is gone.
             *
             * Sanitised by the same `clean` value as `text`, so both encrypted
             * free-text columns on this row go through `sanitizePlainText` at
             * the one path a person writes them.
             */
            sourceQuote: clean.slice(0, REMEMBERED_POINT_MAX_CHARS),
            sourceAt: new Date(),
        },
    });
    if (count === 0) throw codedNotFound('MEMORY_POINT_NOT_FOUND', 'That remembered point was not found.');

    const row = await prisma.assistantMemoryFact.findFirstOrThrow({
        where: { id, userId },
        select: { id: true, text: true, sourceAt: true },
    });
    return toPoint(row);
}
