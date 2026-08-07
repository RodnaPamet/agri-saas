import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { AssetRepository } from '../repositories/AssetRepository';

/**
 * Equipment reads.
 *
 * "Equipment" is no longer its own table. The `Equipment` model was
 * merged into `Asset` — it had zero write paths anywhere in the repo, so
 * this read returned an empty list forever and both pickers (journal
 * modal, farm-task form) were permanently blank. `Asset` is the machine
 * register now, so these rows are real.
 *
 * The route path (`/api/t/:slug/equipment`) and the projected row shape
 * are deliberately UNCHANGED, so neither picker needed a client edit.
 * See `AssetRepository.listMachines` for the field mapping and
 * `@/lib/agriculture/machine-asset-types` for what counts as a machine
 * (buildings and storage are assets you maintain, not machines you take
 * to a field, so they are excluded).
 *
 * A dedicated Equipment CRUD surface is no longer a follow-up: creating
 * and editing a machine is the /assets create + detail page.
 */
export async function listEquipment(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => AssetRepository.listMachines(db, ctx));
}
