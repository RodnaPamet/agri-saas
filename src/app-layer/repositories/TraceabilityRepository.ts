import { PrismaTx } from '@/lib/db-context';
import { CoverageType, ExposureLevel } from '@prisma/client';

export class ControlRiskRepository {



}

export class AssetControlRepository {
    static async listByAsset(db: PrismaTx, tenantId: string, assetId: string) {
        return db.controlAsset.findMany({
            where: { tenantId, assetId },
            include: { control: { select: { id: true, code: true, name: true, status: true, category: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    static async listByControl(db: PrismaTx, tenantId: string, controlId: string) {
        return db.controlAsset.findMany({
            where: { tenantId, controlId },
            include: { asset: { select: { id: true, name: true, type: true, criticality: true, status: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    static async link(db: PrismaTx, tenantId: string, assetId: string, controlId: string, coverageType: string | null, rationale: string | null, userId: string) {
        return db.controlAsset.create({
            data: { tenantId, assetId, controlId, coverageType: (coverageType as CoverageType) ?? CoverageType.UNKNOWN, rationale, createdByUserId: userId },
        });
    }

    static async unlink(db: PrismaTx, tenantId: string, assetId: string, controlId: string) {
        return db.controlAsset.delete({
            where: { tenantId_controlId_assetId: { tenantId, controlId, assetId } },
        });
    }
}

export class AssetRiskRepository {




}
