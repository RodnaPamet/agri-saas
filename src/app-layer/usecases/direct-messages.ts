/**
 * Direct messages between people — P8.2 (#2796).
 *
 * The tables, their policies and their encryption classification are P8.1
 * (#2795). This is the code that writes them.
 *
 * ## Person-scoped, which decides the runner and therefore the routes
 *
 * A direct conversation is between PEOPLE who may share no farm, so these
 * tables carry no `tenantId` and every policy keys on `app.user_id` — the
 * variable `runInUserContext` sets. `runInTenantContext` sets
 * `app.actor_user_id` and deliberately not `app.user_id`, so a tenant route
 * would read ZERO rows with no error, which is indistinguishable from an empty
 * inbox. That is #1664, and it is why these routes live under
 * `/api/social/` and authenticate with `getUserCtx`.
 *
 * ## Two execution paths, and which one a function takes is not a style choice
 *
 * **User context** wherever the database can be the authority:
 * `editDirectMessage`, `deleteDirectMessage`, `markConversationRead`, the
 * reactions and every read. `person-blocks.ts` states the principle — the
 * policy's `USING`/`WITH CHECK` is the control, and a redundant application
 * check "would look like the control and would be the thing a future refactor
 * simplifies away, leaving the impression that the guard was there".
 *
 * **Privileged** for the three writes that cannot be: opening a conversation
 * writes the OTHER person's participant row, responding to a request writes
 * `Conversation.state` (which has no `app_user` UPDATE arm, deliberately — one
 * would let a participant accept their own request), and SENDING must stamp
 * `Conversation.lastMessageAt` atomically with the message.
 *
 * ### Why sending is privileged, written down because the alternative looks better
 *
 * `direct_message_insert`'s `WITH CHECK` already encodes the whole rule, so
 * inserting under user context and stamping afterwards is the obvious design.
 * It does not work: the stamp is an UPDATE on `Conversation`, which has no
 * `app_user` arm, and a privileged write INSIDE an open `runInUserContext`
 * transaction takes a second pool connection while holding one — #1191's P0.8
 * deadlock at `PG_POOL_MAX`.
 *
 * A `SECURITY DEFINER` trigger on `DirectMessage` was the next candidate and
 * was measured rather than reasoned about. It WORKS — and only because the
 * definer is a superuser: `superuser_bypass` reads
 * `current_setting('role') != 'app_user'`, and the `role` GUC does NOT change
 * inside a `SECURITY DEFINER` function (measured: `current_user=test`, role
 * GUC still `app_user`), so the write crosses RLS purely on the definer's
 * `rolsuper`/`rolbypassrls`. In the test database `test` is `super=true
 * bypassrls=true`; in production the app's role is too. So the mechanism
 * depends on the application running as a superuser, and it would break
 * SILENTLY the day somebody hardens that — leaving a stranger able to send
 * without limit. An explicit privileged client is the same power named out
 * loud.
 *
 * So the `WITH CHECK` is a BACKSTOP here rather than the live control, and
 * that is what P8's phase note asks for in any case: "enforced in the usecase
 * AND in `WITH CHECK`". The usecase half is below; the database half protects
 * any future caller that is not this file, and is exercised by
 * `tests/integration/p8-1-direct-message-rls.test.ts`.
 *
 * ## A non-participant gets the SAME not-found a missing conversation gets
 *
 * P8's note: "Non-participants get 404, not 403." A 403 confirms the
 * conversation exists. The same applies to a BLOCK: a blocked caller must not
 * be able to tell a block from a conversation that is not there, which is the
 * silence P5.2b's owner ruling requires and which
 * `tests/unit/person-block-is-silent.test.ts` asserts as a COMPARISON rather
 * than as "it was refused".
 *
 * ## Blocks are enforced HERE because SQL cannot
 *
 * `conversation_participant_select` admits the caller's own row only — forced,
 * because a policy admitting "every participant of a conversation I am in"
 * must ask that table whether I am in it, which Postgres refuses as infinite
 * recursion. So SQL cannot name the counterparty, so a `WITH CHECK` asking
 * "has the counterparty blocked me" would return only the caller and be
 * VACUOUSLY true. The migration says so; this file is the other half.
 *
 * `personBlockExists` and `amIBlockedByAnyOf` come from `person-blocks.ts`,
 * MOVED there by this PR rather than copied. Two spellings of one policy is
 * how the two answers diverge, and #1664 is that bill already paid.
 */
