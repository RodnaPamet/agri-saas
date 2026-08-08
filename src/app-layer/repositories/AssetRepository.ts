import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, AssetType, AssetStatus, Criticality } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';

export interface AssetFilters {
    type?: string;
    status?: string;
    criticality?: string;
    q?: string;
}

export interface AssetListParams {
    limit?: number;
    cursor?: string;
    filters?: AssetFilters;
}

export class AssetRepository {
    static async list(db: PrismaTx, ctx: RequestContext, filters?: AssetFilters) {
        const where = AssetRepository._buildWhere(ctx, filters);
        return db.asset.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                _count: { select: { controls: true } },
                // B4 — resolve the structured assignee so the list Owner
                // column can prefer the assigned user's name over the
                // free-text keeper.
                ownerUser: { select: { id: true, name: true, email: true } },
            },
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: AssetListParams): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where = AssetRepository._buildWhere(ctx, params.filters);

        const cursorWhere = buildCursorWhere(params.cursor);
        if (cursorWhere) {
            if (where.AND) {
                (where.AND as Prisma.AssetWhereInput[]).push(cursorWhere as Prisma.AssetWhereInput);
            } else {
                where.AND = [cursorWhere as Prisma.AssetWhereInput];
            }
        }

        const items = await db.asset.findMany({
            where,
            orderBy: CURSOR_ORDER_BY,
            take: limit + 1,
            include: { _count: { select: { controls: true } } },
        });

        const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
        return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
    }

    private static _buildWhere(ctx: RequestContext, filters?: AssetFilters): Prisma.AssetWhereInput {
        const where: Prisma.AssetWhereInput = { tenantId: ctx.tenantId };

        if (filters?.type) where.type = filters.type as AssetType;
        if (filters?.status) where.status = filters.status as AssetStatus;
        if (filters?.criticality) where.criticality = filters.criticality as Criticality;
        if (filters?.q) {
            where.OR = [
                { name: { contains: filters.q, mode: 'insensitive' } },
                { manufacturer: { contains: filters.q, mode: 'insensitive' } },
                { model: { contains: filters.q, mode: 'insensitive' } },
                { serialNumber: { contains: filters.q, mode: 'insensitive' } },
                { owner: { contains: filters.q, mode: 'insensitive' } },
            ];
        }

        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.asset.findFirst({
            where: { id, tenantId: ctx.tenantId },
            include: { controls: { include: { control: true } } },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.AssetUncheckedCreateInput, 'tenantId'>) {
        // Mint a per-tenant `AST-N` key from an atomic counter.
        // Mirrors `RiskRepository.create` / the TaskKeySequence
        // pattern — the upsert compiles to a native
        // `INSERT … ON CONFLICT DO UPDATE`, race-free under
        // concurrent imports. Callers that supply their own `key`
        // (the migration backfill path / future imports) win — we
        // only mint when none is set.
        let key = (data as { key?: string | null }).key ?? null;
        if (!key) {
            const seq = await db.assetKeySequence.upsert({
                where: { tenantId: ctx.tenantId },
                create: { tenantId: ctx.tenantId, lastValue: 1 },
                update: { lastValue: { increment: 1 } },
            });
            key = `AST-${seq.lastValue}`;
        }
        return db.asset.create({
            data: {
                ...data,
                key,
                tenantId: ctx.tenantId,
            },
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.AssetUncheckedUpdateInput, 'tenantId'>) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return null;

        return db.asset.update({
            where: { id },
            data,
        });
    }

    static async delete(db: PrismaTx, ctx: RequestContext, id: string) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return false;

        await db.asset.delete({ where: { id } });
        return true;
    }
}
