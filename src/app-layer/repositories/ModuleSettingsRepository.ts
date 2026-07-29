import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { ModuleKey } from '@prisma/client';
import { ALL_MODULES } from '@/lib/modules';

/**
 * TenantModuleSettings repository — one row per tenant (tenantId unique),
 * tenant-scoped (RLS). Absence of a row means "all modules enabled".
 */
export class ModuleSettingsRepository {
    static async get(db: PrismaTx, ctx: RequestContext) {
        return db.tenantModuleSettings.findUnique({ where: { tenantId: ctx.tenantId } });
    }

    static async upsert(db: PrismaTx, ctx: RequestContext, enabledModules: ModuleKey[]) {
        return db.tenantModuleSettings.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, enabledModules },
            update: { enabledModules },
        });
    }

    /** Set (or clear with null) the tenant's Meteobot station URL (#14). */
    static async setMeteobotUrl(db: PrismaTx, ctx: RequestContext, meteobotStationUrl: string | null) {
        return db.tenantModuleSettings.upsert({
            where: { tenantId: ctx.tenantId },
            // ALL modules on the create branch, not `[]`.
            //
            // Absence of a row means "everything enabled" (`resolveEnabledModules`),
            // so a tenant that had never customised its modules and then set a
            // Meteobot URL was silently switched from all-on to ALL-OFF — the
            // create branch materialised an empty list as if they had turned
            // every module off by hand. That was already a page-redirect + 403
            // across the product; it now also hides that tenant's Exchange
            // listings from the marketplace (the seller-side module check), so
            // the write has to preserve the default rather than erase it.
            create: {
                tenantId: ctx.tenantId,
                enabledModules: [...ALL_MODULES],
                meteobotStationUrl,
            },
            update: { meteobotStationUrl },
        });
    }
}
