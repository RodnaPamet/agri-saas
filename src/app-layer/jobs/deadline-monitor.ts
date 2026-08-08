/**
 * Deadline Monitor — Periodic Detection of Due/Overdue Items
 *
 * Scans across multiple entity types to detect upcoming and overdue
 * deadlines. Returns normalized `DueItem[]` for downstream processing
 * (notification dispatch, dashboard aggregation, alerting).
 *
 * Monitored entities:
 *   - Control       → nextDueAt
 *   - Policy        → nextReviewAt
 *   - Task          → dueAt
 *
 * Design principles:
 *   - Detection ONLY — no email sending, no side effects beyond audit logs
 *   - Tenant-isolated — all queries filter by tenantId
 *   - Idempotent — same input produces same output; safe to re-run
 *   - Deterministic — output is sorted and stable
 *   - Configurable windows — default [30, 7, 1] days
 *
 * @module app-layer/jobs/deadline-monitor
 */
import { prisma } from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import type { DueItem, DueItemUrgency, JobRunResult } from './types';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';
import { appendAuditEntry } from '@/lib/audit';

// ─── Configuration ──────────────────────────────────────────────────

export interface DeadlineMonitorOptions {
    tenantId?: string;
    /** Detection windows in days, sorted descending. Default: [30, 7, 1] */
    windows?: number[];
    /** Override current time (for testing) */
    now?: Date;
}

export interface DeadlineMonitorResult {
    items: DueItem[];
    counts: {
        overdue: number;
        urgent: number;
        upcoming: number;
    };
    byEntity: Record<string, number>;
}

// ─── Urgency Classifier ─────────────────────────────────────────────

/**
 * Classify a due date relative to now.
 * Returns null if the date is beyond the largest window.
 */
export function classifyUrgency(
    dueDate: Date,
    now: Date,
    windows: number[] = [30, 7, 1],
): { urgency: DueItemUrgency; daysRemaining: number } | null {
    const diffMs = dueDate.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / 86_400_000);

    if (daysRemaining < 0) {
        return { urgency: 'OVERDUE', daysRemaining };
    }

    const maxWindow = Math.max(...windows);
    if (daysRemaining > maxWindow) {
        return null; // Not yet in any detection window
    }

    // Find the tightest matching window
    const urgentThreshold = windows.find(w => w <= 7) ?? 7;

    if (daysRemaining <= urgentThreshold) {
        return { urgency: 'URGENT', daysRemaining };
    }

    return { urgency: 'UPCOMING', daysRemaining };
}

// ─── Entity Scanners ────────────────────────────────────────────────

/**
 * Scan controls with nextDueAt approaching or overdue.
 */
