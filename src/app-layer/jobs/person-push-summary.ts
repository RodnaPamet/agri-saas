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
 * ## The link is CONDITIONAL — owner ruling, same day
 *
 * Exactly one unsettled item links to that item: the five-segment
 * `/channels/{channelId}/posts/{postId}` (#3030) or the DM thread. Two or more
 * carry NO link and simply open the app.
 *
 * The farm summary sends `/t/{slug}/notifications`, a LIST page, and there is
 * no person-scoped equivalent — no «Активност» surface exists (P9.7/#2941
 * would own it) and `/exchange/threads` lists direct messages and exchange
 * threads but no channel mentions, so a summary that was entirely mentions
 * would land somewhere showing none of them. Rather than invent a destination
 * we send none.
 *
 * Exactly-one-or-none also means there is no "most recent wins" tie-break to
 * get wrong, which a "link to the newest of N" rule would have needed — and a
 * strict `>` tie-break never fires on ties.
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

export async function runPersonPushSummary(
    input: PersonPushSummaryPayload,
): Promise<PersonPushSummaryResult> {
    const { recipientUserId, nightKey } = input;

    // Two rows is all the link rule needs: the count decides the copy and
    // "is it exactly one" decides the link, so a second row is proof of
    // "several" without reading the rest. The COUNT is a separate aggregate
    // because the copy names a real number, not "2+".
    const { rows, count } = await runWithoutRls(
        { reason: 'person-push-deferral' },
        async (db) => {
            const where = { recipientUserId, settledAt: null } as const;
            const [found, total] = await Promise.all([
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
            ]);
            return { rows: found, count: total };
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

    // Exactly one -> that item. Several -> nothing. See the docblock.
    const farmRelativePath = count === 1 && rows[0] ? deferralPath(rows[0]) : null;

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
