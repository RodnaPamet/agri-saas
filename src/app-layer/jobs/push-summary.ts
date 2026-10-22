/**
 * One push at 06:00 for everything the quiet window held back — P7.5 (#1994).
 *
 * ## Why a count and not a replay
 *
 * The owner ruled on 2026-10-21 that a suppressed push is DELIVERED when the
 * window ends, as ONE summary rather than N banners — ten notifications held
 * overnight must not become ten buzzes at 06:00, which is the pile-up quiet
 * hours exists to prevent, merely moved six hours.
 *
 * So this sends "Имате N нови известия" and opens the bell. The N is counted
 * when the job runs, from `Notification` rows that already exist — not from a
 * list assembled as they arrived. A stored list would need keeping in step
 * with reads, so somebody who cleared their bell at 02:00 would still be told
 * about ten things; a count at fire time cannot drift because there is nothing
 * to drift from. It is also why this job carries only a night key.
 *
 * ## Only what the window suppressed
 *
 * Bounded to `[22:00, 06:00)` of the night the key names, not "everything
 * unread". A notification from 21:00 already pushed normally, so including it
 * would buzz a second time about something the person may have read and
 * dismissed — the owner's second ruling, and the reason
 * `quietWindowBounds` takes the key rather than `Date.now()`: by the time this
 * runs, now is 06:00 and OUTSIDE the window it has to describe.
 *
 * ## Zero is not a failure
 *
 * A count of zero is the ordinary outcome when the person read their bell
 * overnight, and it sends nothing. That is the case worth not getting wrong:
 * "Имате 0 нови известия" at six in the morning is the push this whole design
 * is meant to avoid.
 */
import type { PushSummaryPayload } from './types';
import type { RequestContext } from '../types';
import { getPermissionsForRole } from '@/lib/permissions';
import { runInTenantContext } from '@/lib/db-context';
import { prisma } from '@/lib/prisma';
import { quietWindowBounds } from '@/lib/notifications/quiet-hours';
import { resolveDelivery } from '@/app-layer/notifications/resolve-delivery';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { translateFor } from '@/lib/i18n/server-messages';
import { sendWebPushToUser } from '@/lib/notifications/web-push';
import { sendApnsToUser } from '@/lib/notifications/apns';
import { logger } from '@/lib/observability/logger';

