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
 * Rule 5's reason, one level up from a profile point: FIVE readers touch
 * turns — the window replay, the id resolver, the extraction sweep, recall and
 * the detail reader (#2721) — so a hard delete would let any of them bring a
 * deleted exchange back. A
 * tombstone they all filter is checkable; a hard delete is a claim about every
 * future reader.
 */
import { prisma } from '@/lib/prisma';
import { withTenantDb, type PrismaTx } from '@/lib/db-context';
import { codedNotFound } from '@/lib/errors/types';

/**
 * Read turn CONTENT for conversations that may span several farms.
 *
 * ## The defect this exists to fix, and why it was silent
 *
 * `AssistantTurn.content` is encrypted under the TENANT's DEK, and
 * `resolveTenantDekPair` takes the tenant from the AUDIT CONTEXT — not from
 * the row, which it cannot, since it needs the key before the row arrives. A
 * person-scoped read binds no tenant, so it resolved `NO_DEK_PAIR` and the
 * extension handed back the `v2:` ENVELOPE. No error, no log: the row looked
 * populated and the string was ciphertext.
 *
 * Measured 2026-11-02 against real rows. All three readers in this file were
 * affected, and each failed differently:
 *
 *   · the list showed `v2:8X18HAVp…` as every row's label;
 *   · recall compared the needle against ciphertext, so it matched NOTHING
 *     for every query, for ever — the one outcome its own docblock warns a
 *     farmer experiences as the assistant forgetting;
 *   · the detail reader (#2721) returned an envelope per turn.
 *
 * **The rule was already written down one file away.** `memory-extract.ts`
 * says it verbatim: a cross-tenant batch "would have to pick a single tenant
 * context and would silently return ciphertext — or nothing — for every other
 * farm in the batch. The read is per-tenant because the KEY is per-tenant."
 * The sweep obeys it; this file did not, and nothing connected the two.
 *
 * ## The shape
 *
 * Metadata (`id`, `tenantId`, the dates, the count) carries no encrypted
 * column, so it is read ONCE, person-scoped, across farms — which is the
 * question these verbs exist to answer. Content is then read one query per
 * distinct FARM, inside that farm's context, where the DEK resolves and RLS
 * additionally confines the rows.
 *
 * The loop is over farms, never over conversations: a person belongs to a
 * handful of farms and may hold fifty conversations.
 */
async function readContentPerTenant<T>(
    rows: ReadonlyArray<{ id: string; tenantId: string }>,
    read: (db: PrismaTx, conversationIds: string[]) => Promise<T[]>,
): Promise<T[]> {
    const byTenant = new Map<string, string[]>();
    for (const row of rows) {
        const seen = byTenant.get(row.tenantId);
        if (seen) seen.push(row.id);
        else byTenant.set(row.tenantId, [row.id]);
    }
    const out: T[] = [];
    for (const [tenantId, conversationIds] of byTenant) {
        /*
         * guardrail-allow: n+1 — one read per FARM, and it cannot be hoisted.
         * The key is per tenant, so a single query would have to pick one
         * context and return ciphertext for every other farm. Bounded by the
         * caller's conversation cap, and in practice by how many farms one
         * person belongs to.
         */
        out.push(...(await withTenantDb(tenantId, (db) => read(db, conversationIds))));
    }
    return out;
}

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
 * The opening is read through `readContentPerTenant`, because it is the one
 * ENCRYPTED value on the row. This docblock claimed the privileged client
 * decrypted it "because the row names its own tenant", and that was false in
 * the way that is hardest to see: the extension needs the key BEFORE the row
 * arrives, so a person-scoped read gave every label a `v2:` envelope. See the
 * helper for the measurement.
 */
export async function listPastConversations(userId: string): Promise<PastConversation[]> {
    const rows = await prisma.assistantConversation.findMany({
        where: { userId, deletedAt: null },
        orderBy: { lastTurnAt: 'desc' },
        take: CONVERSATION_LIST_LIMIT,
        // Metadata only — no encrypted column here, so one cross-farm read is
        // correct. `tenantId` is selected to route the content read below.
        select: {
            id: true,
            tenantId: true,
            startedAt: true,
            lastTurnAt: true,
            _count: { select: { turns: true } },
        },
    });
    if (rows.length === 0) return [];

    const openings = new Map<string, string>();
    for (const found of await readContentPerTenant(rows, (db, conversationIds) =>
        db.assistantConversation.findMany({
            where: { id: { in: conversationIds } },
            select: {
                id: true,
                turns: {
                    where: { role: 'user' },
                    orderBy: { createdAt: 'asc' },
                    take: 1,
                    select: { content: true },
                },
            },
        }),
    )) {
        const opening = found.turns[0]?.content;
        if (opening !== undefined) openings.set(found.id, opening);
    }

    // Mapped over `rows`, so the `lastTurnAt desc` order survives the
    // per-farm regrouping — the per-tenant reads come back in farm order.
    return rows.map((r) => ({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        lastTurnAt: r.lastTurnAt.toISOString(),
        turns: r._count.turns,
        opening: openings.get(r.id) ?? null,
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

/** The most turns ONE exchange returns — see `getPastConversation`. */
export const CONVERSATION_DETAIL_TURN_CAP = 200;

export interface PastConversationTurn {
    role: 'user' | 'assistant';
    text: string;
    at: string;
}

export interface PastConversationDetail {
    id: string;
    startedAt: string;
    lastTurnAt: string;
    /** Total turns on the row, which may exceed `turns.length` at the cap. */
    turns: number;
    /** Oldest first — this is a transcript, not a feed. */
    items: PastConversationTurn[];
    /** True when the cap elided the OLDEST turns, so a client can say so. */
    truncated: boolean;
}

/**
 * ONE exchange, with its turns, for the phone's detail screen (#2721).
 *
 * ## This is the FIFTH reader of turns, and the filter is the whole risk
 *
 * `deletePastConversation` is a tombstone rather than a hard delete precisely
 * because several readers touch turns — the window replay, the id resolver,
 * the extraction sweep, recall, and now this. Each filters `deletedAt: null`.
 * A detail reader that forgot it would show an exchange that has already
 * disappeared from the list, which is the one inconsistency a person would
 * notice, and it would be silent.
 *
 * So the filter is in the `where` of the conversation lookup, not applied to
 * the result: a tombstoned row must be indistinguishable from a nonexistent
 * one, and that is asserted as a COMPARISON rather than as a refusal.
 *
 * ## NOT FOUND, never FORBIDDEN
 *
 * Someone else's conversation answers exactly what a made-up id answers. A
 * 403 would confirm the id exists, and these ids are about people — P5.2B's
 * posture, and the one the `[id]` DELETE already takes.
 *
 * ## Why `userId` and not `tenantId`
 *
 * Person-scoped across farms, like `listPastConversations` above: a person
 * opening their own history is asking a question no single farm's context can
 * serve. `userId` comes from the verified session, never from the request.
 *
 * ## Oldest first, and the cap drops the OLDEST
 *
 * A transcript reads forward, so the items are ascending. But a 500-turn
 * exchange has to be cut somewhere, and cutting the NEWEST would hand back a
 * conversation whose end is missing while `lastTurnAt` says otherwise — so
 * the query takes the newest `CONVERSATION_DETAIL_TURN_CAP` and reverses them.
 * `truncated` says it happened rather than leaving the client to infer it
 * from a count mismatch.
 */
export async function getPastConversation(
    userId: string,
    id: string,
): Promise<PastConversationDetail> {
    const row = await prisma.assistantConversation.findFirst({
        // `deletedAt: null` HERE, so a tombstone and a nonexistent id take the
        // same path out. Never a post-filter.
        //
        // Both cases arrive as `null`, which is exactly right: the CALLER must
        // not be able to tell them apart, and nothing downstream needs to.
        where: { id, userId, deletedAt: null },
        // Metadata only. The turns are encrypted and are read below, in this
        // conversation's own farm — see `readContentPerTenant`.
        select: {
            id: true,
            tenantId: true,
            startedAt: true,
            lastTurnAt: true,
            _count: { select: { turns: true } },
        },
    });
    if (row === null) {
        // The SAME code and message the delete raises, deliberately: two
        // different refusals would let a caller tell the cases apart.
        throw codedNotFound('CONVERSATION_NOT_FOUND', 'That conversation was not found.');
    }

    // One farm, so one read — `readContentPerTenant` is still the right door:
    // it is where the per-tenant-key rule is written down, and a direct
    // `withTenantDb` here would be a second place to forget it.
    const turns = await readContentPerTenant([row], (db, conversationIds) =>
        db.assistantTurn.findMany({
            where: { conversationId: { in: conversationIds } },
            // Newest first to make the cap drop the oldest; reversed below.
            orderBy: { createdAt: 'desc' },
            take: CONVERSATION_DETAIL_TURN_CAP,
            select: { role: true, content: true, createdAt: true },
        }),
    );

    const items = turns
        .slice()
        .reverse()
        .map((t) => ({
            // The column is a string by design (the provider contract uses
            // these two literals), so the narrowing happens here rather than
            // being asserted on the schema.
            role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            text: t.content,
            at: t.createdAt.toISOString(),
        }));
    return {
        id: row.id,
        startedAt: row.startedAt.toISOString(),
        lastTurnAt: row.lastTurnAt.toISOString(),
        turns: row._count.turns,
        items,
        truncated: row._count.turns > items.length,
    };
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
        // Metadata only; the turns are encrypted. Reading them here returned
        // ciphertext, so `includes(needle)` compared a needle against an
        // envelope and matched NOTHING — for every query, silently. That is
        // the one outcome this feature's own docblock says a farmer
        // experiences as the assistant forgetting.
        select: { id: true, tenantId: true },
    });
    if (conversations.length === 0) return [];

    const turnsByConversation = new Map<
        string,
        Array<{ role: string; content: string; createdAt: Date }>
    >();
    for (const found of await readContentPerTenant(conversations, (db, conversationIds) =>
        db.assistantConversation.findMany({
            where: { id: { in: conversationIds } },
            select: {
                id: true,
                turns: {
                    orderBy: { createdAt: 'desc' },
                    // Per conversation, so one very long exchange cannot
                    // consume the whole scan budget and hide every other
                    // conversation. A nested `take` is per PARENT, which is
                    // why the shape stays nested rather than flattening to
                    // one `assistantTurn.findMany` with a global bound.
                    take: 60,
                    select: { role: true, content: true, createdAt: true },
                },
            },
        }),
    )) {
        turnsByConversation.set(found.id, found.turns);
    }

    const out: RecallExcerpt[] = [];
    let scanned = 0;
    // Iterated over `conversations`, NOT over the per-farm results: the scan
    // cap returns early, so the order decides what is found, and it must stay
    // newest-first as the outer query produced it.
    for (const conversation of conversations) {
        for (const turn of turnsByConversation.get(conversation.id) ?? []) {
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
