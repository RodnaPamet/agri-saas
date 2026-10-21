/**
 * Deliver one notification to one person's devices — P7.4 (#1993).
 *
 * ## Why this is a job and not two awaited calls
 *
 * Until now a task assignment awaited both transports inside the request that
 * created it: `sendWebPushToUser` then `sendApnsToUser`, each fanning out to
 * every device the person holds. Both are HTTP calls to third parties — a push
 * service and Apple — so the person doing the assigning paid for the latency of
 * the person being assigned to, and an Apple outage would show up as a slow
 * "Assign" button.
 *
 * It was already post-commit and fire-and-forget (`emitTaskDueNotification`
 * runs after the task's transaction and swallows its own failures), so moving
 * it onto a queue changes no transactional property. What it changes is who
 * waits.
 *
 * ## Why its own queue, and not the main one
 *
 * The main worker runs `concurrency: 5` with `limiter: { max: 50, duration:
 * 60000 }`. A fan-out that consumed that budget would starve every other job
 * type for the rest of the minute — and the jobs it would starve include the
 * outbox sweep, which is how notifications reach email at all.
 *
 * The precedent is `SOIL_QUEUE_NAME`: a dedicated queue exists there for the
 * same shape of reason (an external fair-use budget that must not throttle
 * unrelated work). This copies it rather than inventing a second mechanism.
 *
 * ## What it does NOT do
 *
 * Decide whether to send. Preferences, quiet hours and cross-device dedup are
 * P7.5 (#1994) and belong in one `resolveDelivery()` rather than scattered
 * across producers — so this job sends what it is given, and the two
 * `isXConfigured()` gates inside each transport remain the only suppression.
 *
 * It also does not fan out to several PEOPLE. One job per recipient keeps a
 * retry honest: a failure for one person must not re-send to the others, and
 * BullMQ retries a whole job. #2103 (bulk assignment notifies nobody) is the
 * change that will produce many of these, which is why it waits for this.
 */
import type { PushSendPayload } from './types';
import type { RequestContext } from '../types';
import { getPermissionsForRole } from '@/lib/permissions';
import { sendWebPushToUser } from '@/lib/notifications/web-push';
import { sendApnsToUser } from '@/lib/notifications/apns';
import { logger } from '@/lib/observability/logger';

/**
 * A system RequestContext scoped to a tenant.
 *
 * Same shape as `classify-photo`'s. Both transports only READ
 * `PushSubscription` under RLS and then write prune deletions, so an ADMIN
 * system context is what the tenant-scoped read needs; the recipient is named
 * explicitly in each query rather than inferred from the context.
 */
function makeSystemCtx(tenantId: string, recipientUserId: string): RequestContext {
    return {
        requestId: `push-send-${tenantId}-${recipientUserId}`,
        userId: 'system',
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: false },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

export interface PushSendResult {
    /** Transports attempted — 2 unless one is unconfigured. */
    attempted: number;
    /** Transports that returned without throwing. */
    delivered: number;
}

/**
 * Send one payload to one person over both transports.
 *
 * Each transport is attempted independently and a failure in one does not stop
 * the other: a person may hold a phone and a browser, and an APNs outage must
 * not cost them the web notification. Both already swallow per-device failures
 * internally and prune dead endpoints, so what reaches here is a transport that
 * could not be used at all.
 *
 * Throws only if BOTH failed, which is what makes a BullMQ retry meaningful —
 * retrying because one of two transports was briefly unavailable would re-send
 * the one that already arrived.
 */
export async function runPushSend(payload: PushSendPayload): Promise<PushSendResult> {
    const { tenantId, recipientUserId, title, body, link, collapseKey } = payload;
    const ctx = makeSystemCtx(tenantId, recipientUserId);

    let attempted = 0;
    let delivered = 0;
    const failures: string[] = [];

    for (const transport of ['web', 'apns'] as const) {
        attempted += 1;
        try {
            if (transport === 'web') {
                await sendWebPushToUser(ctx, recipientUserId, {
                    title,
                    body,
                    // `?? undefined`, because the payload says `null` for "no
                    // target" and both transports spell that absent. Passing
                    // `null` through would be a type error here and, worse,
                    // a literal "null" href if either ever stringified it.
                    url: link ?? undefined,
                    tag: collapseKey,
                });
            } else {
                await sendApnsToUser(ctx, recipientUserId, {
                    title,
                    body,
                    link: link ?? undefined,
                    collapseId: collapseKey,
                });
            }
            delivered += 1;
        } catch (err) {
            failures.push(
                `${transport}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    if (delivered === 0 && failures.length > 0) {
        // Both failed. Thrown so BullMQ retries — and the message names both
        // causes, because "push failed" with one transport's error would send
        // whoever reads it looking in the wrong place.
        throw new Error(`push-send failed on every transport — ${failures.join('; ')}`);
    }

    if (failures.length > 0) {
        logger.warn('push.transport_failed', {
            component: 'push',
            // No title, body or link: a push payload is the notification's
            // prose and `Epic C.4` keeps displayed copy out of logs. The
            // collapse key identifies the subject without quoting it.
            collapseKey,
            failures: failures.length,
            detail: failures.join('; '),
        });
    }

    return { attempted, delivered };
}
