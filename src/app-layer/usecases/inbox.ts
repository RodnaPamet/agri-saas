/**
 * One inbox — DMs and Борса deals in a single ordered list (P8.5, #2799).
 *
 * ## Two queries, not one SQL statement, and that is deliberate
 *
 * The phase asks for "one query across the person's farms". What that
 * requirement protects is honoured here — there is **no per-farm loop** and
 * **one pagination** — but it is two Prisma reads rather than one `UNION`, for
 * two measured reasons.
 *
 * **A raw UNION cannot decrypt.** Message bodies are encrypted and the Prisma
 * client extension is what decrypts them, so a raw read returns the envelope:
 * `p8-1-direct-message-rls.test.ts` and `p8-2-direct-messages.test.ts` both
 * assert `$queryRawUnsafe` on `DirectMessage.body` matches `/^v[12]:/`. An
 * inbox preview built that way would render `v2:…` to the operator, and would
 * trip the #2814 ciphertext-egress detector on the way out.
 *
 * **And it would be a second spelling of the exchange filters.** The block
 * exclusions live in a Prisma `where` today; re-expressing them in SQL is the
 * #1664 class, where one half of the system read a different session variable
 * than the other and a block did nothing for every pair, silently. A
 * divergence here is a DISCLOSURE, not a wrong sentence — so the risky half
 * must not be hand-written SQL.
 *
 * The failure modes settle it: over-filtering loses a row from a list, which
 * is visible and annoying; under-filtering shows a blocked person's
 * conversation, which is silent and is what this phase exists to prevent.
 *
 * ## ONE cursor over both sources
 *
 * Both tables carry `lastMessageAt` and `id`, and both are ordered
 * `(lastMessageAt desc, id desc)` — so a single `(at, id)` keyset serves both.
 * Each source is asked for `limit + 1` rows strictly before the cursor, the
 * two are merged on the same order, and `limit + 1` is taken from the merge.
 * That is one pagination, not two: a caller never has to reconcile two
 * independent pages, and `hasMore` is computed from the merged probe row.
 *
 * `id` is in the order and is not decoration — `lastMessageAt` alone is not a
 * total order, so two conversations sharing a timestamp straddle the page
 * boundary and one is dropped while the other repeats. That note is
 * `listExchangeThreads`' already; it applies with more force across a merge,
 * where a DM and an exchange thread can share a second.
 *
 * ## Privileged, with the `where` as the control
 *
 * The exchange side is tenant-scoped (`exchange_thread_audience` keys on
 * `app.actor_user_id`); the DM side is person-scoped (`app.user_id`). No
 * single context satisfies both, so this runs on the privileged client — the
 * P5.6a posture, and P5.6a states the consequence plainly: *"that inverts the
 * usual arrangement where RLS is the backstop: here a dropped clause exports
 * the database."*
 *
 * So every test in `p8-5-one-inbox.test.ts` asserts a SECOND person's rows are
 * ABSENT. A presence-only test passes while this function leaks everything.
 *
 * ## PERSON-scoped, including the exchange half
 *
 * A row appears when the caller is a PARTY to it: `inquirerUserId` or the
 * listing's `sellerUserId` on the exchange side, a participant row on the DM
 * side. It deliberately does NOT reproduce `exchange_thread_audience`, which
 * also admits either farm's OWNER/ADMIN — so an owner does not see a
 * colleague's exchange thread here.
 *
 * That is a choice and it is flagged rather than assumed. The DM half is
 * strictly person-scoped by P8.1's policies, so a mixed inbox would show
 * "conversations you are in" beside "conversations your colleagues are in" on
 * one screen. Starting narrow is also the reversible direction: adding
 * oversight later is additive, removing it later is a user-visible loss. The
 * existing tenant-scoped `/exchange/messages` surface is untouched, so no
 * owner loses oversight today. Measured on production 2026-11-07: one exchange
 * thread, zero DM conversations, one farm with more than one member — so the
 * practical difference today is at most one row.
 */
import prisma from '@/lib/prisma';
import { encodeCursor, decodeCursor, keysetBefore } from '@/lib/exchange/cursor';
import { codedBadRequest } from '@/lib/errors/types';
import type { UserContext } from '@/app-layer/types';

import { whoHasBlockedMe } from './person-blocks';

