/**
 * Bounds for «Какво помни асистентът», in a LEAF module.
 *
 * `REMEMBERED_POINT_MAX_CHARS` lived in
 * `app-layer/usecases/assistant-memory.ts`, which imports `prisma` and
 * `runInUserContext`. When `src/lib/schemas/index.ts` needed the bound for the
 * shared `EditRememberedPointInput` body (#1555), importing it from there
 * would have dragged the Prisma client and the database context into the
 * schema barrel — and that barrel is imported by `'use client'` components, so
 * server-only code would have reached a client bundle.
 *
 * So the constant moved DOWN rather than the import going UP, exactly as
 * `farm-limits.ts` did for `FARM_NAME_MAX`. This module imports nothing, which
 * is the property that makes it safe for both sides to depend on;
 * `assistant-memory.ts` re-exports it so existing importers are unchanged.
 */

/**
 * The longest an edited point may be, matching what the extractor emits.
 *
 * Enforced at the schema AND in the usecase: the schema refuses a longer edit
 * at the boundary, and `editRememberedPoint` additionally `.slice()`s, because
 * it is reachable from the extractor as well as from the route.
 */
export const REMEMBERED_POINT_MAX_CHARS = 280;
