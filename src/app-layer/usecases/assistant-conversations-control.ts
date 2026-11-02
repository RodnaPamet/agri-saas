/**
 * «Какво помни асистентът» — the EXCHANGES half (#2695).
 *
 * The owner's scope is "all exchanges from all sessions with a user", so this
 * is person-scoped ACROSS farms: `userId` is the load-bearing filter and
 * `tenantId` is the narrower case. #2694's `resolveConversation` filters both
 * because it resolves an id for ONE farm's stream; a person looking at their
 * own history is a different question and a tenant filter would hide the
 * exchanges they had in their other farms.
 *
 * ## Why the writes use the privileged client
 *
 * `AssistantConversation` is TENANT-scoped — `tenant_isolation` keyed on
 * `app.tenant_id`, plus its INSERT twin and `superuser_bypass`. There is no
 * person clause, so a person-scoped read ACROSS farms has no context that
 * could serve it: `runInUserContext` binds no tenant and returns zero rows
 * silently, and `runInTenantContext` would confine the answer to one farm.
 *
 * That is `my-farms.ts`'s situation exactly — "which farms are mine" has no
 * tenant to scope to because that IS the question — and it is why this file
 * belongs on the prisma-import allowlist rather than reaching for a runner
 * that cannot express the query.
 *
 * **What stands in for tenant scoping is that `userId` comes from the verified
 * session and never from a request**, and every statement here carries it. A
 * function in this file taking a userId from a request body is the defect the
 * allowlist entry could hide, and is the thing to check in review.
 *
 * ## Deleting is a TOMBSTONE
 *
 * Rule 5's reason, one level up from a profile point: four readers touch
 * turns — the window replay, the id resolver, the extraction sweep and recall
 * — so a hard delete would let any of them bring a deleted exchange back. A
 * tombstone they all filter is checkable; a hard delete is a claim about every
 * future reader.
 */
import { prisma } from '@/lib/prisma';
import { codedNotFound } from '@/lib/errors/types';

/** The most a person may see at once — the profile list's bound, same reason. */
export const CONVERSATION_LIST_LIMIT = 50;

export interface PastConversation {
    id: string;
    startedAt: string;
    lastTurnAt: string;
    turns: number;
    /** The person's FIRST question, so the row is recognisable. */
    opening: string | null;
}

/**
 * This person's exchanges, newest first, across every farm.
 *
 * `opening` is the person's own first question rather than a generated
 * summary: it is what they typed, so it needs no model call, cannot drift from
 * the exchange it labels, and carries no risk of a summary asserting something
 * the conversation did not say.
 *
 * It is read through the privileged client and therefore DECRYPTED under the
 * tenant DEK by the extension — which works because the row names its own
 * tenant. A raw query would hand back ciphertext.
 */
export async function listPastConversations(userId: string): Promise<PastConversation[]> {
    const rows = await prisma.assistantConversation.findMany({
        where: { userId, deletedAt: null },
        orderBy: { lastTurnAt: 'desc' },
        take: CONVERSATION_LIST_LIMIT,
        select: {
            id: true,
            startedAt: true,
            lastTurnAt: true,
            _count: { select: { turns: true } },
            turns: {
                where: { role: 'user' },
                orderBy: { createdAt: 'asc' },
                take: 1,
                select: { content: true },
            },
        },
    });
    return rows.map((r) => ({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        lastTurnAt: r.lastTurnAt.toISOString(),
        turns: r._count.turns,
        opening: r.turns[0]?.content ?? null,
    }));
}

/**
 * Delete ONE exchange. Idempotent, and a conversation that is not this
 * person's answers NOT FOUND rather than forbidden — a 403 would confirm the
 * id exists, which is P5.2b's posture and the one the profile verbs use.
 */
export async function deletePastConversation(userId: string, id: string): Promise<void> {
    const { count } = await prisma.assistantConversation.updateMany({
        where: { id, userId, deletedAt: null },
        data: { deletedAt: new Date() },
    });
    if (count === 0) {
        throw codedNotFound('CONVERSATION_NOT_FOUND', 'That conversation was not found.');
    }
}

/**
 * «Изтрий всичко» for exchanges.
 *
 * Returns the count, and it counts only what was VISIBLE — the same choice
 * `forgetAllRememberedPoints` makes, for the same reason: reporting a number
 * larger than the person could see is a worse answer than a smaller one.
 */
export async function deleteAllPastConversations(userId: string): Promise<number> {
    const { count } = await prisma.assistantConversation.updateMany({
        where: { userId, deletedAt: null },
        data: { deletedAt: new Date() },
    });
    return count;
}
