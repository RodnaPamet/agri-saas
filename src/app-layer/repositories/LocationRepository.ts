import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, LocationStatus, LocationKind } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';

export interface LocationFilters {
    status?: string;
    q?: string;
    /**
     * Restrict to these `LocationKind`s. A `Location` row is both a field and
     * a grain bin depending on `kind`, so callers that mean one of the two
     * must say so — an unfiltered list mixes growing areas with storage.
     */
    kind?: string[];
}

export interface LocationListParams {
    limit?: number;
    cursor?: string;
    filters?: LocationFilters;
}

const OWNER_SELECT = { select: { id: true, name: true, email: true } } as const;

/**
 * Location repository — mirrors AssetRepository (tenant-scoped CRUD,
 * cursor pagination, free-text search). Location is NOT in the
 * SOFT_DELETE_MODELS allowlist, so soft-delete is applied EXPLICITLY:
 * every read filters `deletedAt: null`, and `softDelete` stamps the
 * trio columns rather than calling `db.location.delete()`.
 */
export class LocationRepository {
    static async list(db: PrismaTx, ctx: RequestContext, filters?: LocationFilters) {
        const where = LocationRepository._buildWhere(ctx, filters);
        return db.location.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { parcels: true } }, owner: OWNER_SELECT },
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: LocationListParams): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where = LocationRepository._buildWhere(ctx, params.filters);

        const cursorWhere = buildCursorWhere(params.cursor);
        if (cursorWhere) {
            if (where.AND) {
                (where.AND as Prisma.LocationWhereInput[]).push(cursorWhere as Prisma.LocationWhereInput);
            } else {
                where.AND = [cursorWhere as Prisma.LocationWhereInput];
            }
        }

        const items = await db.location.findMany({
            where,
            orderBy: CURSOR_ORDER_BY,
            take: limit + 1,
            include: { _count: { select: { parcels: true } }, owner: OWNER_SELECT },
        });

        const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
        return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
    }

    private static _buildWhere(ctx: RequestContext, filters?: LocationFilters): Prisma.LocationWhereInput {
        const where: Prisma.LocationWhereInput = { tenantId: ctx.tenantId, deletedAt: null };

        if (filters?.status) where.status = filters.status as LocationStatus;
        if (filters?.kind && filters.kind.length > 0) {
            where.kind = { in: filters.kind as LocationKind[] };
        }
        if (filters?.q) {
            where.OR = [
                { name: { contains: filters.q, mode: 'insensitive' } },
                { description: { contains: filters.q, mode: 'insensitive' } },
            ];
        }

        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.location.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: { _count: { select: { parcels: true } }, owner: OWNER_SELECT },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.LocationUncheckedCreateInput, 'tenantId'>) {
        return db.location.create({
            data: { ...data, tenantId: ctx.tenantId },
            include: { _count: { select: { parcels: true } }, owner: OWNER_SELECT },
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.LocationUncheckedUpdateInput, 'tenantId'>) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return null;

        return db.location.update({
            where: { id },
            data,
            include: { _count: { select: { parcels: true } }, owner: OWNER_SELECT },
        });
    }

    /** Explicit soft delete — Location is not in SOFT_DELETE_MODELS. */
    static async softDelete(db: PrismaTx, ctx: RequestContext, id: string) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return false;

        await db.location.update({
            where: { id },
            data: { deletedAt: new Date(), deletedByUserId: ctx.userId },
        });
        return true;
    }
}
