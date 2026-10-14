/**
 * Request bodies for the farm-brand surface (P6.1, #1810).
 *
 * Declared ONCE, here, and imported by both the route and the OpenAPI module.
 * `tests/guards/request-body-declared-once.test.ts` caps a redeclared body at
 * zero: a route and a spec each with their own Zod for one body are two
 * schemas nothing compares, so a change to either is invisible to the other.
 */
import { z } from 'zod';

/**
 * Whether the farm is public.
 *
 * `z.boolean()` with no default, deliberately. A default would let a client
 * that forgot the field publish a farm by accident, and publishing is the
 * direction that is hard to take back — a page can be indexed, shared, or
 * printed onto paper before anybody notices.
 */
export const SetFarmBrandPublicationSchema = z.object({
    published: z.boolean(),
});

export type SetFarmBrandPublicationInput = z.infer<typeof SetFarmBrandPublicationSchema>;
