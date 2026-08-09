import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma } from '@prisma/client';

/**
 * Service / repair / inspection / breakdown history for a machine.
 *
 * `AssetStatus.IN_MAINTENANCE` existed as a status with nothing behind
 * it. These reads back the Maintenance tab on the asset detail page —
 * the tab a farm actually wants, where Evidence / Mappings /
 * Traceability are compliance-era surfaces a plain-farm tenant has
 * gated off entirely.
 */

/** Page size for the maintenance history list. Bounded by default. */
export const MAINTENANCE_PAGE_SIZE = 100;

export class AssetMaintenanceRepository {
    /** History for one machine, newest first. Bounded. */
    static async listForAsset(
        db: PrismaTx,
        ctx: RequestContext,
        assetId: string,
        take = MAINTENANCE_PAGE_SIZE,
    ) {
        return db.assetMaintenance.findMany({
            where: { tenantId: ctx.tenantId, assetId },
            include: {
                vendor: { select: { id: true, name: true } },
                createdBy: { select: { id: true, name: true, email: true } },
            },
            orderBy: [{ openedAt: 'desc' }],
            take: take,
        });
    }

    /**
     * Records still open (no `closedAt`) for one machine.
     *
     * Drives both status prompts: opening a record is what a farm does
     * when it sets IN_MAINTENANCE, and closing the LAST open record is
     * what offers to put the asset back to ACTIVE.
     */
    static async listOpenForAsset(db: PrismaTx, ctx: RequestContext, assetId: string) {
        return db.assetMaintenance.findMany({
            where: { tenantId: ctx.tenantId, assetId, closedAt: null },
            select: { id: true, kind: true, openedAt: true },
            orderBy: [{ openedAt: 'desc' }],
            take: MAINTENANCE_PAGE_SIZE,
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.assetMaintenance.findFirst({
            where: { id, tenantId: ctx.tenantId },
        });
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        data: Omit<Prisma.AssetMaintenanceUncheckedCreateInput, 'tenantId'>,
    ) {
        return db.assetMaintenance.create({
            data: { ...data, tenantId: ctx.tenantId },
        });
    }

    static async update(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        data: Omit<Prisma.AssetMaintenanceUncheckedUpdateInput, 'tenantId'>,
    ) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return null;
        return db.assetMaintenance.update({ where: { id }, data });
    }

    static async delete(db: PrismaTx, ctx: RequestContext, id: string) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return false;
        await db.assetMaintenance.delete({ where: { id } });
        return true;
    }
}
