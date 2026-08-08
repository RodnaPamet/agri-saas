import { getTenantCtx } from '@/app-layer/context';
import { listSupportSchemes } from '@/app-layer/usecases/support-schemes';
import { SchemesClient } from './SchemesClient';

export const dynamic = 'force-dynamic';

/**
 * Схеми — government support schemes a farm APPLIES FOR (ДФЗ / МЗХ / EC
 * measures with an application window and a payment).
 *
 * This route used to host the CERTIFICATION scheme catalog (voluntary
 * standards a farm is audited against, with control points and evidence).
 * That surface was removed with the compliance uproot and `/schemes` now
 * belongs to support measures — the thing a Bulgarian farm actually files
 * against a deadline.
 */
export default async function SchemesPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    await getTenantCtx({ tenantSlug });

    const schemes = await listSupportSchemes();

    return (
        <SchemesClient
            tenantSlug={tenantSlug}
            initialSchemes={JSON.parse(JSON.stringify(schemes))}
        />
    );
}
