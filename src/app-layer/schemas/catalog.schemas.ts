/**
 * Item and Unit catalogue — the request schemas both the routes and the
 * OpenAPI document read.
 *
 * These lived INLINE in `items/route.ts`, `items/[itemId]/route.ts` and
 * `units/route.ts`. Inline was fine while the handler was the only reader; it
 * is not once the spec has to describe the same body, because a paths module
 * cannot import a route file without dragging the handler's whole import graph
 * into the generator. The alternative — retyping the body in the paths module —
 * is the second spelling this repo keeps paying for.
 *
 * So they move here, and both sides import them. One definition.
 *
 * ── the category enum is DERIVED from Prisma ──
 *
 * `ItemCategory` was hand-spelled in THREE places: both item routes and
 * `parcel-history.paths.ts`. It is a Prisma enum, so `z.nativeEnum(ItemCategory)`
 * is the only spelling that cannot drift — add a category to the schema and
 * every reader gains it without an edit anyone has to remember.
 */
import { z } from 'zod';
import { ItemCategory } from '@prisma/client';

import { normalizeQ } from '@/lib/filters/query-helpers';

/** The catalogue's category vocabulary, derived from the Prisma enum. */
export const ItemCategorySchema = z.nativeEnum(ItemCategory);

/**
 * `GET /items` query. `q` is normalised (trimmed / collapsed) rather than
 * passed through, so a search for `"  wheat "` behaves as `"wheat"`.
 */
export const ItemQuerySchema = z
    .object({
        category: z.string().optional(),
        q: z.string().optional().transform(normalizeQ),
    })
    .strip();

/** The regulatory fields shared by create and update — БАБХ farm-record data. */
const REGULATORY = {
    /** Days produce may not be harvested after application. */
    quarantinePeriodDays: z.number().int().nonnegative().nullable().optional(),
    activeIngredient: z.string().max(200).nullable().optional(),
    /** Plant-protection-product registration number. */
    pppRegistrationNo: z.string().max(120).nullable().optional(),
};

export const CreateItemSchema = z
    .object({
        name: z.string().min(1).max(200),
        category: ItemCategorySchema,
        defaultUnitId: z.string().min(1),
        sku: z.string().max(120).nullable().optional(),
        reorderLevel: z.number().nonnegative().nullable().optional(),
        ...REGULATORY,
    })
    .strip();

export const UpdateItemSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        category: ItemCategorySchema.optional(),
        defaultUnitId: z.string().min(1).optional(),
        sku: z.string().max(120).nullable().optional(),
        reorderLevel: z.number().nonnegative().nullable().optional(),
        ...REGULATORY,
    })
    .strip();

/** `GET /units` query — `measure` narrows to one dimension. */
export const UnitQuerySchema = z.object({ measure: z.string().optional() }).strip();
