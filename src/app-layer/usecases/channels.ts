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
import { runInUserContext, type PrismaTx } from '@/lib/db-context';
import { afterCommit } from '@/lib/db/after-commit';
import { codedBadRequest, codedForbidden, codedNotFound } from '@/lib/errors/types';
import { publishChannelActivityEvent } from '@/lib/notifications/notification-bus';
import { enqueue } from '@/app-layer/jobs/queue';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { translateFor } from '@/lib/i18n/server-messages';
import { logger } from '@/lib/observability/logger';
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
    /**
     * Top-level posts since the caller's read cursor — #2990.
     *
     * **NULL for a channel the caller has not joined**, never 0. A count for a
     * channel you are not in is meaningless, and 0 would read as "joined and
     * caught up" — the two states a badge most needs to tell apart.
     */
    readonly unreadCount: number | null;
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
        const unread = await unreadByChannel(tx, mine.length);
        return channels.map((c) => {
            const m = byChannel.get(c.id);
            return {
                ...c,
                kind: String(c.kind),
                joined: m !== undefined,
                banned: m?.bannedAt != null,
                // NULL, not 0, for a channel the caller has not joined — see
                // `ChannelListItem`.
                unreadCount: m === undefined ? null : (unread.get(c.id) ?? 0),
            };
        });
    });
}

/**
 * Unread top-level posts per JOINED channel, in ONE query — #2990.
 *
 * ## Why this is raw SQL, and why that is the smaller evil
 *
 * The threshold is PER ROW: each membership carries its own `lastReadAt`, so
 * there is no `groupBy` that expresses it — a grouped count can filter on one
 * `createdAt` boundary, not on a different one per channel. The alternatives
 * were a count per channel, which is the N+1 the D1 guardrail refuses, or
 * fetching every post newer than the EARLIEST cursor and counting in memory,
 * which is an unbounded read to answer a bounded question.
 *
 * So the database does it, joined against the caller's own membership rows.
 * P5.5b's anti-join is the precedent, and the thing that made it careful does
 * not apply here: it had to hand rows back to PRISMA because
 * `ContentReport.detail` is encrypted and raw SQL would have scored
 * ciphertext. `ChannelPost.body` is PLAINTEXT (P9.1, so P9.7 can search it)
 * and nothing here reads a body at all — this returns counts.
 *
 * ## RLS still applies, and it is what scopes the join
 *
 * Running inside `runInUserContext`, so `channel_membership_select` admits the
 * caller's OWN rows only — which is why the join needs no `userId` predicate
 * of its own and could not be widened by forgetting one. `app.user_id` is set
 * by that runner; a tenant context would set `app.actor_user_id` instead and
 * this would silently count zero (#1664).
 *
 * ## The four rules the count obeys
 *
 * **Top-level only.** `parentPostId IS NULL`, because the badge means "N new
 * posts in the feed you are about to open" and the feed filters exactly that.
 * Counting replies would badge activity opening the channel does not show —
 * and because the cursor is a TIME, the badge would then clear anyway, which
 * is a lie that covers its own tracks. A reply you should know about reaches
 * you through the mention/reply push instead (#2987): the badge is feed
 * activity, the notification is about you.
 *
 * **Not the caller's own posts.** Posting must not badge the channel you
 * posted in.
 *
 * **A never-read channel counts from `joinedAt`, not from the beginning.**
 * `COALESCE(m."lastReadAt", m."joinedAt")`. Reading NULL as "-infinity" hands
 * a brand-new member of a 2,000-post channel a badge of 2,000; you are not
 * unread on posts from before you joined. This gives `joinedAt` its first
 * reader. CLAUDE.md's P9.5 section called it "the one field nothing reads,
 * which is what made 'lossless' sound plausible" — corrected in this change,
 * because all three columns on the row are load-bearing now and leaving costs
 * the boundary the first unread count is measured from as well as the cursor.
 *
 * **A hidden post is not unread, it is gone.** The same three removal columns
 * `toPostView` collapses. Counting one produces a badge that reading can never
 * clear, because the post it counts will never appear in the feed.
 *
 * ## The count is deliberately blind to `body`
 *
 * It filters on the removal columns, the parent, the author and the time, and
 * on nothing about content. That is a decision rather than an omission, and
 * P9.6 is what makes it worth stating: a post whose content is a photograph or
 * a voice note has an EMPTY body and is perfectly good new activity, so an
 * `AND body <> ''` would silently stop badging exactly the posts a farmer is
 * most likely to care about.
 *
 * It also sidesteps the trap that filter would carry once `body` is nullable:
 * a comparison with NULL yields NULL rather than true, so `body <> ''` drops
 * NULL rows without saying so. The discriminator for "no text" against
 * "removed" is the pair (`body`, `deleted`) at the VIEW boundary, which is
 * `toPostView`'s business — not a count's.
 */
