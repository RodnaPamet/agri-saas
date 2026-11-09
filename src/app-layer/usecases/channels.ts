/**
 * Channels — the core operations. P9.3a (#2937).
 *
 * The directory, joining and leaving, the feed, and posting with slow mode.
 * Threads, mentions, «Въпрос»/«Решено» and moderation are P9.3b–d.
 *
 * ## PERSON-SCOPED, which decides every query in this file
 *
 * Channel policies key on `app.user_id`, which ONLY `runInUserContext` sets.
 * `runInTenantContext` sets `app.actor_user_id` and deliberately not that one,
 * so a tenant-context read here returns ZERO ROWS WITH NO ERROR — #1664
 * verbatim, where `UserBlock`'s policy keyed on one variable while the
 * enforcement ran under the other and blocking silently stopped working.
 *
 * The one tenant-scoped piece in P9.2's rule — suggesting channels from a
 * farm's crops and oblast — therefore cannot live here. It is its own
 * tenant-route read, and it returns CANDIDATES and joins nobody.
 *
 * ## POSTING runs in USER context, and that is better than the DM arrangement
 *
 * P8.2 had to make sending a direct message PRIVILEGED, because the request
 * rule reads `Conversation.lastMessageAt` and the insert has to stamp it — a
 * user-context write could not, and a `SECURITY DEFINER` trigger turned out to
 * cross RLS for a reason nobody declared (the `role` GUC does not change
 * inside one, so the write rode the definer's `rolsuper`).
 *
 * A channel post has no such column. `channel_post_insert`'s WITH CHECK reads
 * `ChannelMembership`, a DIFFERENT table, so the insert runs as the caller and
 * **all three of P9.10's access rules are enforced by the DATABASE**:
 *
 *   * `authorUserId` = the session   → a forged author cannot post
 *   * a membership row exists        → a non-member cannot post
 *   * that row's `bannedAt` is NULL  → a banned member cannot post
 *
 * That is strictly stronger than enforcing them here, because the usecase is
 * the layer a refactor removes.
 *
 * ## JOINING is privileged, and the reason is `memberCount`
 *
 * `Channel.memberCount` is DENORMALISED because `channel_membership_select`
 * admits the caller's own row only (the recursion rule — a policy admitting
 * "every member of a channel I am in" must ask that table whether I am in it,
 * which Postgres refuses). So a member cannot count the others, and the
 * counter has to be maintained by whoever writes the membership.
 *
 * A user-context insert could write the row and not the counter, leaving it
 * wrong with nothing detecting it. So `ChannelMembership` has no `app_user`
 * INSERT arm and both writes happen in one privileged transaction.
 *
 * ## SLOW MODE is here and NOT in SQL, deliberately
 *
 * It compares a post against OTHER ROWS OF `ChannelPost`, which is the shape
 * that recurses inside a policy on that table. So it is a usecase check, and
 * it is a THROTTLE rather than a security control — two concurrent posts can
 * both pass it. That race is acceptable for a rate limit and would not be for
 * an access rule, which is why the access rules are in the WITH CHECK and this
 * is not.
 *
 * P5.5a's shape: a reduced BUDGET, never a cooldown that makes a legitimate
 * first session feel broken. Per CHANNEL rather than per account, because the
 * knob is the operator's — `Channel.slowModeSeconds`, a column so a channel
 * being flooded can be slowed without a deploy.
 */