import type { UserContext } from '@/app-layer/types';
import { runInUserContext, type PrismaTx } from '@/lib/db-context';
import { encodeCursor, decodeCursor, keysetBefore } from '@/lib/exchange/cursor';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import prisma from '@/lib/prisma';
import { getStorageProvider } from '@/lib/storage';
import { codedBadRequest, codedNotFound } from '@/lib/errors/types';
import { publishPersonEvent } from '@/lib/notifications/notification-bus';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';

import { personBlockExists, amIBlockedByAnyOf } from './person-blocks';
import { fetchLinkCard } from './direct-message-link-cards';

/**
 * The same bound `ExchangeMessage` uses. Not a new number: a farmer writing to
 * a farm has no reason to need more room than one writing about a listing, and
 * two different caps would be a difference nobody chose.
 */
export const DM_MAX_BODY_LENGTH = 4000;

/** What a reaction may be. Short enough that no prose fits — see the schema. */
export const DM_MAX_EMOJI_LENGTH = 16;

/**
 * Messages per page of a conversation — #2820.
 *
 * The same 100 `getExchangeThread` uses. Not a new number: a DM timeline and
 * an exchange thread are the same screen with different participants, and two
 * page sizes would be a difference nobody chose.
 */
export const DM_MESSAGE_PAGE_SIZE = 100;

/**
 * What a message CARRIES, beside its text.
 *
 * Sub-objects rather than loose columns, so "is there a photo" is ONE null
 * check instead of four fields that can disagree — a row with a mime and no
 * key is not a state any client should have to reason about.
 *
 * `attachmentKey` is deliberately NOT in the payload. The egress route is
 * `/api/social/messages/{messageId}/photo`, which a client derives from the
 * message id it already has, so the locator buys nobody anything — and the
 * route authorises by RLS participation rather than by possession of the key,
 * which is exactly why it does not need to travel.
 */
export interface MessageAttachmentView {
    readonly mime: string | null;
    readonly bytes: number | null;
    readonly sha256: string | null;
}

/** The stored card. A SNAPSHOT: `fetchedAt` null means the fetch was refused. */
export interface MessageLinkCardView {
    readonly url: string;
    readonly title: string | null;
    readonly description: string | null;
    readonly fetchedAt: Date | null;
}

export interface DirectMessageView {
    readonly id: string;
    readonly senderUserId: string;
    readonly body: string | null;
    readonly createdAt: Date;
    readonly editedAt: Date | null;
    readonly deletedAt: Date | null;
    readonly reactions: readonly { readonly userId: string; readonly emoji: string }[];
    /**
     * The photograph, or null.
     *
     * ADDED HERE ALONGSIDE `linkCard` because the two are the same omission.
     * P8.6's photo half (#2852) shipped `sendDirectPhoto` and
     * `readDirectPhoto` and never put the attachment columns in THIS select,
     * so a client fetching a conversation saw a photo message as `body: null`
     * with nothing saying a photograph existed — sendable, fetchable by a
     * client that already knew, and invisible to one reading the timeline.
     * Adding `linkCard` without it would have shipped a payload that describes
     * link cards and not photographs, which reads as a decision.
     */
    readonly attachment: MessageAttachmentView | null;
    readonly linkCard: MessageLinkCardView | null;
}

export interface ConversationView {
    readonly id: string;
    readonly state: 'REQUEST' | 'ACCEPTED' | 'DECLINED';
    readonly initiatedByUserId: string;
    readonly lastMessageAt: Date | null;
    readonly lastReadAt: Date | null;
    /**
     * ONE PAGE, oldest-first for display — #2820.
     *
     * The first draft of this function had no `take` at all, so a long
     * conversation was one unbounded query AND one decrypt per row, since
     * `body` is in `ENCRYPTED_FIELDS`. CI was green because D2's unbounded-read
     * budget scans `src/app-layer/repositories` only and this is a usecase —
     * a real gate whose population my code sat one directory outside.
     */
    readonly messages: readonly DirectMessageView[];
    /**
     * Pass back as `before` to fetch the page OLDER than this one, or null at
     * the start of the conversation. A chat opens at the bottom and reads
     * backwards, which is why there is no "next".
     */
    readonly olderCursor: string | null;
    readonly hasOlder: boolean;
}

/** The one not-found every refusal in this module collapses to. */
function notThere(): never {
    throw codedNotFound('CONVERSATION_NOT_FOUND', 'Not found.');
}

function messageNotThere(): never {
    throw codedNotFound('MESSAGE_NOT_FOUND', 'Not found.');
}