async function unreadByChannel(
    tx: PrismaTx,
    memberships: number,
): Promise<Map<string, number>> {
    // No memberships, no query. Not an optimisation: the SQL below would
    // return an empty set anyway, and skipping it keeps the directory read at
    // two queries for the common case of a person who has joined nothing.
    if (memberships === 0) return new Map();

    const rows = await tx.$queryRaw<{ channelId: string; unread: bigint }[]>`
        SELECT m."channelId" AS "channelId", COUNT(p.id) AS unread
        FROM "ChannelMembership" m
        JOIN "ChannelPost" p
          ON p."channelId" = m."channelId"
         AND p."parentPostId" IS NULL
         AND p."deletedAt" IS NULL
         AND p."removedByModerationAt" IS NULL
         AND p."autoHiddenAt" IS NULL
         AND p."authorUserId" <> m."userId"
         AND p."createdAt" > COALESCE(m."lastReadAt", m."joinedAt")
        GROUP BY m."channelId"
    `;
    // `COUNT` comes back as a bigint and JSON cannot carry one — an unconverted
    // value serialises as `TypeError: Do not know how to serialize a BigInt`,
    // which surfaces as a 500 on a directory read rather than as a bad count.
    return new Map(rows.map((r) => [r.channelId, Number(r.unread)]));
}

/**
 * Move the caller's read cursor on their own membership row — #2990.
 *
 * ## The cursor only moves FORWARD, and that is the whole guard
 *
 * `lastReadAt: { lt: at }` in the `where`, which is `markReadFor`'s precedent
 * in `exchange-messaging.ts` verbatim. A stale client — a tab left open, a
 * phone replaying a queued call — must not move the cursor backwards, because
 * that resurrects read posts as unread and the operator cannot tell a real new
 * post from a reappearing old one.
 *
 * Unlike the exchange, there is no create branch: `ChannelMembership` exists
 * because the person joined, and a non-member has nothing to mark. A missing
 * row is therefore a REFUSAL rather than an insert — `channel_membership_update`
 * would not admit the write anyway, and an insert here would be a second
 * membership writer, which `channels-are-never-auto-joined` refuses by name.
 *
 * ## `updateMany`, and the count is the answer
 *
 * `update` on a composite unique would throw when the row is absent OR when
 * the guard excludes it, and those are different outcomes: not a member
 * (refuse) against already at or ahead of `at` (nothing to do, and fine).
 * `updateMany` returns a count, so the two are distinguishable without
 * catching an error to tell them apart — and a zero count is checked against a
 * separate membership read rather than assumed to mean one of them.
 */
