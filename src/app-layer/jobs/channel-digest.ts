/**
 * P9.7 (#2941) — the opt-in 07:15 digest of channel activity.
 *
 * ## PUSH, not email, and the issue asked for email
 *
 * #2941's Done-when says the digest "stores rendered text with an explicit
 * `locale`", which describes `NotificationOutbox`. Measured, that is not
 * available: `NotificationOutbox.tenantId` is NOT NULL and
 * `EnqueueEmailInput.tenantId` is required, and a channel has no tenant — the
 * wall #3020 hit, with P5.4a's reason: resolving one would invent a tenant for
 * a person-scoped obligation.
 *
 * Owner ruling 2026-11-15: deliver by push, reusing `person-push-send`. The
 * cost is real and worth stating — somebody who does not open the app gets a
 * banner rather than a mail.
 *
 * ## 07:15 is EUROPE/SOFIA, so the gate is local time and not a cron hour
 *
 * A UTC cron at a fixed hour drifts by an hour across DST, and #2941 names
 * that as the failure: "silently shipping a digest that arrives at 06:15 half
 * the year". So this runs OFTEN and asks whether the person's local 07:15 has
 * passed today — the same shape `statement-dispatch` uses, where the queue is
 * a column rather than a schedule.
 *
 * That is the opposite choice from P9.4's card generator, which takes a UTC
 * cron deliberately: there the hour only needs to be "before anybody looks",
 * and an hour of seasonal drift changes nothing a reader could notice. Here
 * the time is a PROMISE to the recipient, so it must not drift.
 *
 * ## ADDITIVE, not a delivery mode
 *
 * Opting in adds a morning recap; it does not suppress per-event pushes. A
 * person who wants batching INSTEAD sets
 * `UserNotificationPreference.delivery = DAILY_DIGEST`, which
 * `resolveDelivery` already honours — expressing one decision through two
 * mechanisms is how they come to disagree, and this repo has paid for that
 * (`AUDIT_FAIL_CLOSED_ENABLED` is deliberately read in ONE place for the same
 * reason).
 *
 * ## It also covers the DAILY_DIGEST population, which otherwise gets nothing
 *
 * `resolvePersonDelivery` takes the strictest preference across a person's
 * farms, and `DAILY_DIGEST` returns `digest-only` with no push — while the
 * FARM digest counts `Notification` rows, which a channel event never writes.
 * So a person on DAILY_DIGEST would get no channel push and no channel
 * digest. Measured 2026-11-15: production holds ZERO
 * `UserNotificationPreference` rows, so that affects nobody today — a fact
 * about the data, not a property of the design. Including them here closes it
 * before it has a victim.
 */
import { enqueue } from '@/app-layer/jobs/queue';
import { readMyActivity } from '@/app-layer/usecases/channels';
import { FARM_TIME_ZONE, farmToday, farmTodayFloor } from '@/lib/calendar-day-key';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { translateFor } from '@/lib/i18n/server-messages';
import { logger } from '@/lib/observability/logger';

/** The local hour and minute the digest is promised for. */
export const DIGEST_HOUR = 7;
export const DIGEST_MINUTE = 15;

/** How far back a digest looks for activity. */
export const DIGEST_WINDOW_HOURS = 24;

/**
 * How long after 07:15 a digest may still go out.
 *
 * THE GATE IS A WINDOW AND NOT «HAS 07:15 PASSED», which is what the first
 * draft of this file asked. An open-ended gate is true at 23:00, so somebody
 * whose first activity of the day arrived at 22:00 — and who therefore had
 * nothing to report at 07:15, so was never stamped — would be sent a MORNING
 * digest late at night. A digest that arrives at the wrong end of the day is
 * worse than no digest: #2941's own failure case is a recap arriving at 06:15
 * half the year, and 23:00 is the same defect an hour-and-a-half further out.
 *
 * An hour against a 15-minute schedule means four chances to deliver, so a
 * worker down for one beat still sends. After the window the day is simply
 * missed, which is the correct outcome for a promise about the morning.
 */
export const DIGEST_DELIVERY_WINDOW_MINUTES = 60;

export interface ChannelDigestResult {
    /** People eligible by preference, before the clock is considered. */
    candidates: number;
    /** Of those, the ones whose local 07:15 has passed and who are unsent. */
    due: number;
    /** Of those, the ones who had anything to report. */
    withActivity: number;
    sent: number;
}

/**
 * Is `now` inside the local delivery window that opens at 07:15?
 *
 * Exported and PURE, so the boundary is testable without a database — and the
 * test uses an instant whose UTC hour and Sofia hour differ, because every
 * other instant passes either way. That is the `chatDayKey` precedent.
 */
export function digestDueAt(now: Date): boolean {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: FARM_TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const minutesOfDay = hour * 60 + minute;
    const opens = DIGEST_HOUR * 60 + DIGEST_MINUTE;
    return minutesOfDay >= opens
        && minutesOfDay < opens + DIGEST_DELIVERY_WINDOW_MINUTES;
}

