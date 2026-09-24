/**
 * Messaging between the two parties to an exchange listing.
 *
 * ## Why this is not a chat system
 *
 * The obvious build is Conversation + Participant with access by membership,
 * which is what a general chat product gives you. That is the right shape when
 * the party set is OPEN. Here it is closed and known: a listing has exactly one
 * seller tenant, and a thread is opened by exactly one inquirer tenant.
 *
 * So there are two parties, no participant table, and no `tenantId` on the
 * rows — neither party owns a thread, which is the entire point. Visibility
 * comes from `exchange_thread_party_isolation`, the same policy shape
 * `ExchangeInquiry` has used in production since 2026-07.
 *
 * ## Persist, never publish from here
 *
 * There is no broker and no socket. Postgres is the source of truth and
 * delivery is a separate concern, deliberately: publish-then-persist looks
 * equivalent and is not — the message flashes up in both clients, the write
 * then fails, and it is gone on refresh. Users saw it; it does not exist.
 *
 * Nothing here needs to change when a transport is added. That is what makes
 * the split worth having on day one rather than day sixty.
 */
import type { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { codedBadRequest, codedForbidden, codedNotFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';

/** A message body longer than this is a document, not a message. */
const MAX_BODY_LENGTH = 4000;
/** One page of scrollback. */
const DEFAULT_PAGE_SIZE = 100;

export interface ExchangeMessageView {
    id: string;
    senderTenantId: string;
    /** True when the CALLER sent it — clients should not compare tenant ids. */
    mine: boolean;
    body: string | null;
    /** A tombstone keeps the message's place; `body` is null when deleted. */
    deleted: boolean;
    createdAt: Date;
}

export interface ExchangeThreadView {
    id: string;
    listingId: string;
    listingCommodity: string;
    /** Which side the CALLER is. Decides whose read pointer moves. */
    role: 'seller' | 'inquirer';
    lastMessageAt: Date;
    closed: boolean;
    unreadCount: number;
    messages: ExchangeMessageView[];
}

/**
 * Resolve the caller's side of a thread, or refuse.
 *
 * RLS already prevents a third tenant reading the row, so this is not the
 * security boundary — it is how the code knows WHICH party is asking, which
 * decides whose read pointer moves and what `mine` means. Belt and braces: a
 * `notFound` here rather than a crash if the policy ever changes underneath.
 */
async function requireParty(db: PrismaTx, ctx: RequestContext, threadId: string) {
    const thread = await db.exchangeThread.findFirst({
        where: { id: threadId },
        select: {
            id: true,
            listingId: true,
            inquirerTenantId: true,
            lastMessageAt: true,
            closedAt: true,
            sellerLastReadAt: true,
            inquirerLastReadAt: true,
            listing: { select: { sellerTenantId: true, commodity: true } },
        },
    });
    if (!thread) throw codedNotFound('THREAD_NOT_FOUND', 'That conversation was not found.');

    const isInquirer = thread.inquirerTenantId === ctx.tenantId;
    const isSeller = thread.listing.sellerTenantId === ctx.tenantId;
    if (!isInquirer && !isSeller) {
        // Unreachable while the policy holds — asserted rather than assumed.
        throw codedForbidden('THREAD_NOT_A_PARTY', 'You are not a party to that conversation.');
    }
    return { thread, role: (isInquirer ? 'inquirer' : 'seller') as 'inquirer' | 'seller' };
}

/**
 * Open the conversation for a listing, or return the one that exists.
 *
 * Idempotent on (listing, inquirer): a farmer tapping twice gets one thread,
 * not two. The unique constraint is the guarantee; this just reads first so the
 * common path does not rely on catching a violation.
 */
export async function openExchangeThread(ctx: RequestContext, listingId: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const listing = await db.exchangeListing.findFirst({
            where: { id: listingId },
            select: { id: true, sellerTenantId: true },
        });
        if (!listing) throw codedNotFound('LISTING_NOT_FOUND', 'That listing was not found.');

        // A seller cannot open a thread against their own listing: there would
        // be no second party. They reply to threads buyers open.
        if (listing.sellerTenantId === ctx.tenantId) {
            throw codedBadRequest(
                'THREAD_OWN_LISTING',
                'You cannot start a conversation on your own listing.',
            );
        }

        const existing = await db.exchangeThread.findFirst({
            where: { listingId, inquirerTenantId: ctx.tenantId },
            select: { id: true },
        });
        if (existing) return { id: existing.id, created: false };

        const row = await db.exchangeThread.create({
            data: { listingId, inquirerTenantId: ctx.tenantId },
            select: { id: true },
        });
        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'ExchangeThread',
            entityId: row.id,
            details: `Conversation opened on listing ${listingId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ExchangeThread',
                operation: 'created',
                after: { listingId },
                summary: 'Exchange conversation',
            },
        });
        return { id: row.id, created: true };
    });
}

/** The thread with its scrollback, newest last (reading order). */
export async function getExchangeThread(
    ctx: RequestContext,
    threadId: string,
    options: { limit?: number } = {},
): Promise<ExchangeThreadView> {
    assertCanRead(ctx);
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);

    return runInTenantContext(ctx, async (db) => {
        const { thread, role } = await requireParty(db, ctx, threadId);

        const rows = await db.exchangeMessage.findMany({
            where: { threadId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: {
                id: true, senderTenantId: true, body: true,
                deletedAt: true, createdAt: true,
            },
        });

        const readAt = role === 'seller' ? thread.sellerLastReadAt : thread.inquirerLastReadAt;
        const unreadCount = rows.filter(
            (m) => m.senderTenantId !== ctx.tenantId && (!readAt || m.createdAt > readAt),
        ).length;

        return {
            id: thread.id,
            listingId: thread.listingId,
            listingCommodity: thread.listing.commodity,
            role,
            lastMessageAt: thread.lastMessageAt,
            closed: thread.closedAt !== null,
            unreadCount,
            // Reversed: the query takes the NEWEST `limit`, the screen reads
            // oldest-first. Sorting ascending and taking `limit` would hand
            // back the start of a long thread instead of its end.
            messages: rows.reverse().map((m) => ({
                id: m.id,
                senderTenantId: m.senderTenantId,
                mine: m.senderTenantId === ctx.tenantId,
                body: m.deletedAt ? null : m.body,
                deleted: m.deletedAt !== null,
                createdAt: m.createdAt,
            })),
        };
    });
}

/** Post a message. Sanitised on write; bumps the thread for inbox ordering. */
export async function sendExchangeMessage(
    ctx: RequestContext,
    threadId: string,
    body: string,
) {
    assertCanWrite(ctx);
    // Sanitise BEFORE length-checking, so padding with markup cannot smuggle a
    // longer message past the limit.
    const text = sanitizePlainText(body).trim();
    if (!text) throw codedBadRequest('MESSAGE_EMPTY', 'Write a message first.');
    if (text.length > MAX_BODY_LENGTH) {
        throw codedBadRequest('MESSAGE_TOO_LONG', 'That message is too long.');
    }

    return runInTenantContext(ctx, async (db) => {
        const { thread } = await requireParty(db, ctx, threadId);
        if (thread.closedAt) {
            throw codedBadRequest('THREAD_CLOSED', 'That conversation is closed.');
        }

        const now = new Date();
        const row = await db.exchangeMessage.create({
            data: {
                threadId,
                senderTenantId: ctx.tenantId,
                senderUserId: ctx.userId,
                body: text,
                createdAt: now,
            },
            select: { id: true, createdAt: true },
        });
        // Denormalised for inbox ordering. Same transaction as the insert, so
        // a thread can never sort by a message that does not exist.
        await db.exchangeThread.update({
            where: { id: threadId },
            data: { lastMessageAt: now },
        });
        return { id: row.id, createdAt: row.createdAt };
    });
}

/**
 * Move the caller's read pointer to now.
 *
 * MONOTONIC. Two tabs, or a slow network, deliver these out of order — and an
 * older timestamp overwriting a newer one rewinds the pointer, resurrecting
 * messages the user has already read. It presents as a bug in the unread
 * badge, which is the last place anyone looks.
 */
export async function markExchangeThreadRead(ctx: RequestContext, threadId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { thread, role } = await requireParty(db, ctx, threadId);
        const now = new Date();
        const current = role === 'seller' ? thread.sellerLastReadAt : thread.inquirerLastReadAt;
        if (current && current >= now) return { readAt: current };

        await db.exchangeThread.update({
            where: { id: threadId },
            data: role === 'seller' ? { sellerLastReadAt: now } : { inquirerLastReadAt: now },
        });
        return { readAt: now };
    });
}

/** Retract a message. A tombstone, never a hole in the other party's scrollback. */
export async function deleteExchangeMessage(ctx: RequestContext, messageId: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const message = await db.exchangeMessage.findFirst({
            where: { id: messageId },
            select: { id: true, senderTenantId: true, threadId: true, deletedAt: true },
        });
        if (!message) throw codedNotFound('MESSAGE_NOT_FOUND', 'That message was not found.');
        // A party may retract only what they sent.
        if (message.senderTenantId !== ctx.tenantId) {
            throw codedForbidden('MESSAGE_NOT_SENDER', 'You can only remove your own messages.');
        }
        if (message.deletedAt) return { id: message.id };

        await db.exchangeMessage.update({
            where: { id: messageId },
            data: { deletedAt: new Date() },
        });
        return { id: message.id };
    });
}

/** The caller's conversations, most recently active first. */
export async function listExchangeThreads(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        // RLS restricts this to threads the caller is a party to, from either
        // side — which is why there is no tenant filter here to write wrongly.
        const rows = await db.exchangeThread.findMany({
            orderBy: { lastMessageAt: 'desc' },
            take: DEFAULT_PAGE_SIZE,
            select: {
                id: true, listingId: true, inquirerTenantId: true,
                lastMessageAt: true, closedAt: true,
                sellerLastReadAt: true, inquirerLastReadAt: true,
                listing: { select: { sellerTenantId: true, commodity: true } },
            },
        });

        return rows.map((t) => {
            const role = t.inquirerTenantId === ctx.tenantId ? 'inquirer' : 'seller';
            const readAt = role === 'seller' ? t.sellerLastReadAt : t.inquirerLastReadAt;
            return {
                id: t.id,
                listingId: t.listingId,
                listingCommodity: t.listing.commodity,
                role: role as 'seller' | 'inquirer',
                lastMessageAt: t.lastMessageAt,
                closed: t.closedAt !== null,
                /** Cheap staleness signal; the exact count needs the thread. */
                hasUnread: !readAt || t.lastMessageAt > readAt,
            };
        });
    });
}