async function scanControls(
    now: Date,
    maxWindow: number,
    tenantId?: string,
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + maxWindow * 86_400_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
        deletedAt: null,
        applicability: 'APPLICABLE',
        nextDueAt: { not: null, lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;
    else where.tenantId = { not: null };

    const controls = await prisma.control.findMany({
        where,
        select: {
            id: true,
            tenantId: true,
            name: true,
            nextDueAt: true,
            ownerUserId: true,
        },
        orderBy: { nextDueAt: 'asc' },
        take: 1000,
    });

    const items: DueItem[] = [];
    for (const c of controls) {
        if (!c.tenantId || !c.nextDueAt) continue;
        const classification = classifyUrgency(c.nextDueAt, now);
        if (!classification) continue;

        items.push({
            entityType: 'CONTROL',
            entityId: c.id,
            tenantId: c.tenantId,
            name: c.name,
            reason: classification.urgency === 'OVERDUE'
                ? `Control testing overdue by ${Math.abs(classification.daysRemaining)} day(s)`
                : `Control testing due in ${classification.daysRemaining} day(s)`,
            urgency: classification.urgency,
            dueDate: c.nextDueAt.toISOString(),
            daysRemaining: classification.daysRemaining,
            ownerUserId: c.ownerUserId ?? undefined,
        });
    }
    return items;
}

/**
 * Scan policies with nextReviewAt approaching or overdue.
 */
async function scanPolicies(
    now: Date,
    maxWindow: number,
    tenantId?: string,
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + maxWindow * 86_400_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
        deletedAt: null,
        status: { notIn: ['ARCHIVED'] },
        nextReviewAt: { not: null, lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;

    const policies = await prisma.policy.findMany({
        where,
        select: {
            id: true,
            tenantId: true,
            title: true,
            nextReviewAt: true,
            ownerUserId: true,
        },
        orderBy: { nextReviewAt: 'asc' },
        take: 1000,
    });

    const items: DueItem[] = [];
    for (const p of policies) {
        if (!p.nextReviewAt) continue;
        const classification = classifyUrgency(p.nextReviewAt, now);
        if (!classification) continue;

        items.push({
            entityType: 'POLICY',
            entityId: p.id,
            tenantId: p.tenantId,
            name: p.title,
            reason: classification.urgency === 'OVERDUE'
                ? `Policy review overdue by ${Math.abs(classification.daysRemaining)} day(s)`
                : `Policy review due in ${classification.daysRemaining} day(s)`,
            urgency: classification.urgency,
            dueDate: p.nextReviewAt.toISOString(),
            daysRemaining: classification.daysRemaining,
            ownerUserId: p.ownerUserId ?? undefined,
        });
    }
    return items;
}

/**
 * Scan tasks with dueAt approaching or overdue.
 * Only open/in-progress tasks — not completed or cancelled.
 */
async function scanTasks(
    now: Date,
    maxWindow: number,
    tenantId?: string,
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + maxWindow * 86_400_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
        deletedAt: null,
        status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
        dueAt: { not: null, lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;

    const tasks = await prisma.task.findMany({
        where,
        select: {
            id: true,
            tenantId: true,
            title: true,
            dueAt: true,
            assigneeUserId: true,
        },
        orderBy: { dueAt: 'asc' },
        take: 1000,
    });

    const items: DueItem[] = [];
    for (const t of tasks) {
        if (!t.dueAt) continue;
        const classification = classifyUrgency(t.dueAt, now);
        if (!classification) continue;

        items.push({
            entityType: 'TASK',
            entityId: t.id,
            tenantId: t.tenantId,
            name: t.title,
            reason: classification.urgency === 'OVERDUE'
                ? `Task overdue by ${Math.abs(classification.daysRemaining)} day(s)`
                : `Task due in ${classification.daysRemaining} day(s)`,
            urgency: classification.urgency,
            dueDate: t.dueAt.toISOString(),
            daysRemaining: classification.daysRemaining,
            ownerUserId: t.assigneeUserId ?? undefined,
        });
    }
    return items;
}

// ─── Epic G-7 — treatment-plan + milestone scanners ────────────────

// ─── Main Entry Point ───────────────────────────────────────────────

/**
 * Run the deadline monitor — scans all entity types and returns
 * a normalized list of due/overdue items.
 *
 * This is a detection-only job. It does NOT:
 *   - Send emails
 *   - Create tasks
 *   - Modify any database records
 *
 * The output is suitable for downstream notification dispatch.
 */
export async function runDeadlineMonitor(
    options: DeadlineMonitorOptions = {},
): Promise<{ result: JobRunResult; items: DueItem[] }> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob('deadline-monitor', async () => {
        const now = options.now ?? new Date();
        const windows = options.windows ?? [30, 7, 1];
        const maxWindow = Math.max(...windows);

        // Phase 0 — flip past-due treatment plans before scanning so
        // the urgency classifier sees the post-flip status. Each
        // transition emits one TREATMENT_PLAN_MARKED_OVERDUE audit row.

        // Run all scanners in parallel
        const [
            controls,
            policies,
            tasks,
        ] = await Promise.all([
            scanControls(now, maxWindow, options.tenantId),
            scanPolicies(now, maxWindow, options.tenantId),
            scanTasks(now, maxWindow, options.tenantId),
        ]);

        const items = [
            ...controls,
            ...policies,
            ...tasks,
        ];

        // Sort by urgency (OVERDUE first, then by days remaining)
        items.sort((a, b) => {
            const urgencyOrder = { OVERDUE: 0, URGENT: 1, UPCOMING: 2 };
            const ua = urgencyOrder[a.urgency];
            const ub = urgencyOrder[b.urgency];
            if (ua !== ub) return ua - ub;
            return a.daysRemaining - b.daysRemaining;
        });

        const counts = {
            overdue: items.filter(i => i.urgency === 'OVERDUE').length,
            urgent: items.filter(i => i.urgency === 'URGENT').length,
            upcoming: items.filter(i => i.urgency === 'UPCOMING').length,
        };

        const byEntity: Record<string, number> = {};
        for (const item of items) {
            byEntity[item.entityType] = (byEntity[item.entityType] ?? 0) + 1;
        }

        logger.info('deadline monitor completed', {
            component: 'job',
            jobName: 'deadline-monitor',
            total: items.length,
            ...counts,
            byEntity,
        });

        const durationMs = Math.round(performance.now() - startMs);

        const result: JobRunResult = {
            jobName: 'deadline-monitor',
            jobRunId,
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            itemsScanned: items.length,
            itemsActioned: counts.overdue + counts.urgent,
            itemsSkipped: counts.upcoming,
            details: { counts, byEntity },
        };

        return { result, items };
    }, { tenantId: options.tenantId });
}
