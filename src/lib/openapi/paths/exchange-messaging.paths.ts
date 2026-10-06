/**
 * Борса messaging — the conversation between the two parties to a listing.
 *
 * The product noun for this surface is «Борса» everywhere a person reads it —
 * nav, breadcrumbs, page heading, map legend. The TAG stays `Exchange
 * messaging` (renaming a tag regroups somebody's generated SDK); the
 * operation summaries carry the noun. See docs/nav-vocabulary.md.
 *
 * Documented at birth rather than added to the undocumented baseline, which
 * only shrinks. Three things here are not visible from the response shape and
 * would be got wrong by anyone reading only the JSON:
 *
 *   1. opening a thread is IDEMPOTENT, and the status code says which happened;
 *   2. `mine` exists so a client never compares tenant ids to decide sides;
 *   3. a deleted message is a TOMBSTONE — it keeps its place, with a null body;
 *   4. since #1298 a conversation is private to PEOPLE, not shared by the farm.
 *
 * Point 4 changed several shapes' meaning without changing their types, which
 * is the worst kind of change for a client reading only the JSON:
 *
 *   - `mine` means "sent by ME". It used to mean "sent by my FARM", which is
 *     what rendered a colleague's message as the reader's own.
 *   - `unreadCount` / `hasUnread` are per PERSON. They used to move for every
 *     member of the farm, so one colleague opening a thread marked it read for
 *     all of them.
 *   - A thread is one per (listing, inquirer PERSON), so a seller may now see
 *     SEVERAL threads from one buyer farm. That is correct, not duplication.
 *   - A member who is neither the thread's principal nor an OWNER/ADMIN of a
 *     party farm gets 404 on the thread, not 403: the row is invisible to them
 *     at the database level, so the API cannot distinguish "not yours" from
 *     "does not exist" — and should not, since the difference would leak that
 *     a colleague is talking to someone.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const ThreadParams = TenantParams.extend({
    threadId: z.string().openapi({ param: { name: 'threadId', in: 'path' } }),
});

/**
 * Keyset paging. The cursor is OPAQUE — a position, not a timestamp to parse or
 * construct. A client that builds its own has coupled itself to the sort key,
 * and changing the sort key then breaks it silently.
 */
const PageQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({
        param: { name: 'limit', in: 'query' },
        description: 'Page size, 1-100. Values above the cap are clamped, not rejected.',
    }),
});

const Message = z
    .object({
        id: z.string(),
        senderTenantId: z.string(),
        /** Opaque id of the PERSON who sent it. Never an email or a name. */
        senderUserId: z.string(),
        mine: z.boolean(),
        /** Sent by someone else at the caller's own farm (#1298). */
        fromMyFarm: z.boolean(),
        body: z.string().nullable(),
        deleted: z.boolean(),
        createdAt: z.string(),
    })
    .openapi('ExchangeMessage', {
        description:
            'Use `mine` to decide which side of the thread to render a bubble on. Do NOT ' +
            'compare `senderTenantId` to your own tenant — the server already knows which ' +
            'party is asking and answers for it.\n\n' +
            '`mine` means SENT BY YOU, the person — not by your farm (#1298). Three ' +
            'speakers are therefore possible on a thread, and a client needs all three: ' +
            '`mine: true` is you; `fromMyFarm: true` is a COLLEAGUE at your own farm (the ' +
            'seller admin answering for the listing\'s creator) and wants its own speaker ' +
            'label rather than being drawn as either side; both false is the counterparty. ' +
            '`fromMyFarm` is returned rather than derived from the two ids so every client ' +
            'does not reimplement the same comparison.\n\n' +
            'A deleted message keeps its PLACE: `deleted: true` with a null `body`. Render ' +
            'it as removed rather than dropping it, or the other party\'s scrollback ' +
            'develops a hole where something they read used to be.',
    });

