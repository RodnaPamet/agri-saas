/**
 * Epic 49 — Calendar Deadlines Monitor
 *
 * Detects upcoming + overdue compliance deadlines for entities NOT
 * already covered by the existing monitors:
 *
 *   - AuditCycle (periodEndAt)        — close-out date
 *   - VendorDocument (validTo)        — document expiry
 *   - Finding (dueDate)               — remediation deadline
 *
 * The existing `deadline-monitor` already handles Control/Policy/Task/
 * Risk/TestPlan; `evidence-expiry-monitor` handles Evidence retention;
 * `vendor-renewal-check` handles Vendor renewals. Adding a parallel
 * source here would double-count those entities, so we narrow to the
 * three new sources.
 *
 * Output is `DueItem[]` — the same contract every other monitor uses.
 * The `notification-dispatch` orchestrator merges this stream with the
 * existing deadline-monitor output and feeds the combined list to
 * `dispatchDigest({ category: 'DEADLINE_DIGEST', items })`.
 *
 * Dedupe: `dispatchDigest` builds `{tenantId}:DEADLINE_DIGEST:{email}:digest:{YYYY-MM-DD}`
 * and Prisma's `@unique` on `NotificationOutbox.dedupeKey` silently
 * skips duplicates. Re-running this job daily is therefore a no-op for
 * any (tenant, recipient, day) tuple that already received a digest.
 *
 * Tenant safety: every Prisma query starts with `tenantId` filtering;
 * job is per-tenant when `payload.tenantId` is supplied, otherwise
 * sweeps all tenants.
 */

import { prisma } from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import type { DueItem, JobRunResult } from './types';
import { classifyUrgency } from './deadline-monitor';

// ─── Public types ────────────────────────────────────────────────────

export interface CalendarDeadlineMonitorOptions {
    tenantId?: string;
    /** Detection windows in days. Default: [30, 7, 1]. */
    windows?: number[];
    /** Override "now" for testing. */
    now?: Date;
}

export interface CalendarDeadlineMonitorResult {
    items: DueItem[];
    counts: {
        overdue: number;
        urgent: number;
        upcoming: number;
    };
    byEntity: {
        AUDIT_CYCLE: number;
        VENDOR_DOCUMENT: number;
        FINDING: number;
    };
}

// ─── Per-source scanners ─────────────────────────────────────────────

/**
 * Every scan below is BOUNDED and ORDERED.
 *
 * The scheduled run passes no tenantId (schedules.ts defaultPayload is {}),
 * and `...(tenantId && { tenantId })` then contributes no predicate at all —
 * so an unbounded findMany here is a whole-table read across EVERY tenant,
 * pulled into one process's memory at 07:00 UTC. `take` caps that; `orderBy`
 * makes the cap deterministic, so the rows that survive truncation are the
 * most urgent ones rather than whatever the planner happened to emit.
 *
 * Mirrors deadline-monitor.ts, which already does exactly this.
 */
const SCAN_LIMIT = 1000;

async function scanAuditCycles(
    now: Date,
    maxWindow: number,
    windows: number[],
    tenantId?: string,
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + maxWindow * 86_400_000);
    const rows = await prisma.auditCycle.findMany({
        where: {
            ...(tenantId && { tenantId }),
            deletedAt: null,
            // Only cycles still in flight (PLANNING / IN_PROGRESS / READY).
            // COMPLETE cycles are done — no notification value.
            status: { in: ['PLANNING', 'IN_PROGRESS', 'READY'] },
            periodEndAt: { not: null, lte: horizon },
        },
        select: {
            id: true,
            tenantId: true,
            name: true,
            frameworkKey: true,
            periodEndAt: true,
            createdByUserId: true,
        },
        orderBy: { periodEndAt: 'asc' },
        take: SCAN_LIMIT,
    });

    const items: DueItem[] = [];
    for (const r of rows) {
        if (!r.periodEndAt) continue;
        const classified = classifyUrgency(r.periodEndAt, now, windows);
        if (!classified) continue;
        items.push({
            entityType: 'CONTROL', // No CALENDAR-native entity type;
            // re-use CONTROL bucket so the digest template renders. The
            // entity type is informational only — the email shows
            // `name` + `reason` + `dueDate`.
            entityId: r.id,
            tenantId: r.tenantId,
            name: `Audit cycle: ${r.name} (${r.frameworkKey})`,
            reason:
                classified.urgency === 'OVERDUE'
                    ? 'Audit cycle past period end'
                    : 'Audit cycle period ending',
            urgency: classified.urgency,
            dueDate: r.periodEndAt.toISOString(),
            daysRemaining: classified.daysRemaining,
            ownerUserId: r.createdByUserId,
        });
    }
    return items;
}