/** Matches the exchange inbox's page size, so one screen is one size. */
export const INBOX_PAGE_SIZE = 20;

export type InboxSource = 'dm' | 'exchange';

export interface InboxItem {
    readonly source: InboxSource;
    readonly id: string;
    readonly lastMessageAt: Date;
    /** NULL while the caller has never opened it — not the same as caught up. */
    readonly lastReadAt: Date | null;
    readonly unread: boolean;
    /**
     * A DM request the caller has not answered. Null on an exchange row: the
     * exchange has no request state, and inventing `false` for it would read
     * as "answered".
     */
    readonly awaitingMyAnswer: boolean | null;
    /** Enough to render a row without a second fetch. Shape differs per source. */
    readonly title: string | null;
}

export interface InboxPage {
    readonly items: readonly InboxItem[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
}

export async function listInbox(
    ctx: UserContext,
    options: {
        limit?: number;
        cursor?: string | null;
        /**
         * Which halves to read. Omitted ⇒ both — P8.5's original behaviour,
         * unchanged for every existing caller.
         *
         * P8.4 needs `['dm']` and the reason is a disclosure boundary, not
         * efficiency. This function is PERSON-scoped: its exchange half admits
         * the caller only as `inquirerUserId` or the listing's
         * `sellerUserId`, deliberately NOT reproducing
         * `exchange_thread_audience`, which also admits either farm's
         * OWNER/ADMIN. The exchange messaging screen is tenant-scoped and has
         * always shown an owner their colleagues' threads. Backing that screen
         * with this half would therefore REMOVE rows an owner can see today —
         * a regression dressed as a merge. So the screen keeps its own
         * tenant-scoped query and takes only the DM half from here.
         */
        sources?: readonly InboxSource[];
    } = {},
): Promise<InboxPage> {
    // `Number.isFinite`, not `??`: NaN is neither null nor undefined, so `??`
    // passes it through and `take: NaN` is a Prisma 500. The same choke point
    // `listExchangeThreads` carries, for the same reason.
    const requested = Number.isFinite(options.limit)
        ? (options.limit as number)
        : INBOX_PAGE_SIZE;
    const limit = Math.min(Math.max(requested, 1), INBOX_PAGE_SIZE);

    const raw = options.cursor ?? null;
    const cursor = decodeCursor(raw);
    if (raw && !cursor) {
        // A cursor we cannot decode is a bad request, not an empty first page.
        // Treating it as "start again" would silently restart a client's
        // scroll, which looks like duplicated rows rather than an error.
        throw codedBadRequest('INVALID_CURSOR', 'That cursor is not readable.');
    }
    const before = cursor ? keysetBefore(cursor, 'lastMessageAt') : {};

    // One indexed lookup, shared by both halves — the visibility predicate.
    // One-directional on purpose: the blocked party loses sight of the
    // conversation, the blocker keeps their history (P5.2b).
    const blockers = await whoHasBlockedMe(prisma as never, ctx.userId);
    const notBlocked = blockers.length > 0 ? { notIn: blockers } : undefined;

    // An excluded half is NOT read at all. `Promise.all` accepts a plain
    // value, so the skipped side is an empty array rather than a query with a
    // `take: 0` or a never-matching `where` — both of which still cost a round
    // trip and would make the skip invisible in a query log.
    const wantDm = !options.sources || options.sources.includes('dm');
    const wantExchange = !options.sources || options.sources.includes('exchange');

    const [dmRows, exRows] = await Promise.all([
        !wantDm ? [] : prisma.conversation.findMany({
            where: {
                // `AND`, not two spreads into one object. `keysetBefore`
                // returns `{ OR: [...] }`, and a sibling `OR` key in the same
                // literal would SILENTLY REPLACE it — the cursor filter would
                // vanish and every page would return the same rows.
                // `listExchangeThreads` carries this note; the first draft of
                // this function had the bug on the exchange half.
                AND: [
                    before,
                    {
                        // A participant row is the caller's membership.
                        // Person-scoped throughout — these tables have no
                        // tenant.
                        participants: {
                            some: { userId: ctx.userId },
                            // Hide a conversation whose counterparty has
                            // blocked me. `in`, NOT `notIn`: `none: { userId:
                            // { notIn: blockers } }` excludes every
                            // conversation that has any participant who is not
                            // a blocker — which includes ME — so the first
                            // draft emptied the whole list the moment one
                            // block existed. An empty list looks exactly like
                            // having no conversations.
                            ...(blockers.length > 0
                                ? { none: { userId: { in: blockers } } }
                                : {}),
                        },
                        // A conversation with no message yet is not an inbox
                        // row: an opened-but-unwritten REQUEST would show the
                        // recipient an empty thread before the sender spoke.
                        lastMessageAt: { not: null },
                        // DECLINED stays out. The decision was final and the
                        // routes answer not-found on every content path, so a
                        // row the caller cannot open is a dead end in a list.
                        state: { in: ['REQUEST', 'ACCEPTED'] },
                    },
                ],
            },
            orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: {
                id: true,
                lastMessageAt: true,
                state: true,
                initiatedByUserId: true,
                participants: {
                    where: { userId: ctx.userId },
                    select: { lastReadAt: true },
                    take: 1,
                },
                // The newest message, for the preview. Decrypted by the
                // extension because this is a model read and not raw SQL,
                // which is the whole reason this function is two Prisma
                // queries rather than one UNION.
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: { body: true, deletedAt: true },
                },
            },
        }),
        !wantExchange ? [] : prisma.exchangeThread.findMany({
            where: {
                // `AND` for the same reason as above, and here the collision
                // was REAL rather than hypothetical: `...before` sets `OR`,
                // and the party clause below is also an `OR`, so the second
                // overwrote the cursor and every page returned page one.
                AND: [
                    before,
                    {
                        // PARTY only — see the header on why this is narrower
                        // than `exchange_thread_audience`.
                        OR: [
                            { inquirerUserId: ctx.userId },
                            { listing: { sellerUserId: ctx.userId } },
                        ],
                    },
                    ...(notBlocked
                        ? [{ inquirerUserId: notBlocked, listing: { sellerUserId: notBlocked } }]
                        : []),
                ],
            },
            orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: {
                id: true,
                lastMessageAt: true,
                reads: { where: { userId: ctx.userId }, select: { lastReadAt: true }, take: 1 },
                listing: { select: { commodity: true, regionName: true } },
            },
        }),
    ]);