/**
 * The body a message may carry.
 *
 * `sanitizePlainText` TRIMS since #1825, so a whitespace-only message is
 * refused rather than stored — the repo's standard blank check. Sanitising
 * happens HERE, at the usecase, and not at a renderer, because the stored row
 * is read back by the counterparty, by a P5.2 report snapshot if somebody
 * reports it, and by the Art 15 export: three readers, which is the C.5
 * argument in full.
 */
function cleanBody(raw: string): string {
    const body = sanitizePlainText(raw);
    if (!body) throw codedBadRequest('DM_BODY_REQUIRED', 'A message cannot be empty.');
    if (body.length > DM_MAX_BODY_LENGTH) {
        throw codedBadRequest('DM_BODY_TOO_LONG', 'That message is too long.');
    }
    return body;
}

/**
 * A farm handle to the PERSON who should receive the message.
 *
 * Owner ruling 2026-11-06: the farm's ACTIVE OWNER. Measured on production the
 * same day — 4 farms have an active owner and NONE has more than one — so the
 * tie-break below is for a shape the schema permits rather than one the data
 * shows: `admin.owner_management` can add a second OWNER, and then "the owner"
 * stops being a single person.
 *
 * The tie-break is the OLDEST membership, which is deterministic and is the
 * nearest thing to "the farm's principal". It is not a judgement about who
 * should answer — `collapse-to-one-needs-a-total-order` is the reason it is
 * `createdAt` then `id` rather than `createdAt` alone: two memberships created
 * in the same millisecond would otherwise tie and the winner would depend on
 * the plan.
 *
 * ## The ORDER of the three reads is what bounds the bypass
 *
 * See `dm-recipient-resolution` in `rls-middleware.ts`. The published profile
 * is asked FIRST, so an unpublished farm is never resolved to a tenant at all
 * — reversing steps 1 and 2 would make this a handle→tenant oracle for farms
 * that never chose to be public, which is the coupling P6 kept `tenantId` off
 * the projection to avoid. Only a `userId` is returned.
 */
export async function resolveHandleRecipient(handle: string): Promise<string | null> {
    const normalised = handle.trim().toLowerCase();
    if (!normalised) return null;

    return runWithoutRls({ reason: 'dm-recipient-resolution' }, async (db) => {
        // 1. The farm's own decision to be publicly reachable.
        const published = await db.publicFarmProfile.findUnique({
            where: { handle: normalised },
            select: { handle: true },
        });
        if (!published) return null;

        // 2. Only now, the tenant behind that handle.
        const brand = await db.farmBrand.findUnique({
            where: { handle: normalised },
            select: { tenantId: true },
        });
        if (!brand) return null;

        // 3. Only now, that tenant's principal — a userId and nothing else.
        const owner = await db.tenantMembership.findFirst({
            where: { tenantId: brand.tenantId, role: 'OWNER', status: 'ACTIVE' },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { userId: true },
        });
        return owner?.userId ?? null;
    });
}

/**
 * Open a conversation with the person behind a farm handle, or return the one
 * that already exists.
 *
 * Idempotent on purpose: pressing «Съобщение» twice is one conversation. The
 * existing-conversation lookup is what makes a REQUEST unrepeatable — a
 * stranger cannot escape the one-message rule by opening a second thread,
 * because there is no second thread to open.
 */
export async function openConversationFromHandle(
    ctx: UserContext,
    handle: string,
): Promise<{ conversationId: string; state: 'REQUEST' | 'ACCEPTED' | 'DECLINED' }> {
    const recipientUserId = await resolveHandleRecipient(handle);
    // A handle that resolves to nobody and a handle that does not exist are
    // the same answer. Telling them apart would say whether a farm has an
    // active owner, which is nobody's business from outside.
    if (!recipientUserId) notThere();
    if (recipientUserId === ctx.userId) {
        throw codedBadRequest('DM_SELF', 'You cannot message yourself.');
    }

    // The block check runs BEFORE anything is written, and its refusal is the
    // same not-found a missing handle gets.
    const blocked = await runInUserContext(ctx, (db) =>
        personBlockExists(db, { aUserId: ctx.userId, bUserId: recipientUserId }),
    );
    if (blocked) notThere();

    return prisma.$transaction(async (tx) => {
        const existing = await tx.conversationParticipant.findFirst({
            where: {
                userId: ctx.userId,
                conversation: { participants: { some: { userId: recipientUserId } } },
            },
            select: { conversation: { select: { id: true, state: true } } },
        });
        if (existing) {
            return {
                conversationId: existing.conversation.id,
                state: existing.conversation.state,
            };
        }

        const conversation = await tx.conversation.create({
            data: {
                state: 'REQUEST',
                initiatedByUserId: ctx.userId,
                participants: {
                    create: [{ userId: ctx.userId }, { userId: recipientUserId }],
                },
            },
            select: { id: true, state: true },
        });
        logger.info('dm.conversation_opened', {
            component: 'direct-messages',
            conversationId: conversation.id,
        });
        return { conversationId: conversation.id, state: conversation.state };
    });
}