function makeSystemCtx(tenantId: string, recipientUserId: string): RequestContext {
    return {
        requestId: `push-summary-${tenantId}-${recipientUserId}`,
        userId: 'system',
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: false },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

export interface PushSummaryResult {
    /** Notifications the window suppressed that are still unread. */
    count: number;
    /** Transports that accepted the summary. Zero when `count` is zero. */
    delivered: number;
}

export async function runPushSummary(payload: PushSummaryPayload): Promise<PushSummaryResult> {
    const { tenantId, recipientUserId, nightKey } = payload;
    const ctx = makeSystemCtx(tenantId, recipientUserId);
    const { start, end } = quietWindowBounds(nightKey);

    const { count, preference, devices } = await runInTenantContext(ctx, async (db) => {
        const n = await db.notification.count({
            where: {
                userId: recipientUserId,
                // RLS scopes the tenant; `userId` is named because a tenant's
                // notifications are per-person and one member must not be
                // summarised another's.
                createdAt: { gte: start, lt: end },
                read: false,
            },
        });
        const pref = await db.userNotificationPreference.findUnique({
            where: { userId_tenantId: { userId: recipientUserId, tenantId } },
            select: { delivery: true },
        });
        const rows = await db.pushSubscription.groupBy({
            by: ['platform'],
            where: { userId: recipientUserId },
            _count: { _all: true },
        });
        const countOf = (pl: 'WEB' | 'IOS') =>
            rows.find((r) => r.platform === pl)?._count._all ?? 0;
        return {
            count: n,
            preference: pref?.delivery ?? null,
            devices: { web: countOf('WEB'), ios: countOf('IOS') },
        };
    });

    if (count === 0) {
        logger.info('push.summary_empty', {
            component: 'push',
            nightKey,
        });
        return { count: 0, delivered: 0 };
    }

    // Asked AGAIN, at 06:00, and this is not belt-and-braces. The night is
    // eight hours long: somebody can turn push off at 23:00, and a summary
    // that only re-checked the clock would deliver at 06:00 exactly the push
    // they had just refused. So every producer goes through `resolveDelivery`
    // and `tests/guards/one-resolve-delivery.test.ts` holds that to be true —
    // "one" is the requirement in #1994, and a second producer deciding for
    // itself is how the single decision point stops being one.
    const decision = resolveDelivery({ preference, now: new Date(), devices });

    if (decision.deferral !== null) {
        // Only reachable if this job ran so late that it landed inside the
        // NEXT night's window — a backlog of eight hours or more. Logged and
        // dropped rather than re-deferred: chaining a summary into the
        // following night would announce a window two nights old, and the
        // rows it describes are still in the bell either way.
        logger.warn('push.summary_too_late', {
            component: 'push',
            nightKey,
            count,
        });
        return { count, delivered: 0 };
    }

    if (!decision.webPush && !decision.apns) {
        logger.info('push.summary_suppressed', {
            component: 'push',
            nightKey,
            count,
            reason: decision.suppressedBecause,
        });
        return { count, delivered: 0 };
    }

    // The recipient's own language. Read OUTSIDE the tenant context: `User` is
    // a global table with no tenantId, so a tenant-scoped transaction is the
    // wrong lens for it — and `uiLanguage` is a property of the person, not of
    // their membership.
    const user = await prisma.user.findUnique({
        where: { id: recipientUserId },
        select: { uiLanguage: true },
    });
    const locale = resolveRecipientLocale(user?.uiLanguage);

    const title = await translateFor(locale, 'push.quietSummary.title');
    // Two keys rather than one with an ICU plural. `translateFor`'s
    // interpolation is a plain `{name}` replacement — it does not evaluate
    // `{count, plural, …}`, so an ICU key reached from a job renders the raw
    // syntax. The existing server-rendered keys dodge this by using one form
    // for every count (`{count} записа`), which reads wrong at one; a push
    // whose whole body is a number deserves the grammatical form, and a count
    // of exactly one is the common case rather than an edge.
    const body = await translateFor(
        locale,
        count === 1 ? 'push.quietSummary.bodyOne' : 'push.quietSummary.bodyMany',
        { count },
    );

    let delivered = 0;
    const failures: string[] = [];
    const wanted = [
        ...(decision.webPush ? (['web'] as const) : []),
        ...(decision.apns ? (['apns'] as const) : []),
    ];
    for (const transport of wanted) {
        try {
            // #2171 — the same correction as `push-send`: `delivered += 1`
            // after a call that cannot throw counted transport functions that
            // returned, so this job's `push.summary_sent` line reported every
            // wanted transport as delivered and `failures: 0` always, however
            // many devices actually failed.
            const outcome =
                transport === 'web'
                    ? await sendWebPushToUser(ctx, recipientUserId, {
                          title,
                          body,
                          // The bell, not a specific task: the summary is
                          // about several notifications and there is no single
                          // target.
                          url: '/notifications',
                          // One collapse key per night, so a retry or a second
                          // process cannot stack two summaries for one window.
                          tag: `quiet-summary-${nightKey}`,
                      })
                    : await sendApnsToUser(ctx, recipientUserId, {
                          title,
                          body,
                          link: '/notifications',
                          collapseId: `quiet-summary-${nightKey}`,
                      });
            if (outcome.sent > 0) delivered += 1;
            if (outcome.retryable > 0) {
                failures.push(`${transport}: ${outcome.retryable} device send(s) failed`);
            }
        } catch (err) {
            failures.push(`${transport}: threw — ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    logger.info('push.summary_sent', {
        component: 'push',
        // The count and the night, never the prose: a summary's body is
        // displayed copy and Epic C.4 keeps that out of logs.
        nightKey,
        count,
        delivered,
        failures: failures.length,
    });

    // Deliberately does NOT throw when both transports failed, unlike
    // `push-send`. This job has `attempts: 1` — see `JOB_DEFAULTS` — because a
    // retry would either re-send the same summary seconds later or send one
    // about a window that has since closed. Throwing would buy a failure count
    // and no delivery, so the failure is logged and the bell remains the
    // fallback it has been all night.
    return { count, delivered };
}
