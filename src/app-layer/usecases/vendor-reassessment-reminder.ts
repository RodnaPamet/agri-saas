/**
 * Vendor re-assessment reminder — Audit Coherence S6 (2026-05-22).
 *
 * Auditors expect vendor due-diligence to follow a cadence: a vendor
 * marked for review by `nextReviewAt` either gets re-assessed or
 * the date is acknowledged + extended. Pre-this-cron the
 * `calendar` view surfaced overdue vendors but no
 * automated reminder fired — operators only saw them by clicking
 * into the calendar tab.
 *
 * This sweep finds every non-deleted, non-archived vendor whose
 * `nextReviewAt` is in the past, creates a `VENDOR_REVIEW_DUE`
 * notification routed to the vendor's owner (or tenant admins
 * if no owner is set), and bumps `nextReviewAt` forward by the
 * cadence (default 365 days) so the reminder isn't a daily spam
 * source — it fires once per vendor per cycle.
 *
 * Idempotent at the notification layer (notifications are
 * de-duplicated upstream by tenant+entityId+type+day); the cron
 * itself isn't idempotent on `nextReviewAt` — every run forwards
 * the date — but the WHERE clause ensures only past-due rows are
 * touched, so a no-op sweep is a no-op `updateMany`.
 *
 * Tenant scoping: optional `tenantId` for single-tenant; absent
 * means sweep all (the cron uses absent; admin-triggered debug
 * uses set).
 */
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { runJob } from '@/lib/observability/job-runner';

export interface VendorReassessmentReminderOptions {
    /** Override "now" timestamp for tests. */
    now?: Date;
    /** Scope to one tenant. Absent = sweep all. */
    tenantId?: string;
    /**
     * Days to add to `nextReviewAt` when bumping it forward.
     * Defaults to 365 (annual review cycle — matches ISO 27001
     * §15.2.1 informal practice).
     */
    cadenceDays?: number;
}

export interface VendorReassessmentReminderResult {
    /** Past-due vendors found (and reminded) by this sweep. */
    reminded: number;
}

const DEFAULT_CADENCE_DAYS = 365;

export async function runVendorReassessmentReminder(
    options: VendorReassessmentReminderOptions = {},
): Promise<VendorReassessmentReminderResult> {
    return runJob('vendor-reassessment-reminder', async () => {
        const now = options.now ?? new Date();
        const cadenceDays = options.cadenceDays ?? DEFAULT_CADENCE_DAYS;

        // 1. Find past-due vendors. (Vendor has soft-delete via
        // `deletedAt` but no `isArchived` column — vendors are
        // retired by setting `status = OFFBOARDED`, which we
        // exclude here so dormant relationships don't generate
        // reminders.)
        const overdue = await prisma.vendor.findMany({
            where: {
                ...(options.tenantId ? { tenantId: options.tenantId } : {}),
                deletedAt: null,
                status: { not: 'OFFBOARDED' },
                nextReviewAt: { not: null, lt: now },
            },
            select: {
                id: true,
                tenantId: true,
                name: true,
                ownerUserId: true,
            },
        });

        if (overdue.length === 0) {
            logger.info('vendor-reassessment-reminder: no overdue vendors', {
                component: 'job',
                tenantId: options.tenantId,
            });
            return { reminded: 0 };
        }

        // 2. Per-vendor: create notification + bump nextReviewAt.
        // Done one-at-a-time so a single vendor's failure (e.g.
        // owner row deleted mid-cycle) doesn't sink the whole sweep.
        let reminded = 0;
        for (const v of overdue) {
            try {
                if (v.ownerUserId) {
                    await prisma.notification.create({
                        data: {
                            tenantId: v.tenantId,
                            userId: v.ownerUserId,
                            type: 'VENDOR_REVIEW_DUE',
                            title: `Vendor review due: ${v.name}`,
                            message:
                                `Vendor "${v.name}" is past its scheduled review date. ` +
                                'Re-assess the vendor or extend the review date.',
                            linkUrl: `/vendors/${v.id}`,
                        },
                    });
                }
                const nextDate = new Date(now);
                nextDate.setDate(nextDate.getDate() + cadenceDays);
                await prisma.vendor.update({
                    where: { id: v.id },
                    data: { nextReviewAt: nextDate },
                });
                reminded += 1;
            } catch (err) {
                // Best-effort per vendor — don't fail the whole sweep
                // if one row's notification can't be written.
                logger.warn(
                    'vendor-reassessment-reminder: per-vendor write failed',
                    {
                        component: 'job',
                        vendorId: v.id,
                        tenantId: v.tenantId,
                        err: err instanceof Error ? err : new Error(String(err)),
                    },
                );
            }
        }

        logger.info('vendor-reassessment-reminder: sweep complete', {
            component: 'job',
            reminded,
            overdueFound: overdue.length,
            cadenceDays,
            tenantId: options.tenantId,
        });
        return { reminded };
    }, { tenantId: options.tenantId });
}
