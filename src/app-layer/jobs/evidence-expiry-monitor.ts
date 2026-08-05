/**
 * Evidence Expiry Monitor — Periodic Detection of Expiring Evidence
 *
 * Scans evidence records to detect items that are:
 *   - Already expired (expiredAt < now, or retentionUntil < now)
 *   - Expiring soon (within configurable windows)
 *
 * Returns normalized `DueItem[]` for downstream notification dispatch.
 *
 * Eligibility filters (records must satisfy ALL):
 *   - NOT soft-deleted (deletedAt is null)
 *   - NOT archived (isArchived = false)
 *   - NOT in REJECTED status
 *   - Has a retentionUntil or expiredAt date set
 *
 * Design principles:
 *   - Detection ONLY — no email sending, no archival, no side effects
 *   - Tenant-isolated — all queries filter by tenantId
 *   - Idempotent — same input produces same output
 *   - Separate from existing dailyEvidenceExpiry (which creates tasks + emails)
 *
 * @module app-layer/jobs/evidence-expiry-monitor
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import type { DueItem, DueItemUrgency, JobRunResult } from './types';
import { resolveDueItemOwner } from '../domain/due-item-ownership';

// ─── Configuration ──────────────────────────────────────────────────

export interface EvidenceExpiryMonitorOptions {
    tenantId?: string;
    /** Detection windows in days. Default: [30, 7, 1] */
    windows?: number[];
    /** Override current time (for testing) */
    now?: Date;
}

export interface EvidenceExpiryMonitorResult {
    items: DueItem[];
    counts: {
        expired: number;
        urgent: number;
        upcoming: number;
    };
}

// ─── Evidence Scanner ───────────────────────────────────────────────

/**
 * Scan evidence with retentionUntil approaching or already past.
 * Uses retentionUntil as the primary expiry date, falling back to
 * expiredAt for items already marked expired.
 */
async function scanExpiringEvidence(
    now: Date,
    maxWindow: number,
    tenantId?: string,
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + maxWindow * 86_400_000);

    // 1. Evidence expiring within window (retentionUntil set and within horizon)
    const expiringWhere: Prisma.EvidenceWhereInput = {
        deletedAt: null,
        isArchived: false,
        status: { notIn: ['REJECTED'] },
        retentionUntil: { not: null, lte: horizon },
        // Exclude already-archived items handled by the retention sweep
        expiredAt: null,
    };
    if (tenantId) expiringWhere.tenantId = tenantId;

    const expiring = await prisma.evidence.findMany({
        where: expiringWhere,
        select: {
            id: true,
            tenantId: true,
            title: true,
            retentionUntil: true,
            owner: true,
            ownerUserId: true,
            controlId: true,
        },
        orderBy: { retentionUntil: 'asc' },
        take: 1000,
    });

    // 2. Evidence already expired (expiredAt set, not archived yet)
    const expiredWhere: Prisma.EvidenceWhereInput = {
        deletedAt: null,
        isArchived: false,
        status: { notIn: ['REJECTED'] },
        expiredAt: { not: null, lt: now },
    };
    if (tenantId) expiredWhere.tenantId = tenantId;

    const expired = await prisma.evidence.findMany({
        where: expiredWhere,
        select: {
            id: true,
            tenantId: true,
            title: true,
            expiredAt: true,
            owner: true,
            ownerUserId: true,
            controlId: true,
        },
        orderBy: { expiredAt: 'asc' },
        take: 1000,
    });

    const items: DueItem[] = [];
    const seenIds = new Set<string>();

    // Process expiring evidence (retentionUntil-based)
    for (const ev of expiring) {
        if (seenIds.has(ev.id)) continue;
        seenIds.add(ev.id);

        // retentionUntil is non-null: the where clause filters `retentionUntil: { not: null }`
        const retentionDate = new Date(ev.retentionUntil!);
        const diffMs = retentionDate.getTime() - now.getTime();
        const daysRemaining = Math.ceil(diffMs / 86_400_000);

        let urgency: DueItemUrgency;
        let reason: string;

        if (daysRemaining < 0) {
            urgency = 'OVERDUE';
            reason = `Evidence retention expired ${Math.abs(daysRemaining)} day(s) ago`;
        } else if (daysRemaining <= 7) {
            urgency = 'URGENT';
            reason = `Evidence expires in ${daysRemaining} day(s)`;
        } else {
            urgency = 'UPCOMING';
            reason = `Evidence expires in ${daysRemaining} day(s)`;
        }

        items.push({
            entityType: 'EVIDENCE',
            entityId: ev.id,
            tenantId: ev.tenantId,
            name: ev.title,
            reason,
            urgency,
            dueDate: retentionDate.toISOString(),
            daysRemaining,
            ownerUserId: resolveDueItemOwner('EVIDENCE', ev),
        });
    }

    // Process already-expired evidence (expiredAt-based)
    for (const ev of expired) {
        if (seenIds.has(ev.id)) continue;
        seenIds.add(ev.id);

        // expiredAt is non-null: the where clause filters `expiredAt: { not: null }`
        const expiredDate = new Date(ev.expiredAt!);
        const diffMs = expiredDate.getTime() - now.getTime();
        const daysRemaining = Math.ceil(diffMs / 86_400_000);

        items.push({
            entityType: 'EVIDENCE',
            entityId: ev.id,
            tenantId: ev.tenantId,
            name: ev.title,
            reason: `Evidence expired ${Math.abs(daysRemaining)} day(s) ago`,
            urgency: 'OVERDUE',
            dueDate: expiredDate.toISOString(),
            daysRemaining,
            ownerUserId: resolveDueItemOwner('EVIDENCE', ev),
        });
    }

    return items;
}

