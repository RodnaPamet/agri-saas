/**
 * The display-name bound, in a LEAF module.
 *
 * `DISPLAY_NAME_MAX` lived in `lib/account/profile.ts`, which imports
 * `@/lib/prisma` — and `@/lib/prisma` reads `Prisma.dmmf` at module load. When
 * `src/lib/schemas/index.ts` needed the bound for the shared
 * `UpdateOwnProfileRequest` body (#3080), importing it from there dragged
 * Prisma into the schema barrel, which `'use client'` components import. The
 * Build failed, which is the good outcome: a client bundle carrying the
 * database client is the failure this layout prevents.
 *
 * So the constant moved DOWN rather than the import going UP — the same fix,
 * for the same reason, as `farm-limits.ts` (#1555) and `errors/unique-violation.ts`
 * (#1500). This module imports nothing, which is the property that makes it
 * safe for both sides to depend on; `account/profile.ts` re-exports it so
 * existing importers are unchanged.
 */

/** Max length of the composed display name. Enforced at the schema AND in the usecase. */
export const DISPLAY_NAME_MAX = 100;