/**
 * Send a message.
 *
 * Privileged, for the reason in the header, so every check the `WITH CHECK`
 * would have made is made here — participation, the request allowance, and the
 * block SQL cannot see — inside one transaction with the `lastMessageAt` stamp
 * the request rule reads.
 *
 * `idempotencyKey` is scoped to the sender by `@@unique([senderUserId,
 * idempotencyKey])`, so a replayed send is one message. A replay returns the
 * EXISTING message rather than an error: the client cannot tell its first
 * attempt from its second, and `outboxHeaders()` exists precisely so the two
 * carry the same key.
 */
export async function sendDirectMessage(
    ctx: UserContext,
    input: {
        conversationId: string;
        body: string;
        idempotencyKey?: string;
        /**
         * Optional link card. Fetched through the per-hop host policy and
         * stored as a SNAPSHOT — see `direct-message-link-cards.ts`.
         */
        linkUrl?: string;
    },
): Promise<{ messageId: string; createdAt: Date; deduplicated: boolean }> {
    const body = cleanBody(input.body);

    if (input.idempotencyKey) {
        const replay = await prisma.directMessage.findUnique({
            where: {
                senderUserId_idempotencyKey: {
                    senderUserId: ctx.userId,
                    idempotencyKey: input.idempotencyKey,
                },
            },
            select: { id: true, createdAt: true, conversationId: true },
        });
        if (replay) {
            // Scoped to the conversation the caller named, so a key reused
            // across two conversations is a bad request rather than a silent
            // cross-post.
            if (replay.conversationId !== input.conversationId) {
                throw codedBadRequest(
                    'DM_IDEMPOTENCY_KEY_REUSED',
                    'That idempotency key belongs to a different conversation.',
                );
            }
            return { messageId: replay.id, createdAt: replay.createdAt, deduplicated: true };
        }
    }

    // Fetched BEFORE the transaction, and that is not a style choice. An
    // external fetch inside an open transaction holds a pool connection for
    // the duration of a third party's response time — #1191's P0.8 deadlock
    // is what happens when a transaction wants a resource it cannot get, and
    // `PG_POOL_MAX` is 12. A 3-second third-party timeout × 12 concurrent
    // sends would wedge the pool.
    //
    // Best-effort by construction: `fetchLinkCard` returns a card with nothing
    // in it rather than throwing, for every failure except a URL that is not
    // `https:` — which is a bad request and should be one.
    const card = input.linkUrl ? await fetchLinkCard(input.linkUrl) : null;
    // THE ONE sanitising pass over the card's text (#2874). `fetchLinkCard`
    // trims and caps and deliberately does not sanitise — two passes decode
    // an entity-encoded payload one step closer to markup rather than further
    // from it, and its docblock carries the measurement.
    //
    // Bound to consts so `sanitize-rich-text-coverage` sees the field by name
    // at its write path, which is the form that guard verifies rather than
    // trusts. `|| null` because "they sent only markup" and "there was no
    // title" are the same fact to every reader, and an empty string is a
    // third state nobody wants to handle.
    const linkTitle = card?.title == null ? null : (sanitizePlainText(card.title) || null);
    // ONE LINE, like its sibling: `sanitize-rich-text-coverage`'s
    // `const safe = sanitizePlainText(v)` form is matched per line, so the
    // wrapped version read as no binding at all and the guard said so.
    const linkDescription = card?.description == null ? null : (sanitizePlainText(card.description) || null);

    const sent = await prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.findUnique({
            where: { id: input.conversationId },
            select: {
                id: true,
                state: true,
                lastMessageAt: true,
                participants: { select: { userId: true } },
            },
        });
        // Participation is checked here because the privileged client sees
        // every row. Not a participant and not there are the same answer.
        if (!conversation) notThere();
        const members = conversation.participants.map((p) => p.userId);
        if (!members.includes(ctx.userId)) notThere();

        const others = members.filter((m) => m !== ctx.userId);
        if (await amIBlockedByAnyOf(tx as PrismaTx, ctx.userId, others)) notThere();
        for (const other of others) {
            if (await personBlockExists(tx as PrismaTx, { aUserId: ctx.userId, bUserId: other })) {
                notThere();
            }
        }

        // THE REQUEST RULE's usecase half. The database half is
        // `direct_message_insert`'s WITH CHECK, which reads the same column.
        if (conversation.state === 'DECLINED') notThere();
        if (conversation.state === 'REQUEST' && conversation.lastMessageAt !== null) {
            throw codedBadRequest(
                'DM_REQUEST_AWAITING_REPLY',
                'You can send one message until this request is accepted.',
            );
        }

        const message = await tx.directMessage.create({
            data: {
                conversationId: conversation.id,
                senderUserId: ctx.userId,
                body,
                ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                // The card's text is ALREADY sanitised — `fetchLinkCard` does
                // it, at the usecase layer, because the row is read by the
                // Art 15 export and by SDK consumers and not only by a
                // renderer (C.5). Encryption happens on the way to the column
                // and is a different problem (D.2).
                // SANITISED EXACTLY ONCE, at the boundary in `fetchLinkCard`,
                // and deliberately NOT again here (#2874).
                //
                // This used to sanitise a second time, under a comment saying
                // it cost nothing because `sanitizePlainText` is idempotent.
                // It is NOT. Each pass decodes one level of HTML entities
                // AFTER stripping tags, so a second pass walks an encoded
                // payload one step closer to markup — measured:
                //
                //   `&amp;lt;script&amp;gt;a&amp;lt;/script&amp;gt;`
                //      pass 1 → `&lt;script&gt;a&lt;/script&gt;`   (inert text)
                //      pass 2 → `<script>a</script>`               (STORED markup)
                //
                // One pass leaves the entity-encoded form, which every
                // consumer renders as text. Two passes store literal markup.
                // So the extra call did not add a protection, it removed one —
                // and this is the one caller whose input is chosen by a
                // hostile third party rather than typed by the operator.
                //
                // The underlying ordering defect is #2854. This change does
                // not depend on how that is resolved: a single pass is correct
                // either way.
                ...(card
                    ? {
                          linkUrl: card.url,
                          linkTitle,
                          linkDescription,
                          linkFetchedAt: card.fetchedAt,
                      }
                    : {}),
            },
            select: { id: true, createdAt: true },
        });

        // Atomic with the insert, which is the whole reason this path is
        // privileged. A stamp that lands outside the transaction leaves a
        // crash window in which a REQUEST admits a second message.
        await tx.conversation.update({
            where: { id: conversation.id },
            data: { lastMessageAt: message.createdAt },
        });

        return { messageId: message.id, createdAt: message.createdAt, deduplicated: false };
    });

    // ── live delivery to the OTHER party — #2809 ──
    //
    // AFTER the transaction resolves, and directly rather than through
    // `afterCommit`. That helper only defers when a `db-context` scope is
    // open, and this function uses a bare `prisma.$transaction`, which opens
    // none — so `afterCommit` here would fire `void runEffect(...)`
    // un-awaited, which is #1619 verbatim.
    //
    // Published to the RECIPIENTS, never to the sender: the sender already has
    // the message in the response. Addressed per PERSON because a direct
    // conversation has no tenant.
    //
    // The frame carries the CONVERSATION id and nothing else — a handle to
    // refetch under the client's own authorisation. Never the body: it is
    // encrypted at rest, and a channel carrying a farmer's prose would put it
    // through Redis and, via push, through APNs.
    //
    // Best-effort by construction, like every other publish on this bus: the
    // row is committed by the time this runs, a lost event degrades to the
    // client's REST refetch, and `publishPersonEvent` returns void so this
    // cannot become a new unhandled-rejection path.
    //
    // A DEDUPLICATED send publishes nothing, and the EARLY RETURN above is
    // what achieves that — not a check here. There is exactly one
    // `deduplicated: true` in this function and it returns before the
    // transaction, so `sent.deduplicated` is always false by this line.
    //
    // The first draft guarded on it anyway. `Selector teeth`'s equivalent for
    // behaviour — a mutation — showed the guard was dead: forcing it true
    // changed nothing, because the branch is unreachable. A condition that
    // cannot be false reads as a safeguard and is one more thing to keep
    // true.
    //
    // The TEST for it stays, because the property is worth pinning even
    // though this line no longer claims it: it fails if somebody moves this
    // publish above the early return, or adds a second dedup path inside the
    // transaction.
    for (const userId of await otherParticipantIds(input.conversationId, ctx.userId)) {
        publishPersonEvent(userId, { id: input.conversationId });
    }

    return sent;
}

