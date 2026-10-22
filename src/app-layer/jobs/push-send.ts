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
 * ## It asks `resolveDelivery` rather than deciding — P7.5 (#1994)
 *
 * The decision is made HERE, when the send is attempted, and not at the
 * enqueue site. A job that sat behind a backlog would otherwise act on a
 * decision taken minutes earlier — which matters precisely at 22:00, where a
 * notification created at 21:59 and processed at 22:01 should be held, and the
 * reverse at 06:00.
 *
 * When the window holds it back, this enqueues ONE `push-summary` job for the
 * night instead, keyed so the fifth notification of the night cannot schedule
 * a fifth summary.
 *
 * It also does not fan out to several PEOPLE. One job per recipient keeps a
 * retry honest: a failure for one person must not re-send to the others, and
 * BullMQ retries a whole job. #2103 (bulk assignment notifies nobody) is the
 * change that will produce many of these, which is why it waits for this.
 */
import type { PushSendPayload } from './types';
import type { RequestContext } from '../types';
import { getPermissionsForRole } from '@/lib/permissions';
import { runInTenantContext } from '@/lib/db-context';
import { resolveDelivery } from '@/app-layer/notifications/resolve-delivery';
import { enqueue } from './queue';
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

    // One tenant-scoped read for both inputs the decision needs. Counting
    // devices here rather than letting each transport discover it lets the
    // decision say "no devices" once, instead of two transports each querying
    // and each returning quietly — and a log line of "attempted 2, delivered
    // 0" that means nothing was reachable reads exactly like one where both
    // calls failed.
    const { preference, devices } = await runInTenantContext(ctx, async (db) => {
        const pref = await db.userNotificationPreference.findUnique({
            where: { userId_tenantId: { userId: recipientUserId, tenantId } },
            select: { delivery: true },
        });
        const rows = await db.pushSubscription.groupBy({
            by: ['platform'],
            where: { userId: recipientUserId },
            _count: { _all: true },
        });
        const countOf = (p: 'WEB' | 'IOS') =>
            rows.find((r) => r.platform === p)?._count._all ?? 0;
        return {
            preference: pref?.delivery ?? null,
            devices: { web: countOf('WEB'), ios: countOf('IOS') },
        };
    });

    const decision = resolveDelivery({ preference, now: new Date(), devices });

    if (decision.deferral !== null) {
        const { at, nightKey } = decision.deferral;
        // `jobId` makes this idempotent across every notification of the
        // night AND across processes: BullMQ refuses a duplicate id, so
        // "ensure one summary" is a single `add` rather than a
        // read-modify-write that two workers could interleave.
        await enqueue(
            'push-summary',
            { tenantId, recipientUserId, nightKey },
            { jobId: `push-summary:${tenantId}:${recipientUserId}:${nightKey}`, delay: Math.max(0, at.getTime() - Date.now()) },
        );
        logger.info('push.deferred', {
            component: 'push',
            // No prose: the payload is displayed copy.
            collapseKey,
            nightKey,
            reason: decision.suppressedBecause,
        });
        return { attempted: 0, delivered: 0 };
    }

    if (!decision.webPush && !decision.apns) {
        logger.info('push.suppressed', {
            component: 'push',
            collapseKey,
            reason: decision.suppressedBecause,
        });
        return { attempted: 0, delivered: 0 };
    }

    let attempted = 0;
    let delivered = 0;
    const failures: string[] = [];

    const wanted = [
        ...(decision.webPush ? (['web'] as const) : []),
        ...(decision.apns ? (['apns'] as const) : []),
    ];
    /** Device sends that failed for a reason another attempt could fix. */
    let retryable = 0;

    for (const transport of wanted) {
        attempted += 1;
        try {
            // #2171 — the OUTCOME, not the absence of a throw.
            //
            // This read `await send…(); delivered += 1;` inside a try whose
            // catch could never fire: neither transport throws, both catch
            // per device and return. So `delivered` counted transport
            // functions that returned, `failures` was always empty, and the
            // two branches below were unreachable — measured in production as
            // two `apns.send_threw` against ZERO `push.transport_failed`,
            // with this job reporting success and never spending `attempts: 3`.
            const outcome =
                transport === 'web'
                    ? await sendWebPushToUser(ctx, recipientUserId, {
                          title,
                          body,
                          // `?? undefined`, because the payload says `null` for
                          // "no target" and both transports spell that absent.
                          // Passing `null` through would be a type error here
                          // and, worse, a literal "null" href if either ever
                          // stringified it.
                          url: link ?? undefined,
                          tag: collapseKey,
                      })
                    : await sendApnsToUser(ctx, recipientUserId, {
                          title,
                          body,
                          link: link ?? undefined,
                          collapseId: collapseKey,
                      });

            // A transport counts as delivered when at least one DEVICE
            // accepted. That is what makes `attempted - delivered` the
            // "skipped" the executor documents — an unconfigured transport,
            // or one whose every device failed, is now attempted and not
            // delivered rather than silently both.
            if (outcome.sent > 0) delivered += 1;
            if (outcome.retryable > 0) {
                retryable += outcome.retryable;
                // COUNTS, never a message from the transport: a failure
                // string is about to be logged and thrown, and a push
                // payload's prose is displayed copy (Epic C.4).
                failures.push(`${transport}: ${outcome.retryable} device send(s) failed`);
            }
        } catch (err) {
            // Kept as a backstop, not as the mechanism. Neither transport
            // throws today; if a future one does, that is a bug worth
            // retrying rather than swallowing.
            retryable += 1;
            failures.push(
                `${transport}: threw — ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    if (delivered === 0 && retryable > 0) {
        // Nothing arrived anywhere AND something failed in a way a retry could
        // fix. Thrown so BullMQ retries — and the message names every
        // transport, because "push failed" with one transport's cause would
        // send whoever reads it looking in the wrong place.
        //
        // The `retryable > 0` half is what keeps the retry honest: a recipient
        // with a registered device and no configured transport, or one whose
        // only device is dead and pruned, delivers nothing and must NOT burn
        // three attempts discovering that again.
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
