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
import { runInTenantContext, withTenantDb, type PrismaTx } from '@/lib/db-context';
import { enqueueEmail } from '../notifications/enqueue';
import { encodeCursor, decodeCursor, keysetBefore } from '@/lib/exchange/cursor';
import { isUniqueViolation } from '@/lib/errors/prisma';
import { translateFor } from '@/lib/i18n/server-messages';
import { publishNotificationEvent } from '@/lib/notifications/notification-bus';
import { isLocale } from '@/lib/i18n/locales';
import { RECIPIENT_FALLBACK_LOCALE } from '@/lib/email/recipient-locale';
import { logger } from '@/lib/observability/logger';
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
    /** Opaque position of the next OLDER page, or null at the start of the thread. */
    olderCursor: string | null;
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
 * Is `inquirerTenantId` blocked by `sellerTenantId`?
 *
 * Readable from EITHER side. The SELECT policy on `ExchangeBlock` is
 * deliberately wide enough for the blocked tenant to see the row naming them,
 * because this predicate runs inside THEIR request — a row they cannot see
 * cannot refuse them, and the refusal would silently never fire. Everything
 * that CHANGES a block is the seller's alone, enforced by separate per-command
 * policies rather than one USING clause.
 */
async function isBlocked(
    db: PrismaTx,
    sellerTenantId: string,
    inquirerTenantId: string,
): Promise<boolean> {
    const row = await db.exchangeBlock.findFirst({
        where: { sellerTenantId, blockedTenantId: inquirerTenantId },
        select: { id: true },
    });
    return row !== null;
}

/**
 * Refuse further contact from the other party to this thread.
 *
 * SELLER ONLY — the listing owner decides who may keep writing to them. The
 * mirror case (a buyer silencing a seller) is not a thing: the buyer can simply
 * stop opening threads, and closing already tidies one away for either side.
 *
 * Addressed by THREAD rather than by tenant id so the API never has to take a
 * tenant id from a client, and so the caller provably has standing: you can
 * only block someone who has already written to you.
 *
 * Idempotent — blocking twice is one row and not an error.
 */
