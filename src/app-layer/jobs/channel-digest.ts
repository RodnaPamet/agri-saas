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
import { farmToday } from '@/lib/calendar-day-key';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { translateFor } from '@/lib/i18n/server-messages';
import { logger } from '@/lib/observability/logger';

/** The local hour and minute the digest is promised for. */
export const DIGEST_HOUR = 7;
export const DIGEST_MINUTE = 15;

/** How far back a digest looks. */
export const DIGEST_WINDOW_HOURS = 24;

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
 * Has the person's local 07:15 passed, on the day `now` falls in?
 *
 * Exported and PURE, so the boundary is testable without a database — and the
 * test uses an instant whose UTC hour and Sofia hour differ, because every
 * other instant passes either way. That is the `chatDayKey` precedent.
 */
export function digestDueAt(now: Date): boolean {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Sofia',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return hour > DIGEST_HOUR || (hour === DIGEST_HOUR && minute >= DIGEST_MINUTE);
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
                deletedAt: null,
                suspendedAt: null,
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

    // The clock gate is the SAME for everybody — 07:15 Europe/Sofia passes at
    // one instant — so it is asked once rather than per person.
    const dueNow = digestDueAt(now);
    const todayFloor = new Date(`${today}T00:00:00.000Z`);

    for (const person of candidates) {
        if (!dueNow) continue;
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
