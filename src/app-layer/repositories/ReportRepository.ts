import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

export class ReportRepository {
    static async getSOAData(db: PrismaTx, ctx: RequestContext) {
        return db.control.findMany({
            where: { OR: [{ tenantId: ctx.tenantId }, { tenantId: null }] },
            orderBy: { code: 'asc' },
            include: {
                evidence: { where: { tenantId: ctx.tenantId } },
            },
        });
    }

}