export async function runChannelDigest(
    now: Date = new Date(),
): Promise<ChannelDigestResult> {
    const today = farmToday(now);
    const reading: ChannelDigestResult = {
        candidates: 0, due: 0, withActivity: 0, sent: 0,
    };

    /*
     * The population: opted in, OR batching by preference. Read privileged —
     * `User` is global and `UserNotificationPreference` is per-farm, so no
     * single tenant context could see either set.
     *
     * Bounded with `take`, like every repository read here. A deployment past
     * the bound would leave people unsent, which the reading would show as
     * `candidates` pinned at the cap rather than as silence.
     */
    const candidates = await runWithoutRls({ reason: 'channel-digest' }, (db) =>
        db.user.findMany({
            where: {
                suspendedAt: null,
                /*
                 * `User` HAS NO `deletedAt`, and the first draft of this
                 * clause used one. It typechecked — an extended-client `where`
                 * key is not caught by `tsc`, the same class as the five wrong
                 * `select` keys P5.6a shipped — and failed at runtime as a
                 * `PrismaClientValidationError`. The four lifecycle columns
                 * are `suspendedAt`, `deletionRequestedAt`, `terminatedAt` and
                 * `pseudonymisedAt`; verify a column against the schema, never
                 * against a green typecheck.
                 */
                /*
                 * An ERASED account is excluded, and `suspendedAt` does not
                 * cover it. A moderation TERMINATION sets `suspendedAt`, but a
                 * self-service erasure sets `deletionRequestedAt` and then
                 * `pseudonymisedAt` — and never `suspendedAt` — so a person who
                 * asked to be deleted and was, while opted in, would stay a
                 * digest candidate for ever. P5.6b keeps the `User` row alive
                 * deliberately (Art 17(3)(b)), which is exactly why "the row
                 * exists" cannot be read as "there is somebody to notify".
                 */
                pseudonymisedAt: null,
                /*
                 * Somebody inside the 30-day deletion grace period is excluded
                 * too. #1655's freeze does not name notifications — it stops
                 * new content and hides their listings — so this is a product
                 * call rather than that rule: a daily «here is what you
                 * missed» nudge to a person who has asked to be deleted is the
                 * wrong thing to send them.
                 *
                 * It is also non-destructive, which is what makes it the safe
                 * direction: cancelling the request clears the column, so they
                 * resume receiving digests with nothing to restore.
                 */
                deletionRequestedAt: null,
                OR: [
                    { channelDigestOptIn: true },
                    { notificationPreferences: { some: { delivery: 'DAILY_DIGEST' } } },
                ],
            },
            select: { id: true, uiLanguage: true, channelDigestSentOn: true },
            take: 5_000,
        }),
    );
    reading.candidates = candidates.length;

    const todayFloor = farmTodayFloor(now);

    /*
     * THE CLOCK GATE IS THE SAME INSTANT FOR EVERYBODY — local 07:15 passes
     * once — so it is asked ONCE, before the loop, and the run leaves.
     *
     * Two reasons it is not a per-person `continue` inside the loop. It would
     * be a second clock read against a `now` that has since moved, so a run
     * straddling 07:15 would send to some of its candidates and not others —
     * a flake rather than a policy. And a loop that iterates every candidate
     * to skip them all is the shape that later grows a send inside it: the
     * first draft of this file did exactly that, and removing the `continue`
     * while leaving the loop in place would have sent every digest at
     * midnight with nothing failing.
     *
     * The reading is still emitted, so a run before 07:15 reports
     * `dueNow: false` BESIDE its candidate count rather than looking like a
     * run that found nobody.
     */
    const dueNow = digestDueAt(now);
    if (!dueNow) {
        logger.info('channel_digest.reading', {
            component: 'channel-digest', day: today, dueNow, ...reading,
        });
        return reading;
    }

    for (const person of candidates) {
        // Already sent today. A DATE comparison, so a person whose digest went
        // out at 07:15 is not pushed again at 07:30.
        if (person.channelDigestSentOn
            && person.channelDigestSentOn.getTime() >= todayFloor.getTime()) {
            continue;
        }
        reading.due += 1;

        const since = new Date(now.getTime() - DIGEST_WINDOW_HOURS * 3600_000);
        // The SAME read «За Вас» serves, so the digest cannot disagree with the
        // surface it points at — a second spelling of "what happened to you"
        // is the #1664 class.
        const activity = await readMyActivity(
            { requestId: `digest-${person.id}`, userId: person.id, email: '' },
            { limit: 50 },
        );
        const fresh = activity.items.filter(
            (i) => new Date(i.post.createdAt).getTime() >= since.getTime(),
        );

        if (fresh.length === 0) {
            // NOTHING TO SAY, so nothing is sent — and `channelDigestSentOn`
            // is left alone. Stamping it would mean a person who had no
            // activity at 07:15 could not receive one later the same day if
            // the job were re-run after a fix.
            continue;
        }
        reading.withActivity += 1;

        const locale = resolveRecipientLocale(person.uiLanguage);
        // The count AFTER a label, because `translateFor` is a plain
        // interpolator with no ICU: a plural form would come back as the
        // literal template.
        const pushBody = await translateFor(locale, 'notifications.person.digest.body', {
            count: fresh.length,
        });

        await enqueue('person-push-send', {
            recipientUserId: person.id,
            title: await translateFor(locale, 'notifications.person.digest.title'),
            body: pushBody,
            // The person-scoped surface the digest is ABOUT. One destination
            // for any count, unlike #3020's summary — a digest is a recap of
            // many things by definition, so there is no exactly-one case.
            farmRelativePath: '/channels/for-you',
            // Per DAY, so a re-run cannot stack a second banner.
            collapseKey: `channel-digest-${today}`,
        });

        await runWithoutRls({ reason: 'channel-digest' }, (db) =>
            db.user.update({
                where: { id: person.id },
                data: { channelDigestSentOn: todayFloor },
            }),
        );
        reading.sent += 1;
    }

    logger.info('channel_digest.reading', {
        component: 'channel-digest',
        day: today,
        dueNow,
        ...reading,
    });

    return reading;
}
