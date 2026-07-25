import { getTenantCtx } from '@/app-layer/context';
import { listLocations } from '@/app-layer/usecases/location';
import { isGeeConfigured } from '@/lib/agro/gee-config';
import { FarmRiskClient } from './FarmRiskClient';

export const dynamic = 'force-dynamic';

/**
 * Farm Risk (#13) — the per-parcel, Sentinel-2-derived risk page for farm
 * tenants. Replaces the GRC Risk Register in the farm nav (the GRC module
 * stays available at /risks behind CERTIFICATION). Server shell fetches the
 * tenant's locations; the client picks one and shows each parcel's vegetation
 * + moisture risk levels and an insurer "ask for offer".
 *
 * The page shows satellite-DERIVED readings (NDVI/NDMI means + traffic-light
 * levels) — it renders no imagery and no AI prose. `geeConfigured` is resolved
 * here, on the server, from the EE-free `gee-config` predicate: the client
 * needs it BEFORE the first per-parcel response lands so its loading copy
 * never claims imagery analysis on a deployment with no credentials.
 */
export default async function FarmRiskPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    const locations = await listLocations(ctx);
    const options = locations.map((l) => ({ id: l.id, name: l.name }));

    return (
        <FarmRiskClient
            tenantSlug={tenantSlug}
            locations={JSON.parse(JSON.stringify(options))}
            geeConfigured={isGeeConfigured()}
        />
    );
}
