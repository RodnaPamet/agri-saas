/**
 * Inventory lots — stock on hand, the append-only ledger, and the recall trace.
 *
 * The other half of the catalogue. `/items` says what a product IS; this says
 * how much of it exists, where, and what happened to it.
 *
 * ── the ledger is HASH-CHAINED and append-only ──
 *
 * Every movement carries an `entryHash` linking it to the one before, and
 * `StockTransaction` blocks UPDATE and DELETE at the database. So a correction
 * is a NEW entry with an opposite delta, never an edit — which is why
 * `POST /adjust` refuses a zero delta: an adjustment of nothing would be a
 * permanent record that a human touched the stock and changed nothing.
 *
 * A client should present the ledger as history rather than as editable rows,
 * and should expect `entryHash` to be meaningful (it is what `verifyStockChain`
 * checks) rather than an opaque id it can ignore.
 *
 * ── THREE pagination conventions now exist in this API ──
 *
 * This surface uses the third, and the differences are not cosmetic:
 *
 *   { items, pageInfo: { nextCursor, hasNextPage } }   inventory  <- here
 *   { rows, nextCursor }                               exchange, tasks
 *   { rows, totalCount, truncated }                    grain
 *
 * `pagination.ts` documents the FIRST as the standard, and most of the API does
 * not follow it. Documented as they are rather than reconciled: renaming a
 * response key breaks a client that exists. But a client cannot write one
 * pager for this API, and knowing that up front is cheaper than discovering it.
 *
 * ── `GET /inventory/lots` returns TWO shapes ──
 *
 * Bare, it is a full ARRAY. With `?limit=` or `?cursor=`, it is a PAGE. Same
 * route, decided by the query, exactly like `GET /tasks`. A client that assumes
 * the page shape and calls the route bare reads `undefined.items`.
 *
 * ── `lowStock` conflates two different states ──
 *
 * `lowStock: reorder !== null ? onHand < reorder : false`. So `false` means
 * EITHER "above the threshold" OR "no threshold is set". A client cannot tell
 * them apart from this field, and an item with no `reorderLevel` will never
 * report low no matter how empty it gets. Read `item.reorderLevel` from the
 * catalogue if the distinction matters.
 *
 * ── and the single read is not the list row ──
 *
 * `GET /lots/{lotId}` has an embedded `ledger` (the recent page) and NO
 * `lowStock`. The list row has `lowStock` and no ledger. Two shapes, one
 * resource, again.
 */
import { z } from '@/lib/openapi/zod';
import {
    LotQuerySchema,
    CreateLotSchema,
    UpdateLotSchema,
    ReceiveSchema,
    AdjustSchema,
    LedgerQuerySchema,
} from '@/app-layer/schemas/inventory.schemas';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const LotParams = TenantParams.extend({
    lotId: z.string().openapi({ param: { name: 'lotId', in: 'path' } }),
});

const PageInfoSchema = z
    .object({
        /** Opaque. Pass back verbatim. Null on the last page. */
        nextCursor: z.string().nullable(),
        hasNextPage: z.boolean(),
    })
    .openapi('InventoryPageInfo', {
        description:
            'The `{ items, pageInfo }` convention — used by inventory, NOT by grain (`{rows, totalCount, truncated}`) or exchange (`{rows, nextCursor}`). One pager cannot serve all three.',
    });

const LotRowSchema = z
    .object({
        id: z.string(),
        lotCode: z.string(),
        item: z.object({ id: z.string(), name: z.string(), category: z.string() }),
        unit: z.object({ id: z.string(), symbol: z.string() }),
        location: z.object({ id: z.string(), name: z.string() }).nullable(),
        /** Decimal converted to a NUMBER by the mapper. */
        quantityOnHand: z.number(),
        expiresAt: z.string().datetime().nullable(),
        receivedAt: z.string().datetime().nullable(),
        /**
         * COMPUTED, and it conflates two states: `false` means either "above
         * the reorder level" or "no reorder level is set". An item without one
         * never reports low however empty it gets.
         */
        lowStock: z.boolean(),
    })
    .openapi('InventoryLot', {
        description:
            'A stock lot as a LIST row. quantityOnHand is a number (the mapper converts the Decimal). lowStock is computed and false BOTH when stock is sufficient and when the item has no reorderLevel — it is not a reliable "is fine" signal on its own.',
    });

