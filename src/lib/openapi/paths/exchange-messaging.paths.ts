/**
 * Exchange messaging — the conversation between the two parties to a listing.
 *
 * Documented at birth rather than added to the undocumented baseline, which
 * only shrinks. Three things here are not visible from the response shape and
 * would be got wrong by anyone reading only the JSON:
 *
 *   1. opening a thread is IDEMPOTENT, and the status code says which happened;
 *   2. `mine` exists so a client never compares tenant ids to decide sides;
 *   3. a deleted message is a TOMBSTONE — it keeps its place, with a null body.
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
        mine: z.boolean(),
        body: z.string().nullable(),
        deleted: z.boolean(),
        createdAt: z.string(),
    })
    .openapi('ExchangeMessage', {
        description:
            'Use `mine` to decide which side of the thread to render a bubble on. Do NOT ' +
            'compare `senderTenantId` to your own tenant — the server already knows which ' +
            'party is asking and answers for it.\n\n' +
            'A deleted message keeps its PLACE: `deleted: true` with a null `body`. Render ' +
            'it as removed rather than dropping it, or the other party\'s scrollback ' +
            'develops a hole where something they read used to be.',
    });

const ThreadSummary = z
    .object({
        id: z.string(),
        listingId: z.string(),
        listingCommodity: z.string(),
        role: z.enum(['seller', 'inquirer']),
        lastMessageAt: z.string(),
        closed: z.boolean(),
        hasUnread: z.boolean(),
    })
    .openapi('ExchangeThreadSummary', {
        description:
            'Threads from BOTH sides — ones this tenant opened as a buyer and ones opened ' +
            'against its own listings. `role` says which. `hasUnread` is a cheap staleness ' +
            'flag; the exact count needs the thread itself.',
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
        unreadCount: z.number().int(),
        /** Opaque position of the next OLDER page; null at the start of the thread. */
        olderCursor: z.string().nullable(),
        messages: z.array(Message),
    })
    .openapi('ExchangeThread');

export function registerExchangeMessagingPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/exchange/listings/{listingId}/thread',
        operationId: 'openExchangeThread',
        summary: 'Open the conversation for a listing',
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
        success: {
            status: 201,
            description: 'The conversation, created or already open.',
            schema: z.object({ id: z.string(), created: z.boolean() }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/exchange/threads',
        operationId: 'listExchangeThreads',
        summary: "The caller's conversations",
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
        summary: 'A conversation and its messages',
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
        summary: 'Send a message',
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
            'Without a key the send is NOT idempotent — two taps make two messages.',
        tags: ['Exchange messaging'],
        params: ThreadParams,
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
        summary: "Move the caller's read pointer to now",
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
        summary: 'Close a conversation',
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
        summary: 'Refuse further contact from the other party',
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
        summary: 'Lift a block',
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
        summary: 'Retract a message you sent',
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
