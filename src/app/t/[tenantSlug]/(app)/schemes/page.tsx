import { getTenantCtx } from '@/app-layer/context';
import { listSchemes } from '@/app-layer/usecases/certification-scheme';
import { SchemesClient } from './SchemesClient';
import { isPlatformTenant } from '@/lib/auth/platform-support';

export const dynamic = 'force-dynamic';

/**
 * Certification Schemes — Server Component.
 * Fetches the global AG_SCHEME framework catalog server-side and
 * delegates all interaction to the client island.
 */
export default async function SchemesPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const schemes = await listSchemes(ctx);

    return (
        <SchemesClient
            initialSchemes={JSON.parse(JSON.stringify(schemes))}
            tenantSlug={tenantSlug}
            permissions={{
                // Authoring a scheme writes the GLOBAL catalogue every tenant
                // reads, so the API now refuses it outside the platform
                // tenant. Gating the button on `canAdmin` alone would offer
                // every farm's owner a form whose submit 404s — the UI has to
                // agree with the gate, not just decorate around it.
                canAuthorScheme:
                    ctx.permissions.canAdmin && isPlatformTenant(ctx.tenantSlug),
            }}
        />
    );
}
