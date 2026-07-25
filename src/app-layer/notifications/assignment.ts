/**
 * 2026-05-27 — Notification streaming/alerts roadmap PR-A.
 *
 * In-app notifications for task + control assignment. Today the
 * task-assignment path enqueues only an EMAIL via the
 * NotificationOutbox; nothing reaches the bell. The control-owner
 * path doesn't emit any notification at all. This module unifies
 * both: a single `createAssignmentNotification` function that the
 * caller drives with a typed payload.
 *
 * Mirrors the shape of `createTaskDueNotification` (task-due.ts):
 *   - `db.notification.createMany({ skipDuplicates: true })` so
 *     a duplicate dedupeKey returns count=0 with NO exception
 *     (raw `create` throws P2002 which poisons interactive PG
 *     transactions).
 *   - dedupeKey shape `{tenantId}:{TYPE}:{entityId}:{userId}:{date}`
 *     so the same user being assigned the same entity twice in
 *     one day collapses to a single bell notification — matching
 *     the existing TASK_ASSIGNED email idempotency.
 *
 * Fire-and-forget — callers must isolate the write in its own
 * transaction (see `assignTask` and `setControlOwner` paths) so a
 * notification failure never rolls back the parent operation.
 */

import type { PrismaClient } from '@prisma/client';
import { publishNotificationEvent } from '@/lib/notifications/notification-bus';

export interface AssignmentTarget {
    /** Tenant the entity belongs to. */
    tenantId: string;
    /** Recipient — the new assignee/owner. */
    assigneeUserId: string;
    /** Entity being assigned. */
    entityId: string;
    /** Display label for the notification body. */
    entityLabel: string;
    /** Optional key for the body (e.g. `T-123` for tasks, control code). */
    entityKey?: string | null;
    /** Tenant slug for the deep link. */
    tenantSlug: string;
}

export type AssignmentNotificationKind =
    | 'TASK_ASSIGNED'
    | 'CONTROL_ASSIGNED'
    | 'RISK_ASSIGNED'
    | 'ASSET_ASSIGNED';

interface AssignmentCopy {
    title: string;
    body: (label: string) => string;
    linkPath: (tenantSlug: string, entityId: string) => string;
}

const COPY: Record<AssignmentNotificationKind, AssignmentCopy> = {
    TASK_ASSIGNED: {
        title: 'You were assigned a task',
        body: (label) => `${label} is now yours.`,
        linkPath: (slug, id) => `/t/${slug}/farm-tasks/${id}`,
    },
    CONTROL_ASSIGNED: {
        title: 'You were assigned a control',
        body: (label) => `${label} is now yours.`,
        linkPath: (slug, id) => `/t/${slug}/controls/${id}`,
    },
    RISK_ASSIGNED: {
        title: 'You were assigned a risk',
        body: (label) => `${label} is now yours.`,
        linkPath: (slug, id) => `/t/${slug}/risks/${id}`,
    },
    ASSET_ASSIGNED: {
        title: 'You were assigned an asset',
        body: (label) => `${label} is now yours.`,
        linkPath: (slug, id) => `/t/${slug}/assets/${id}`,
    },
};

/**
 * Build the idempotency key. Pure helper so tests can assert the
 * format directly.
 */
export function buildAssignmentDedupeKey(
    tenantId: string,
    kind: AssignmentNotificationKind,
    entityId: string,
    userId: string,
    now: Date = new Date(),
): string {
    // Day granularity in UTC — re-assigning the same user to the
    // same entity within one day shouldn't double-notify the bell.
    const ymd = now.toISOString().slice(0, 10);
    return `${tenantId}:${kind}:${entityId}:${userId}:${ymd}`;
}

export interface AssignmentNotificationOutcome {
    status: 'created' | 'duplicate';
    /**
     * The notification copy, present only when `status === 'created'`. Lets
     * the caller fan the same alert out to other channels (Web Push) without
     * rebuilding the title/body/link.
     */
    notification?: { title: string; message: string; linkUrl: string };
}

export async function createAssignmentNotification(
    db: Pick<PrismaClient, 'notification'>,
    kind: AssignmentNotificationKind,
    target: AssignmentTarget,
    now: Date = new Date(),
): Promise<AssignmentNotificationOutcome> {
    const copy = COPY[kind];
    const label = target.entityKey
        ? `${target.entityKey} "${target.entityLabel}"`
        : `"${target.entityLabel}"`;

    const row = {
        tenantId: target.tenantId,
        userId: target.assigneeUserId,
        type: kind,
        title: copy.title,
        message: copy.body(label),
        linkUrl: copy.linkPath(target.tenantSlug, target.entityId),
        dedupeKey: buildAssignmentDedupeKey(
            target.tenantId,
            kind,
            target.entityId,
            target.assigneeUserId,
            now,
        ),
    };

    const result = await db.notification.createMany({
        data: [row],
        skipDuplicates: true,
    });

    // 2026-05-28 — fan the fresh insert out to the SSE bus (set up
    // by PR-C #761) so subscribed bell clients see the assignment
    // alert the moment it lands, not on the next 60s poll. Skip
    // when result.count === 0 — that means the dedupeKey collapsed
    // a duplicate, and we already pushed the original.
    if (result.count > 0) {
        publishNotificationEvent(target.tenantId, target.assigneeUserId, {
            id: row.dedupeKey,
            type: row.type,
            title: row.title,
            message: row.message,
            read: false,
            linkUrl: row.linkUrl,
            createdAt: now.toISOString(),
        });
    }

    return result.count > 0
        ? { status: 'created', notification: { title: row.title, message: row.message, linkUrl: row.linkUrl } }
        : { status: 'duplicate' };
}