import { prisma } from '@/lib/prisma';
import { runInUserContext } from '@/lib/db-context';
import { codedBadRequest, codedForbidden, codedNotFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { UserContext } from '@/app-layer/types';

/** Matches `DM_MAX_BODY_LENGTH`. A channel post is not an essay. */
export const CHANNEL_POST_MAX_LENGTH = 4000;

/**
 * How many people one post may mention — P9.3 (#2937).
 *
 * Enforced HERE and not in SQL: counting the mention rows already inserted for
 * a post is a query against the table the policy would be guarding, which is
 * the shape Postgres refuses. So `channel_post_mention_insert` bounds WHO may
 * write one (only a post's author) and this bounds HOW MANY.
 */
export const CHANNEL_MENTION_MAX = 5;

/** Feed page size, and the ceiling a caller may ask for. */
export const CHANNEL_FEED_PAGE_SIZE = 50;
export const CHANNEL_FEED_MAX_PAGE_SIZE = 100;

function cleanBody(raw: string): string {
    const body = sanitizePlainText(raw);
    if (!body) {
        throw codedBadRequest('CHANNEL_POST_REQUIRED', 'A post cannot be empty.');
    }
    if (body.length > CHANNEL_POST_MAX_LENGTH) {
        throw codedBadRequest('CHANNEL_POST_TOO_LONG', 'That post is too long.');
    }
    return body;
}

export interface ChannelListItem {
    readonly id: string;
    readonly key: string;
    readonly nameBg: string;
    readonly nameEn: string;
    readonly kind: string;
    readonly memberCount: number;
    readonly slowModeSeconds: number;
    /** Whether the CALLER is a member. Derived from their own row only. */
    readonly joined: boolean;
    /** Whether the caller is banned. Shown so a ban is not a silent refusal. */
    readonly banned: boolean;
}

/**
 * The channel directory.
 *
 * Readable by any authenticated caller including non-members, which is the
 * departure from a conversation: P9.2 cannot suggest a channel nobody can
 * read, and nobody joins one they cannot look into first. `channel_select`
 * admits on session presence for exactly this.
 *
 * `joined` and `banned` come from the caller's OWN membership row — the only
 * one `channel_membership_select` admits — so this is one query per caller and
 * not a per-channel loop (query-shape D1).
 */
export async function listChannels(ctx: UserContext): Promise<ChannelListItem[]> {
    return runInUserContext(ctx, async (tx) => {
        const [channels, mine] = await Promise.all([
            tx.channel.findMany({
                where: { archivedAt: null },
                orderBy: [{ memberCount: 'desc' }, { key: 'asc' }],
                take: 200,
                select: {
                    id: true, key: true, nameBg: true, nameEn: true,
                    kind: true, memberCount: true, slowModeSeconds: true,
                },
            }),
            // The caller's own rows. ONE query, then a map — not a lookup per
            // channel, which is the N+1 the D1 guardrail refuses.
            tx.channelMembership.findMany({
                select: { channelId: true, bannedAt: true },
            }),
        ]);
        const byChannel = new Map(mine.map((m) => [m.channelId, m]));
        return channels.map((c) => {
            const m = byChannel.get(c.id);
            return {
                ...c,
                kind: String(c.kind),
                joined: m !== undefined,
                banned: m?.bannedAt != null,
            };
        });
    });
}

/**
 * Join a channel.
 *
 * PRIVILEGED, because it maintains `Channel.memberCount` in the same
 * transaction as the membership row — see the header. Idempotent: joining
 * twice is not an error and does not double-count, which `@@unique([channelId,
 * userId])` makes checkable rather than hoped for.
 *
 * A BANNED member rejoining stays banned. The row survives a ban precisely so
 * that a rejoin cannot escape it, and this must not clear `bannedAt` — the
 * unban is a moderator's act (P9.3c), never a side effect of the banned person
 * pressing a button.
 */
export async function joinChannel(
    ctx: UserContext,
    channelId: string,
): Promise<{ joined: boolean; alreadyMember: boolean }> {
    return prisma.$transaction(async (tx) => {
        const channel = await tx.channel.findUnique({
            where: { id: channelId },
            select: { id: true, archivedAt: true },
        });
        if (!channel) {
            throw codedNotFound('CHANNEL_NOT_FOUND', 'That channel does not exist.');
        }
        if (channel.archivedAt) {
            throw codedBadRequest('CHANNEL_ARCHIVED', 'That channel is closed.');
        }

        const existing = await tx.channelMembership.findUnique({
            where: { channelId_userId: { channelId, userId: ctx.userId } },
            select: { id: true },
        });
        if (existing) return { joined: true, alreadyMember: true };

        await tx.channelMembership.create({
            data: { channelId, userId: ctx.userId },
        });
        // Atomic with the row above. An increment computed in JS would lose a
        // concurrent join; `increment` is one statement in the database.
        await tx.channel.update({
            where: { id: channelId },
            data: { memberCount: { increment: 1 } },
        });
        return { joined: true, alreadyMember: false };
    });
}

/**
 * Leave a channel. Privileged for `memberCount`'s sake, like joining.
 *
 * A banned member leaving DELETES their row, which does lift the ban — and
 * that is acceptable in a way clearing `bannedAt` would not be: they must then
 * rejoin, and `channel_post_insert` refuses a post from somebody with no
 * membership row at all. P9.3c's ban will need to decide whether a re-ban is
 * automatic; it is recorded here rather than assumed.
 */
export async function leaveChannel(ctx: UserContext, channelId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
        const membership = await tx.channelMembership.findUnique({
            where: { channelId_userId: { channelId, userId: ctx.userId } },
            select: { id: true },
        });
        // Idempotent: leaving something you are not in is not an error, and
        // reporting one would tell a caller whether somebody else's membership
        // exists if the id were ever guessable.
        if (!membership) return;

        await tx.channelMembership.delete({ where: { id: membership.id } });
        await tx.channel.update({
            where: { id: channelId },
            // `decrement` floors at nothing in SQL, so a counter that has
            // drifted below zero would go negative. Clamped on read instead of
            // guarded here, because a guard would need the count first and that
            // is the read this avoids.
            data: { memberCount: { decrement: 1 } },
        });
    });
}