const LedgerEntrySchema = z
    .object({
        id: z.string(),
        /** Movement kind — RECEIPT, CONSUMPTION, ADJUSTMENT, harvest, … */
        type: z.string(),
        /** Signed. Negative consumes. Never zero on an adjustment. */
        quantityDelta: z.number(),
        unitSymbol: z.string(),
        occurredAt: z.string().datetime(),
        /** Free text, required on an adjustment and null on most others. */
        reason: z.string().nullable(),
        actor: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
        /**
         * The chain link. `verifyStockChain` recomputes these to detect a
         * tampered row, so it is evidence rather than an id.
         */
        entryHash: z.string(),
    })
    .openapi('InventoryLedgerEntry', {
        description:
            'One append-only stock movement. UPDATE and DELETE are blocked at the database, so a correction is a NEW opposing entry rather than an edit. entryHash chains the row to its predecessor and is what a tamper check verifies.',
    });

const LotDetailSchema = z
    .object({
        id: z.string(),
        lotCode: z.string(),
        item: z.object({ id: z.string(), name: z.string(), category: z.string() }),
        /** NOTE the extra `name` here — the LIST row's unit carries only `symbol`. */
        unit: z.object({ id: z.string(), symbol: z.string(), name: z.string() }),
        location: z.object({ id: z.string(), name: z.string() }).nullable(),
        quantityOnHand: z.number(),
        expiresAt: z.string().datetime().nullable(),
        receivedAt: z.string().datetime().nullable(),
        /** The RECENT page, inline. Deep history is the /ledger route. */
        ledger: z.array(LedgerEntrySchema),
    })
    .openapi('InventoryLotDetail', {
        description:
            'A lot with its recent ledger embedded. NOT the same shape as a list row: this has `ledger` and no `lowStock`. For deep history use GET /lots/{lotId}/ledger, which is cursor-paginated.',
    });

const MovementAckSchema = z
    .object({
        /** The balance AFTER the movement. */
        quantityOnHand: z.number(),
        /** The new chain head — proof the entry landed. */
        entryHash: z.string(),
    })
    .openapi('InventoryMovementAck', {
        description:
            'What receive and adjust answer with: the resulting balance and the new chain head. Not the lot and not the ledger entry.',
    });

const TraceNodeSchema = z
    .object({
        id: z.string(),
        lotCode: z.string(),
        item: z.object({ id: z.string(), name: z.string(), category: z.string() }),
        unitSymbol: z.string(),
        quantityOnHand: z.number(),
        /** Parcels this lot was consumed on, plus a harvest lot's source field. */
        fields: z.array(z.object({ id: z.string(), name: z.string() })),
    })
    .openapi('TraceLotNode', {
        description: 'One lot in the genealogy graph, annotated with the fields it touched.',
    });