/**
 * Everybody in the conversation except the caller.
 *
 * PRIVILEGED, and it has to be: `conversation_participant_select` admits the
 * caller's OWN row only — forced by P8.1's recursion rule, since a policy
 * admitting "every participant of a conversation I am in" must ask that table
 * whether I am in it. So a user-context read here returns exactly one row, the
 * caller's, and the counterparty would never be told anything.
 *
 * It returns IDS ONLY, which is what keeps that privilege narrow: nothing here
 * reads a message, a body or a profile.
 */
async function otherParticipantIds(conversationId: string, selfUserId: string): Promise<string[]> {
    const rows = await prisma.conversationParticipant.findMany({
        where: { conversationId, userId: { not: selfUserId }, leftAt: null },
        select: { userId: true },
        // A direct conversation has two participants. The bound is here
        // because an unbounded `findMany` is an unbounded `findMany` whatever
        // today's data says, and D2's budget scans repositories only — this is
        // a usecase, which is the gap #2820 was filed for.
        take: 10,
    });
    return rows.map((r) => r.userId);
}

/**
 * Accept or decline a request.
 *
 * Privileged, because `Conversation` has no `app_user` UPDATE arm and must not
 * get one: the arm would let the person who OPENED a request accept it
 * themselves.
 *
 * Only the other party may answer, and the refusal is the usual not-found.
 * A decision is final — a DECLINED conversation keeps its row precisely so the
 * same person cannot re-open the same request.
 */