const ThreadSummary = z
    .object({
        id: z.string(),
        listingId: z.string(),
        listingCommodity: z.string(),
        listingRegionName: z.string(),
        /** Decimal as a STRING, like every quantity on this API. */
        listingQuantityTonnes: z.string(),
        /**
         * The SELLER's published name, or null. Opt-in per listing, so it is
         * NOT an identity and must not be the only thing a row is scanned by.
         * Never the counterparty's: on a seller's row the other party is a
         * buyer, whose identity is behind the inquiry contact-reveal gate.
         */
        sellerDisplayName: z.string().nullable(),
        role: z.enum(['seller', 'inquirer']),
        lastMessageAt: z.string(),
        closed: z.boolean(),
        /** Per PERSON since #1298, not per farm. */
        hasUnread: z.boolean(),
    })
    .openapi('ExchangeThreadSummary', {
        description:
            'The caller\'s OWN inbox (#1298) — threads they opened as a buyer, plus threads ' +
            'on listings they created, plus threads on either where they are an OWNER/ADMIN ' +
            'of a party farm. It is no longer the farm\'s shared inbox, so two colleagues ' +
            'see different lists.\n\n' +
            '`role` says which side a row is. `hasUnread` is a cheap staleness flag and is ' +
            'now PER PERSON: a colleague reading a thread no longer clears your badge. The ' +
            'exact count needs the thread itself.\n\n' +
            'A seller may see SEVERAL rows for one buyer farm, because a thread is per ' +
            '(listing, inquirer PERSON). Do not de-duplicate by farm — they are different ' +
            'conversations with different people.',
    });

const Thread = z
    .object({
        id: z.string(),
        listingId: z.string(),
        listingCommodity: z.string(),
        role: z.enum(['seller', 'inquirer']),
        lastMessageAt: z.string(),
        closed: z.boolean(),
        /**
         * Seller-relevant, returned to BOTH sides: the blocked buyer's screen
         * needs to explain why sending will be refused rather than letting
         * them type into a void and collect a 403.
         */
        blocked: z.boolean(),
        /** Counted for the CALLER, not their farm (#1298). */
        unreadCount: z.number().int(),
        /** Opaque position of the next OLDER page; null at the start of the thread. */
        olderCursor: z.string().nullable(),
        messages: z.array(Message),
    })
    .openapi('ExchangeThread', {
        description:
            'Private to PEOPLE since #1298. The audience is the thread\'s principal — the ' +
            'person who opened it on the buyer side, the listing\'s creator on the seller ' +
            'side — plus any active OWNER/ADMIN of either party farm, so a farm can still ' +
            'answer when the principal is away or has left.\n\n' +
            'Anyone else gets **404**, including a colleague at a party farm. Not 403: the ' +
            'row is invisible at the database level, so the API cannot tell "not yours" ' +
            'from "does not exist" — and must not, because the difference would leak that a ' +
            'colleague is in a conversation.\n\n' +
            '`unreadCount` is counted for the CALLER. It used to be per farm, so a ' +
            'colleague opening the thread zeroed everyone\'s count.',
    });

