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
 *   - Risk          → nextReviewAt, targetDate
 *   - ControlTestPlan → nextDueAt
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

/**
 * Scan risks with nextReviewAt approaching or overdue.
 */
async function scanRisks(
    now: Date,
    maxWindow: number,
    tenantId?: string,
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + maxWindow * 86_400_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
        deletedAt: null,
        status: { notIn: ['CLOSED', 'ACCEPTED'] },
        nextReviewAt: { not: null, lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;

    const risks = await prisma.risk.findMany({
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
    for (const r of risks) {
        if (!r.nextReviewAt) continue;
        const classification = classifyUrgency(r.nextReviewAt, now);
        if (!classification) continue;

        items.push({
            entityType: 'RISK',
            entityId: r.id,
            tenantId: r.tenantId,
            name: r.title,
            reason: classification.urgency === 'OVERDUE'
                ? `Risk review overdue by ${Math.abs(classification.daysRemaining)} day(s)`
                : `Risk review due in ${classification.daysRemaining} day(s)`,
            urgency: classification.urgency,
            dueDate: r.nextReviewAt.toISOString(),
            daysRemaining: classification.daysRemaining,
            ownerUserId: r.ownerUserId ?? undefined,
        });
    }
    return items;
}

// ─── Epic G-7 — treatment-plan + milestone scanners ────────────────

/**
 * Scan treatment plans whose `targetDate` is approaching or past
 * AND whose status is not already COMPLETED. The monitor doesn't
 * mutate state — it emits DueItem records that downstream
 * notification + dashboard surfaces consume.
 */
async function scanTreatmentPlans(
    now: Date,
    maxWindow: number,
    tenantId?: string,
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + maxWindow * 86_400_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
        deletedAt: null,
        status: { in: ['DRAFT', 'ACTIVE', 'OVERDUE'] },
        targetDate: { lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;

    const plans = await prisma.riskTreatmentPlan.findMany({
        where,
        select: {
            id: true,
            tenantId: true,
            riskId: true,
            ownerUserId: true,
            targetDate: true,
            risk: { select: { title: true } },
        },
        orderBy: { targetDate: 'asc' },
        take: 1000,
    });

    const items: DueItem[] = [];
    for (const p of plans) {
        if (!p.targetDate) continue;
        const c = classifyUrgency(p.targetDate, now);
        if (!c) continue;
        items.push({
            entityType: 'TREATMENT_PLAN',
            entityId: p.id,
            tenantId: p.tenantId,
            name: p.risk?.title ?? '(unnamed risk)',
            reason:
                c.urgency === 'OVERDUE'
                    ? `Treatment plan target overdue by ${Math.abs(c.daysRemaining)} day(s)`
                    : `Treatment plan target due in ${c.daysRemaining} day(s)`,
            urgency: c.urgency,
            dueDate: p.targetDate.toISOString(),
            daysRemaining: c.daysRemaining,
            ownerUserId: p.ownerUserId,
        });
    }
    return items;
}

/**
 * Scan treatment milestones whose `dueDate` is approaching or past
 * AND whose `completedAt` is null. Each milestone surfaces as its
 * own DueItem so per-owner digests can group them naturally.
 */
async function scanTreatmentMilestones(
    now: Date,
    maxWindow: number,
    tenantId?: string,
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + maxWindow * 86_400_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
        completedAt: null,
        dueDate: { lte: horizon },
        treatmentPlan: { deletedAt: null, status: { in: ['DRAFT', 'ACTIVE', 'OVERDUE'] } },
    };
    if (tenantId) where.tenantId = tenantId;

    const milestones = await prisma.treatmentMilestone.findMany({
        where,
        select: {
            id: true,
            tenantId: true,
            title: true,
            dueDate: true,
            treatmentPlan: {
                select: { id: true, ownerUserId: true, riskId: true },
            },
        },
        orderBy: { dueDate: 'asc' },
        take: 2000,
    });

    const items: DueItem[] = [];
    for (const m of milestones) {
        if (!m.dueDate) continue;
        const c = classifyUrgency(m.dueDate, now);
        if (!c) continue;
        items.push({
            entityType: 'TREATMENT_MILESTONE',
            entityId: m.id,
            tenantId: m.tenantId,
            name: m.title,
            reason:
                c.urgency === 'OVERDUE'
                    ? `Milestone overdue by ${Math.abs(c.daysRemaining)} day(s)`
                    : `Milestone due in ${c.daysRemaining} day(s)`,
            urgency: c.urgency,
            dueDate: m.dueDate.toISOString(),
            daysRemaining: c.daysRemaining,
            ownerUserId: m.treatmentPlan?.ownerUserId,
        });
    }
    return items;
}

/**
 * Phase 0 — flip past-due treatment plans (DRAFT/ACTIVE) to OVERDUE
 * with one audit row per transition. Runs BEFORE the scanners so
 * the post-flip status is what downstream surfaces see. Each
 * transition is per-row + atomic so a concurrent renewal never
 * gets clobbered.
 */
async function transitionPlansToOverdue(
    now: Date,
    tenantId?: string,
): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
        deletedAt: null,
        status: { in: ['DRAFT', 'ACTIVE'] },
        targetDate: { lt: now },
    };
    if (tenantId) where.tenantId = tenantId;

    const candidates = await prisma.riskTreatmentPlan.findMany({
        where,
        // ownerUserId is included for parity with the scanner SELECTs —
        // the due-item-ownership ratchet asserts every SELECT in this
        // file carries an owner field. The transition itself doesn't
        // use it, but pulling it in costs nothing and keeps the shape
        // uniform for future "notify the owner of an overdue plan"
        // callers that build off this list.
        select: {
            id: true,
            tenantId: true,
            riskId: true,
            ownerUserId: true,
            targetDate: true,
        },
    });

    let transitioned = 0;
    for (const c of candidates) {
        const update = await prisma.riskTreatmentPlan.updateMany({
            where: {
                id: c.id,
                tenantId: c.tenantId,
                status: { in: ['DRAFT', 'ACTIVE'] },
                deletedAt: null,
                targetDate: { lt: now },
            },
            data: { status: 'OVERDUE' },
        });
        if (update.count === 0) continue;

        await appendAuditEntry({
            tenantId: c.tenantId,
            userId: null,
            actorType: 'SYSTEM',
            entity: 'RiskTreatmentPlan',
            entityId: c.id,
            action: 'TREATMENT_PLAN_MARKED_OVERDUE',
            detailsJson: {
                category: 'status_change',
                entityName: 'RiskTreatmentPlan',
                toStatus: 'OVERDUE',
                summary: `Treatment plan ${c.id} transitioned to OVERDUE at scheduled deadline`,
                after: {
                    riskId: c.riskId,
                    targetDateIso: c.targetDate?.toISOString() ?? null,
                    transitionedBy: 'deadline-monitor',
                },
            },
        });
        transitioned++;
    }

    return transitioned;
}

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
        await transitionPlansToOverdue(now, options.tenantId);

        // Run all scanners in parallel
        const [
            controls,
            policies,
            tasks,
            risks,
            treatmentPlans,
            treatmentMilestones,
        ] = await Promise.all([
            scanControls(now, maxWindow, options.tenantId),
            scanPolicies(now, maxWindow, options.tenantId),
            scanTasks(now, maxWindow, options.tenantId),
            scanRisks(now, maxWindow, options.tenantId),
            scanTreatmentPlans(now, maxWindow, options.tenantId),
            scanTreatmentMilestones(now, maxWindow, options.tenantId),
        ]);

        const items = [
            ...controls,
            ...policies,
            ...tasks,
            ...risks,
            ...treatmentPlans,
            ...treatmentMilestones,
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