export async function blockExchangeParty(ctx: RequestContext, threadId: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { thread, role } = await requireParty(db, ctx, threadId);
        if (role !== 'seller') {
            throw codedForbidden('BLOCK_SELLER_ONLY', 'Only the seller can block a buyer.');
        }

        const blockedTenantId = thread.inquirerTenantId;
        const existing = await db.exchangeBlock.findFirst({
            where: { sellerTenantId: ctx.tenantId, blockedTenantId },
            select: { id: true },
        });
        if (existing) return { blocked: true, alreadyBlocked: true };

        await db.exchangeBlock.create({
            data: { sellerTenantId: ctx.tenantId, blockedTenantId, createdByUserId: ctx.userId },
        });
        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'ExchangeBlock',
            entityId: threadId,
            details: `Blocked further contact on thread ${threadId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ExchangeBlock',
                operation: 'created',
                // The blocked tenant id is NOT in `params` — ids of other
                // tenants have no place in an audit payload this one can read.
                after: { threadId },
                summary: 'Exchange contact blocked',
            },
        });
        return { blocked: true, alreadyBlocked: false };
    });
}

/** Lift a block. Seller only, and reversible by design — see `blockExchangeParty`. */
export async function unblockExchangeParty(ctx: RequestContext, threadId: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { thread, role } = await requireParty(db, ctx, threadId);
        if (role !== 'seller') {
            throw codedForbidden('BLOCK_SELLER_ONLY', 'Only the seller can block a buyer.');
        }
        // deleteMany, not delete: absent is the desired end state either way,
        // and a missing row must not be an error on an undo action.
        await db.exchangeBlock.deleteMany({
            where: { sellerTenantId: ctx.tenantId, blockedTenantId: thread.inquirerTenantId },
        });
        return { blocked: false };
    });
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

        // Checked BEFORE the idempotent read below: a blocked tenant must not
        // be handed back a thread they opened before the block either.
        if (await isBlocked(db, listing.sellerTenantId, ctx.tenantId)) {
            throw codedForbidden('THREAD_BLOCKED', 'That seller is not accepting messages from you.');
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
    options: { limit?: number; before?: string | null } = {},
): Promise<ExchangeThreadView> {
    assertCanRead(ctx);
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), DEFAULT_PAGE_SIZE);
    const before = decodeCursor(options.before);

    return runInTenantContext(ctx, async (db) => {
        const { thread, role } = await requireParty(db, ctx, threadId);
        const blocked = await isBlocked(db, thread.listing.sellerTenantId, thread.inquirerTenantId);

        const rows = await db.exchangeMessage.findMany({
            where: { threadId, ...(before ? keysetBefore(before, 'createdAt') : {}) },
            // `id` tiebreaks, for the same reason as the inbox: two messages
            // sharing a `createdAt` are not ordered by the timestamp alone, and
            // the pair straddling a page boundary loses one and repeats the
            // other. In a conversation that means a line somebody wrote either
            // vanishes or is said twice.
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: {
                id: true, senderTenantId: true, body: true,
                deletedAt: true, createdAt: true,
            },
        });

        const hasOlder = rows.length > limit;
        const page = hasOlder ? rows.slice(0, limit) : rows;
        // The OLDEST row of this page — the query is newest-first, so that is
        // the last element, and it is the position the next (older) page
        // continues from.
        const oldest = page.at(-1);

        const readAt = role === 'seller' ? thread.sellerLastReadAt : thread.inquirerLastReadAt;
        // Counted in the DATABASE, not over the page. Filtering the fetched
        // rows capped the badge at `limit`, so a thread with more unread
        // messages than one page reported the page size and called it a count
        // — precisely the "badge that is wrong" failure, and one that only
        // appears once a conversation is long enough that nobody checks.
        const unreadCount = await db.exchangeMessage.count({
            where: {
                threadId,
                senderTenantId: { not: ctx.tenantId },
                deletedAt: null,
                ...(readAt ? { createdAt: { gt: readAt } } : {}),
            },
        });

        return {
            id: thread.id,
            listingId: thread.listingId,
            listingCommodity: thread.listing.commodity,
            role,
            lastMessageAt: thread.lastMessageAt,
            closed: thread.closedAt !== null,
            // Only meaningful to the seller — they are the only side that can
            // set or lift it — but returned to both because the blocked buyer's
            // screen needs to explain why their composer is refusing, rather
            // than letting them type into a void and collect an error.
            blocked,
            unreadCount,
            // Reversed: the query takes the NEWEST `limit`, the screen reads
            // oldest-first. Sorting ascending and taking `limit` would hand
            // back the start of a long thread instead of its end.
            // Null means there is nothing older. Opaque — see `lib/exchange/cursor`.
            olderCursor: hasOlder && oldest ? encodeCursor({ at: oldest.createdAt, id: oldest.id }) : null,
            messages: page.reverse().map((m) => ({
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


/**
 * Tell the other side something was said.
 *
 * ── Why the OUTBOX and not a direct send ──
 *
 * The rest of the Exchange mails directly (`sendInquiryEmail`). This one goes
 * through `enqueueEmail` for a property direct sending does not have: the
 * outbox dedupe key is `tenant:type:email:entityId:DAY`, and a duplicate is
 * skipped silently. Keyed on the THREAD, that yields exactly one nudge per
 * conversation per recipient per day — which is what a chat notification
 * should be. Ten messages in an afternoon is a conversation, not ten emails.
 *
 * ── The same mechanism, the opposite intent ──
 *
 * Earlier the same dedupe was a BUG for insurance leads: keyed on the parcel,
 * a farmer correcting their land size wrote a second lead and the mail was
 * silently dropped. The fix there was to key on the lead, so every ask mails.
 *
 * Both are right. An insurance lead is a discrete event the operator must
 * action individually; a chat message is one of many in a conversation that
 * has a single place to go and look. The question is never "dedupe or not" —
 * it is "does each of these need its own notification".
 *
 * Fail-open. The message is already committed; a mail failure must not turn a
 * successful send into an error the sender sees.
 */
async function notifyOtherParty(
    senderTenantId: string,
    thread: { id: string; inquirerTenantId: string; listing: { sellerTenantId: string; commodity: string } },
): Promise<void> {
    const recipientTenantId =
        senderTenantId === thread.inquirerTenantId
            ? thread.listing.sellerTenantId
            : thread.inquirerTenantId;

    try {
        // The recipient's memberships are RLS-forced, so this must run in
        // THEIR context — a context-less read returns zero rows and the
        // notification silently goes nowhere.
        await withTenantDb(recipientTenantId, async (db) => {
            const admins = await db.tenantMembership.findMany({
                where: { tenantId: recipientTenantId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
                // `uiLanguage` because this crosses a tenant boundary: the
                // reader is a different person from the writer.
                select: {
                    // `id` for the bell row (Notification is per USER), `email`
                    // for the outbox (deduped per ADDRESS). One person holding
                    // two admin memberships is one bell row and one email, but
                    // those are different groupings, so they need two maps.
                    user: { select: { id: true, email: true, uiLanguage: true } },
                    tenant: { select: { slug: true } },
                },
                take: 25,
            });
            if (admins.length === 0) return;

            // One person may hold several admin memberships; keep the first
            // locale seen for an address rather than mailing them twice.
            const byEmail = new Map<string, { locale: string | null; slug: string }>();
            const byUser = new Map<string, { locale: string | null; slug: string }>();
            for (const a of admins) {
                const email = a.user.email;
                if (email && !byEmail.has(email)) {
                    byEmail.set(email, { locale: a.user.uiLanguage, slug: a.tenant.slug });
                }
                if (!byUser.has(a.user.id)) {
                    byUser.set(a.user.id, { locale: a.user.uiLanguage, slug: a.tenant.slug });
                }
            }

            // ── The bell, one row per message ──
            //
            // NOT deduped, deliberately, and this is the whole point of the
            // channel. The email's dedupe key ends in the UTC day, so the
            // second message of a conversation sends no mail — silently. If
            // the bell deduped the same way, a live negotiation would notify
            // on NO channel from the second message onward, which is how this
            // shipped and what this fixes.
            //
            // Written per user rather than with `createMany` because the SSE
            // event needs the row's real id, and `createMany` returns none.
            // The sibling assignment writer passes its `dedupeKey` as the id
            // instead — an option only because it HAS one.
            for (const [userId, { locale, slug }] of byUser) {
                const loc = isLocale(locale) ? locale : RECIPIENT_FALLBACK_LOCALE;
                // Rendered in the RECIPIENT's language, not the sender's.
                // Every other bell writer stores English prose and the bell
                // renders `{n.title}` raw, so a Bulgarian operator reads
                // English — `docs/i18n-airtight-roadmap.md` class B2. It is
                // avoidable here because a Notification row targets exactly
                // ONE user whose `uiLanguage` we have just read: unlike a
                // digest fanned to several recipients, the language IS
                // knowable at the point of authoring.
                const title = await translateFor(loc, 'notificationInApp.exchangeMessage.title');
                const message = await translateFor(loc, 'notificationInApp.exchangeMessage.body', {
                    commodity: thread.listing.commodity,
                });
                const linkUrl = `/t/${slug}/exchange/threads/${thread.id}`;

                const row = await db.notification.create({
                    data: {
                        tenantId: recipientTenantId,
                        userId,
                        type: 'EXCHANGE_MESSAGE',
                        title,
                        message,
                        linkUrl,
                        // Left NULL on purpose — see the comment above and the
                        // `dedupeKey` docblock on the model.
                    },
                    select: { id: true, createdAt: true },
                });

                // Persist, then publish. A subscriber that receives an event
                // for a row that is not yet committed would render a
                // notification the next poll cannot find.
                publishNotificationEvent(recipientTenantId, userId, {
                    id: row.id,
                    type: 'EXCHANGE_MESSAGE',
                    title,
                    message,
                    read: false,
                    linkUrl,
                    createdAt: row.createdAt.toISOString(),
                });
            }

            for (const [toEmail, { locale, slug }] of byEmail) {
                await enqueueEmail(db, {
                    tenantId: recipientTenantId,
                    type: 'EXCHANGE_MESSAGE',
                    toEmail,
                    // Required, so there is no "unset" to pass through. A
                    // recipient with no uiLanguage gets the product's own
                    // fallback rather than the sender's language — the reader
                    // is a different person, which is the whole point of
                    // reading uiLanguage in the first place.
                    locale: isLocale(locale) ? locale : RECIPIENT_FALLBACK_LOCALE,
                    // THE THREAD, deliberately — see the docblock.
                    entityId: thread.id,
                    payload: { commodity: thread.listing.commodity, tenantSlug: slug, threadId: thread.id },
                });
            }
        });
    } catch (err) {
        logger.warn('exchange.message_notify_failed', {
            component: 'exchange-messaging',
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Close a conversation. EITHER party may.
 *
 * Symmetric on purpose: a listing seller who could close unilaterally, with no
 * way back, could silence a buyer mid-negotiation. Sending a message reopens
 * the thread (`sendExchangeMessage`), so this is a soft "I'm done here" that
 * tidies the inbox rather than a lock — which is why it needs no permission
 * beyond being a party, and why there is no separate reopen endpoint.
 *
 * Idempotent: closing an already-closed thread keeps the ORIGINAL timestamp,
 * so "when did this end" does not drift every time someone taps it again.
 */
export async function closeExchangeThread(ctx: RequestContext, threadId: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { thread } = await requireParty(db, ctx, threadId);
        if (thread.closedAt) return { closedAt: thread.closedAt, alreadyClosed: true };

        const now = new Date();
        await db.exchangeThread.update({
            where: { id: threadId },
            data: { closedAt: now },
        });
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ExchangeThread',
            entityId: threadId,
            details: `Conversation closed on thread ${threadId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ExchangeThread',
                operation: 'updated',
                after: { closedAt: now.toISOString() },
                summary: 'Exchange conversation closed',
            },
        });
        return { closedAt: now, alreadyClosed: false };
    });
}

