/**
 * Deliver one PERSON-SCOPED notification to one person's devices — #2987.
 *
 * The tenantless sibling of `push-send`. A channel mention, a channel reply
 * and a direct message have no farm — P9.1's five channel tables and P8.1's
 * four DM tables carry no `tenantId`, deliberately — so every step of the
 * existing push path is unavailable to them:
 *
 *   `Notification.tenantId`            NOT NULL
 *   `PushSubscription.tenantId`        NOT NULL, one row per (tenant, user, endpoint)
 *   `UserNotificationPreference`       one row per (user, tenant)
 *   `sendApnsToUser` / `…WebPush…`     bind RLS through `runInTenantContext`
 *   `push-send` / `push-summary`       keyed on a tenant, including the jobId
 *
 * Resolving a tenant from the recipient is the mistake P5.4a names for
 * `NotificationOutbox` — "resolving one would invent a tenant for a
 * person-scoped obligation" — and here it would also pick WRONG: the
 * registration route is tenant-scoped, so a person in three farms may hold a
 * `PushSubscription` row under only the farm they happened to be in when the
 * device registered.
 *
 * ## Its own queue, like its sibling
 *
 * `PUSH_QUEUE_JOBS`, for `push-send`'s reason: a fan-out on the main worker
 * would consume its 50/min limiter budget and starve every other job type for
 * the rest of the minute — including the outbox sweep, which is how
 * notifications reach email at all.
 *
 * ## ONE job per recipient, never a fan-out over people
 *
 * `push-send`'s rule, and it matters more here: BullMQ retries a whole job, so
 * a failure for one person must not re-send to the others. A channel post may
 * mention five people; that is five jobs.
 *
 * ## QUIET HOURS SUPPRESS HERE RATHER THAN DEFERRING, and that is a GAP
 *
 * `push-send` defers to 06:00 by enqueuing ONE `push-summary` for the night,
 * which then reads the person's unread `Notification` rows for that tenant.
 * A tenantless event writes NO `Notification` row — it cannot, the column is
 * NOT NULL — so there would be nothing for a summary to count. A person
 * summary enqueued here would wake somebody at 06:00 to tell them about
 * zero things.
 *
 * So inside the window the push is SUPPRESSED, and the person finds the
 * message when they next open the app: the SSE frame and the REST read are
 * both unaffected. That is strictly better than today, where the push does not
 * exist at all and the window therefore changes nothing — but it IS a hole,
 * and **#3020 carries it** rather than this docblock being the only record.
 * Closing it needs a durable record of tenantless notifications, which is
 * #2990's territory (the read cursor) and not a line of code here.
 *
 * ## The payload carries no free text
 *
 * `title` and `body` are composed from catalogue copy by the caller, never
 * from a message. `push-payload-carries-no-free-text` is the control, and it
 * is a CHOICE here rather than a consequence: `DirectMessage.body` is
 * encrypted at rest, but `ChannelPost.body` is plaintext (P9.1, so P9.7 can
 * search it), so nothing would have stopped a channel post's prose going
 * through Redis and APNs.
 */
import { resolvePersonDelivery } from '@/app-layer/notifications/person-delivery';
import { sendApnsToPerson } from '@/lib/notifications/apns';
import { sendWebPushToPerson } from '@/lib/notifications/web-push';
import { logger } from '@/lib/observability/logger';

export interface PersonPushSendInput {
    /** The person being notified — never the actor. */
    recipientUserId: string;
    title: string;
    body: string;
    /** Root-relative, or null for a notification with no target. */
    link: string | null;
    /**
     * One key for both transports: the Web Push `tag` and the APNs
     * `apns-collapse-id`. A second notification about the same subject
     * supersedes the first rather than stacking — so a channel that is busy
     * does not produce a column of identical banners.
     */
    collapseKey: string;
}

export interface PersonPushSendResult {
    attempted: number;
    delivered: number;
}

export async function runPersonPushSend(
    input: PersonPushSendInput,
): Promise<PersonPushSendResult> {
    const { recipientUserId, title, body, link, collapseKey } = input;

    const decision = await resolvePersonDelivery(recipientUserId, new Date());

    if (decision.deferral !== null) {
        // See the docblock: there is nothing to summarise, so this is a
        // SUPPRESSION with the deferral's own reason attached rather than a
        // silent drop. Logged at info with the night key, so the volume held
        // back by the window is countable — which is the evidence #3020 needs.
        logger.info('person-push.suppressed', {
            component: 'person-push',
            collapseKey,
            reason: decision.suppressedBecause,
            nightKey: decision.deferral.nightKey,
            // No prose: the payload is displayed copy.
        });
        return { attempted: 0, delivered: 0 };
    }

    if (!decision.webPush && !decision.apns) {
        logger.info('person-push.suppressed', {
            component: 'person-push',
            collapseKey,
            reason: decision.suppressedBecause,
        });
        return { attempted: 0, delivered: 0 };
    }

    let attempted = 0;
    let delivered = 0;

    const wanted = [
        ...(decision.webPush ? (['web'] as const) : []),
        ...(decision.apns ? (['apns'] as const) : []),
    ];

    for (const transport of wanted) {
        attempted += 1;
        // #2171's lesson, inherited rather than rediscovered: the OUTCOME, not
        // the absence of a throw. Neither transport throws — both catch per
        // device and return counts — so `delivered += 1` inside a try would
        // have counted every call that returned, including an unconfigured
        // transport that sent nothing.
        const outcome =
            transport === 'web'
                ? await sendWebPushToPerson(recipientUserId, {
                      title,
                      body,
                      // `?? undefined`, because the payload spells "no target"
                      // as null and both transports spell it absent. Passing
                      // null through would be a literal "null" href.
                      url: link ?? undefined,
                      tag: collapseKey,
                  })
                : await sendApnsToPerson(recipientUserId, {
                      title,
                      body,
                      link: link ?? undefined,
                      collapseId: collapseKey,
                  });

        if (outcome.sent > 0) delivered += 1;
        else if (outcome.retryable > 0) {
            logger.warn('person-push.transport_failed', {
                component: 'person-push',
                transport,
                collapseKey,
                retryable: outcome.retryable,
            });
        }
    }

    return { attempted, delivered };
}