export async function respondToConversation(
    ctx: UserContext,
    conversationId: string,
    decision: 'ACCEPT' | 'DECLINE',
): Promise<{ state: 'ACCEPTED' | 'DECLINED' }> {
    return prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.findUnique({
            where: { id: conversationId },
            select: {
                id: true,
                state: true,
                initiatedByUserId: true,
                participants: { select: { userId: true } },
            },
        });
        if (!conversation) notThere();
        const members = conversation.participants.map((p) => p.userId);
        if (!members.includes(ctx.userId)) notThere();
        // The opener cannot answer their own request.
        if (conversation.initiatedByUserId === ctx.userId) notThere();
        if (conversation.state !== 'REQUEST') {
            throw codedBadRequest(
                'DM_REQUEST_ALREADY_ANSWERED',
                'This request has already been answered.',
            );
        }

        const state = decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
        await tx.conversation.update({ where: { id: conversation.id }, data: { state } });
        return { state };
    });
}

/**
 * Read one conversation and its messages.
 *
 * User context, so RLS is the control: a non-participant's `SELECT` returns
 * nothing and the empty result becomes the not-found. The caller's own
 * participant row is the only one visible — see the model docblock on why that
 * narrowness is forced — so the counterparty is derived from the MESSAGES,
 * which is exactly how P5.2b derives it on an exchange thread.
 *
 * A soft-deleted message keeps its place with a null body. Removing it from
 * the list would renumber the conversation under the other party.
 */
