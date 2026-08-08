/**
 * Which `AssetType` values are MACHINES — i.e. the subset of the asset
 * register that a journal entry or a farm task can be performed *with*.
 *
 * Since the `Equipment` merge, `Asset` is the single machine register.
 * That table also holds BUILDING and STORAGE (a barn is an asset you
 * maintain, not a machine you take to a field) and OTHER, so the
 * equipment pickers filter to this set rather than listing everything.
 *
 * This is the one definition — the `/api/t/:slug/equipment` route, the
 * journal-modal picker and the farm-task picker all resolve through it,
 * so "what counts as equipment" cannot drift between surfaces.
 */
import type { AssetType } from '@prisma/client';

/**
 * Machine-shaped asset types, in the order the product talks about them.
 *
 * Excluded deliberately:
 *   - BUILDING / STORAGE — fixed structures; they are maintained and
 *     insured, but you do not log a field operation as performed *with*
 *     a barn.
 *   - OTHER — the catch-all. Including it would make the picker a dump
 *     of every uncategorised row and defeat the filter.
 */
export const MACHINE_ASSET_TYPES = [
    'TRACTOR',
    'HARVESTER',
    'IMPLEMENT',
    'VEHICLE',
    'IRRIGATION',
    'TOOL',
    'LIVESTOCK_EQUIPMENT',
] as const satisfies readonly AssetType[];

export type MachineAssetType = (typeof MACHINE_ASSET_TYPES)[number];

/** Mutable copy for Prisma's `{ in: [...] }`, which wants a plain array. */
export const MACHINE_ASSET_TYPE_LIST: AssetType[] = [...MACHINE_ASSET_TYPES];

/**
 * The Prisma `where` fragment every machine-register read shares:
 * machine-shaped, not retired, not soft-deleted. Retired machines stay
 * in /assets (they are history) but must not appear in a picker offering
 * "what did you use today".
 */
export const MACHINE_ASSET_WHERE = {
    type: { in: MACHINE_ASSET_TYPE_LIST },
    status: { not: 'RETIRED' },
    deletedAt: null,
} as const;