export function registerInventoryPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/inventory/lots',
        operationId: 'listInventoryLots',
        summary: 'List stock lots',
        description:
            'DUAL-MODE, decided by the query. Bare, it returns the full ARRAY. With `limit` or `cursor` it returns a PAGE — `{ items, pageInfo }`, which is the inventory convention and differs from both grain’s and exchange’s. ' +
            '\n\nA client that assumes the page shape and calls this bare reads `undefined.items`.',
        tags: ['Inventory'],
        params: TenantParams,
        query: LotQuerySchema,
        success: {
            status: 200,
            description:
                'Either the full array (bare) or one page (with limit/cursor). The two are the same rows in different envelopes.',
            schema: z.union([
                z.array(LotRowSchema),
                z.object({ items: z.array(LotRowSchema), pageInfo: PageInfoSchema }),
            ]),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/inventory/lots',
        operationId: 'createInventoryLot',
        summary: 'Create a stock lot',
        description:
            'Requires the INVENTORY module. `initialQuantity` opens the lot with a receipt — omit it for a lot that exists before anything arrives.',
        tags: ['Inventory'],
        params: TenantParams,
        body: CreateLotSchema,
        success: { status: 201, description: 'The created lot.', schema: LotRowSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/inventory/lots/{lotId}',
        operationId: 'getInventoryLot',
        summary: 'Get one lot with its recent ledger',
        description:
            'NOT the list row: this carries an inline `ledger` (the recent page, newest first) and has no `lowStock`. For full history use the cursor-paginated `/ledger` route.',
        tags: ['Inventory'],
        params: LotParams,
        success: { status: 200, description: 'The lot and its recent movements.', schema: LotDetailSchema },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/inventory/lots/{lotId}',
        operationId: 'updateInventoryLot',
        summary: 'Move a lot to another location',
        description:
            'ONE field is updatable: `locationId`. Quantity is never edited — it only ever moves through the ledger, via receive and adjust.',
        tags: ['Inventory'],
        params: LotParams,
        body: UpdateLotSchema,
        success: {
            status: 200,
            description:
                'The id, the resulting location, and whether anything actually moved.',
            schema: z
                .object({
                    id: z.string(),
                    /** Where the lot is NOW. Null when it has no location. */
                    locationId: z.string().nullable(),
                    /**
                     * FALSE when the requested location was the one it already
                     * had — the call succeeded and no ledger entry was written.
                     * A client refreshing on every 200 refreshes for nothing;
                     * this is how to tell.
                     */
                    moved: z.boolean(),
                })
                .openapi('InventoryLotMoveAck', {
                    description:
                        'A move acknowledgement. `moved: false` means the lot was already there — the request succeeded and changed nothing, which is different from a failure and different from a move.',
                }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/inventory/lots/{lotId}/receive',
        operationId: 'receiveInventoryStock',
        summary: 'Receive stock into a lot',
        description:
            'Appends a RECEIPT to the ledger. `quantity` must be POSITIVE — receiving a negative amount is an adjustment, and it has its own route so that the reason is required.',
        tags: ['Inventory'],
        params: LotParams,
        body: ReceiveSchema,
        success: { status: 200, description: 'The new balance and chain head.', schema: MovementAckSchema },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/inventory/lots/{lotId}/adjust',
        operationId: 'adjustInventoryStock',
        summary: 'Correct a lot’s quantity',
        description:
            'Appends a signed ADJUSTMENT. `delta` may not be ZERO and `reason` is required — the ledger is append-only, so an adjustment of nothing would be a permanent record that someone touched the stock and changed nothing. ' +
            '\n\nCorrections are new entries, never edits: there is no route that rewrites history because the database blocks it.',
        tags: ['Inventory'],
        params: LotParams,
        body: AdjustSchema,
        success: { status: 200, description: 'The new balance and chain head.', schema: MovementAckSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/inventory/lots/{lotId}/ledger',
        operationId: 'listInventoryLotLedger',
        summary: 'A lot’s full movement history',
        description:
            'Cursor-paginated deep history — the companion to the recent page embedded in `GET /lots/{lotId}`. Same entry shape. `{ items, pageInfo }`.',
        tags: ['Inventory'],
        params: LotParams,
        query: LedgerQuerySchema,
        success: {
            status: 200,
            description: 'One page of movements, newest first.',
            schema: z.object({ items: z.array(LedgerEntrySchema), pageInfo: PageInfoSchema }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/inventory/lots/{lotId}/trace',
        operationId: 'traceInventoryLot',
        summary: 'Trace a lot’s provenance both ways',
        description:
            'The FOOD-SAFETY RECALL query. Walks the genealogy graph up to the seed and input lots this one derives from, and down to the harvest lots derived from it, annotating every node with the fields it touched. ' +
            '\n\n"Given this seed lot, which fields and which harvest lots are implicated?" — and its inverse, "given this harvest, what went into it?". `edges` carries the parent/child links so a client can draw the graph rather than infer it from the arrays.',
        tags: ['Inventory'],
        params: LotParams,
        success: {
            status: 200,
            description: 'The lot, its ancestors, its descendants, and the edges between them.',
            schema: z
                .object({
                    root: TraceNodeSchema,
                    /** Upstream input/seed lots. */
                    ancestors: z.array(TraceNodeSchema),
                    /** Downstream harvest/output lots. */
                    descendants: z.array(TraceNodeSchema),
                    edges: z.array(
                        z.object({
                            parentLotId: z.string(),
                            childLotId: z.string(),
                            type: z.string(),
                        }),
                    ),
                })
                .openapi('TraceLotResult', {
                    description:
                        'A lot’s provenance in both directions. ancestors and descendants are flat arrays; `edges` is what makes them a graph.',
                }),
        },
    });
}