export async function readConversation(
    ctx: UserContext,
    conversationId: string,
    options: { limit?: number; before?: string | null } = {},
): Promise<ConversationView> {
    return runInUserContext(ctx, async (db) => {
        const conversation = await db.conversation.findUnique({
            where: { id: conversationId },
            select: { id: true, state: true, initiatedByUserId: true, lastMessageAt: true },
        });
        if (!conversation) notThere();

        // The blocked party loses SIGHT of the conversation, one-directionally
        // — the blocker keeps their history. `amIBlockedByAnyOf` is the
        // visibility predicate for that reason.
        const senders = await db.directMessage.findMany({
            where: { conversationId },
            select: { senderUserId: true },
            distinct: ['senderUserId'],
        });
        const others = senders.map((s) => s.senderUserId).filter((s) => s !== ctx.userId);
        if (others.length > 0 && (await amIBlockedByAnyOf(db, ctx.userId, others))) notThere();

        const mine = await db.conversationParticipant.findFirst({
            where: { conversationId, userId: ctx.userId },
            select: { lastReadAt: true },
        });

        // `Number.isFinite`, not `??`: NaN is neither null nor undefined, and
        // `take: NaN` is a Prisma 500. The same choke point every paged read
        // in this layer carries.
        const requested = Number.isFinite(options.limit)
            ? (options.limit as number)
            : DM_MESSAGE_PAGE_SIZE;
        const limit = Math.min(Math.max(requested, 1), DM_MESSAGE_PAGE_SIZE);

        const before = options.before ?? null;
        const cursor = decodeCursor(before);
        if (before && !cursor) {
            // Refused rather than treated as "from the top". Silently
            // restarting a backwards scroll duplicates the page a client
            // already has, which reads as a render bug.
            throw codedBadRequest('INVALID_CURSOR', 'That cursor is not readable.');
        }

        // Fetched NEWEST-first, because a chat opens at the bottom and reads
        // backwards; reversed below so the page is in display order. `id` is
        // in the order and is not decoration — `createdAt` alone is not a
        // total order, so two messages sharing a timestamp straddle the page
        // boundary and one is dropped while the other repeats.
        const rows = await db.directMessage.findMany({
            where: {
                ...(cursor ? keysetBefore(cursor, 'createdAt') : {}),
                conversationId,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: {
                id: true,
                senderUserId: true,
                body: true,
                createdAt: true,
                editedAt: true,
                deletedAt: true,
                reactions: { select: { userId: true, emoji: true } },
                // `attachmentKey` is read only to decide PRESENCE; it is not
                // returned. See `MessageAttachmentView`.
                attachmentKey: true,
                attachmentMime: true,
                attachmentBytes: true,
                attachmentSha256: true,
                linkUrl: true,
                linkTitle: true,
                linkDescription: true,
                linkFetchedAt: true,
            },
        });

        const hasOlder = rows.length > limit;
        const pageNewestFirst = hasOlder ? rows.slice(0, limit) : rows;
        const oldestOnPage = pageNewestFirst.at(-1) ?? null;
        const messages = [...pageNewestFirst].reverse();

        return {
            id: conversation.id,
            state: conversation.state,
            initiatedByUserId: conversation.initiatedByUserId,
            lastMessageAt: conversation.lastMessageAt,
            lastReadAt: mine?.lastReadAt ?? null,
            olderCursor:
                hasOlder && oldestOnPage
                    ? encodeCursor({ at: oldestOnPage.createdAt, id: oldestOnPage.id })
                    : null,
            hasOlder,
            messages: messages.map((m) => ({
                id: m.id,
                senderUserId: m.senderUserId,
                body: m.deletedAt ? null : m.body,
                createdAt: m.createdAt,
                editedAt: m.editedAt,
                deletedAt: m.deletedAt,
                reactions: m.reactions,
                // `deletedAt` is checked here as well as in the delete, which
                // clears both sets of columns. Belt and braces in the cheap
                // direction: a row that somehow kept its card must not serve
                // it back, and the test for a retraction asserts the PAYLOAD
                // rather than the columns for that reason.
                attachment:
                    m.deletedAt || !m.attachmentKey
                        ? null
                        : {
                            mime: m.attachmentMime,
                            bytes: m.attachmentBytes,
                            sha256: m.attachmentSha256,
                        },
                linkCard:
                    m.deletedAt || !m.linkUrl
                        ? null
                        : {
                            url: m.linkUrl,
                            title: m.linkTitle,
                            description: m.linkDescription,
                            fetchedAt: m.linkFetchedAt,
                        },
            })),
        };
    });
}

/**
 * Edit your own message.
 *
 * User context: `direct_message_update`'s `USING` is
 * `senderUserId = app.user_id`, so somebody else's message updates ZERO rows
 * and returns normally — the silent shape. The count is therefore the answer,
 * and zero becomes the not-found.
 */
export async function editDirectMessage(
    ctx: UserContext,
    messageId: string,
    rawBody: string,
): Promise<void> {
    const body = cleanBody(rawBody);
    const count = await runInUserContext(ctx, async (db) => {
        const { count: n } = await db.directMessage.updateMany({
            // `deletedAt: null` so editing a deleted message is a not-found
            // rather than a resurrection with new text.
            where: { id: messageId, deletedAt: null },
            data: { body, editedAt: new Date() },
        });
        return n;
    });
    if (count === 0) messageNotThere();
}

/**
 * Delete your own message — SOFT, because the conversation is two people's
 * record and P5.3 needs a deleted message to say so (a deleted message is not
 * reportable, and its snapshot would be an empty body indistinguishable from a
 * capture failure).
 */
export async function deleteDirectMessage(ctx: UserContext, messageId: string): Promise<void> {
    // Read the key BEFORE the update clears it, so the object can be removed
    // afterwards. Under user context, so a non-participant reads nothing and
    // the update below then affects zero rows — the refusal stays the
    // database's.
    const existing = await runInUserContext(ctx, async (db) =>
        db.directMessage.findUnique({
            where: { id: messageId },
            select: { attachmentKey: true },
        }),
    );

    const count = await runInUserContext(ctx, async (db) => {
        const { count: n } = await db.directMessage.updateMany({
            where: { id: messageId, deletedAt: null },
            // `body: ''` destroys the plaintext while keeping the row. The
            // attachment columns go in the SAME statement, and P8.6's schema
            // stage shaped the CHECK (`deletedAt IS NOT NULL OR body IS NOT
            // NULL OR attachmentKey IS NOT NULL`) with its `deletedAt` arm
            // precisely so this clearing is PERMITTED: a retracted photo-only
            // message has nothing left, and without that arm the database
            // would refuse the update and the DELETION would fail rather than
            // the photograph stopping.
            data: {
                deletedAt: new Date(),
                body: '',
                attachmentKey: null,
                attachmentMime: null,
                attachmentBytes: null,
                attachmentSha256: null,
                // The link card goes with it. A retracted message keeping its
                // card would still show what was shared, which is the
                // disclosure the retraction is for — and the CHECK's
                // `deletedAt` arm is what permits a row with nothing left.
                linkUrl: null,
                linkTitle: null,
                linkDescription: null,
                linkFetchedAt: null,
            },
        });
        return n;
    });
    if (count === 0) messageNotThere();

    // The stored OBJECT is removed AFTER the row, and best-effort.
    //
    // Order matters: the row no longer resolves a key, and `readDirectPhoto`
    // only ever reaches an object through a row — so the photograph has
    // already stopped being servable. A failed object delete therefore leaves
    // unreachable garbage rather than a readable photo. Throwing here would
    // turn a successful retraction into an error the caller retries, and the
    // retry would find the message already deleted.
    if (existing?.attachmentKey) {
        try {
            await getStorageProvider().delete(existing.attachmentKey);
        } catch (err) {
            logger.warn('dm.photo_object_delete_failed', {
                component: 'direct-messages',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/**
 * Move your read cursor.
 *
 * Forward only. A cursor that could move BACKWARDS would let a client
 * un-read a conversation and re-trigger whatever P8.5's inbox counts, and
 * nothing needs it: «Нови съобщения» is computed from the cursor, so the
 * client that wants to re-show the divider re-renders rather than rewinding
 * the server.
 */
export async function markConversationRead(
    ctx: UserContext,
    conversationId: string,
    at: Date,
): Promise<void> {
    const count = await runInUserContext(ctx, async (db) => {
        const { count: n } = await db.conversationParticipant.updateMany({
            where: {
                conversationId,
                userId: ctx.userId,
                OR: [{ lastReadAt: null }, { lastReadAt: { lt: at } }],
            },
            data: { lastReadAt: at },
        });
        return n;
    });
    // Zero is not an error: the cursor was already at or past `at`. A 404 here
    // would make a client that double-tapped look broken.
    if (count === 0) {
        logger.debug('dm.read_cursor_not_moved', { component: 'direct-messages' });
    }
}

/**
 * Add a reaction. Idempotent — `@@unique([messageId, userId, emoji])` means
 * pressing the same one twice is one row.
 *
 * The emoji is NOT free text, and the cap is the enforcement. A reaction is
 * delivered by push, and `push-payload-carries-no-free-text` (#1999) exists
 * because a task assignment put a farmer's own prose into `aps.alert.body`,
 * which Apple reads.
 */
export async function addReaction(
    ctx: UserContext,
    messageId: string,
    emoji: string,
): Promise<void> {
    const value = sanitizePlainText(emoji);
    if (!value) throw codedBadRequest('DM_REACTION_REQUIRED', 'A reaction cannot be empty.');
    if (value.length > DM_MAX_EMOJI_LENGTH) {
        throw codedBadRequest('DM_REACTION_TOO_LONG', 'That is not a reaction.');
    }

    await runInUserContext(ctx, async (db) => {
        try {
            await db.messageReaction.create({
                data: { messageId, userId: ctx.userId, emoji: value },
            });
        } catch (err) {
            // A unique violation is the idempotent case. Anything else is the
            // policy refusing a message the caller cannot see, which is a
            // not-found.
            if ((err as { code?: string }).code === 'P2002') return;
            messageNotThere();
        }
    });
}

/** Remove your own reaction. Somebody else's removes zero rows — the silent shape. */
export async function removeReaction(
    ctx: UserContext,
    messageId: string,
    emoji: string,
): Promise<void> {
    const value = sanitizePlainText(emoji);
    if (!value) throw codedBadRequest('DM_REACTION_REQUIRED', 'A reaction cannot be empty.');
    const count = await runInUserContext(ctx, async (db) => {
        const { count: n } = await db.messageReaction.deleteMany({
            where: { messageId, userId: ctx.userId, emoji: value },
        });
        return n;
    });
    if (count === 0) messageNotThere();
}
