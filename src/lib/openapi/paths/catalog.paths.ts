/**
 * The product and unit catalogue — what a dose is measured in and what it is.
 *
 * `/items` and `/units` were absent from the spec, and they are not a leaf
 * surface: every spray, every fertiliser application and every stock movement
 * names an item and a unit. The native client had modelled `InputItem` and
 * `Unit` by measurement.
 *
 * ── four operations, FOUR different shapes ──
 *
 * This is the part worth reading before writing a client, because none of it is
 * guessable and one part of it is a type conflict:
 *
 *   GET   /items            full raw Item + defaultUnit, reorderLevel a STRING
 *   POST  /items            { id, name, category } ONLY, 201
 *   GET   /items/{itemId}   a 9-field projection, reorderLevel a NUMBER
 *   PATCH /items/{itemId}   { id, name, category } ONLY
 *
 * **`reorderLevel` is a decimal STRING on the list and a NUMBER on the single
 * read.** The column is `Decimal?`; the list is a bare `findMany` so Prisma's
 * Decimal serialises to a string, while `getItemDetail` passes it through
 * `Number()`. A client cannot share one model between the two operations, and
 * the failure is silent in the direction that matters — a JSON decoder handed
 * `"12.5"` for a numeric field either throws or coerces, and which one depends
 * on the decoder.
 *
 * **The writes answer with three fields.** Both `create` and `update` carry
 * `select: { id, name, category }`, so a client expecting the created object
 * back must re-read it. Documented rather than changed: widening a response is
 * a change to what every existing caller receives.
 *
 * ── one enum, one spelling ──
 *
 * `ItemCategory` is a Prisma enum and is now derived from it in
 * `catalog.schemas.ts`, which both the routes and this module import. It had
 * been hand-spelled in three places.
 */
import { z } from '@/lib/openapi/zod';
import { ItemCategory, QuantityMeasure } from '@prisma/client';
import {
    ItemQuerySchema,
    CreateItemSchema,
    UpdateItemSchema,
    UnitQuerySchema,
} from '@/app-layer/schemas/catalog.schemas';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const ItemParams = TenantParams.extend({
    itemId: z.string().openapi({ param: { name: 'itemId', in: 'path' } }),
});

const UnitSchema = z
    .object({
        id: z.string(),
        /** Stable machine key — what a client should match on, not `name`. */
        key: z.string(),
        name: z.string(),
        symbol: z.string(),
        measure: z.nativeEnum(QuantityMeasure),
        createdAt: z.string().datetime(),
    })
    .openapi('Unit', {
        description:
            'A unit of measure from the GLOBAL seeded catalogue — not tenant-scoped, and there is no write path for it. `measure` constrains which units a dose may use; match on `key`, never on the localised `name`.',
    });

const UnitRefSchema = z
    .object({
        id: z.string(),
        key: z.string(),
        symbol: z.string(),
        measure: z.nativeEnum(QuantityMeasure),
    })
    .openapi('UnitRef', {
        description: 'The unit reference embedded in a catalogue item — no `name`, no `createdAt`.',
    });

/** The LIST row: the raw model, so every column is on the wire. */
const ItemListRowSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        name: z.string(),
        category: z.nativeEnum(ItemCategory),
        sku: z.string().nullable(),
        defaultUnitId: z.string(),
        /**
         * A decimal STRING here — the column is `Decimal?` and this is a bare
         * `findMany`. The single read returns the same field as a NUMBER.
         */
        reorderLevel: z.string().nullable(),
        quarantinePeriodDays: z.number().nullable(),
        activeIngredient: z.string().nullable(),
        pppRegistrationNo: z.string().nullable(),
        /** True for catalogue TEMPLATES rather than a tenant's own product. */
        isArchetype: z.boolean(),
        attributesJson: z.unknown().nullable(),
        createdByUserId: z.string().nullable(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
        deletedAt: z.string().datetime().nullable(),
        deletedByUserId: z.string().nullable(),
        retentionUntil: z.string().datetime().nullable(),
        defaultUnit: UnitRefSchema,
    })
    .openapi('CatalogItemListRow', {
        description:
            'A catalogue item as the LIST returns it: the raw model, so soft-delete and retention bookkeeping are on the wire too (deletedAt is always null on a listed row). reorderLevel is a decimal STRING here and a NUMBER on the single read — the two operations are not interchangeable.',
    });

