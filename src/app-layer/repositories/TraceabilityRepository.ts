import { PrismaTx } from '@/lib/db-context';
import { CoverageType } from '@prisma/client';

export class AssetPracticeRepository {
    static async listByAsset(db: PrismaTx, tenantId: string, assetId: string) {
        return db.practiceAsset.findMany({
            where: { tenantId, assetId },
            include: { practice: { select: { id: true, code: true, name: true, status: true, category: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    static async listByPractice(db: PrismaTx, tenantId: string, practiceId: string) {
        return db.practiceAsset.findMany({
            where: { tenantId, practiceId },
            include: { asset: { select: { id: true, name: true, type: true, criticality: true, status: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    static async link(db: PrismaTx, tenantId: string, assetId: string, practiceId: string, coverageType: string | null, rationale: string | null, userId: string) {
        return db.practiceAsset.create({
            data: { tenantId, assetId, practiceId, coverageType: (coverageType as CoverageType) ?? CoverageType.UNKNOWN, rationale, createdByUserId: userId },
        });
    }

    static async unlink(db: PrismaTx, tenantId: string, assetId: string, practiceId: string) {
        return db.practiceAsset.delete({
            where: { tenantId_practiceId_assetId: { tenantId, practiceId, assetId } },
        });
    }
}