/** Post a message. Sanitised on write; bumps the thread for inbox ordering. */
export async function sendExchangeMessage(
    ctx: RequestContext,
    threadId: string,
    body: string,
    idempotencyKey?: string | null,
): Promise<{ id: string; createdAt: Date; reopened: boolean; replayed: boolean }> {
    try {
        return await sendExchangeMessageImpl(ctx, threadId, body, idempotencyKey);
    } catch (err) {
        // Race backstop: two retries of the same send both clear the replay
        // check above, then one loses the unique index. The loser re-reads the
        // winner rather than surfacing a 500 for a message that WAS delivered.
        if (idempotencyKey && isUniqueViolation(err)) {
            const prior = await runInTenantContext(ctx, (db) =>
                db.exchangeMessage.findFirst({
                    where: { senderTenantId: ctx.tenantId, clientMutationId: idempotencyKey },
                    select: { id: true, createdAt: true },
                }),
            );
            if (prior) {
                return { id: prior.id, createdAt: prior.createdAt, reopened: false, replayed: true };
            }
        }
        throw err;
    }
}

async function sendExchangeMessageImpl(
    ctx: RequestContext,
    threadId: string,
    body: string,
    idempotencyKey?: string | null,
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
        // Replay check FIRST — before the party, block and closed checks. A
        // retry of a message that was already accepted must return the
        // original result even if the seller has since blocked the sender;
        // otherwise a flaky link turns "your message was delivered" into a
        // 403 for a message that IS in the thread.
        if (idempotencyKey) {
            const prior = await db.exchangeMessage.findFirst({
                where: { senderTenantId: ctx.tenantId, clientMutationId: idempotencyKey },
                select: { id: true, createdAt: true },
            });
            if (prior) {
                return { id: prior.id, createdAt: prior.createdAt, reopened: false, replayed: true };
            }
        }

        const { thread, role } = await requireParty(db, ctx, threadId);
        // Only the BLOCKED side is refused. The seller who pressed block can
        // still write in the thread — the control is "stop them reaching me",
        // not "freeze the record" — and a symmetric refusal would let a seller
        // lock themselves out of their own conversation.
        if (role === 'inquirer'
            && await isBlocked(db, thread.listing.sellerTenantId, ctx.tenantId)) {
            throw codedForbidden('THREAD_BLOCKED', 'That seller is not accepting messages from you.');
        }
        // A closed thread does NOT refuse the message — sending REOPENS it.
        //
        // Closing is a soft "I'm done here" that clears the thread from the
        // active inbox, not a door that locks. Either party may close, so a
        // refusal would let one side mute the other permanently, which is the
        // one outcome a two-party negotiation channel must not allow. Reopening
        // on send also means there is no separate reopen action to find.
        const reopening = thread.closedAt !== null;

        const now = new Date();
        const row = await db.exchangeMessage.create({
            data: {
                threadId,
                senderTenantId: ctx.tenantId,
                senderUserId: ctx.userId,
                body: text,
                createdAt: now,
                clientMutationId: idempotencyKey ?? null,
            },
            select: { id: true, createdAt: true },
        });
        // Denormalised for inbox ordering. Same transaction as the insert, so
        // a thread can never sort by a message that does not exist.
        await db.exchangeThread.update({
            where: { id: threadId },
            // `closedAt: null` unconditionally rather than only when
            // `reopening` — one write either way, and a conditional spread
            // would leave a window where a close landing between the read and
            // this update survives a message that came after it.
            //
            // The SENDER's own read pointer moves too. The inbox computes
            // `hasUnread` as `lastMessageAt > readAt` and does not look at who
            // sent the last message, so without this your own message bumps
            // `lastMessageAt` past your own pointer and your own thread reports
            // unread. (The per-thread `unreadCount` was already right — it
            // filters on `senderTenantId !== ctx.tenantId` — which is why the
            // two disagreed and only the cheap one was wrong.)
            //
            // Monotonic, like `markExchangeThreadRead`: `now` is never behind
            // the stored pointer. It does mean replying without opening marks
            // the other party's earlier messages read — defensible, because you
            // cannot reply to a conversation you have not looked at, and the
            // exact count lives on the thread endpoint either way.
            data: {
                lastMessageAt: now,
                closedAt: null,
                ...(role === 'seller'
                    ? { sellerLastReadAt: now }
                    : { inquirerLastReadAt: now }),
            },
        });
        // Persist, THEN notify. Never the reverse: a notification for a write
        // that then failed tells the other party to come and read something
        // that does not exist.
        await notifyOtherParty(ctx.tenantId, thread);
        // `replayed` is explicit rather than inferable. A replay that looks
        // identical to a create is a shape a client cannot branch on, and the
        // iOS session asked for exactly this distinction to be named.
        return { id: row.id, createdAt: row.createdAt, reopened: reopening, replayed: false };
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
export async function listExchangeThreads(
    ctx: RequestContext,
    options: { limit?: number; cursor?: string | null } = {},
) {
    assertCanRead(ctx);
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), DEFAULT_PAGE_SIZE);
    const cursor = decodeCursor(options.cursor);
    return runInTenantContext(ctx, async (db) => {
        // RLS restricts this to threads the caller is a party to, from either
        // side — which is why there is no tenant filter here to write wrongly.
        const rows = await db.exchangeThread.findMany({
            where: cursor ? keysetBefore(cursor, 'lastMessageAt') : undefined,
            // `id` is the tiebreak, and it is not decoration: ordering on
            // `lastMessageAt` alone is not a total order, so two threads
            // sharing a timestamp straddle the page boundary and one is
            // dropped while the other repeats.
            orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
            // One more than asked, to learn whether another page exists
            // without a second COUNT query.
            take: limit + 1,
            select: {
                id: true, listingId: true, inquirerTenantId: true,
                lastMessageAt: true, closedAt: true,
                sellerLastReadAt: true, inquirerLastReadAt: true,
                listing: { select: { sellerTenantId: true, commodity: true } },
            },
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page.at(-1);

        const threads = page.map((t) => {
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

        return {
            threads,
            // Null means "this is the end", and it is computed from the extra
            // row rather than from `page.length < limit` — a full final page
            // would otherwise advertise a next page that returns nothing.
            nextCursor: hasMore && last ? encodeCursor({ at: last.lastMessageAt, id: last.id }) : null,
        };
    });
}
