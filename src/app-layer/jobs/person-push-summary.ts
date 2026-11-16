/**
 * #3020 — one summary push at 06:00 for everything quiet hours held back from
 * a person.
 *
 * Owner ruling 2026-11-14: a channel mention, a channel reply or a direct
 * message arriving 22:00–06:00 `Europe/Sofia` is HELD and delivered as one
 * push at 06:00, as a farm notification already is — not dropped, which is
 * what `person-push-send` did until this landed.
 *
 * ## It counts ROWS, because a tenantless event has no bell
 *
 * `push-summary`, the farm sibling, counts the person's unread `Notification`
 * rows for a tenant. A person-scoped event cannot write one —
 * `Notification.tenantId` is NOT NULL with an FK — so this counts
 * `PersonPushDeferral` instead. That table's docblock carries why it is rows
 * and not a counter.
 *
 * ## The read is by PERSON, not by night
 *
 * `nightKey` arrives in the payload and is NOT the read key. It exists to make
 * the BullMQ `jobId` idempotent at the producer, so the fifth mention of a
 * night cannot schedule a fifth summary.
 *
 * Reading every UNSETTLED row for the person instead is what makes a lost
 * night self-healing: a Redis flush, or a run that landed inside the next
 * window, leaves rows NULL and the following summary includes them. The farm
 * sibling can afford to drop that case because "the rows it describes are
 * still in the bell either way"; there is no bell here, so dropping would be
 * the only loss of the interruption.
 *
 * ## The link is CONDITIONAL — owner ruling, and one third of it has EXPIRED
 *
 * Exactly one unsettled item links to that item: the five-segment
 * `/channels/{channelId}/posts/{postId}` (#3030) or the DM thread.
 *
 * The original ruling (2026-11-14) gave two or more items NO link, and the
 * reason it gave was that no surface rendered several at once: *"`/exchange
 * /threads` lists direct messages and exchange threads but no channel
 * mentions, so a summary that was entirely mentions would land somewhere
 * showing none of them. Rather than invent a destination we send none."*
 *
 * «За Вас» (`/channels/for-you`, #3069) is now that surface, so the premise
 * expired and the ruling's own reasoning points the other way (#3074). This is
 * `a-safety-argument-expires-silently`: the ruling was right when made,
 * nothing failed when it stopped being right, and only re-reading the reason
 * against today's routes surfaces it.
 *
 * ## It is the KINDS that decide, not the count
 *
 * «За Вас» renders replies to the caller's posts and mentions of them. It
 * renders NO direct messages — `/api/social/activity` is channel activity. So
 * `count > 1` alone is the wrong test, and sending every multi-item night
 * there would commit the exact error the original ruling avoided, one surface
 * over: a night of two DMs would land on a page showing neither.
 *
 * Several items therefore link to «За Вас» only when EVERY one of them is
 * channel activity. A mixed night, or a night of direct messages alone, still
 * carries no link — the conservative half of the ruling survives for precisely
 * the cases that have no destination yet. An all-DM night has a plausible one
 * in `/exchange/threads`; that is a destination ruling rather than an expired
 * premise, so it is #3133 and not assumed here.
 *
 * None of this needs a "most recent wins" tie-break, which a "link to the
 * newest of N" rule would have needed — and a strict `>` tie-break never
 * fires on ties.
 *
 * ## The copy names a COUNT after a label, deliberately
 *
 * `translateFor` is a plain interpolator with NO ICU support, so a plural form
 * would come back as the literal template. «Нови съобщения: 3» is grammatical
 * at any count in both languages, which is the rule this repo already applies
 * to the triage alert.
 *
 * ## `settledAt` is stamped for two different reasons
 *
 * After a successful send, and when the person has NO transport at all —
 * because nothing will ever deliver those rows and every later run would
 * reach the same conclusion, so leaving them would grow the table without
 * bound. A send that THROWS leaves them NULL, which is the per-row retry.
 */
import type { PersonPushDeferralKind } from '@prisma/client';

import { enqueue } from '@/app-layer/jobs/queue';
import { prisma } from '@/lib/prisma';
import type { PersonPushSummaryPayload } from '@/app-layer/jobs/types';
import { resolvePersonDelivery } from '@/app-layer/notifications/person-delivery';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { translateFor } from '@/lib/i18n/server-messages';
import { logger } from '@/lib/observability/logger';

export interface PersonPushSummaryResult {
    count: number;
    delivered: number;
}