export function registerExchangeMessagingPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/exchange/listings/{listingId}/thread',
        operationId: 'openExchangeThread',
        summary: 'Борса — open the conversation for a listing',
        description:
            '**Idempotent.** A second call returns the thread that already exists rather ' +
            'than creating another, so a client may call it on every "message seller" tap ' +
            'without checking first. **201** means one was created, **200** that one was ' +
            'already open — both carry the same body.\n\n' +
            'A seller cannot open a thread on their OWN listing (there would be no second ' +
            'party); that returns 400 `THREAD_OWN_LISTING`. Sellers reply to threads buyers ' +
            'open.',
        tags: ['Exchange messaging'],
        params: TenantParams.extend({
            listingId: z.string().openapi({ param: { name: 'listingId', in: 'path' } }),
        }),
        // 200 is DECLARED, not only described. The prose above says a second
        // call answers 200, and until now only the 201 was in the document —
        // so a strict or generated client treated the ordinary
        // already-open case as an undeclared response.
        extraResponses: {
            200: {
                description: 'The conversation was already open. Same body as the 201.',
                content: {
                    'application/json': {
                        schema: z.object({ id: z.string(), created: z.boolean() }),
                    },
                },
            },
        },
        success: {
            status: 201,
            description: 'The conversation was created.',
            schema: z.object({ id: z.string(), created: z.boolean() }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/exchange/threads',
        operationId: 'listExchangeThreads',
        summary: "Борса — the caller's conversations",
        description:
            'Most recently active first. Deliberately NOT ETagged: an inbox whose purpose ' +
            'is unread state should not be served from a cache.',
        tags: ['Exchange messaging'],
        params: TenantParams,
        query: PageQuery.extend({
            cursor: z.string().optional().openapi({
                param: { name: 'cursor', in: 'query' },
                description:
                    'Opaque position from a previous response\'s `nextCursor`. A stale or ' +
                    'malformed cursor RESTARTS the listing rather than erroring.',
            }),
        }),
        success: {
            status: 200,
            description: 'Conversations from both sides.',
            schema: z.object({
                threads: z.array(ThreadSummary),
                nextCursor: z.string().nullable().openapi({
                    description:
                        'Pass as `cursor` for the next page. **Null means the end** — it is ' +
                        'computed by over-fetching one row, so a final page that happens to ' +
                        'be exactly `limit` long correctly reports null rather than sending ' +
                        'the client after an empty page.',
                }),
            }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/exchange/threads/{threadId}',
        operationId: 'getExchangeThread',
        summary: 'Борса — a conversation and its messages',
        description:
            'Messages come back OLDEST-FIRST (reading order), but are selected newest-first ' +
            'and reversed — so a long thread returns its END, not its beginning.\n\n' +
            'Scroll back with `before`: pass the response\'s `olderCursor` to fetch the page ' +
            'immediately older than the one you hold. `olderCursor: null` means you have ' +
            'reached the start of the conversation.\n\n' +
            '`unreadCount` is counted in the DATABASE, not over the returned page, so it is a ' +
            'true count rather than one capped at `limit`.',
        tags: ['Exchange messaging'],
        params: ThreadParams,
        query: PageQuery.extend({
            before: z.string().optional().openapi({
                param: { name: 'before', in: 'query' },
                description:
                    'Opaque position from a previous response\'s `olderCursor`. A stale or ' +
                    'malformed value returns the newest page rather than erroring.',
            }),
        }),
        success: { status: 200, description: 'The conversation.', schema: Thread },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/exchange/threads/{threadId}/messages',
        operationId: 'sendExchangeMessage',
        summary: 'Борса — send a message',
        description:
            'The body is HTML-sanitised on write and then length-checked, in that order — ' +
            'so markup cannot pad a message past the limit.\n\n' +
            'A CLOSED thread is not refused: sending REOPENS it and the response says so ' +
            'with `reopened: true`. (This previously returned 400 `THREAD_CLOSED`; that ' +
            'refusal is gone, because either party can close and a refusal would let one ' +
            'side mute the other permanently.)\n\n' +
            'Send `Idempotency-Key` ALWAYS, minted BEFORE the first attempt and reused on ' +
            'every retry of the same logical send. The server maps it to `clientMutationId`, ' +
            'unique per SENDER, and a replay returns the ORIGINAL message with ' +
            '`replayed: true` rather than adding a duplicate line to the conversation. ' +
            '**`replayed` is explicit on purpose** — a replay indistinguishable from a create ' +
            'is a shape a client cannot branch on.\n\n' +
            'The replay check runs BEFORE the party, block and closed checks, so a retry of a ' +
            'message that was already accepted returns its original result even if the seller ' +
            'has since blocked the sender. Otherwise a flaky link turns "delivered" into a ' +
            '403 for a message that IS in the thread.\n\n' +
            'Without a key the send is NOT idempotent — two taps make two messages.\n\n' +
            '**Rate limit: 60 per minute, SHARED across the whole sending tenant** — ' +
            'not per user, not per device, and not per thread. Every conversation a ' +
            'tenant has draws on ONE budget, because the cost this bounds is the ' +
            'recipient\'s notification bell, which gets a row per message by design. ' +
            'Per-thread was rejected: a thread is per (listing, inquirer), so a ' +
            'per-thread ceiling would be multiplied by however many listings the ' +
            'RECIPIENT happens to have. Each party has their own budget, so one side ' +
            'can never exhaust the other\'s ability to reply.\n\n' +
            'On 429, HONOUR `Retry-After`. A client that retries on its own schedule ' +
            'spends the next window the moment it opens and stays blocked; the header ' +
            'says when the budget is actually free. A blocked sender consumes quota too ' +
            '— the limit runs before the block check, so the cost of being blocked falls ' +
            'on the blocked party. See #1161.',
        tags: ['Exchange messaging'],
        params: ThreadParams,
        headers: z.object({
            'Idempotency-Key': z
                .string()
                .min(1)
                .optional()
                .openapi({
                    description:
                        'Mint it BEFORE the first attempt and reuse it for every retry of the ' +
                        'same logical send. Without it the send is NOT idempotent — two taps ' +
                        'make two messages. A replay returns the ORIGINAL message with ' +
                        '`replayed: true`.',
                }),
        }),
        body: z.object({ body: z.string().min(1).max(8000) }).openapi('SendExchangeMessage'),
        success: {
            status: 201,
            description: 'Sent.',
            schema: z.object({
                id: z.string(),
                createdAt: z.string(),
                // True when this message REOPENED a closed thread. A client
                // caching `closed` locally must clear it on this, or the
                // composer keeps showing a closed banner for a live thread.
                reopened: z.boolean(),
                replayed: z.boolean().openapi({
                    description:
                        'True when an `Idempotency-Key` matched an earlier send and this is ' +
                        'the ORIGINAL message rather than a new one. False for a first send, ' +
                        'and always false when no key was supplied.',
                }),
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/exchange/threads/{threadId}/read',
        operationId: 'markExchangeThreadRead',
        summary: "Борса — move the caller's read pointer to now",
        description:
            '**Monotonic.** Safe to fire from two tabs, out of order, or repeatedly — the ' +
            'pointer never travels backwards. That matters because an older timestamp ' +
            'overwriting a newer one resurrects messages the user has already read, and it ' +
            'presents as a bug in the unread badge rather than in the request that caused it.',
        tags: ['Exchange messaging'],
        params: ThreadParams,
        success: {
            status: 200,
            description: 'The pointer, after the move.',
            schema: z.object({ readAt: z.string() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/exchange/threads/{threadId}/close',
        operationId: 'closeExchangeThread',
        summary: 'Борса — close a conversation',
        description:
            '**Either party may close, and closing does not lock the thread.** Sending a ' +
            'message reopens it, which is why there is no reopen endpoint to pair with this ' +
            'one — the way back is the thing you were going to do anyway.\n\n' +
            'Symmetric on purpose: if only the seller could close, or if a close were final, ' +
            'one side could silence the other mid-negotiation. Treat `closed` as "tidied out ' +
            'of the active inbox", not as a permission.\n\n' +
            '**Idempotent** — closing an already-closed thread keeps the ORIGINAL timestamp ' +
            'and reports `alreadyClosed: true`, so "when did this end" does not drift each ' +
            'time someone taps it.',
        tags: ['Exchange messaging'],
        params: ThreadParams,
        success: {
            status: 200,
            description: 'The close timestamp, and whether this call is what closed it.',
            schema: z.object({ closedAt: z.string(), alreadyClosed: z.boolean() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/exchange/threads/{threadId}/block',
        operationId: 'blockExchangeParty',
        summary: 'Борса — refuse further contact from the other party',
        description:
            '**Seller only.** The listing owner decides who may keep writing to them. There ' +
            'is no buyer-side mirror: a buyer can simply stop opening threads, and closing ' +
            'already tidies one away for either side.\n\n' +
            'Addressed by THREAD rather than by tenant id, so no client ever sends another ' +
            'tenant\'s id and the caller provably has standing — you can only block someone ' +
            'who has already written to you.\n\n' +
            'Only the blocked side is refused afterwards. The seller who pressed this can ' +
            'still write in the thread: the control is "stop them reaching me", not "freeze ' +
            'the record". **Idempotent.**',
        tags: ['Exchange messaging'],
        params: ThreadParams,
        success: {
            status: 200,
            description: 'The end state, and whether this call is what changed it.',
            schema: z.object({ blocked: z.boolean(), alreadyBlocked: z.boolean() }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/exchange/threads/{threadId}/block',
        operationId: 'unblockExchangeParty',
        summary: 'Борса — lift a block',
        description:
            'Seller only, and idempotent — lifting a block that is not there is not an ' +
            'error, because the end state is what is asserted rather than the transition.',
        tags: ['Exchange messaging'],
        params: ThreadParams,
        success: {
            status: 200,
            description: 'The end state.',
            schema: z.object({ blocked: z.boolean() }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/exchange/messages/{messageId}',
        operationId: 'deleteExchangeMessage',
        summary: 'Борса — retract a message you sent',
        description:
            'A TOMBSTONE, not a removal: the message keeps its place in the other party\'s ' +
            'scrollback with a null body. Only the sender may retract; another party gets ' +
            '403 `MESSAGE_NOT_SENDER`. Retracting twice is not an error.',
        tags: ['Exchange messaging'],
        params: TenantParams.extend({
            messageId: z.string().openapi({ param: { name: 'messageId', in: 'path' } }),
        }),
        success: { status: 200, description: 'Retracted.', schema: z.object({ id: z.string() }) },
    });
}
