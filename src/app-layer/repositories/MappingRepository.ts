import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

export class MappingRepository {
    static async getPracticesWithEvidence(db: PrismaTx, ctx: RequestContext) {
        return db.practice.findMany({
            where: { OR: [{ tenantId: ctx.tenantId }, { tenantId: null }] },
            include: {
                evidence: { where: { tenantId: ctx.tenantId } },
                _count: { select: { evidence: true } },
            },
        });
    }
}