/**
 * The destination for a single held item, farm-relative.
 *
 * Composed from the row's PIECES rather than replayed from a stored path, so a
 * route that moves is a change here and not a silently stale link (#1087).
 * Returns null for a row with no subject — a payload from before #3020, which
 * is counted and linkless.
 */
export function deferralPath(row: {
    kind: string;
    channelId: string | null;
    postId: string | null;
    conversationId: string | null;
}): string | null {
    if (row.kind === 'DIRECT_MESSAGE') {
        return row.conversationId ? `/exchange/threads/dm/${row.conversationId}` : null;
    }
    if (row.channelId && row.postId) {
        return `/channels/${row.channelId}/posts/${row.postId}`;
    }
    return null;
}

/**
 * The kinds «За Вас» actually renders.
 *
 * An ALLOWLIST, derived from what the surface shows, rather than "everything
 * that is not a DM": `PersonPushDeferralKind` has three members today, and a
 * fourth must be a deliberate decision about whether that page lists it. An
 * open-ended `!== 'DIRECT_MESSAGE'` would silently enrol it and link a push to
 * a page showing none of its items — the same reasoning as
 * `PERSISTABLE_PATHS`, where a forgotten allowlist entry costs one refetch and
 * a forgotten denylist entry is the defect.
 */
export const FOR_YOU_KINDS: readonly PersonPushDeferralKind[] = [
    'CHANNEL_MENTION',
    'CHANNEL_REPLY',
];

/** «За Вас» — every channel reply and mention for the caller, newest first. */
export const FOR_YOU_PATH = '/channels/for-you';

/**
 * Where the summary push lands, farm-relative, or null for "just open the app".
 *
 * `offSurfaceCount` is the number of unsettled rows whose kind «За Вас» does
 * NOT render, and it is a COUNT rather than a scan of `rows` because `rows` is
 * `take: 2` — enough to answer "is there exactly one", which is all the
 * original rule needed, and not enough to answer "is every one of them channel
 * activity". Reading the kinds off those two rows would send a night of two
 * mentions and one DM to a page showing two of its three items, and the third
 * would be the one a farmer was actually waiting for.
 *
 * Exported because the no-link branch is unobservable from the push itself: a
 * missing destination and a destination that shows nothing look identical to
 * the person tapping it.
 */
export function summaryPath(input: {
    count: number;
    offSurfaceCount: number;
    first: {
        kind: string;
        channelId: string | null;
        postId: string | null;
        conversationId: string | null;
    } | null;
}): string | null {
    if (input.count === 0) return null;
    // One item lands on the item itself, which is strictly better than any
    // aggregate: the post, not a list containing the post.
    if (input.count === 1) return input.first ? deferralPath(input.first) : null;
    // Several — and only where the surface renders all of them.
    return input.offSurfaceCount === 0 ? FOR_YOU_PATH : null;
}