export async function markChannelRead(
    ctx: UserContext,
    channelId: string,
    now: Date = new Date(),
): Promise<{ lastReadAt: string }> {
    return runInUserContext(ctx, async (tx) => {
        const moved = await tx.channelMembership.updateMany({
            where: {
                channelId,
                // A NULL cursor must match, and `{ lt: now }` does NOT match
                // NULL — this is where `markReadFor`'s precedent stops
                // transferring. In the exchange the whole ROW is absent until
                // the first read, so its create branch covers the case; here
                // the row exists from the moment somebody joins, with
                // `lastReadAt` NULL. Without this arm the FIRST mark-read on
                // every channel wrote nothing and reported the caller's own
                // timestamp back as though it had — a badge that never
                // cleared, and a function that lied about why.
                //
                // Measured: three cases in `p9-unread-counts` failed on it,
                // and the tell was the returned value being the timestamp
                // sent rather than the one stored.
                OR: [{ lastReadAt: null }, { lastReadAt: { lt: now } }],
            },
            data: { lastReadAt: now },
        });

        if (moved.count === 0) {
            // Either not a member, or the stored cursor is already at or ahead
            // of `now`. Only the first is an error, so ask which.
            const mine = await tx.channelMembership.findFirst({
                where: { channelId },
                select: { lastReadAt: true },
            });
            if (mine === null) throw codedNotFound('CHANNEL_NOT_JOINED', 'Not a member');
            // Already ahead: report the STORED value, so a client that sent a
            // stale `now` learns the real cursor instead of being told its own
            // number back.
            return { lastReadAt: (mine.lastReadAt ?? now).toISOString() };
        }

        return { lastReadAt: now.toISOString() };
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
    /**
     * When a «Въпрос» was marked «Решено», or null (#2961).
     *
     * `setQuestionResolved` has written this column since P9.3b and NOTHING
     * returned it, so a resolved question was byte-identical to an open one
     * through every read path — the write was unobservable and no UI could
     * render the state the roadmap names. Only `QUESTION` may carry it; it is
     * null on a `POST` and a `CARD` by construction rather than by filtering.
     */
    readonly resolvedAt: Date | null;
    /**
     * How many replies hang off this post (#2961).
     *
     * Here so a feed can show that a thread EXISTS without a request per
     * post, which is the N+1 the D1 guardrail refuses. It counts every reply
     * including hidden ones, matching how the feed itself reports a hidden
     * post rather than omitting it: a count that shrank when a moderator
     * hid one reply would tell every reader that something had been removed.
     */
    readonly replyCount: number;
    /**
     * Who wrote it — name and farm (#2989), or null on a hidden post.
     *
     * The owner decided (2026-11-12) that a channel post shows name + farm,
     * e.g. «Иван Петров, ЗК Победа». Both halves are independently absent:
     *
     * - `displayName` is null until the person has set one AND published it.
     *   `PersonProfile.published` defaults false, so this is null for
     *   everybody on day one — zero rows existed in production when this was
     *   built — and the fallback is the FARM ALONE rather than an id or
     *   «Анонимен». An id is unusable and a placeholder invites the reader to
     *   think the person is hiding.
     * - `farmName` is null when the post recorded no farm. See
     *   `ChannelPost.authorTenantId` for the three different truths that
     *   produce it; all three render as the name alone.
     *
     * Both null is a legitimate state and renders as neither — which is why
     * `authorUserId` stays on this view, so a client has something stable to
     * key a reply or a report on without having a name to show.
     *
     * NULL ON A HIDDEN POST — owner ruling, relayed 2026-11-12: "no author
     * line on a removed post, its time only". The body is already emptied,
     * and naming a person above content nobody can read attributes an
     * accusation to them; the timestamp stays, so the gap is still placed in
     * time. It cannot leak WHICH removal applied, because the three collapse
     * into `deleted` before this point.
     */
    readonly author: {
        readonly displayName: string | null;
        readonly farmName: string | null;
    } | null;
}

/**
 * Names and farms for one PAGE of posts, resolved in two queries — #2989.
 *
 * TWO QUERIES FOR A PAGE, NEVER ONE PER POST. A Prisma read inside a loop is
 * what the D1 guardrail refuses, and P9.3d's auto-hide had to be rewritten
 * into exactly this shape after its first draft tripped it. So: collect the
 * distinct ids from the rows already in hand, one `findMany` each, two maps.
 *
 * ## `published: true` is the control, and it is the ONLY control
 *
 * `PersonProfile` has row-level security DISABLED — measured on the migrated
 * database, not inferred: `relrowsecurity` is false, and the P6 migration
 * that created it says "no policy, because nothing reaches it under
 * app_user". This function is the reader that comment says did not exist, so
 * nothing in the database will withhold an UNPUBLISHED display name if this
 * `where` stops asking for one. That is the inverted posture P5.6a names,
 * where RLS is usually the backstop and here the clause is the whole fence —
 * which is why the test asserts an unpublished profile is NOT rendered rather
 * than only that a published one is. #3007 proposes the policy that would
 * make the database the backstop again.
 *
 * ## Why these two tables can be read on the caller's own client
 *
 * Both are outside RLS (`Tenant` likewise measured false), so this runs on
 * the same `tx` the feed is already using, inside the same transaction, with
 * no bypass and no second pool connection — #1191's P0.8 deadlock is reached
 * by taking a second connection while holding one, which is exactly what a
 * privileged read here would do.
 *
 * `Tenant.name` is plaintext and NOT NULL, so a farm that resolves always has
 * a name. `displayName` is nullable even on a published row, so a published
 * profile with no name set still renders the farm alone.
 */
interface AuthorBook {
    readonly names: ReadonlyMap<string, string>;
    readonly farms: ReadonlyMap<string, string>;
}

async function resolveAuthors(
    tx: Pick<typeof prisma, 'personProfile' | 'tenant'>,
    rows: readonly { authorUserId: string; authorTenantId: string | null }[],
): Promise<AuthorBook> {
    const userIds = [...new Set(rows.map((r) => r.authorUserId))];
    const tenantIds = [
        ...new Set(rows.map((r) => r.authorTenantId).filter((id): id is string => id != null)),
    ];

    const [profiles, tenants] = await Promise.all([
        userIds.length
            ? tx.personProfile.findMany({
                  where: { userId: { in: userIds }, published: true },
                  select: { userId: true, displayName: true },
              })
            : Promise.resolve([]),
        tenantIds.length
            ? tx.tenant.findMany({
                  where: { id: { in: tenantIds } },
                  select: { id: true, name: true },
              })
            : Promise.resolve([]),
    ]);

    const names = new Map<string, string>();
    for (const p of profiles) {
        // A published row with a null or blank name is the same as no name:
        // rendering an empty string would print «, ЗК Победа» with a comma
        // and nothing before it.
        const name = p.displayName?.trim();
        if (name) names.set(p.userId, name);
    }
    const farms = new Map<string, string>();
    for (const t of tenants) farms.set(t.id, t.name);
    return { names, farms };
}

/**
 * The ONE place a `ChannelPost` row becomes a `ChannelPostView`.
 *
 * Shared by the feed and by `readPostReplies` deliberately. The collapse of
 * three removal columns into `deleted` plus an EMPTY body is a disclosure
 * rule, not a formatting one: #2961 added the second read path, and a second
 * spelling of this mapping is how one of them comes to serve the text of a
 * post the other hides. P9.3d's auto-hide sets `autoHiddenAt` on any post
 * including a reply, so a thread read that forgot the collapse would hand
 * back content the moderation path had taken down.
 *
 * That is the #1664 class — two spellings of one rule, where the divergence
 * is a disclosure rather than a wrong sentence.
 */
function toPostView(
    r: {
        id: string;
        authorUserId: string;
        authorTenantId: string | null;
        body: string;
        kind: unknown;
        createdAt: Date;
        deletedAt: Date | null;
        removedByModerationAt: Date | null;
        autoHiddenAt: Date | null;
        resolvedAt: Date | null;
        _count: { replies: number };
    },
    authors: AuthorBook,
): ChannelPostView {
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
        resolvedAt: r.resolvedAt,
        replyCount: r._count.replies,
        // Suppressed on a hidden post — see the field's docblock. Written as
        // part of the SAME collapse as the empty body, so the two cannot
        // drift: a reader of this function sees one rule for one state.
        author: hidden
            ? null
            : {
                  displayName: authors.names.get(r.authorUserId) ?? null,
                  farmName: r.authorTenantId
                      ? authors.farms.get(r.authorTenantId) ?? null
                      : null,
              },
    };
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
                id: true, authorUserId: true, authorTenantId: true,
                body: true, kind: true,
                createdAt: true, deletedAt: true,
                removedByModerationAt: true, autoHiddenAt: true,
                resolvedAt: true,
                // ONE aggregate for the page, not a query per post — the N+1
                // the D1 guardrail refuses. Prisma folds this into the same
                // statement, and `@@index([parentPostId])` serves it.
                _count: { select: { replies: true } },
            },
        });
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        // Resolved for the PAGE, after the slice — the extra `limit + 1` row
        // is a hasMore probe that is never rendered, so looking its author up
        // would be one wasted id per page.
        const authors = await resolveAuthors(tx, page);
        const posts = page.map((r) => toPostView(r, authors));
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
/**
 * A page of ONE post's replies, OLDEST first (#2961).
 *
 * ## It is a different order from the feed, and that is the design
 *
 * A feed is read newest-first because the reader wants what is new. A thread
 * is read oldest-first because it is a conversation and the answers only make
 * sense in the order they were given. So the keyset runs FORWARD — `after`,
 * not `before` — and the two read paths deliberately do not share a direction.
 *
 * ## Readable by a NON-MEMBER, exactly as the feed is
 *
 * `channel_post_select` admits any authenticated caller, so a reply is already
 * readable at the database and a narrower API rule here would be a second,
 * disagreeing answer to one question — while a wider one is not available.
 * There is no private channel in this design (P9.1); adding one means a
 * visibility column and a second SELECT arm, and this function would then
 * inherit it rather than needing its own rule.
 *
 * ## A reply to a missing or hidden PARENT still reads
 *
 * The parent must EXIST — otherwise the id is unverifiable and the answer
 * would be an empty page, which reads as "no replies" rather than "no such
 * post". But a hidden parent still serves its replies: the feed already shows
 * a hidden post as `deleted: true` rather than omitting it, precisely so a
 * reply does not dangle, and withholding the thread would make the moderation
 * of one post silently remove other people's words.
 *
 * ## No composite index, and the condition that would change that
 *
 * The query filters `parentPostId` and sorts `(createdAt, id)` within it, and
 * `@@index([parentPostId])` serves the filter. A thread is ONE level deep
 * (`replyToPost` refuses a reply to a reply), so the sorted set is small and
 * the sort is cheap. `@@index([parentPostId, createdAt])` would make the
 * single-column index a redundant prefix and cost a write on every post for a
 * gain nothing measures yet. Revisit if a real thread ever grows past a few
 * hundred replies.
 */
