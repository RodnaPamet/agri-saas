/**
 * Field bounds for farm creation, in a LEAF module.
 *
 * `FARM_NAME_MAX` lived in `app-layer/usecases/farm-creation.ts`, which imports
 * `runInTenantContext`, `hashForLookup` and `node:crypto`. When
 * `src/lib/schemas/index.ts` needed the bound for the shared
 * `CreateFarmRequest` body (#1555), importing it from there would have dragged
 * the database context and the encryption stack into the schema barrel — and
 * `components/tasks/_form/NewTaskFields.tsx` is a `'use client'` component that
 * imports that barrel, so server-only code would have reached a client bundle.
 *
 * So the constant moved DOWN rather than the import going UP. This module
 * imports nothing, which is the property that makes it safe for both sides to
 * depend on; `farm-creation.ts` re-exports it so existing importers are
 * unchanged.
 *
 * Same shape as `errors/unique-violation.ts` (#1500): a value needed by an
 * Edge-or-client-reachable module does not get to live behind an import that
 * pulls in Prisma.
 */

/** Longest accepted farm name. Enforced at the schema AND in the usecase. */
export const FARM_NAME_MAX = 120;