    const dmItems: InboxItem[] = dmRows.map((c) => {
        const lastReadAt = c.participants[0]?.lastReadAt ?? null;
        const newest = c.messages[0];
        return {
            source: 'dm' as const,
            id: c.id,
            lastMessageAt: c.lastMessageAt as Date,
            lastReadAt,
            unread: lastReadAt === null || lastReadAt < (c.lastMessageAt as Date),
            // Only the recipient of an unanswered request is awaiting an
            // answer — the opener is waiting for one, which is a different
            // thing and must not light up the same badge.
            awaitingMyAnswer: c.state === 'REQUEST' && c.initiatedByUserId !== ctx.userId,
            // A deleted newest message previews as null rather than as its
            // cleared body, so the row does not render an empty string.
            title: newest && !newest.deletedAt ? newest.body : null,
        };
    });

    const exItems: InboxItem[] = exRows.map((t) => {
        const lastReadAt = t.reads[0]?.lastReadAt ?? null;
        return {
            source: 'exchange' as const,
            id: t.id,
            lastMessageAt: t.lastMessageAt,
            lastReadAt,
            unread: lastReadAt === null || lastReadAt < t.lastMessageAt,
            // NULL, not false — the exchange has no request state, and `false`
            // would read as "already answered".
            awaitingMyAnswer: null,
            title: [t.listing.commodity, t.listing.regionName].filter(Boolean).join(' · ') || null,
        };
    });

    // The merge uses the SAME total order both queries used, so the result is
    // what a single ORDER BY over a union would have produced.
    const merged = [...dmItems, ...exItems].sort((a, b) => {
        const byTime = b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
        return byTime !== 0 ? byTime : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    });

    const hasMore = merged.length > limit;
    const items = hasMore ? merged.slice(0, limit) : merged;
    const last = items.at(-1) ?? null;

    return {
        items,
        // The cursor is (at, id) of the last MERGED row, which both sources
        // then page before. Encoding either source's own cursor would skip
        // rows from the other.
        nextCursor: hasMore && last ? encodeCursor({ at: last.lastMessageAt, id: last.id }) : null,
        hasMore,
    };
}