export async function readPostReplies(
    ctx: UserContext,
    postId: string,
    opts?: { limit?: number; after?: Date },
): Promise<{ replies: ChannelPostView[]; hasMore: boolean }> {
    const limit = Math.min(
        Math.max(opts?.limit ?? CHANNEL_FEED_PAGE_SIZE, 1),
        CHANNEL_FEED_MAX_PAGE_SIZE,
    );
    return runInUserContext(ctx, async (tx) => {
        const parent = await tx.channelPost.findUnique({
            where: { id: postId },
            select: { id: true, parentPostId: true },
        });
        if (!parent) {
            throw codedNotFound('CHANNEL_POST_NOT_FOUND', 'That post does not exist.');
        }
        // A reply has no replies of its own, so asking for a reply's thread is
        // a caller error rather than an empty page. Answered as the PARENT's
        // id being wrong, not as "no replies", because the two are different
        // facts and only one of them is fixable by the caller.
        if (parent.parentPostId != null) {
            throw codedBadRequest(
                'CHANNEL_POST_IS_A_REPLY',
                'That post is itself a reply, and a thread is only one level deep.',
            );
        }
        const rows = await tx.channelPost.findMany({
            where: {
                parentPostId: postId,
                ...(opts?.after ? { createdAt: { gt: opts.after } } : {}),
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            // The `hasMore` probe, and NOTHING is filtered after this query —
            // a post-filter would shrink the page and make `hasMore` wrong,
            // which P8.5 shipped once and corrected.
            take: limit + 1,
            select: {
                id: true, authorUserId: true, authorTenantId: true,
                body: true, kind: true,
                createdAt: true, deletedAt: true,
                removedByModerationAt: true, autoHiddenAt: true,
                resolvedAt: true,
                // Always 0 for a reply — a thread is one level deep — and
                // selected anyway because `toPostView` is the ONE mapper and
                // a second shape for replies is how the collapse rule drifts.
                _count: { select: { replies: true } },
            },
        });
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const authors = await resolveAuthors(tx, page);
        return { replies: page.map((r) => toPostView(r, authors)), hasMore };
    });
}

export async function postToChannel(
    ctx: UserContext,
    channelId: string,
    input: {
        body: string;
        mentionUserIds?: readonly string[];
        /**
         * «Въпрос» when `QUESTION`, else «Публикация» — #2961. `CARD` is NOT
         * accepted: a card is machine-written by P9.4's queue, so taking one
         * from a caller would let a member forge a post that renders as the
         * platform's own data.
         */
        kind?: 'POST' | 'QUESTION';
        /**
         * The farm to post AS, by slug — #2989. Optional; absent records
         * null, which renders as the name alone. See
         * `resolveAuthorTenantId` for why it is supplied rather than read
         * off the path, and why a missing one is never guessed.
         */
        tenantSlug?: string;
    },
): Promise<{ postId: string; createdAt: Date; mentionsRecorded: number }> {
    const body = cleanBody(input.body);
    // OUTSIDE the transaction — see `resolveMentionable`. Inside it the
    // membership policy hides everybody but the caller.
    const recordable = await resolveMentionable(
        channelId, ctx.userId, input.mentionUserIds ?? [],
    );
    const authorTenantId = await resolveAuthorTenantId(ctx.userId, input.tenantSlug);

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
            // `kind` defaults in the DATABASE (`@default(POST)`), so an absent
            // value is not spelled here — writing `kind: input.kind ?? 'POST'`
            // would put a second definition of the default in the app layer.
            data: {
                channelId, authorUserId: ctx.userId, body,
                ...(input.kind ? { kind: input.kind } : {}),
                // Spread rather than written as `?? null`, so an absent farm
                // leaves the column at its own default instead of putting a
                // second definition of it in the app layer — the same reason
                // `kind` is spread directly above.
                ...(authorTenantId ? { authorTenantId } : {}),
            },
            select: { id: true, createdAt: true },
        });
        // In the SAME transaction and the SAME session context. That is why
        // `channel_post_mention_insert` exists at all (P9.3b): the post is
        // inserted as the caller so the WITH CHECK enforces the access rules,
        // and mentions cannot then be written privileged without either
        // splitting the transaction or taking a second pool connection while
        // holding one — #1191's P0.8 deadlock.
        const mentionsRecorded = await recordMentions(tx, post.id, recordable);
        // Queued from INSIDE the callback and drained after COMMIT — see
        // `queueChannelActivityNotify`. No `parentAuthorUserId`: a top-level
        // post notifies the people it MENTIONS and nobody else, because
        // telling every member would make a 2,000-member crop channel
        // reachable by anybody who joined it.
        queueChannelActivityNotify({
            channelId,
            postId: post.id,
            authorUserId: ctx.userId,
            mentionedUserIds: recordable,
            parentAuthorUserId: null,
        });
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
 * Recording them on both rows would notify twice for one act. The reply is
 * where the mention was made; the copy exists for visibility.
 *
 * Since #2987 that is a statement about live behaviour rather than an
 * intention — `queueChannelActivityNotify` is called once, for the REPLY, and
 * not again for the channel copy, which is the same rule one level up.
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
        /** The farm to reply AS, by slug — #2989. See `postToChannel`. */
        tenantSlug?: string;
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
    // Resolved once for BOTH rows below: a reply and its «Също изпрати в
    // канала» copy are the same person posting as the same farm, and two
    // calls would be two chances to disagree.
    const authorTenantId = await resolveAuthorTenantId(ctx.userId, input.tenantSlug);

    return runInUserContext(ctx, async (tx) => {
        const parent = await tx.channelPost.findUnique({
            where: { id: parentPostId },
            select: {
                id: true, channelId: true, parentPostId: true, deletedAt: true,
                // #2987 — the reply's notify target. Selected here rather than
                // read again afterwards: the row is already being fetched, and
                // a second read would be a second chance to disagree about
                // which post the reply is under.
                authorUserId: true,
            },
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
                ...(authorTenantId ? { authorTenantId } : {}),
            },
            select: { id: true, createdAt: true },
        });

        const mentionsRecorded = await recordMentions(tx, reply.id, recordable);

        // ONE event per person even when a reply also MENTIONS its parent's
        // author — `notifyChannelActivity` unions the two causes into a set.
        // Queued once for the REPLY and not again for «Също изпрати в канала»'s
        // channel copy, which is the same rule that stops the copy re-recording
        // the mentions: one act, one notification.
        queueChannelActivityNotify({
            channelId: channel.id,
            // The REPLY, not the parent — a mention in a reply should open the
            // reply. `alsoToChannel`'s channel copy is deliberately not
            // notified about at all, so there is no second id to choose from.
            postId: reply.id,
            authorUserId: ctx.userId,
            mentionedUserIds: recordable,
            parentAuthorUserId: parent.authorUserId,
        });

        let channelCopyPostId: string | null = null;
        if (input.alsoToChannel) {
            const copy = await tx.channelPost.create({
                data: {
                    channelId: channel.id, authorUserId: ctx.userId, body,
                    ...(authorTenantId ? { authorTenantId } : {}),
                },
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
/**
 * Which farm a post is being made AS — #2989.
 *
 * ## The farm is SUPPLIED, and #2989's premise about where from was wrong
 *
 * That issue says to take it from "the tenant slug already present in the
 * posting request's own path". There is no such slug: channel routes are
 * `/api/social/channels/...`, person-scoped, because the DM and channel
 * policies key on `app.user_id` and a tenant route would read zero rows with
 * no error (#1664). The PAGE is at `/t/{slug}/channels`, the API is not.
 *
 * So the client sends it and this validates it. It is not forgeable: an
 * ACTIVE membership of that farm is required, which is the same bar posting
 * anywhere else in the product clears.
 *
 * ## A missing slug is recorded as NULL, never guessed
 *
 * The read-time rule this column exists to avoid is "oldest membership, then
 * id", and applying it at write time would be the same guess merely frozen —
 * a person in three farms would have one picked for them and the post would
 * claim a farm they did not choose. Null renders as the name alone, which is
 * honest, and it is what a post by somebody in no farm shows anyway.
 *
 * ## A slug the caller is not in is REFUSED, not downgraded to null
 *
 * The client is asserting "I am posting as this farm" and the assertion is
 * false; recording null would hide a client bug and publish a post under the
 * wrong attribution. One code covers "no such farm" and "not your farm"
 * deliberately — two would make this an enumeration oracle for farm slugs.
 *
 * On the GLOBAL client and outside any transaction, for `resolveMentionable`'s
 * reason one level over: `TenantMembership` is RLS-keyed on `app.tenant_id`,
 * which `runInUserContext` does not set, so this read inside the posting
 * transaction would match nothing and every post would silently record null.
 */
async function resolveAuthorTenantId(
    userId: string,
    tenantSlug: string | undefined,
): Promise<string | null> {
    if (!tenantSlug) return null;
    const membership = await prisma.tenantMembership.findFirst({
        where: {
            userId,
            status: 'ACTIVE',
            tenant: { slug: tenantSlug, deletedAt: null },
        },
        select: { tenantId: true },
    });
    if (!membership) {
        throw codedForbidden(
            'NOT_A_MEMBER_OF_THAT_FARM',
            'You are not a member of that farm.',
        );
    }
    return membership.tenantId;
}

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
    // lookup and cannot notify twice. `@@unique([postId, userId])` would refuse
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

/** Why a person is being told. Decides the push copy and nothing else. */
type ChannelNotifyReason = 'mention' | 'reply';

interface ChannelTarget {
    userId: string;
    reason: ChannelNotifyReason;
}

interface ChannelActivityTargets {
    channelId: string;
    /**
     * The post this event is ABOUT — the reply, never its parent.
     *
     * Not used by the SSE half, which deliberately carries the CHANNEL id
     * (`StreamFrame`: a client with a message id still has to work out where
     * to put it, and `readConversation`'s sibling here is keyed by channel).
     * It is the push DESTINATION: agrent-ios honours `?post={postId}` on
     * builds that are already shipped, so the push can open the post itself
     * rather than the channel — see the link literal below and #3030.
     */
    postId: string;
    authorUserId: string;
    mentionedUserIds: readonly string[];
    /** The author of the post being replied to, or null for a top-level post. */
    parentAuthorUserId: string | null;
}

/**
 * Who may be TOLD about a post — the mute and the ban are applied here.
 *
 * ## TWO causes, ONE event — and the `Set` is NOT what achieves that
 *
 * P9.3 notifies for mentions and replies and nothing else — never for an
 * ordinary post, which would make every member of a 2,000-member crop channel
 * reachable by anybody who joined it. A reply that also mentions its parent's
 * author is ONE act and must produce ONE event.
 *
 * The obvious claim is that the `new Set` below is what holds that, and it is
 * false — MEASURED, by a mutation that removed the `Set` and left every case
 * in `channel-mention-notifies` green. The duplicate dies one line later: the
 * publish iterates the ROWS of a `findMany`, and there is one
 * `ChannelMembership` row per person per channel, so `in: [x, x]` returns one
 * row and one event however many times `x` appears.
 *
 * The `Set` stays, for two smaller reasons rather than the big one: it keeps
 * the `in` list from carrying needless duplicates, and it keeps the
 * `candidates` figure in the log below honest — a count of 2 for one person
 * mentioned twice would make the `suppressed` arithmetic beside it read as a
 * mute that did not happen.
 *
 * Recorded this way rather than quietly deleted, because the mechanism a
 * reader would credit and the mechanism that works are different ones, and
 * the test asserting ONE event is right either way: it grades the OUTCOME, so
 * it survives a future change to which of the two does the work. This is the
 * same shape as `sendDirectMessage`'s `!deduplicated` guard — a condition that
 * cannot be false reads as a safeguard and is one more thing to keep true.
 *
 * ## THE MUTE IS APPLIED HERE, NOT AT THE MENTION
 *
 * `resolveMentionable` deliberately does not filter `mutedAt`: the mention ROW
 * is a record — and the thing the Art 15 export returns — while a mute is a
 * statement about being INTERRUPTED. Filtering earlier would make a muted
 * person's mention vanish from their own data download, which is the opposite
 * of what muting a channel means.
 *
 * ## Banned, and LEFT, are both read as "do not tell me"
 *
 * `bannedAt: null` is required, so a banned member is not notified even though
 * they may still READ the channel. And a parent author who has LEFT has no row
 * at all, so a reply to their old post tells them nothing: leaving discards
 * `lastReadAt` and `mutedAt` (P9.5 — rejoining writes a FRESH row), so there
 * is no preference left to honour and treating the absence as "not interested
 * in this channel" is the only reading that does not invent one.
 *
 * ## PRIVILEGED, and necessarily so
 *
 * `channel_membership_select` admits the caller's OWN ROW ONLY — forced by
 * P8.1's recursion rule — so a user-context read here returns at most the
 * author's own row and every recipient is silently dropped. That is the shape
 * `resolveMentionable` already carries a docblock about, and it is also why
 * this runs after the commit: a privileged read taken while a user-context
 * transaction is still open is #1191's P0.8 deadlock at `PG_POOL_MAX`.
 */
async function reachableTargets(args: ChannelActivityTargets): Promise<ChannelTarget[]> {
    // The REASON per person, because the push copy differs — «Споменаха Ви»
    // is not «Нов отговор». A `Map` rather than two lists so the union and the
    // precedence happen in one place: a reply that also MENTIONS its parent's
    // author is one act, and the MENTION wins because it is the more specific
    // description of what happened. Built mention-first so the later
    // `parentAuthorUserId` write cannot overwrite it.
    const reasons = new Map<string, ChannelNotifyReason>();
    for (const id of args.mentionedUserIds) reasons.set(id, 'mention');
    if (args.parentAuthorUserId && !reasons.has(args.parentAuthorUserId)) {
        reasons.set(args.parentAuthorUserId, 'reply');
    }
    reasons.delete(args.authorUserId);

    const candidates = [...reasons.keys()];
    if (candidates.length === 0) return [];

    const rows = await prisma.channelMembership.findMany({
        where: {
            channelId: args.channelId,
            userId: { in: candidates },
            mutedAt: null,
            bannedAt: null,
        },
        select: { userId: true },
    });

    // The DENOMINATOR beside the answer, because `notified=0` is otherwise
    // ambiguous between "nobody was addressed" and "everybody addressed is
    // muted" — and the defect this closes was a mechanism whose absence was
    // invisible for exactly that kind of reason.
    logger.info('channel.activity_targets', {
        component: 'channels',
        channelId: args.channelId,
        candidates: candidates.length,
        reachable: rows.length,
        suppressed: candidates.length - rows.length,
    });
    return rows.map((r) => ({ userId: r.userId, reason: reasons.get(r.userId)! }));
}

/**
 * Tell the people a post is FOR — #2987.
 *
 * ## What this closes, and why nothing failed before it
 *
 * `recordMentions` was the only writer of `ChannelPostMention` and the GDPR
 * export was the only reader, so a mention's sole observable effect was that
 * it appeared in the mentioned person's Art 15 download, possibly months
 * later. Three docblocks described a push that did not exist — one of them a
 * SECURITY argument (`channel_post_mention_insert` has no `app_user` arm
 * "because a mention is a PUSH TRIGGER") and one of them `mutedAt`'s, a column
 * no writer touched and nothing consulted.
 *
 * Every check stayed green: a missing notification is not a route, no copy was
 * absent because none is composed, and the behavioural suites asserted that
 * the ROW was written — which was true. #2961's rule verbatim: when you add a
 * write, name the read path that makes its effect observable.
 *
 * ## `afterCommit`, and the publish is INSIDE the callback on purpose
 *
 * `runInUserContext` OWNS an after-commit scope (both helpers in
 * `db-context.ts` do, placed outside `$transaction`), so queuing from inside
 * its callback defers correctly and a ROLLBACK drops the queue unrun.
 * `sendDirectMessage` cannot use this — a bare `prisma.$transaction` opens no
 * scope and `afterCommit` there fires `void runEffect(...)` un-awaited, which
 * is #1619 — and the difference is worth naming because the two sit one domain
 * apart.
 *
 * The publish is written INSIDE the callback rather than in a function the
 * callback calls, because `notification-publish-after-commit` is LEXICAL: it
 * asks whether the call sits inside an `afterCommit(` span. A publish one hop
 * away is unwrapped as far as that guard can tell, and it reported exactly
 * that on the first draft of this file — correctly, since the next person to
 * call that helper from somewhere else would not be warned.
 *
 * One consequence is measured and worth relying on: the scope owner AWAITS
 * the drain, so by the time `postToChannel` resolves the event has been
 * published. Replacing `afterCommit` with an un-awaited `void (async () =>
 * …)()` reddened 12 of 14 cases in `channel-mention-notifies` — not because
 * the rollback leaked, but because the publish had not happened yet when the
 * caller looked. So this is not fire-and-forget with respect to the REQUEST;
 * it is one indexed membership query on the response path, which is the price
 * of the event being observable at all.
 *
 * ## BOTH halves are delivered, and this paragraph used to say otherwise
 *
 * It read "This is the SSE half… a person with it closed learns nothing until
 * they open it", which was true of the first PR and is the exact defect
 * #2987 was filed about — a docblock describing the state of a push. The
 * person-scoped transport exists now: `sendApnsToPerson` and
 * `sendWebPushToPerson` read devices through `runWithoutRls` rather than
 * binding a tenant, `resolvePersonDelivery` takes the STRICTEST of a person's
 * per-farm preferences because a tenantless event belongs to none of those
 * farms, and `person-push-send` delivers one person per job.
 *
 * What was true and stays true is WHY none of that could reuse the existing
 * path: `PushSubscription.tenantId` is NOT NULL, `sendApnsToUser` binds RLS
 * through `runInTenantContext`, and `UserNotificationPreference` is per
 * (user, farm). Resolving a tenant from the recipient would both invent a farm
 * for a person-scoped obligation — P5.4a's objection for
 * `NotificationOutbox` — and pick WRONG, since registration is tenant-scoped
 * and a person in three farms may hold a row under only one of them.
 *
 * Two things are still owed and are issues rather than sentences here. Quiet
 * hours SUPPRESS instead of deferring, because a tenantless event writes no
 * `Notification` row for a 06:00 summary to count (#3020). And `mutedAt` is
 * honoured in `reachableTargets` while still having no WRITER, so the mute it
 * respects cannot yet be set by anybody (#2990).
 */
function queueChannelActivityNotify(args: ChannelActivityTargets): void {
    afterCommit('channel-activity-notify', async () => {
        const targets = await reachableTargets(args);
        if (targets.length === 0) return;

        // ── the SSE half, unchanged ──
        for (const t of targets) {
            // The CHANNEL id, never the post id — see `StreamFrame`. The
            // publisher returns void by design: the post is committed by the
            // time this runs, a lost event degrades to the client's REST
            // refetch, and this cannot become a new unhandled-rejection path.
            publishChannelActivityEvent(t.userId, { id: args.channelId });
        }

        // ── the BACKGROUND PUSH half — #2987 PR B ──
        //
        // ONE query for every recipient's language and one for the channel's
        // names, then a job per person. Not a read per recipient: five
        // mentions would be five queries inside a post's response path, which
        // is the D1 N+1 the query-shape guardrail refuses.
        const [channel, users] = await Promise.all([
            prisma.channel.findUnique({
                where: { id: args.channelId },
                select: { nameBg: true, nameEn: true },
            }),
            prisma.user.findMany({
                where: { id: { in: targets.map((t) => t.userId) } },
                select: { id: true, uiLanguage: true },
            }),
        ]);
        // A channel that vanished between the post and this drain has no name
        // to put in the copy. Skipped rather than pushed with a blank, because
        // «Някой Ви спомена в .» is worse than no notification.
        if (!channel) return;
        const languageOf = new Map(users.map((u) => [u.id, u.uiLanguage]));

        for (const t of targets) {
            // The RECIPIENT's language, never the author's. `translateFor`
            // with an explicit locale is the rule for anything addressed to
            // somebody else; `getTranslations()` would resolve the request
            // cookie, which here belongs to the person who posted.
            const locale = resolveRecipientLocale(languageOf.get(t.userId));
            const key = t.reason === 'mention'
                ? 'notifications.social.channelMention'
                : 'notifications.social.channelReply';
            // The channel NAME is the entity, and naming it is the 2026-11-01
            // ruling ("keep the KEY, drop the free text") applied here: it is
            // platform-seeded reference data carried in both locales by
            // `Channel.nameBg`/`nameEn`, not a farmer's prose. The POST's body
            // is what must never travel — and `ChannelPost.body` is plaintext
            // at rest (P9.1, so P9.7 can search it), so nothing but this rule
            // stops it.
            const channelName = locale === 'bg' ? channel.nameBg : channel.nameEn;
            const pushBody = await translateFor(locale, `${key}.pushBody`, {
                channel: channelName,
            });
            await enqueue('person-push-send', {
                recipientUserId: t.userId,
                title: await translateFor(locale, `${key}.title`),
                body: pushBody,
                // Root-relative, which is the shape agrent-ios asked for: the
                // server owns it, so correcting it never needs a client
                // release. NOT tenant-prefixed — a channel has no farm.
                // The path WITHOUT `/t/{slug}`: a channel has no farm, so
                // `person-push-send` resolves one for the RECIPIENT and
                // composes the link. A bare path is what #2932 cost.
                //
                // The post rides in the QUERY, which is the one of three
                // agreed shapes that works today. agrent-ios honours all
                // three: this one (agreed with the other backend session
                // 2026-11-12), the four-segment `/channels/{id}`, and
                // `/channels/{id}/posts/{postId}` from agrent-ios #591. The
                // last needs a page this repo does not have — emitting it
                // would be #2932 again — and the four-segment form loses the
                // post. So: a path that resolves, carrying an identifier the
                // phone can act on and the web currently ignores. #3030
                // settles which shape wins once the permalink page exists.
                farmRelativePath: `/channels/${args.channelId}?post=${args.postId}`,
                // Per CHANNEL rather than per post, deliberately: a busy
                // channel should supersede its own banner rather than stack a
                // column of them. The reason is in the key so a mention does
                // not silently replace a reply notification and vice versa.
                collapseKey: `channel-${args.channelId}-${t.reason}`,
            });
        }
    });
}
