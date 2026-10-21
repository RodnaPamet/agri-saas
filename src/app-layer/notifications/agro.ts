/**
 * Agro-intel in-app notifications — spray-window warnings + disease-risk
 * escalations fired by the daily `weather-pull` job's signal evaluator.
 *
 * Modelled exactly on `createAssignmentNotification` (assignment.ts):
 *   - `db.notification.createMany({ skipDuplicates: true })` so a
 *     duplicate dedupeKey returns count=0 with NO exception (raw
 *     `create` throws P2002 which poisons interactive PG transactions).
 *   - dedupeKey shape `{tenantId}:{TYPE}:{entityId}:{userId}:{date}` so
 *     the same location/recipient/day collapses to one bell row —
 *     a second backstop beneath the AgroSignal unique key.
 *
 * These use the existing `GENERAL` NotificationType rather than minting
 * new enum values: the row's title/message carry the agro semantics and
 * the link drops the recipient on the location's detail page. Keeping to
 * `GENERAL` means no schema migration is needed for the notification
 * surface.
 *
 * Fire-and-forget — callers isolate the write in its own transaction so
 * a notification failure never rolls back the signal/Risk write.
 */

import type { PrismaClient } from '@prisma/client';
import { publishFreshNotifications } from './publish-fresh';

export type AgroNotificationKind = 'SPRAY_WINDOW_WARNING' | 'DISEASE_RISK_RAISED' | 'AGRO_COPILOT_READY';

export interface AgroNotificationTarget {
    tenantId: string;
    /** Recipient — the location owner, or the job's admin fallback. */
    recipientUserId: string;
    /** Location the signal is for — also the deep-link target + dedupe entity. */
    locationId: string;
    /** Display label (location name). */
    locationLabel: string;
    /** Tenant slug for the deep link. */
    tenantSlug: string;
    /** Short reason summary for the notification body. */
    detail?: string | null;
}

interface AgroCopy {
    title: string;
    body: (label: string, detail?: string | null) => string;
}

const COPY: Record<AgroNotificationKind, AgroCopy> = {
    SPRAY_WINDOW_WARNING: {
        title: 'Spray window unsuitable',
        body: (label, detail) =>
            `Today's conditions at ${label} are unsuitable for spraying${detail ? ` — ${detail}` : '.'}`,
    },
    DISEASE_RISK_RAISED: {
        title: 'Disease pressure rising',
        body: (label, detail) =>
            `High disease pressure detected at ${label}${detail ? ` — ${detail}` : '.'} A risk has been raised.`,
    },
    AGRO_COPILOT_READY: {
        title: 'Agronomy copilot explanation',
        body: (label, detail) =>
            `An agronomy explanation is ready for ${label}${detail ? ` — ${detail}` : '.'}`,
    },
};

/**
 * Build the idempotency key. Pure helper so tests can assert the format.
 * Day granularity in UTC — a same-day re-run shouldn't double-notify.
 */
export function buildAgroDedupeKey(
    tenantId: string,
    kind: AgroNotificationKind,
    locationId: string,
    userId: string,
    now: Date = new Date(),
): string {
    const ymd = now.toISOString().slice(0, 10);
    return `${tenantId}:${kind}:${locationId}:${userId}:${ymd}`;
}

export interface AgroNotificationOutcome {
    status: 'created' | 'duplicate';
    /** Notification copy, present only when `status === 'created'` (for Web Push fan-out). */
    notification?: { title: string; message: string; linkUrl: string };
}

export async function createAgroSignalNotification(
    db: Pick<PrismaClient, 'notification'>,
    kind: AgroNotificationKind,
    target: AgroNotificationTarget,
    now: Date = new Date(),
): Promise<AgroNotificationOutcome> {
    const copy = COPY[kind];
    const dedupeKey = buildAgroDedupeKey(
        target.tenantId,
        kind,
        target.locationId,
        target.recipientUserId,
        now,
    );
    const row = {
        tenantId: target.tenantId,
        userId: target.recipientUserId,
        // Reuse GENERAL — no enum migration; semantics ride the title/body.
        type: 'GENERAL' as const,
        title: copy.title,
        message: copy.body(target.locationLabel, target.detail),
        linkUrl: `/t/${target.tenantSlug}/locations/${target.locationId}`,
        dedupeKey,
    };

    const result = await db.notification.createMany({
        data: [row],
        skipDuplicates: true,
    });

    if (result.count > 0) {
        await publishFreshNotifications(db, 'notify.agro', [
            { tenantId: target.tenantId, userId: target.recipientUserId, dedupeKey: row.dedupeKey },
        ]);
    }

    return result.count > 0
        ? { status: 'created', notification: { title: row.title, message: row.message, linkUrl: row.linkUrl } }
        : { status: 'duplicate' };
}
