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
 * Post to a channel.
 *
 * Runs in USER context, so the three access rules are enforced by
 * `channel_post_insert`'s WITH CHECK rather than by this function — see the
 * header. What this function adds is slow mode, which cannot live in SQL.
 */
export async function postToChannel(
    ctx: UserContext,
    channelId: string,
    input: { body: string },
): Promise<{ postId: string; createdAt: Date }> {
    const body = cleanBody(input.body);

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

        if (channel.slowModeSeconds > 0) {
            const since = new Date(Date.now() - channel.slowModeSeconds * 1000);
            const recent = await tx.channelPost.findFirst({
                where: {
                    channelId,
                    authorUserId: ctx.userId,
                    createdAt: { gt: since },
                },
                orderBy: { createdAt: 'desc' },
                select: { createdAt: true },
            });
            if (recent) {
                const waitSeconds = Math.max(
                    1,
                    Math.ceil(
                        (recent.createdAt.getTime()
                            + channel.slowModeSeconds * 1000
                            - Date.now()) / 1000,
                    ),
                );
                // The wait is in the DETAILS rather than the message, because
                // the message is displayed copy and a number interpolated at
                // the throw site would be English prose on a Bulgarian screen
                // — `no-server-authored-user-copy`'s rule.
                throw codedBadRequest(
                    'CHANNEL_SLOW_MODE',
                    'That channel is in slow mode.',
                    { waitSeconds, slowModeSeconds: channel.slowModeSeconds },
                );
            }
        }

        const post = await tx.channelPost.create({
            data: { channelId, authorUserId: ctx.userId, body },
            select: { id: true, createdAt: true },
        });
        return { postId: post.id, createdAt: post.createdAt };
    });
}
