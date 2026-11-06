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
import { op, rawErrorResponses } from './helpers';

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
});

const ConversationSchema = z.object({
    id: z.string(),
    state: z.enum(['REQUEST', 'ACCEPTED', 'DECLINED']),
    initiatedByUserId: z.string(),
    lastMessageAt: z.string().datetime({ offset: true }).nullable(),
    lastReadAt: z.string().datetime({ offset: true }).nullable().openapi({
        description: "The CALLER's own read cursor, never the counterparty's. The participant read policy admits only the caller's own row, so the other person's cursor is not available here — «Видяно» is P8.3's own problem and not solved by this field.",
    }),
    messages: z.array(MessageSchema),
});

export function registerDirectMessagePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/social/conversations',
        operationId: 'openDirectConversation',
        summary: 'Open a direct conversation with a farm',
        description:
            'Resolves a farm HANDLE to the person who should receive the message — that farm\'s active owner — and returns the conversation, creating it if there is none. Idempotent: pressing it twice returns the same conversation, which is also what makes a REQUEST unrepeatable, since there is no second thread to open. Limited to 5 per hour per caller: the abusable act in a DM system is opening threads with people who never asked, and the default 60/min mutation tier does not bound that.',
        tags: TAGS,
        body: { schema: OpenConversationSchema },
        extraResponses: rawErrorResponses({
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
        summary: 'Read a conversation and its messages',
        tags: TAGS,
        params: ConversationIdParam,
        extraResponses: rawErrorResponses({
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
            'Sends into a conversation the caller participates in. While the conversation is a REQUEST, exactly ONE message is allowed until the other person accepts — so a second send answers 400 DM_REQUEST_AWAITING_REPLY rather than queueing. Repeating a request with the same idempotencyKey returns the first attempt\'s message with `deduplicated: true` and status 200.',
        tags: TAGS,
        params: ConversationIdParam,
        body: { schema: SendDirectMessageSchema },
        extraResponses: {
            ...rawErrorResponses({
                400: 'INVALID_JSON, INVALID_BODY, DM_BODY_REQUIRED (empty after trimming), DM_BODY_TOO_LONG, DM_REQUEST_AWAITING_REPLY (a request already holds its one message), or DM_IDEMPOTENCY_KEY_REUSED (that key belongs to a different conversation).',
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
        body: { schema: RespondToConversationSchema },
        extraResponses: rawErrorResponses({
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
        body: { schema: MarkConversationReadSchema },
        extraResponses: rawErrorResponses({
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
        body: { schema: EditDirectMessageSchema },
        extraResponses: rawErrorResponses({
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
        extraResponses: rawErrorResponses({
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
        body: { schema: MessageReactionSchema },
        extraResponses: rawErrorResponses({
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
        body: { schema: MessageReactionSchema },
        extraResponses: rawErrorResponses({
            400: 'INVALID_JSON, INVALID_BODY or DM_REACTION_REQUIRED.',
            404: 'MESSAGE_NOT_FOUND — the caller has no such reaction on that message.',
        }),
        success: { status: 204, description: 'The reaction is gone.' },
    });
}
