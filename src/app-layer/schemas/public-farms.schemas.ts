/**
 * Query for the public farm directory (P6.8, #1817).
 *
 * Declared ONCE and imported by both the route and the OpenAPI module —
 * `tests/guards/request-body-declared-once.test.ts` caps a redeclaration at
 * zero, because a route and a spec each with their own Zod for one shape are
 * two schemas nothing compares.
 */
import { z } from 'zod';

import { FARM_SEARCH_MAX_LIMIT } from '@/app-layer/usecases/public-farm-profile';

/**
 * Every field optional, because an empty query is a legitimate request: it
 * BROWSES the directory rather than matching nothing.
 *
 * `limit` arrives as a string from the query string, so it is coerced and then
 * bounded here as well as in the usecase. Two bounds rather than one is
 * deliberate: this one gives a caller a 400 naming the field, and the
 * usecase's protects any future non-HTTP caller.
 */
export const PublicFarmSearchQuerySchema = z.object({
    q: z.string().trim().max(120).optional(),
    oblast: z.string().trim().max(80).optional(),
    crop: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(FARM_SEARCH_MAX_LIMIT).optional(),
});

export type PublicFarmSearchQuery = z.infer<typeof PublicFarmSearchQuerySchema>;
