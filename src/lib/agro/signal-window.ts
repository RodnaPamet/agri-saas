/**
 * How wide a window `GET /api/t/{tenantSlug}/agro/signals` will answer for.
 *
 * Its own pure module because THREE things need it and none of them may
 * import the others: the route enforces it, the OpenAPI spec module publishes
 * it, and a test asserts the two agree. A spec module that imported the ROUTE
 * would pull a handler, `getTenantCtx` and Prisma into the generator — the
 * mistake `MAX_LUNAR_DAYS` was moved out of `app/api/lunar/route.ts` to avoid
 * (#3070).
 *
 * Deliberately the same number as `MAX_LUNAR_DAYS`, so a client rendering a
 * month view with both neighbours makes one window serve both reads. The two
 * are capped for DIFFERENT reasons — the lunar read pays an ephemeris
 * computation per day, this one pays rows — so they are separate constants
 * that happen to agree rather than one shared value.
 */
export const MAX_SIGNAL_DAYS = 62;
