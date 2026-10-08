/**
 * Inventory DTOs — the lot list/page shapes returned by the INVENTORY
 * module API (GET /inventory/lots).
 *
 * `listLots` maps the raw Prisma rows to a flat DTO: Decimal
 * `quantityOnHand` → number, the item/unit/location includes narrowed to
 * id+label refs, and a computed `lowStock` flag (on-hand below the item's
 * reorderLevel). The endpoint is dual-mode: a bare GET returns
 * `InventoryLot[]`; a `?limit=`/`?cursor=` GET returns an
 * `InventoryLotPage` (cursor pagination, mirroring the locations list).
 */
import { z } from '@/lib/openapi/zod';

const LotItemRefSchema = z
    .object({ id: z.string(), name: z.string(), category: z.string() })
    .passthrough();

const LotUnitRefSchema = z
    .object({ id: z.string(), symbol: z.string() })
    .passthrough();

const LotLocationRefSchema = z
    .object({ id: z.string(), name: z.string() })
    .passthrough();

export const InventoryLotDTOSchema = z
    .object({
        id: z.string(),
        lotCode: z.string(),
        item: LotItemRefSchema,
        unit: LotUnitRefSchema,
        location: LotLocationRefSchema.nullable().optional(),
        /** Decimal → number (denormalised cache, ledger-derived). */
        quantityOnHand: z.number(),
        expiresAt: z.string().datetime().nullable().optional(),
        receivedAt: z.string().datetime().nullable().optional(),
        /** True when on-hand has dropped below the item's reorderLevel. */
        lowStock: z.boolean(),
    })
    .passthrough()
    .openapi('InventoryLot', {
        description:
            'An inventory lot of a catalog input (seed / pesticide / fertilizer / …). quantityOnHand is the ledger-derived ' +
            'on-hand quantity in the lot unit; lowStock flags reorder. Cursor-paginate with ?limit=&cursor= for large fields.',
    });

export type InventoryLotDTO = z.infer<typeof InventoryLotDTOSchema>;

export const InventoryLotPageDTOSchema = z
    .object({
        items: z.array(InventoryLotDTOSchema),
        pageInfo: z.object({
            nextCursor: z.string().optional(),
            hasNextPage: z.boolean(),
        }),
    })
    .openapi('InventoryLotPage', {
        description: 'A cursor page of inventory lots — returned by GET /inventory/lots?limit=&cursor=.',
    });

export type InventoryLotPageDTO = z.infer<typeof InventoryLotPageDTOSchema>;