async function scanVendorDocuments(
    now: Date,
    maxWindow: number,
    windows: number[],
    tenantId?: string,
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + maxWindow * 86_400_000);
    const rows = await prisma.vendorDocument.findMany({
        where: {
            ...(tenantId && { tenantId }),
            validTo: { not: null, lte: horizon },
            vendor: {
                status: { not: 'OFFBOARDED' },
                deletedAt: null,
            },
        },
        select: {
            id: true,
            tenantId: true,
            type: true,
            validTo: true,
            vendor: {
                select: {
                    name: true,
                    ownerUserId: true,
                },
            },
        },
        orderBy: { validTo: 'asc' },
        take: SCAN_LIMIT,
    });

    const items: DueItem[] = [];
    for (const r of rows) {
        if (!r.validTo) continue;
        const classified = classifyUrgency(r.validTo, now, windows);
        if (!classified) continue;
        items.push({
            entityType: 'VENDOR',
            entityId: r.id,
            tenantId: r.tenantId,
            name: `${r.type}: ${r.vendor.name}`,
            reason:
                classified.urgency === 'OVERDUE'
                    ? 'Vendor document expired'
                    : 'Vendor document expiring',
            urgency: classified.urgency,
            dueDate: r.validTo.toISOString(),
            daysRemaining: classified.daysRemaining,
            ownerUserId: r.vendor.ownerUserId ?? undefined,
        });
    }
    return items;
}

async function scanFindings(
    now: Date,
    maxWindow: number,
    windows: number[],
    tenantId?: string,
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + maxWindow * 86_400_000);
    const rows = await prisma.finding.findMany({
        where: {
            ...(tenantId && { tenantId }),
            // A soft-deleted finding is not a finding. Without this the job
            // EMAILS people about records they already deleted.
            deletedAt: null,
            // Don't notify on closed findings.
            status: { not: 'CLOSED' },
            dueDate: { not: null, lte: horizon },
        },
        select: {
            id: true,
            tenantId: true,
            title: true,
            dueDate: true,
            owner: true,
        },
        orderBy: { dueDate: 'asc' },
        take: SCAN_LIMIT,
    });

    const items: DueItem[] = [];
    for (const r of rows) {
        if (!r.dueDate) continue;
        const classified = classifyUrgency(r.dueDate, now, windows);
        if (!classified) continue;
        items.push({
            entityType: 'TASK', // Findings are work-items in the digest;
            // use TASK bucket so the existing template renders without
            // a parallel branch. This is purely a presentation choice;
            // `name` + `reason` carry the real semantics.
            entityId: r.id,
            tenantId: r.tenantId,
            name: `Finding: ${r.title}`,
            reason:
                classified.urgency === 'OVERDUE'
                    ? 'Finding overdue'
                    : 'Finding due',
            urgency: classified.urgency,
            dueDate: r.dueDate.toISOString(),
            daysRemaining: classified.daysRemaining,
            ownerUserId: r.owner ?? undefined,
        });
    }
    return items;
}

// ─── Public entry point ──────────────────────────────────────────────

/**
 * Detect upcoming + overdue calendar deadlines. Returns the unified
 * `DueItem[]` for downstream digest dispatch. Side-effect-free — does
 * NOT enqueue notifications itself; the orchestrator does that.
 */
export async function runCalendarDeadlineMonitor(
    options: CalendarDeadlineMonitorOptions = {},
): Promise<CalendarDeadlineMonitorResult> {
    const now = options.now ?? new Date();
    const windows = options.windows ?? [30, 7, 1];
    const maxWindow = Math.max(...windows);

    const [auditCycles, vendorDocs, findings] = await Promise.all([
        scanAuditCycles(now, maxWindow, windows, options.tenantId),
        scanVendorDocuments(now, maxWindow, windows, options.tenantId),
        scanFindings(now, maxWindow, windows, options.tenantId),
    ]);

    const items = [...auditCycles, ...vendorDocs, ...findings];
    const counts = {
        overdue: items.filter((i) => i.urgency === 'OVERDUE').length,
        urgent: items.filter((i) => i.urgency === 'URGENT').length,
        upcoming: items.filter((i) => i.urgency === 'UPCOMING').length,
    };
    const byEntity = {
        AUDIT_CYCLE: auditCycles.length,
        VENDOR_DOCUMENT: vendorDocs.length,
        FINDING: findings.length,
    };

    logger.info('calendar deadline monitor scan complete', {
        component: 'calendar-deadlines',
        counts,
        byEntity,
        tenantId: options.tenantId ?? 'all',
    });

    return { items, counts, byEntity };
}

/**
 * BullMQ-friendly wrapper. Allows the monitor to be enqueued + run on
 * its own (e.g., for ad-hoc scans), even though the production path is
 * via the `notification-dispatch` orchestrator.
 */
export interface CalendarDeadlinePayload {
    tenantId?: string;
    windows?: number[];
}

export async function runCalendarDeadlineJob(
    payload: CalendarDeadlinePayload,
): Promise<{ result: JobRunResult; monitor: CalendarDeadlineMonitorResult }> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob('calendar-deadlines', async () => {
        const monitor = await runCalendarDeadlineMonitor(payload);
        const durationMs = Math.round(performance.now() - startMs);
        const result: JobRunResult = {
            jobName: 'calendar-deadlines',
            jobRunId,
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            itemsScanned:
                monitor.byEntity.AUDIT_CYCLE +
                monitor.byEntity.VENDOR_DOCUMENT +
                monitor.byEntity.FINDING,
            itemsActioned: monitor.items.length,
            itemsSkipped: 0,
            details: {
                counts: monitor.counts,
                byEntity: monitor.byEntity,
            },
        };
        return { result, monitor };
    }, { tenantId: payload.tenantId });
}