export interface ChannelPostView {
    readonly id: string;
    readonly authorUserId: string;
    readonly body: string;
    readonly kind: string;
    readonly createdAt: Date;
    readonly deleted: boolean;
}

/**
 * A page of a channel's feed, newest first.
 *
 * Readable by a NON-MEMBER, like the directory. The keyset is
 * `(createdAt, id)`, matching the `[channelId, createdAt]` index.
 *
 * A removed, auto-hidden or author-deleted post comes back with an EMPTY body
 * and `deleted: true` rather than being omitted, so a reply above it does not
 * dangle — the DM precedent, where `deleteDirectMessage` writes `''` and keeps
 * the row.
 */
export async function readChannelFeed(
    ctx: UserContext,
    channelId: string,
    opts?: { limit?: number; before?: Date },
): Promise<{ posts: ChannelPostView[]; hasMore: boolean }> {
    const limit = Math.min(
        Math.max(opts?.limit ?? CHANNEL_FEED_PAGE_SIZE, 1),
        CHANNEL_FEED_MAX_PAGE_SIZE,
    );
    return runInUserContext(ctx, async (tx) => {
        const channel = await tx.channel.findUnique({
            where: { id: channelId },
            select: { id: true },
        });
        if (!channel) {
            throw codedNotFound('CHANNEL_NOT_FOUND', 'That channel does not exist.');
        }
        const rows = await tx.channelPost.findMany({
            where: {
                channelId,
                parentPostId: null,
                ...(opts?.before ? { createdAt: { lt: opts.before } } : {}),
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            // `limit + 1` is the hasMore probe. Nothing is filtered AFTER this
            // query for that reason — a post-filter would shrink the page and
            // make `hasMore` wrong, which P8.5 shipped once and corrected.
            take: limit + 1,
            select: {
                id: true, authorUserId: true, body: true, kind: true,
                createdAt: true, deletedAt: true,
                removedByModerationAt: true, autoHiddenAt: true,
            },
        });
        const hasMore = rows.length > limit;
        const posts = rows.slice(0, limit).map((r) => {
            const hidden =
                r.deletedAt != null
                || r.removedByModerationAt != null
                || r.autoHiddenAt != null;
            return {
                id: r.id,
                authorUserId: r.authorUserId,
                body: hidden ? '' : r.body,
                kind: String(r.kind),
                createdAt: r.createdAt,
                deleted: hidden,
            };
        });
        return { posts, hasMore };
    });
}

/**
 * Refuse a post that is inside the channel's slow-mode window.
 *
 * ONE definition, because P9.3b added a second caller: a reply IS a post, and
 * a throttle that applied to posting and not to replying would be worked
 * around by replying to anything. Two copies of this rule is how one of them
 * comes to differ.
 *
 * It CANNOT live in SQL — it compares against other rows of `ChannelPost`,
 * which is the shape a policy on that table may not query (P8.1's recursion
 * rule). So it is a usecase check, and therefore a THROTTLE rather than an
 * access control: two concurrent posts can both pass it. That race is fine for
 * a rate limit and would not be for an access rule, which is why the access
 * rules are in `channel_post_insert`'s WITH CHECK and this is not.
 */
async function assertNotSlowed(
    tx: Parameters<Parameters<typeof runInUserContext>[1]>[0],
    channelId: string,
    userId: string,
    slowModeSeconds: number,
): Promise<void> {
    if (slowModeSeconds <= 0) return;
    const since = new Date(Date.now() - slowModeSeconds * 1000);
    const recent = await tx.channelPost.findFirst({
        where: { channelId, authorUserId: userId, createdAt: { gt: since } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
    });
    if (!recent) return;

    const waitSeconds = Math.max(
        1,
        Math.ceil(
            (recent.createdAt.getTime() + slowModeSeconds * 1000 - Date.now()) / 1000,
        ),
    );
    // The wait is in the DETAILS rather than interpolated into the message:
    // the message is displayed copy, and a number built at the throw site
    // would be English prose on a Bulgarian screen —
    // `no-server-authored-user-copy`'s rule.
    throw codedBadRequest(
        'CHANNEL_SLOW_MODE',
        'That channel is in slow mode.',
        { waitSeconds, slowModeSeconds },
    );
}

/**
 * Post to a channel.
 *
 * Runs in USER context, so the three access rules are enforced by
 * `channel_post_insert`'s WITH CHECK rather than by this function — see the
 * header. What this function adds is slow mode, which cannot live in SQL.
 */
export async function postToChannel(
    ctx: UserContext,
    channelId: string,
    input: { body: string; mentionUserIds?: readonly string[] },
): Promise<{ postId: string; createdAt: Date; mentionsRecorded: number }> {
    const body = cleanBody(input.body);
    // OUTSIDE the transaction — see `resolveMentionable`. Inside it the
    // membership policy hides everybody but the caller.
    const recordable = await resolveMentionable(
        channelId, ctx.userId, input.mentionUserIds ?? [],
    );

    return runInUserContext(ctx, async (tx) => {
        const channel = await tx.channel.findUnique({
            where: { id: channelId },
            select: { id: true, archivedAt: true, slowModeSeconds: true },
        });
        if (!channel) {
            throw codedNotFound('CHANNEL_NOT_FOUND', 'That channel does not exist.');
        }
        if (channel.archivedAt) {
            throw codedBadRequest('CHANNEL_ARCHIVED', 'That channel is closed.');
        }

        // TWO LAYERS, both load-bearing — the tenant-isolation arrangement one
        // domain over.
        //
        // `channel_post_insert`'s WITH CHECK is the GUARANTEE: it refuses a
        // forged author, a non-member and a banned member in the database, so
        // the rules hold even if this function is refactored away. But a policy
        // refusal arrives as a Prisma error and would surface as a 500, which
        // tells a farmer nothing. So the membership is read FIRST and refused
        // with a code the client can act on.
        //
        // This check is therefore for the MESSAGE, not for the security. Remove
        // it and posting is still safe and still refused — just unreadably.
        // `tests/integration/p9-3a-channel-core.test.ts` asserts both layers,
        // and the RLS one by dropping the policy.
        const membership = await tx.channelMembership.findUnique({
            where: { channelId_userId: { channelId, userId: ctx.userId } },
            select: { bannedAt: true },
        });
        if (!membership) {
            throw codedForbidden(
                'CHANNEL_NOT_A_MEMBER',
                'Join the channel before posting in it.',
            );
        }
        if (membership.bannedAt != null) {
            throw codedForbidden(
                'CHANNEL_BANNED',
                'You can no longer post in that channel.',
            );
        }

        await assertNotSlowed(tx, channelId, ctx.userId, channel.slowModeSeconds);

        const post = await tx.channelPost.create({
            data: { channelId, authorUserId: ctx.userId, body },
            select: { id: true, createdAt: true },
        });
        // In the SAME transaction and the SAME session context. That is why
        // `channel_post_mention_insert` exists at all (P9.3b): the post is
        // inserted as the caller so the WITH CHECK enforces the access rules,
        // and mentions cannot then be written privileged without either
        // splitting the transaction or taking a second pool connection while
        // holding one — #1191's P0.8 deadlock.
        const mentionsRecorded = await recordMentions(tx, post.id, recordable);
        return { postId: post.id, createdAt: post.createdAt, mentionsRecorded };
    });
}

/**
 * Reply to a post — P9.3b (#2937), and optionally «Също изпрати в канала».
 *
 * ## «Също изпрати в канала» is TWO ROWS, not a flag
 *
 * The feed filters `parentPostId: null`, so one row cannot be both a reply and
 * a top-level post without that filter learning about a flag. Two rows keeps
 * the feed query as it is and makes the thread and the channel copy
 * independently moderatable — which matters, because a moderator removing the
 * channel copy should not silently remove the reply from its thread.
 *
 * Both rows are written in ONE transaction, so a copy cannot outlive a
 * rolled-back reply.
 *
 * ## Mentions are recorded on the REPLY only
 *
 * Recording them on both rows would push twice for one act. The reply is where
 * the mention was made; the copy exists for visibility.
 *
 * ## Threads are ONE level deep
 *
 * A reply to a reply is refused rather than nested. `parentPostId` pointing at
 * a row that itself has a parent would make the feed's "top-level only" filter
 * hide an arbitrarily deep tree, and the P8.3 timeline this will eventually
 * render flattens to a ROW LIST — there is no second indent to render into.
 */
export async function replyToPost(
    ctx: UserContext,
    parentPostId: string,
    input: {
        body: string;
        alsoToChannel?: boolean;
        mentionUserIds?: readonly string[];
    },
): Promise<{
    postId: string;
    channelCopyPostId: string | null;
    createdAt: Date;
    mentionsRecorded: number;
}> {
    const body = cleanBody(input.body);

    // The channel is derived from the parent, and the mention resolution has to
    // happen OUTSIDE the transaction (see `resolveMentionable`) — so the
    // parent's channel is read first, privileged. `ChannelPost` is readable by
    // any authenticated caller, so this discloses nothing a user-context read
    // would not; it is outside the transaction purely to avoid holding two
    // connections.
    const parentChannel = await prisma.channelPost.findUnique({
        where: { id: parentPostId },
        select: { channelId: true },
    });
    if (!parentChannel) {
        throw codedNotFound('CHANNEL_POST_NOT_FOUND', 'That post does not exist.');
    }
    const recordable = await resolveMentionable(
        parentChannel.channelId, ctx.userId, input.mentionUserIds ?? [],
    );

    return runInUserContext(ctx, async (tx) => {
        const parent = await tx.channelPost.findUnique({
            where: { id: parentPostId },
            select: { id: true, channelId: true, parentPostId: true, deletedAt: true },
        });
        if (!parent) {
            throw codedNotFound('CHANNEL_POST_NOT_FOUND', 'That post does not exist.');
        }
        if (parent.parentPostId != null) {
            throw codedBadRequest(
                'CHANNEL_THREAD_TOO_DEEP',
                'Reply to the original post rather than to a reply.',
            );
        }
        if (parent.deletedAt != null) {
            // A retracted post has nothing to reply to, and a reply under it
            // would render beneath «изтрито» with no context.
            throw codedBadRequest(
                'CHANNEL_POST_DELETED',
                'That post was removed, so it cannot be replied to.',
            );
        }

        const channel = await tx.channel.findUniqueOrThrow({
            where: { id: parent.channelId },
            select: { id: true, archivedAt: true, slowModeSeconds: true },
        });
        if (channel.archivedAt) {
            throw codedBadRequest('CHANNEL_ARCHIVED', 'That channel is closed.');
        }

        const membership = await tx.channelMembership.findUnique({
            where: { channelId_userId: { channelId: channel.id, userId: ctx.userId } },
            select: { bannedAt: true },
        });
        if (!membership) {
            throw codedForbidden(
                'CHANNEL_NOT_A_MEMBER',
                'Join the channel before posting in it.',
            );
        }
        if (membership.bannedAt != null) {
            throw codedForbidden(
                'CHANNEL_BANNED',
                'You can no longer post in that channel.',
            );
        }

        // A reply IS a post, so slow mode applies to it — otherwise the way
        // round a throttle is to reply to anything rather than post.
        await assertNotSlowed(tx, channel.id, ctx.userId, channel.slowModeSeconds);

        const reply = await tx.channelPost.create({
            data: {
                channelId: channel.id,
                authorUserId: ctx.userId,
                body,
                parentPostId: parent.id,
            },
            select: { id: true, createdAt: true },
        });

        const mentionsRecorded = await recordMentions(tx, reply.id, recordable);

        let channelCopyPostId: string | null = null;
        if (input.alsoToChannel) {
            const copy = await tx.channelPost.create({
                data: { channelId: channel.id, authorUserId: ctx.userId, body },
                select: { id: true },
            });
            channelCopyPostId = copy.id;
        }

        return {
            postId: reply.id,
            channelCopyPostId,
            createdAt: reply.createdAt,
            mentionsRecorded,
        };
    });
}

/**
 * Mark a «Въпрос» as «Решено» — P9.3b (#2937).
 *
 * THE ASKER ONLY. The reversible direction, and it matches how the exchange
 * treats a thread's owner: a moderator can already remove a post, and
 * resolving is not a moderation act.
 *
 * Enforced here rather than in SQL. `channel_post_update`'s WITH CHECK already
 * pins the author, so the author can write `resolvedAt` — but so could they
 * write it on a `POST` that is no question, and a CHECK naming an enum value
 * would need rewriting every time the enum grows.
 */
export async function setQuestionResolved(
    ctx: UserContext,
    postId: string,
    resolved: boolean,
): Promise<{ resolvedAt: Date | null }> {
    return runInUserContext(ctx, async (tx) => {
        const post = await tx.channelPost.findUnique({
            where: { id: postId },
            select: { id: true, kind: true, authorUserId: true },
        });
        if (!post) {
            throw codedNotFound('CHANNEL_POST_NOT_FOUND', 'That post does not exist.');
        }
        if (post.authorUserId !== ctx.userId) {
            // The same not-found a missing post gives would be wrong here: the
            // caller can SEE the post (the feed is public), so pretending it is
            // absent would contradict what they are looking at.
            throw codedForbidden(
                'CHANNEL_NOT_THE_ASKER',
                'Only the person who asked can mark a question answered.',
            );
        }
        if (post.kind !== 'QUESTION') {
            throw codedBadRequest(
                'CHANNEL_NOT_A_QUESTION',
                'Only a question can be marked answered.',
            );
        }

        const updated = await tx.channelPost.update({
            where: { id: postId },
            data: { resolvedAt: resolved ? new Date() : null },
            select: { resolvedAt: true },
        });
        return { resolvedAt: updated.resolvedAt };
    });
}

/**
 * Record who a post mentions — P9.3b (#2937).
 *
 * ## Mentions are EXPLICIT IDS, never parsed from the body
 *
 * Measured 2026-11-09: **there is no person handle in this product.**
 * `PersonProfile` carries `userId` and `displayName` and no handle, and the DM
 * surface's `resolveHandleRecipient` resolves a FARM handle to that farm's
 * active owner — not a person handle. So `@Иван` is display text with nothing
 * to resolve it against.
 *
 * Three reasons that is the better shape anyway, and the third is a trap this
 * repo has already paid for:
 *
 *   1. the CAP is enforceable — a cap over a parsed list is advisory;
 *   2. the PUSH target is unambiguous, and P9.3 pushes for mentions and
 *      replies and nothing else;
 *   3. **JavaScript's `\b` and `\w` are ASCII-ONLY**, so `/@\w+/` matches
 *      nothing in `@Иван`. A parser would have looked correct, passed its
 *      English fixtures, and mentioned nobody in Bulgarian — which is every
 *      real user. Recorded in this repo as a negated guard passing vacuously
 *      against `/\bимот/`.
 *
 * ## A mention must name a MEMBER, and a non-member is DROPPED not refused
 *
 * A channel is public, so anyone may post; five mentions per post across many
 * channels reaches a lot of people who never joined anything. Restricting the
 * addressable set to members bounds the reach rather than just the rate, and it
 * matches what the gesture means. A non-member can still READ the post.
 *
 * Dropped rather than refused so a stale picker does not fail the whole post —
 * the caller is told how many were recorded.
 */
/**
 * Which of the requested mentions may be RECORDED — resolved BEFORE the
 * transaction opens, and that placement is the whole point.
 *
 * ## Why this cannot happen inside the transaction
 *
 * `channel_membership_select` admits the caller's OWN ROW ONLY, forced by
 * P8.1's recursion rule. So inside `runInUserContext` an author cannot see
 * whether the person they are mentioning is a member — the read returns
 * nothing and every mention is silently dropped. I wrote exactly that first,
 * and `p9-3b-threads-mentions` reported `mentionsRecorded: 0` with no error,
 * which is the shape that constraint always produces.
 *
 * Reading it PRIVILEGED inside the transaction is the other trap: a second
 * pool connection taken while the first is held is #1191's P0.8 deadlock at
 * `PG_POOL_MAX`.
 *
 * So the resolution happens here, outside any transaction, on the global
 * client. The TOCTOU window — somebody leaving the channel between this check
 * and the insert — is harmless for a mention and is the price of not holding
 * two connections.
 */
async function resolveMentionable(
    channelId: string,
    authorUserId: string,
    mentionUserIds: readonly string[],
): Promise<string[]> {
    if (mentionUserIds.length === 0) return [];
    if (mentionUserIds.length > CHANNEL_MENTION_MAX) {
        throw codedBadRequest(
            'CHANNEL_TOO_MANY_MENTIONS',
            'A post may mention at most five people.',
            { max: CHANNEL_MENTION_MAX, given: mentionUserIds.length },
        );
    }

    // Deduplicated before the read, so a body naming somebody twice costs one
    // lookup and cannot push twice. `@@unique([postId, userId])` would refuse
    // the second row anyway; this keeps the COUNT honest.
    //
    // A SELF-mention is dropped rather than refused: a picker allows it, and
    // pushing somebody about their own post is the kind of detail nobody files
    // a bug for and everybody notices.
    const wanted = [...new Set(mentionUserIds)].filter((id) => id !== authorUserId);
    if (wanted.length === 0) return [];

    const members = await prisma.channelMembership.findMany({
        where: { channelId, userId: { in: wanted }, bannedAt: null },
        select: { userId: true },
    });

    // ONE query for every candidate, then a filter — not a lookup per mention,
    // which is the N+1 the D1 guardrail refuses.
    const memberIds = new Set(members.map((m) => m.userId));
    return wanted.filter((id) => memberIds.has(id));
}

/**
 * Write the mention rows, inside the caller's transaction.
 *
 * `channel_post_mention_insert` (P9.3b) bounds this to a post the caller
 * AUTHORED, which is what made a user-context write possible at all — P9.1
 * withheld the arm because a mention is a push trigger, and authorship plus an
 * unbanned membership is what answers that.
 */
async function recordMentions(
    tx: Parameters<Parameters<typeof runInUserContext>[1]>[0],
    postId: string,
    recordable: readonly string[],
): Promise<number> {
    if (recordable.length === 0) return 0;
    await tx.channelPostMention.createMany({
        data: recordable.map((userId) => ({ postId, userId })),
    });
    return recordable.length;
}
