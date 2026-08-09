import { RequestContext } from '../types';
import { ReportRepository } from '../repositories/ReportRepository';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { traceUsecase } from '@/lib/observability/tracing';

export async function getReports(ctx: RequestContext) {
    assertCanRead(ctx);
    logger.info('report generation started', { component: 'report' });

    return traceUsecase('report.generate', ctx, () => runInTenantContext(ctx, async (db) => {
        const controls = await ReportRepository.getSOAData(db, ctx);

        const soa = controls.map((c) => ({
            controlId: c.id,
            name: c.name,
            applicable: c.applicability === 'APPLICABLE',
            status: c.status,
            effectiveness: c.effectiveness,
            evidenceCount: c.evidence.length,
            approvedEvidence: c.evidence.filter((e) => e.status === 'APPROVED').length,
            hasOverdue: c.evidence.some((e) => e.nextReviewDate && new Date(e.nextReviewDate) < new Date()),
            reviewCadence: c.reviewCadence,
        }));


        logger.info('report generation completed', {
            component: 'report',
            soaCount: soa.length,
        });

        return { soa };
    }));
}
