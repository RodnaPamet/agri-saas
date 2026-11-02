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

// ─── Recall (#2695) ──────────────────────────────────────────────────

/**
 * The most turns DECRYPTED in one search.
 *
 * This is the bound that makes recall affordable, and it exists because of
 * encryption rather than taste: `AssistantTurn.content` is ciphertext at rest
 * (`v2:`, under the tenant DEK), so there is no SQL text search to run —
 * `LIKE` sees an envelope, and `hashForLookup` is an exact-match HMAC that
 * cannot do substrings. The only way to match words is to decrypt and compare
 * in memory.
 *
 * So the DATE filter does the narrowing and this caps what is left. The
 * owner's own example carries a date — «какво ми каза за повитицата миналия
 * месец?» — which is why that is the right axis.
 *
 * **The cost is a real gap, stated rather than hidden:** a question with NO
 * date, about something older than this cap, finds nothing. The tool's
 * description tells the model to ask for a timeframe on an empty result
 * instead of concluding nothing was ever said, because "I did not look far
 * enough" and "you never mentioned it" are different answers and a farmer
 * experiences the second as the assistant forgetting.
 *
 * Owner decision 2026-11-02: date-bounded, over decrypting the whole history
 * per search (the cost the owner already rejected one level up) and over a
 * plaintext search column (which would put a farmer's own words unencrypted
 * beside the encrypted copy).
 */
export const RECALL_TURN_SCAN_CAP = 300;
/** Conversations whose turns are read, newest first. */
export const RECALL_CONVERSATION_CAP = 40;
/** Excerpts returned to the model. */
export const RECALL_MAX_EXCERPTS = 8;
/** Characters per excerpt. */
export const RECALL_EXCERPT_CHARS = 400;

export interface RecallExcerpt {
    conversationId: string;
    /** ISO day, so the model can say "on the 14th" without a timestamp. */
    on: string;
    role: 'user' | 'assistant';
    text: string;
}

export interface RecallOptions {
    query: string;
    /** ISO date, inclusive. */
    from?: string;
    /** ISO date, inclusive. */
    to?: string;
}

/**
 * Search this person's past exchanges, across every farm.
 *
 * Deleted conversations are excluded — #2695's constraint 3, and the reason
 * the tombstone landed first: recall cannot resurrect what the person removed
 * if the filter is here before the search exists.
 *
 * The match is a case-insensitive SUBSTRING, deliberately not a word-boundary
 * regex: JavaScript's `\b` is ASCII-only, so `/\bповитица/` never matches
 * Cyrillic and a boundary-based search would silently return nothing for the
 * language this product is in.
 */
export async function searchPastConversations(
    userId: string,
    opts: RecallOptions,
): Promise<RecallExcerpt[]> {
    const needle = opts.query.trim().toLowerCase();
    if (needle.length < 2) return [];

    const conversations = await prisma.assistantConversation.findMany({
        where: {
            userId,
            deletedAt: null,
            ...(opts.from || opts.to
                ? {
                      lastTurnAt: {
                          ...(opts.from ? { gte: new Date(opts.from) } : {}),
                          ...(opts.to ? { lte: new Date(opts.to) } : {}),
                      },
                  }
                : {}),
        },
        orderBy: { lastTurnAt: 'desc' },
        take: RECALL_CONVERSATION_CAP,
        select: {
            id: true,
            turns: {
                orderBy: { createdAt: 'desc' },
                // Per conversation, so one very long exchange cannot consume
                // the whole scan budget and hide every other conversation.
                take: 60,
                select: { role: true, content: true, createdAt: true },
            },
        },
    });

    const out: RecallExcerpt[] = [];
    let scanned = 0;
    for (const conversation of conversations) {
        for (const turn of conversation.turns) {
            if (scanned >= RECALL_TURN_SCAN_CAP) return out;
            scanned += 1;
            if (!turn.content.toLowerCase().includes(needle)) continue;
            out.push({
                conversationId: conversation.id,
                on: turn.createdAt.toISOString().slice(0, 10),
                role: turn.role === 'assistant' ? 'assistant' : 'user',
                text: turn.content.slice(0, RECALL_EXCERPT_CHARS),
            });
            if (out.length >= RECALL_MAX_EXCERPTS) return out;
        }
    }
    return out;
}
