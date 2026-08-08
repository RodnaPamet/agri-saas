/**
 * RQ-10 — scheduled report delivery cron (cross-tenant fan-out).
 *
 * Finds due ReportSchedules, generates the report, EMAILS the artefact to the
 * recipients as an attachment, and advances nextRunAt. (SharePoint push to
 * `sharePointFolderId` awaits a Graph upload primitive — see the impl note.)
 *
 * @module jobs/report-delivery-jobs
 */
import prisma from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { logger } from '@/lib/observability/logger';
import type { ReportDeliveryPayload } from './types';

const asRecipients = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

async function buildCtx(tenantId: string): Promise<RequestContext | null> {
    const admin = await prisma.tenantMembership.findFirst({
        where: { tenantId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
        select: { userId: true, role: true }, orderBy: { createdAt: 'asc' },
    });
    if (!admin) return null;
    const appPermissions = getPermissionsForRole(admin.role);
    return {
        requestId: `report-delivery-${tenantId}`, userId: admin.userId, tenantId, role: admin.role,
        permissions: {
            canRead: appPermissions.risks.view, canWrite: appPermissions.risks.edit,
            canAdmin: appPermissions.admin.manage, canAudit: appPermissions.audits.view, canExport: appPermissions.reports.export,
        },
        appPermissions,
    };
}

export async function runReportDelivery(_payload: ReportDeliveryPayload) {
    const now = new Date();
    const due = await prisma.reportSchedule.findMany({
        where: { isActive: true, nextRunAt: { lte: now } },
        select: { id: true, tenantId: true, templateId: true, format: true, cadence: true, parametersJson: true, recipientsJson: true, sharePointDriveId: true, sharePointFolderId: true, template: { select: { name: true } } },
        take: 1000,
    });
    let generated = 0, delivered = 0, pushed = 0, failed = 0;
    for (const s of due) {
        const ctx = await buildCtx(s.tenantId);
        if (!ctx) continue;
        try {
            const run = await generateReport(ctx, s.templateId, (s.parametersJson ?? {}) as Record<string, unknown>, (s.format as ReportFormat) ?? 'PDF');
            generated++;
            const label = s.template?.name ?? 'Risk report';
            const sent = await deliverReportByEmail(run, asRecipients(s.recipientsJson), label);
            if (sent > 0) delivered++;
            const spItemId = await deliverReportToSharePoint(ctx, run, s.sharePointDriveId, s.sharePointFolderId, label);
            if (spItemId) pushed++;
            logger.info('report-delivery: generated + delivered scheduled report', {
                component: 'report-delivery', tenantId: s.tenantId, scheduleId: s.id, runId: run.id,
                recipients: sent, sharePoint: spItemId ? 'pushed' : 'skipped',
            });
        } catch (err) {
            failed++;
            logger.warn('report-delivery: scheduled generation failed', {
                component: 'report-delivery', tenantId: s.tenantId, scheduleId: s.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        await prisma.reportSchedule.update({
            where: { id: s.id },
            data: { lastRunAt: now, nextRunAt: computeNextRun(s.cadence, now) },
        });
    }
    return { due: due.length, generated, delivered, pushed, failed };
}
