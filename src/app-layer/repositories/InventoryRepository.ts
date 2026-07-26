import { Prisma } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';

/** Shared include for the lot list projections (list + paginated). */
const LOT_LIST_INCLUDE = {
    item: { select: { id: true, name: true, category: true, reorderLevel: true } },
    unit: { select: { id: true, symbol: true, name: true } },
    location: { select: { id: true, name: true } },
} satisfies Prisma.InventoryLotInclude;

/**
 * InventoryLot repository — all reads/writes tenant-scoped. The ledger
 * itself (StockTransaction) is written ONLY through
 * `src/lib/inventory/stock-ledger.ts`; this repository owns the lot
 * rows + read projections, never a direct StockTransaction write.
 */
export class InventoryRepository {
    /** List a tenant's lots (newest first), with item + unit for display. */
    static async listLots(
        db: PrismaTx,
        ctx: RequestContext,
        opts: { itemId?: string; take?: number } = {},
    ) {
        return db.inventoryLot.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                ...(opts.itemId ? { itemId: opts.itemId } : {}),
            },
            include: LOT_LIST_INCLUDE,
            orderBy: [{ createdAt: 'desc' }],
            take: opts.take ?? 200,
        });
    }

    /**
     * Cursor-paginated lots (mirrors LocationRepository.listPaginated): a
     * stable (createdAt, id) cursor + a `limit+1` over-fetch to detect the
     * next page. Backs the inventory-traceability list on large fields
     * (10k+ lots) where the unbounded `listLots` take would be unsafe.
     */
    static async listLotsPaginated(
        db: PrismaTx,
        ctx: RequestContext,
        params: { limit?: number; cursor?: string; itemId?: string },
    ): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where: Prisma.InventoryLotWhereInput = {
            tenantId: ctx.tenantId,
            deletedAt: null,
            ...(params.itemId ? { itemId: params.itemId } : {}),
        };
        const cursorWhere = buildCursorWhere(params.cursor);
        if (cursorWhere) {
            where.AND = [cursorWhere as Prisma.InventoryLotWhereInput];
        }
        const items = await db.inventoryLot.findMany({
            where,
            orderBy: CURSOR_ORDER_BY,
            take: limit + 1,
            include: LOT_LIST_INCLUDE,
        });
        const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
        return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
    }

    /** A single lot with its recent ledger (most-recent first). */
    static async getLot(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.inventoryLot.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: {
                item: { select: { id: true, name: true, category: true } },
                unit: { select: { id: true, symbol: true, name: true } },
                location: { select: { id: true, name: true } },
            },
        });
    }

    /** The ledger rows for one lot (read projection, bounded). */
    static async lotLedger(db: PrismaTx, ctx: RequestContext, lotId: string, take = 100) {
        return db.stockTransaction.findMany({
            where: { tenantId: ctx.tenantId, lotId },
            include: {
                unit: { select: { symbol: true } },
                actor: { select: { id: true, name: true } },
            },
            orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
            take: take,
        });
    }

    /**
     * Cursor-paginated ledger for a lot — orders by (createdAt, id), the
     * canonical append / hash-chain order and the stable cursor key. Backs
     * the `/ledger` endpoint so a high-volume lot's full history pages
     * instead of being capped at the getLot inline first page. The
     * `[tenantId, lotId, createdAt]` index (perf-scale migration) serves
     * exactly this filter+sort.
     */
    static async lotLedgerPage(
        db: PrismaTx,
        ctx: RequestContext,
        lotId: string,
        params: { limit?: number; cursor?: string },
    ): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where: Prisma.StockTransactionWhereInput = { tenantId: ctx.tenantId, lotId };
        const cursorWhere = buildCursorWhere(params.cursor);
        if (cursorWhere) {
            where.AND = [cursorWhere as Prisma.StockTransactionWhereInput];
        }
        const items = await db.stockTransaction.findMany({
            where,
            orderBy: CURSOR_ORDER_BY,
            take: limit + 1,
            include: {
                unit: { select: { symbol: true } },
                actor: { select: { id: true, name: true } },
            },
        });
        const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
        return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
    }

    /** Validate + fetch an item the lot/consumption will reference. */
    static async getItem(db: PrismaTx, ctx: RequestContext, itemId: string) {
        return db.item.findFirst({
            where: { id: itemId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true, defaultUnitId: true, reorderLevel: true },
        });
    }

    /** Create a lot row (stock is added separately via a RECEIPT ledger entry). */
    static async createLot(
        db: PrismaTx,
        ctx: RequestContext,
        input: {
            itemId: string;
            lotCode: string;
            unitId: string;
            locationId?: string | null;
            expiresAt?: Date | null;
            receivedAt?: Date | null;
            unitCostAmount?: number | null;
            unitCostCurrency?: string | null;
            attributesJson?: Prisma.InputJsonValue;
        },
    ) {
        return db.inventoryLot.create({
            data: {
                tenantId: ctx.tenantId,
                itemId: input.itemId,
                lotCode: input.lotCode,
                unitId: input.unitId,
                locationId: input.locationId ?? null,
                expiresAt: input.expiresAt ?? null,
                receivedAt: input.receivedAt ?? null,
                unitCostAmount: input.unitCostAmount ?? null,
                unitCostCurrency: input.unitCostCurrency ?? null,
                ...(input.attributesJson !== undefined ? { attributesJson: input.attributesJson } : {}),
            },
            select: { id: true, lotCode: true, unitId: true },
        });
    }

    /**
     * Move a lot to a different storage location (or unassign it with null).
     *
     * Writes `locationId` and NOTHING else — deliberately. The inventory
     * module is single-writer: `quantityOnHand` is a denormalised ledger sum
     * refreshed only by the ledger writer, so a position change must not go
     * near it. That is also why this is a lot-row update rather than a pair
     * of ledger transactions: no stock is created, consumed or moved between
     * items, only the shelf it sits on.
     */
    static async updateLotLocation(
        db: PrismaTx,
        ctx: RequestContext,
        lotId: string,
        locationId: string | null,
    ) {
        const res = await db.inventoryLot.updateMany({
            where: { id: lotId, tenantId: ctx.tenantId, deletedAt: null },
            data: { locationId },
        });
        return res.count;
    }

    /**
     * First-Expiry-First-Out lot selection for an item: the non-deleted
     * lot with stock on hand whose contents expire soonest. Used by the
     * spray-completion CONSUMPTION path to pick which lot to draw from.
     * Returns null when the item has no lot with positive stock.
     */
    static async getFefoLot(db: PrismaTx, ctx: RequestContext, itemId: string) {
        return db.inventoryLot.findFirst({
            where: {
                tenantId: ctx.tenantId,
                itemId,
                deletedAt: null,
                quantityOnHand: { gt: 0 },
            },
            orderBy: [
                { expiresAt: { sort: 'asc', nulls: 'last' } },
                { receivedAt: { sort: 'asc', nulls: 'last' } },
                { createdAt: 'asc' },
            ],
            select: { id: true, unitId: true, lotCode: true, quantityOnHand: true },
        });
    }

    // ─── Lot genealogy + traceability (Phase 1 follow-up) ───────────

    /**
     * Batch-hydrate lots by id for the traceability walk — one query for
     * a whole BFS level (never a per-node read). `attributesJson` carries
     * `harvestedFromParcelId` for HARVEST_IN lots.
     */
    static async getLotsByIds(db: PrismaTx, ctx: RequestContext, ids: string[]) {
        if (ids.length === 0) return [];
        return db.inventoryLot.findMany({ // guardrail-allow: unbounded — bounded by the id:{in} BFS frontier (≤ TRACE_MAX_DEPTH × 500)
            where: { tenantId: ctx.tenantId, id: { in: ids } },
            select: {
                id: true,
                lotCode: true,
                quantityOnHand: true,
                attributesJson: true,
                receivedAt: true,
                item: { select: { id: true, name: true, category: true } },
                unit: { select: { id: true, symbol: true } },
            },
        });
    }

    /** Genealogy edges INTO a set of child lots (one BFS level up). */
    static async listParentLinks(db: PrismaTx, ctx: RequestContext, childLotIds: string[]) {
        if (childLotIds.length === 0) return [];
        return db.lotLink.findMany({
            where: { tenantId: ctx.tenantId, childLotId: { in: childLotIds } },
            select: { parentLotId: true, childLotId: true, type: true, logEntryId: true },
            take: 500,
        });
    }

    /** Genealogy edges OUT of a set of parent lots (one BFS level down). */
    static async listChildLinks(db: PrismaTx, ctx: RequestContext, parentLotIds: string[]) {
        if (parentLotIds.length === 0) return [];
        return db.lotLink.findMany({
            where: { tenantId: ctx.tenantId, parentLotId: { in: parentLotIds } },
            select: { parentLotId: true, childLotId: true, type: true, logEntryId: true },
            take: 500,
        });
    }

    /**
     * The fields (parcels) a set of lots was CONSUMED on — walks the
     * ledger's `logEntry → operationParcel → parcel` chain. One query for
     * all lots; the caller groups by `lotId` in memory.
     */
    static async findConsumptionParcels(db: PrismaTx, ctx: RequestContext, lotIds: string[]) {
        if (lotIds.length === 0) return [];
        return db.stockTransaction.findMany({
            where: { tenantId: ctx.tenantId, type: 'CONSUMPTION', lotId: { in: lotIds } },
            select: {
                lotId: true,
                occurredAt: true,
                logEntry: {
                    select: {
                        operationParcel: {
                            select: { parcel: { select: { id: true, name: true } } },
                        },
                    },
                },
            },
            orderBy: [{ occurredAt: 'desc' }],
            take: 500,
        });
    }

    /**
     * Distinct input lots that were CONSUMED on a given parcel (field) —
     * the parents of a harvest recorded from that field. Used when wiring
     * the DERIVATION genealogy on a HARVEST entry.
     */
    static async findInputLotsConsumedOnParcel(db: PrismaTx, ctx: RequestContext, parcelId: string) {
        const rows = await db.stockTransaction.findMany({
            where: {
                tenantId: ctx.tenantId,
                type: 'CONSUMPTION',
                logEntry: { is: { operationParcel: { is: { parcelId } } } },
            },
            select: { lotId: true },
            distinct: ['lotId'],
            take: 500,
        });
        return rows.map((r) => r.lotId);
    }
}