/**
 * Scan evidence whose periodic REVIEW is due.
 *
 * `Evidence.reviewCycle` (MONTHLY / QUARTERLY / SEMI_ANNUALLY / ANNUALLY) and
 * `Evidence.nextReviewDate` are settable in the edit modal, are counted by the
 * dashboard's overdue / due-soon tiles, and have their own notification types
 * (`EVIDENCE_DUE_SOON`, `EVIDENCE_OVERDUE`). All of that existed; the sweep
 * that would have made any of it happen did not. Setting a cadence produced
 * nothing at all — no notification when the date arrived, and a dashboard tile
 * that either stayed at zero forever or, once a date passed, stayed red
 * forever, because nothing advanced the date either (see `reviewEvidence`).
 *
 * Deliberately a SEPARATE scan from the retention one above. Retention asks
 * "may we still keep this?"; review asks "is this still true?" — different
 * dates, different remedies, and a control point can be well inside its
 * retention window while its proof has gone a year unlooked-at.
 */
async function scanEvidenceDueForReview(
    now: Date,
    maxWindow: number,
    tenantId?: string,
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + maxWindow * 86_400_000);

    const where: Prisma.EvidenceWhereInput = {
        deletedAt: null,
        isArchived: false,
        // A rejected row is not awaiting review; it has had one.
        status: { notIn: ['REJECTED'] },
        nextReviewDate: { not: null, lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;

    const due = await prisma.evidence.findMany({
        where,
        select: {
            id: true,
            tenantId: true,
            title: true,
            nextReviewDate: true,
            owner: true,
            ownerUserId: true,
            controlId: true,
        },
        orderBy: { nextReviewDate: 'asc' },
        take: 1000,
    });

    // The where-clause guarantees a non-null date; the filter is a seatbelt.
    // This runs nightly and unattended, and `new Date(undefined)` throws on
    // `.toISOString()` — one malformed row should not take the sweep down for
    // every tenant.
    return due.filter((ev) => ev.nextReviewDate).map((ev) => {
        const reviewDate = new Date(ev.nextReviewDate!);
        const daysRemaining = Math.ceil((reviewDate.getTime() - now.getTime()) / 86_400_000);

        let urgency: DueItemUrgency;
        let reason: string;
        if (daysRemaining < 0) {
            urgency = 'OVERDUE';
            reason = `Evidence review overdue by ${Math.abs(daysRemaining)} day(s)`;
        } else if (daysRemaining <= 7) {
            urgency = 'URGENT';
            reason = `Evidence review due in ${daysRemaining} day(s)`;
        } else {
            urgency = 'UPCOMING';
            reason = `Evidence review due in ${daysRemaining} day(s)`;
        }

        return {
            entityType: 'EVIDENCE' as const,
            entityId: ev.id,
            tenantId: ev.tenantId,
            name: ev.title,
            reason,
            urgency,
            dueDate: reviewDate.toISOString(),
            daysRemaining,
            ownerUserId: resolveDueItemOwner('EVIDENCE', ev),
        };
    });
}

// ─── Main Entry Point ───────────────────────────────────────────────

/**
 * Run the evidence expiry monitor.
 *
 * Detection-only — does NOT:
 *   - Send emails (that's processOutbox)
 *   - Create tasks (that's retention-notifications)
 *   - Archive evidence (that's retention-sweep)
 *   - Purge evidence (that's data-lifecycle)
 *
 * The output is suitable for downstream notification digest assembly.
 */
export async function runEvidenceExpiryMonitor(
    options: EvidenceExpiryMonitorOptions = {},
): Promise<{ result: JobRunResult; items: DueItem[] }> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob('evidence-expiry-monitor', async () => {
        const now = options.now ?? new Date();
        const windows = options.windows ?? [30, 7, 1];
        const maxWindow = Math.max(...windows);

        // Sequential, not Promise.all. Three cheap indexed reads gain nothing
        // measurable from overlapping, and concurrency here costs real
        // reasoning: the retention scan issues two queries and the review scan
        // a third, so running them together makes the order they hit the
        // database non-deterministic — which is exactly the kind of thing that
        // is invisible until something depends on it.
        const expiryItems = await scanExpiringEvidence(now, maxWindow, options.tenantId);
        const reviewItems = await scanEvidenceDueForReview(now, maxWindow, options.tenantId);

        // One row can be both expiring and due for review. The retention date
        // wins: it is the harder deadline (the row is about to leave), and two
        // notifications about one piece of evidence in the same digest is how
        // people learn to skim the digest.
        const seen = new Set(expiryItems.map((i) => i.entityId));
        const items = [...expiryItems, ...reviewItems.filter((i) => !seen.has(i.entityId))];

        // Sort by urgency (OVERDUE first)
        items.sort((a, b) => {
            const urgencyOrder = { OVERDUE: 0, URGENT: 1, UPCOMING: 2 };
            const ua = urgencyOrder[a.urgency];
            const ub = urgencyOrder[b.urgency];
            if (ua !== ub) return ua - ub;
            return a.daysRemaining - b.daysRemaining;
        });

        const counts = {
            expired: items.filter(i => i.urgency === 'OVERDUE').length,
            urgent: items.filter(i => i.urgency === 'URGENT').length,
            upcoming: items.filter(i => i.urgency === 'UPCOMING').length,
        };

        logger.info('evidence expiry monitor completed', {
            component: 'job',
            jobName: 'evidence-expiry-monitor',
            total: items.length,
            ...counts,
        });

        const durationMs = Math.round(performance.now() - startMs);

        const result: JobRunResult = {
            jobName: 'evidence-expiry-monitor',
            jobRunId,
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            itemsScanned: items.length,
            itemsActioned: counts.expired + counts.urgent,
            itemsSkipped: counts.upcoming,
            details: { counts },
        };

        return { result, items };
    }, { tenantId: options.tenantId });
}