/** The single read: a narrow projection, and a different `reorderLevel` type. */
const ItemDetailSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        category: z.nativeEnum(ItemCategory),
        defaultUnitId: z.string(),
        sku: z.string().nullable(),
        /** A NUMBER here — `Number()`-converted. A STRING on the list. */
        reorderLevel: z.number().nullable(),
        quarantinePeriodDays: z.number().nullable(),
        activeIngredient: z.string().nullable(),
        pppRegistrationNo: z.string().nullable(),
    })
    .openapi('CatalogItemDetail', {
        description:
            'A catalogue item as the SINGLE read returns it: nine fields, no defaultUnit relation, and reorderLevel as a NUMBER rather than the list’s decimal string. Carries the БАБХ regulatory fields — quarantinePeriodDays, activeIngredient and pppRegistrationNo — which the farm-record register is generated from.',
    });

/** What both writes answer with. Three fields, deliberately. */
const ItemWriteAckSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        category: z.nativeEnum(ItemCategory),
    })
    .openapi('CatalogItemWriteAck', {
        description:
            'What create and update answer with — the id, name and category ONLY, because both carry a narrow `select`. A client needing the whole item must re-read it.',
    });

export function registerCatalogPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/items',
        operationId: 'listCatalogItems',
        summary: 'List catalogue items',
        description:
            'The tenant’s products — seed, plant-protection products, fertiliser, fuel, harvested produce. Returns the RAW model per row plus the default unit. ' +
            '\n\n`q` matches the name case-insensitively and is normalised server-side, so leading and trailing space does not change the result. `category` narrows to one `ItemCategory`. ' +
            '\n\nNote `reorderLevel` is a decimal STRING here; the single read returns it as a number.',
        tags: ['Catalog'],
        params: TenantParams,
        query: ItemQuerySchema,
        success: {
            status: 200,
            description: 'The items, by name. A BARE ARRAY — not an envelope, not paginated.',
            schema: z.array(ItemListRowSchema),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/items',
        operationId: 'createCatalogItem',
        summary: 'Create a catalogue item',
        description:
            'Adds a product. Requires the INVENTORY module. `defaultUnitId` must name a unit that exists — a bad one is a 400, not a 500. ' +
            '\n\nItem names are unique per tenant case-insensitively (a partial unique index on `lower(name)`), so a duplicate is a **409**. ' +
            '\n\nAnswers with the id, name and category ONLY.',
        tags: ['Catalog'],
        params: TenantParams,
        body: CreateItemSchema,
        success: { status: 201, description: 'The created item’s id, name and category.', schema: ItemWriteAckSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/items/{itemId}',
        operationId: 'getCatalogItem',
        summary: 'Get one catalogue item',
        description:
            'A NINE-FIELD projection — not the list row. No `defaultUnit` relation, and `reorderLevel` is a number here rather than the list’s decimal string.',
        tags: ['Catalog'],
        params: ItemParams,
        success: { status: 200, description: 'The item.', schema: ItemDetailSchema },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/items/{itemId}',
        operationId: 'updateCatalogItem',
        summary: 'Update a catalogue item',
        description:
            'Every field is optional; only what is sent changes. A rename colliding with another item is a **409** on the same case-insensitive unique index as create. Answers with the id, name and category ONLY.',
        tags: ['Catalog'],
        params: ItemParams,
        body: UpdateItemSchema,
        success: { status: 200, description: 'The updated item’s id, name and category.', schema: ItemWriteAckSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/units',
        operationId: 'listUnits',
        summary: 'List units of measure',
        description:
            'The GLOBAL seeded unit catalogue, ordered by measure then name. Not tenant-scoped and there is no write path — the list is stable and cached for a day, so a client may cache it aggressively. ' +
            '\n\n`measure` narrows to one dimension (MASS, VOLUME, COUNT …). Filtering by MASS or VOLUME returns only PER-DECARE rate units: Bulgaria works in decares, so per-hectare rows remain in the catalogue for legacy operations that reference them but are withheld from selection, and a new dose therefore cannot be created per hectare. ' +
            '\n\nMatch on `key`, never on `name`.',
        tags: ['Catalog'],
        params: TenantParams,
        query: UnitQuerySchema,
        success: {
            status: 200,
            description: 'The units. A BARE ARRAY.',
            schema: z.array(UnitSchema),
        },
    });
}