export async function runPersonPushSummary(
    input: PersonPushSummaryPayload,
): Promise<PersonPushSummaryResult> {
    const { recipientUserId, nightKey } = input;

    // Two rows is all the link rule needs: the count decides the copy and
    // "is it exactly one" decides the link, so a second row is proof of
    // "several" without reading the rest. The COUNT is a separate aggregate
    // because the copy names a real number, not "2+".
    const { rows, count, offSurfaceCount } = await runWithoutRls(
        { reason: 'person-push-deferral' },
        async (db) => {
            const where = { recipientUserId, settledAt: null } as const;
            const [found, total, offSurface] = await Promise.all([
                db.personPushDeferral.findMany({
                    where,
                    orderBy: { createdAt: 'asc' },
                    take: 2,
                    select: {
                        id: true,
                        kind: true,
                        channelId: true,
                        postId: true,
                        conversationId: true,
                    },
                }),
                db.personPushDeferral.count({ where }),
                // Rows «За Вас» would not show. Counted in the DATABASE and
                // bounded, because the destination rule is about EVERY
                // unsettled row and `take: 2` cannot see past the second.
                db.personPushDeferral.count({
                    // Spread, because Prisma's `notIn` takes a MUTABLE array
                    // and the allowlist is `readonly` — which it stays: a
                    // module constant another file can push onto is not an
                    // allowlist. One copy per run, against a count query.
                    where: { ...where, kind: { notIn: [...FOR_YOU_KINDS] } },
                }),
            ]);
            return { rows: found, count: total, offSurfaceCount: offSurface };
        },
    );

    if (count === 0) {
        // Not an error and not unexpected: the person's previous summary may
        // have settled these, or a duplicate job id was refused and this is
        // the second arrival.
        logger.info('person-push.summary_empty', {
            component: 'person-push',
            nightKey,
        });
        return { count: 0, delivered: 0 };
    }

    // ASKED AGAIN at 06:00, and not belt-and-braces: the night is eight hours
    // long, so somebody can turn push off at 23:00, and a summary that only
    // re-checked the clock would deliver at 06:00 exactly the push they had
    // just refused. Every producer goes through one decision point —
    // `one-resolve-delivery` holds that to be true.
    const decision = await resolvePersonDelivery(recipientUserId, new Date());

    if (decision.deferral !== null) {
        // This run landed inside the NEXT night's window — a backlog of eight
        // hours or more. Left UNSETTLED on purpose, so the following summary
        // picks the rows up. Re-enqueuing from here would be a second
        // scheduler for the same rows and could chain nightly.
        logger.warn('person-push.summary_too_late', {
            component: 'person-push',
            nightKey,
            count,
        });
        return { count, delivered: 0 };
    }

    if (!decision.webPush && !decision.apns) {
        // SETTLED, though nothing was sent. Nothing will ever deliver these —
        // the person has no transport — and every later run would reach the
        // same conclusion while the rows accumulated. See the column's own
        // docblock for why the field is not called `deliveredAt`.
        await settle(recipientUserId);
        logger.info('person-push.summary_suppressed', {
            component: 'person-push',
            nightKey,
            count,
            reason: decision.suppressedBecause,
        });
        return { count, delivered: 0 };
    }

    // The RECIPIENT's language, never the actor's — `translateFor` with an
    // explicit locale. A person-scoped summary has no tenant whose preference
    // could stand in, so this is read from the person's own row.
    // The plain client, exactly as `push-summary` reads it: `User` is a global
    // table with no `tenantId`, so a tenant-scoped lens is the wrong one for
    // it, and `uiLanguage` is a property of the person rather than of any
    // membership. No bypass is needed for a table RLS does not scope.
    const user = await prisma.user.findUnique({
        where: { id: recipientUserId },
        select: { uiLanguage: true },
    });
    const locale = resolveRecipientLocale(user?.uiLanguage);

    // One -> that item. Several, all channel activity -> «За Вас». Mixed, or
    // direct messages alone -> nothing. See the docblock.
    const farmRelativePath = summaryPath({ count, offSurfaceCount, first: rows[0] ?? null });

    // Delegated to `person-push-send` rather than sending here, so the farm
    // slug resolution, the two transports and the no-link fallback stay in ONE
    // place. A second sender is how #2932 happened — a path that resolved for
    // one producer and not the other.
    // Named `pushBody`, which is the convention
    // `push-payload-carries-no-free-text` §1 enforces: every push-enqueue site
    // must feed `body` from one, so that a payload built from a farmer's prose
    // is a visible departure rather than an inline expression nobody reads.
    const pushBody = await translateFor(
        locale,
        'notifications.person.summary.body',
        { count },
    );

    await enqueue('person-push-send', {
        recipientUserId,
        title: await translateFor(locale, 'notifications.person.summary.title'),
        body: pushBody,
        farmRelativePath,
        // Per NIGHT, so a second summary cannot stack a banner on the first.
        collapseKey: `person-summary-${nightKey}`,
        // No subject: this push is ABOUT several things, or about one whose
        // destination is already in `farmRelativePath`. Leaving it absent also
        // means that if 06:00 somehow falls inside the window, the summary is
        // held with no destination rather than deferring a deferral.
    });

    // Stamped BEFORE the send resolves, because the send is now a separate
    // job. That is deliberate and is the one place this differs from
    // `statement-dispatch`, which stamps after: there the send is in-process
    // and its failure is observable here, while a `person-push-send` failure
    // is retried by BullMQ three times on its own and is not reportable back
    // to this run. Leaving the rows unsettled would re-summarise them
    // tomorrow on top of a push that did go out.
    await settle(recipientUserId);

    logger.info('person-push.summary_sent', {
        component: 'person-push',
        nightKey,
        count,
        linked: farmRelativePath !== null,
    });
    return { count, delivered: 1 };
}

/** Settle every row this summary covered. */
async function settle(recipientUserId: string): Promise<void> {
    await runWithoutRls({ reason: 'person-push-deferral' }, (db) =>
        db.personPushDeferral.updateMany({
            where: { recipientUserId, settledAt: null },
            data: { settledAt: new Date() },
        }),
    );
}
