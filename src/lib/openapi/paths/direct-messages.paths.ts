/**
 * Direct messages — `/api/social/conversations/**` and
 * `/api/social/messages/**` (P8.2, #2796).
 *
 * ## Every 4xx NAMES its codes, which is the point of this module existing
 *
 * `ErrorResponse.error.code` is the field the spec tells clients to switch on,
 * and a code a client has never heard of falls back to a generic message — so
 * a refusal with a precise cause reaches the operator as "something went
 * wrong" (#1391). `error-codes-are-documented` refused this PR until the eight
 * `DM_*` codes were named, which is the mechanism working rather than a
 * formality.
 *
 * ## What is NOT documented, deliberately: the 404
 *
 * Every refusal this surface makes that could disclose something collapses to
 * one not-found — a non-participant, a blocked caller, a handle that resolves
 * to nobody, a farm that does not exist. P8's phase note requires it
 * ("Non-participants get 404, not 403"), and the spec describes the 404 in
 * those terms WITHOUT enumerating the causes. Listing them would hand a client
 * the discrimination the server spent effort refusing to give: a caller who
 * could tell `CONVERSATION_BLOCKED` from `CONVERSATION_NOT_FOUND` would have
 * the block disclosed, which is exactly what P5.2b's owner ruling forbids.
 *
 * So the single documented 404 code is `CONVERSATION_NOT_FOUND` /
 * `MESSAGE_NOT_FOUND`, and that is the whole truth about what the server
 * sends.
 *
 * ## `codedErrorResponses`, NOT `rawErrorResponses`
 *
 * Every 4xx here is the `ErrorResponse` ENVELOPE — `codedBadRequest` and
 * `codedNotFound` produce `error: { code, message }`, and `error.code` is the
 * field the spec tells clients to switch on.
 *
 * P8.2 and P8.5 shipped this module using `rawErrorResponses`, which declares
 * the bare `{ error: string }` form reserved for the native auth family (RFC
 * 6749 §5.2) and the cadastre-import poll. That documented a lie of exactly
 * the kind #1391 is about: it told clients there is no `code` to switch on,
 * for routes whose whole 4xx design is a set of distinguishable codes.
 *
 * `openapi-breaking-change` is what caught it, and only on the third DM PR —
 * adding a 400 to an operation that previously had none replaced
 * `commonErrorResponses`' envelope with the raw shape, and the gate reported
 * `"error" no longer accepts object` plus `error.code was removed`. On the two
 * earlier PRs the override replaced an envelope with an envelope-shaped hole
 * nothing compared.
 *
 * Schemas are IMPORTED from `@/lib/schemas` rather than redeclared.
 * `request-body-declared-once` caps hand-written duplicates at zero, and its
 * reason applies: a route and a spec module each declaring their own Zod for
 * one body are two schemas nothing compares.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import {
    OpenConversationSchema,
    SendDirectMessageSchema,
    RespondToConversationSchema,
    EditDirectMessageSchema,
    MarkConversationReadSchema,
    MessageReactionSchema,
} from '@/lib/schemas';
import { op, codedErrorResponses } from './helpers';

const TAGS = ['Direct messages'];

const ConversationIdParam = z.object({
    conversationId: z.string().openapi({
        description: 'The conversation. A cuid, which names no person — unlike a user id, which is why the block routes keep theirs in a body.',
        example: 'cm4x8z1q0000a01pq9r7s3t2',
    }),
});

const MessageIdParam = z.object({
    messageId: z.string().openapi({
        description: 'The message.',
        example: 'cm4x8z1q0000b02rs0t8u4v3',
    }),
});

const OpenedSchema = z.object({
    conversationId: z.string(),
    state: z.enum(['REQUEST', 'ACCEPTED', 'DECLINED']).openapi({
        description: 'A conversation with a stranger starts as REQUEST, which admits exactly ONE message until the other person accepts. An existing conversation is returned with whatever state it already had, so a client must read this rather than assume REQUEST.',
    }),
});

const SentSchema = z.object({
    messageId: z.string(),
    createdAt: z.string().datetime({ offset: true }),
    deduplicated: z.boolean().openapi({
        description: 'True when an idempotencyKey matched a message this sender had already sent, in which case the existing message is returned and nothing new was created. The HTTP status is 200 for a replay and 201 for a new message, so a client has two ways to tell.',
    }),
});

const MessageSchema = z.object({
    id: z.string(),
    senderUserId: z.string(),
    body: z.string().nullable().openapi({
        description: 'NULL for a deleted message. The row keeps its place in the timeline — removing it would renumber the conversation under the other party — and the stored text is overwritten at delete time rather than merely hidden.',
    }),
    createdAt: z.string().datetime({ offset: true }),
    editedAt: z.string().datetime({ offset: true }).nullable(),
    deletedAt: z.string().datetime({ offset: true }).nullable(),
    reactions: z.array(z.object({ userId: z.string(), emoji: z.string() })),
    attachment: z.object({
        mime: z.string().nullable(),
        bytes: z.number().int().nullable(),
        sha256: z.string().nullable(),
    }).nullable().openapi({
        description: 'The photograph this message carries, or null. A sub-object so "is there a photo" is one null check rather than three fields that can disagree. The BYTES are fetched from `/api/social/messages/{messageId}/photo`, which a client derives from the message id — the storage key is deliberately not in this payload, because that route authorises by RLS participation and not by possession of a key. Null for a retracted message: deleting clears the columns AND the payload re-checks `deletedAt`.',
    }),
    linkCard: z.object({
        url: z.string(),
        title: z.string().nullable(),
        description: z.string().nullable(),
        fetchedAt: z.string().datetime({ offset: true }).nullable(),
    }).nullable().openapi({
        description: 'The link card, or null. A SNAPSHOT taken when the message was sent and never refreshed — re-fetching later would silently rewrite what two people discussed. `fetchedAt` null means the fetch was REFUSED (a host that resolves privately at any redirect hop, a timeout, a non-2xx), which is how a client tells that apart from a page that simply carried no metadata and therefore stamped a time. `title` and `description` are the third-party page\'s own text, sanitised at the usecase.',
    }),
    replyTo: z.object({
        id: z.string(),
        senderUserId: z.string(),
        body: z.string().nullable(),
        deleted: z.boolean(),
    }).nullable().openapi({
        description: 'The message this one quotes, or null. A sub-object rather than a bare id, and that is the point of the field: the target may sit OUTSIDE the page you are holding — a reply to something from last week arrives on a page whose oldest row is from today — so an id alone would cost one extra request per reply.\n\n`deleted` is what tells a RETRACTED target from a PHOTO-ONLY one, both of which have a null `body` (the body column is nullable since P8.6). Render «Съобщението е изтрито» for the first and a photo affordance for the second; a client reading only `body` would show the wrong copy for one of them.\n\nThe body is the target\'s full text, not a truncation: clamping a quote to one line is a display decision, and it discloses nothing new, because the target is always in the SAME conversation. `attachment` and `linkCard` are deliberately absent — a quote is a line of text, and re-serving a photograph\'s metadata once per reply to it would put the same bytes in the payload repeatedly.',
    }),
});

const ConversationSchema = z.object({
    id: z.string(),
    state: z.enum(['REQUEST', 'ACCEPTED', 'DECLINED']),
    initiatedByUserId: z.string(),
    lastMessageAt: z.string().datetime({ offset: true }).nullable(),
    olderCursor: z.string().nullable().openapi({
        description: 'Pass back as `before` to fetch the page OLDER than this one, or null at the start of the conversation. There is no "next": a chat opens at the bottom and reads backwards.',
    }),
    hasOlder: z.boolean().openapi({
        description: 'Whether an older page exists. Computed from a `limit + 1` probe row rather than a second COUNT.',
    }),
    lastReadAt: z.string().datetime({ offset: true }).nullable().openapi({
        description: "The CALLER's own read cursor, never the counterparty's. The participant read policy admits only the caller's own row, so the other person's cursor is not available here — «Видяно» is P8.3's own problem and not solved by this field.",
    }),
    messages: z.array(MessageSchema).openapi({
        description: 'ONE PAGE, oldest-first within the page even though the page returned first is the NEWEST — a client renders upward from the bottom. Capped at 100 (#2820); the first version of this endpoint returned every message and decrypted every one of them.',
    }),
});

const InboxItemSchema = z.object({
    source: z.enum(['dm', 'exchange']).openapi({
        description: 'Which kind of conversation this row is. A client needs it to choose a destination — a DM opens at /api/social/conversations/{id}, an exchange thread at its own tenant route — and the two carry different fields below.',
    }),
    id: z.string(),
    lastMessageAt: z.string().datetime({ offset: true }),
    lastReadAt: z.string().datetime({ offset: true }).nullable().openapi({
        description: "The CALLER's own read cursor, never the counterparty's. NULL means never opened, which is not the same as caught up at the first message.",
    }),
    unread: z.boolean(),
    awaitingMyAnswer: z.boolean().nullable().openapi({
        description: 'TRUE only when this is a DM request the caller has not answered. FALSE on a request the caller themselves opened — waiting for an answer is not owing one, and must not light the same badge. NULL on an exchange row, because the exchange has no request state and `false` there would read as "already answered".',
    }),
    title: z.string().nullable().openapi({
        description: 'A row preview: the newest message for a DM, or commodity and region for an exchange thread. NULL when the newest message was deleted, so a client renders an absence rather than an empty string.',
    }),
});

const InboxPageSchema = z.object({
    items: z.array(InboxItemSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
});

export function registerDirectMessagePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/social/inbox',
        operationId: 'listInbox',
        summary: 'One inbox — direct messages and Борса deals',
        description:
            'Every conversation the caller is a PARTY to, newest activity first, across every farm. Person-scoped: it does not include a colleague\'s exchange thread even where the caller is an owner of that farm — the tenant-scoped exchange inbox is unchanged and remains the place for that. Ordering is a single total order over both sources, so `nextCursor` pages the merge rather than either half.',
        tags: TAGS,
        query: z.object({
            limit: z.string().optional().openapi({ description: 'Positive integer, clamped to 20.' }),
            cursor: z.string().optional().openapi({ description: 'Opaque. From a previous response\'s nextCursor.' }),
            source: z
                .string()
                .optional()
                .openapi({
                    description:
                        'Comma-separated subset of `dm,exchange`. Absent returns both. `dm` exists because this endpoint is PERSON-scoped: its exchange half admits the caller only as the inquirer or the listing\'s seller, so a tenant-scoped screen that shows an owner their colleagues\' threads must keep its own query for that half and take only `dm` from here. An unrecognised value is a 400, never a silent fallback to both — that would add person-scoped exchange rows beside tenant-scoped ones and show the same thread twice from two audiences.',
                }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_LIMIT (not a positive integer), INVALID_CURSOR (unreadable) or INVALID_SOURCE (not a subset of dm,exchange). A broken cursor is refused rather than treated as a first page, because silently restarting a scroll looks like duplicated rows.',
        }),
        success: {
            status: 200,
            description: 'One page of the merged inbox.',
            schema: InboxPageSchema,
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/social/conversations',
        operationId: 'openDirectConversation',
        summary: 'Open a direct conversation with a farm',
        description:
            'Resolves a farm HANDLE to the person who should receive the message — that farm\'s active owner — and returns the conversation, creating it if there is none. Idempotent: pressing it twice returns the same conversation, which is also what makes a REQUEST unrepeatable, since there is no second thread to open. Limited to 5 per hour per caller: the abusable act in a DM system is opening threads with people who never asked, and the default 60/min mutation tier does not bound that.',
        tags: TAGS,
        body: OpenConversationSchema,
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON, INVALID_BODY or DM_SELF — the body was unreadable, the handle was missing, or the handle resolves to the caller.',
            404: 'CONVERSATION_NOT_FOUND. One code for every disclosing cause: no such handle, a farm that has not published, a farm with no active owner, or a block in either direction. Telling them apart would disclose the block.',
        }),
        success: {
            status: 201,
            description: 'The conversation. 201 whether it was created now or already existed — a client that needs to know reads `state`.',
            schema: OpenedSchema,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/social/conversations/{conversationId}',
        operationId: 'readDirectConversation',
        summary: 'Read a conversation and one page of its messages',
        description:
            'Returns the NEWEST page of messages, oldest-first within the page, and a cursor for the page before it. Paged since #2820 — the first version returned the whole history and decrypted every row in one request.',
        tags: TAGS,
        params: ConversationIdParam,
        query: z.object({
            limit: z.string().optional().openapi({ description: 'Positive integer, clamped to 100.' }),
            before: z.string().optional().openapi({ description: "Opaque. From a previous response's olderCursor." }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_LIMIT (not a positive integer) or INVALID_CURSOR (unreadable `before`). A broken cursor is refused rather than treated as the start of the conversation, because silently restarting a backwards scroll duplicates a page the client already has.',
            404: 'CONVERSATION_NOT_FOUND — no such conversation, the caller is not a participant, or the caller is blocked by one. Identical in every observable, by design.',
        }),
        success: {
            status: 200,
            description: 'The conversation, its messages oldest-first, and the caller\'s read cursor.',
            schema: ConversationSchema,
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/social/conversations/{conversationId}/messages',
        operationId: 'sendDirectMessage',
        summary: 'Send a message',
        description:
            'Sends into a conversation the caller participates in. While the conversation is a REQUEST, exactly ONE message is allowed until the other person accepts — so a second send answers 400 DM_REQUEST_AWAITING_REPLY rather than queueing. Repeating a request with the same idempotencyKey returns the first attempt\'s message with `deduplicated: true` and status 200.\n\nAn optional `linkUrl` attaches a LINK CARD. The server fetches that page BEFORE opening the transaction — an external fetch inside one holds a pool connection, and `PG_POOL_MAX` is 12 — through `fetchPublicUrl`, which re-runs the host policy at every redirect hop. Whatever metadata comes back is sanitised at the usecase and stored as a SNAPSHOT that is never refreshed.\n\nAn optional `replyToMessageId` QUOTES an earlier message, and it must be one in THIS conversation. A target in another conversation and a target that does not exist get the SAME refusal, deliberately — two answers would let a sender probe for real message ids. A DELETED message is a valid target: the row survives a retraction, so the reply lands and the quote renders as deleted, rather than the composer failing because the other party retracted something a moment earlier.\n\nThe database holds the same rule independently (`direct_message_reply_same_conversation`, a trigger, because Postgres forbids a subquery in a CHECK and the comparison is between two rows). The usecase check is what produces a usable refusal: measured without it, the trigger\'s SQLSTATE 23514 reaches the client as Prisma\'s `P2039` — an unrecognised error with no coded mapping, so a 500 carrying nothing a client can show anybody.',
        tags: TAGS,
        params: ConversationIdParam,
        body: SendDirectMessageSchema,
        extraResponses: {
            ...codedErrorResponses({
                400: 'INVALID_JSON, INVALID_BODY, DM_BODY_REQUIRED (empty after trimming), DM_BODY_TOO_LONG, DM_REQUEST_AWAITING_REPLY (a request already holds its one message), DM_IDEMPOTENCY_KEY_REUSED (that key belongs to a different conversation), DM_REPLY_TARGET_NOT_FOUND (the quoted message is not in this conversation, or does not exist — one code for both), or DM_LINK_URL_INVALID.\n\n`DM_LINK_URL_INVALID` is not reachable through this route: `linkUrl` is declared `httpsUrl()`, so a non-https value is already INVALID_BODY at the boundary. It is documented because the usecase raises it for a second caller arriving without the schema, and a code with no entry in the catalogues is a refusal a client cannot show anybody.\n\nA link whose page cannot be fetched is NOT a refusal. The fetch is best-effort: a host that resolves privately at any redirect hop, a timeout, a non-2xx or a page with no metadata all send the message with the URL stored and `linkCard.fetchedAt` null.',
                404: 'CONVERSATION_NOT_FOUND — no such conversation, not a participant, blocked, or the request was declined.',
            }),
            200: {
                description: 'A replay: this idempotencyKey already produced a message, which is returned unchanged. Nothing was sent.',
                content: { 'application/json': { schema: SentSchema } },
            },
        },
        success: { status: 201, description: 'The message was sent.', schema: SentSchema },
    });

    op(registry, {
        method: 'post',
        path: '/api/social/conversations/{conversationId}/respond',
        operationId: 'respondToDirectConversation',
        summary: 'Accept or decline a conversation request',
        description:
            'Only the party who did NOT open the request may answer it, and only while it is still a REQUEST. A decline is final and keeps its row, so the same person cannot re-open the same request.',
        tags: TAGS,
        params: ConversationIdParam,
        body: RespondToConversationSchema,
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON, INVALID_BODY, or DM_REQUEST_ALREADY_ANSWERED.',
            404: 'CONVERSATION_NOT_FOUND — no such conversation, not a participant, or the caller is the one who opened it.',
        }),
        success: {
            status: 200,
            description: 'The new state.',
            schema: z.object({ state: z.enum(['ACCEPTED', 'DECLINED']) }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/social/conversations/{conversationId}/read',
        operationId: 'markDirectConversationRead',
        summary: 'Move the caller\'s read cursor',
        description:
            'Forward only. A cursor already at or past the given instant is left alone and the call still answers 204 — a client that double-taps has not done anything wrong.',
        tags: TAGS,
        params: ConversationIdParam,
        body: MarkConversationReadSchema,
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON or INVALID_BODY — readAt must be an ISO instant with an offset.',
        }),
        success: { status: 204, description: 'The cursor is at or past that instant.' },
    });

    op(registry, {
        method: 'patch',
        path: '/api/social/messages/{messageId}',
        operationId: 'editDirectMessage',
        summary: 'Edit a message the caller sent',
        tags: TAGS,
        params: MessageIdParam,
        body: EditDirectMessageSchema,
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON, INVALID_BODY, DM_BODY_REQUIRED or DM_BODY_TOO_LONG.',
            404: 'MESSAGE_NOT_FOUND — no such message, it was sent by somebody else, or it is deleted. A deleted message is not editable: the row is kept as a record, not as a draft.',
        }),
        success: { status: 204, description: 'The message was edited.' },
    });

    op(registry, {
        method: 'delete',
        path: '/api/social/messages/{messageId}',
        operationId: 'deleteDirectMessage',
        summary: 'Delete a message the caller sent',
        description:
            'A SOFT delete: the row keeps its place with a null body so the conversation does not renumber under the other party, and the stored text is overwritten rather than merely hidden.',
        tags: TAGS,
        params: MessageIdParam,
        extraResponses: codedErrorResponses({
            404: 'MESSAGE_NOT_FOUND — no such message, it was sent by somebody else, or it is already deleted.',
        }),
        success: { status: 204, description: 'The message was deleted.' },
    });

    op(registry, {
        method: 'post',
        path: '/api/social/messages/{messageId}/reactions',
        operationId: 'addDirectMessageReaction',
        summary: 'React to a message',
        description:
            'Idempotent — the same reaction twice is one row. The emoji field is short on purpose: a reaction is delivered by push, and a field long enough for prose would put a farmer\'s words into APNs.',
        tags: TAGS,
        params: MessageIdParam,
        body: MessageReactionSchema,
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON, INVALID_BODY, DM_REACTION_REQUIRED or DM_REACTION_TOO_LONG.',
            404: 'MESSAGE_NOT_FOUND — no such message, or the caller cannot see it.',
        }),
        success: { status: 204, description: 'The reaction is present.' },
    });

    op(registry, {
        method: 'delete',
        path: '/api/social/messages/{messageId}/reactions',
        operationId: 'removeDirectMessageReaction',
        summary: 'Remove the caller\'s reaction',
        tags: TAGS,
        params: MessageIdParam,
        body: MessageReactionSchema,
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON, INVALID_BODY or DM_REACTION_REQUIRED.',
            404: 'MESSAGE_NOT_FOUND — the caller has no such reaction on that message.',
        }),
        success: { status: 204, description: 'The reaction is gone.' },
    });
    op(registry, {
        method: 'post',
        path: '/api/social/conversations/{conversationId}/photos',
        operationId: 'sendDirectPhoto',
        summary: 'Send a photograph into a conversation',
        description:
            'A photograph, optionally with a caption. The caption is OPTIONAL because a photo alone is a complete message (owner ruling 2026-11-07) — `DirectMessage.body` is nullable and the CHECK accepts a row with an attachment and no text.\n\n'
            + '**This is the record-less upload class**, which decides the ordering. There is no `FileRecord`, so nothing downstream carries a `scanStatus` and there is no download gate to defer to: the AV scan runs at INGEST, on the ORIGINAL bytes, before anything is stripped or stored. Stripping decodes caller bytes with libvips, so it cannot precede the scan.\n\n'
            + 'Metadata is stripped server-side by re-encoding. The FORMAT IS PRESERVED — a JPEG is stored as a JPEG — so the response type of the read route is the sniffed type recorded at upload, not a fixed one. A farm photograph carries GPS, and a parcel location is exactly what must not travel.\n\n'
            + '**Refusal codes.**\n'
            + '- `INVALID_BODY` — no `photo` part, or it was not a file.\n'
            + '- `FILE_TOO_LARGE`, `FILE_EMPTY` — the SHARED upload bounds, 4 MB here, mirroring the avatar ruling of 2026-10-16 (a phone photo is 1–3 MB). The same codes every other upload in the product reports, deliberately: a client should not have to learn a second vocabulary for the same refusal.\n'
            + '- `FILE_TYPE_NOT_ALLOWED` — not a JPEG, PNG or WebP, checked on the MAGIC NUMBER rather than the declared type.\n'
            + '- `DM_PHOTO_NEEDS_ACCEPTED` — the conversation is still a REQUEST. The request rule admits TEXT so a stranger can say who they are; an unsolicited image from an unknown person is what that state exists to hold back.\n'
            + '- `CONVERSATION_NOT_FOUND` — no such conversation, or the caller is not a participant. One code, because telling them apart discloses which.',
        tags: TAGS,
        bodyContentType: 'multipart/form-data',
        body: z.object({
            photo: z.string().openapi({ format: 'binary' }),
            body: z.string().optional().openapi({ description: 'Optional caption.' }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_BODY, FILE_TOO_LARGE, FILE_EMPTY, FILE_TYPE_NOT_ALLOWED or DM_PHOTO_NEEDS_ACCEPTED.',
            404: 'CONVERSATION_NOT_FOUND — no such conversation, not a participant, or a block in either direction.',
        }),
        success: {
            status: 201,
            description: 'The message the photograph was sent as.',
            schema: z.object({
                messageId: z.string(),
                createdAt: z.string().datetime({ offset: true }),
            }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/social/messages/{messageId}/photo',
        operationId: 'readDirectPhoto',
        summary: 'Serve a conversation photograph',
        description:
            'Streams the stored image, as the type recorded at upload. **The gate is RLS, not a check in the route**: the storage key is resolved under a person context where `direct_message_select` admits a participant\'s rows and nobody else\'s, so a non-participant\'s lookup returns nothing and the empty result becomes the not-found. That is also what makes an orphaned object unreachable — the bytes are written before the row, and a key is only ever reached through a row.\n\n'
            + '`no-store` and no ETag, unlike the avatar route: an avatar is low-sensitivity and shown across member lists, while a photograph sent privately must not sit in a shared cache on a phone that may be lost, sold or handed on.\n\n'
            + 'A RETRACTED message serves nothing. Deleting clears the attachment columns and removes the object, in that order, so the key stops resolving before the bytes go.',
        tags: TAGS,
        extraResponses: codedErrorResponses({
            404: 'CONVERSATION_NOT_FOUND. Four causes, one answer: no such message, not a participant, no photograph on it, or retracted.',
        }),
        success: {
            status: 200,
            description: 'The image bytes, as `image/jpeg`, `image/png` or `image/webp` — whichever the upload sniffed.',
            schema: z.string().openapi({ format: 'binary' }),
        },
    });

}
