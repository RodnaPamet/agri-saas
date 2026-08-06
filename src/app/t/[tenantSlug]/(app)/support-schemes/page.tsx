import { getTenantCtx } from '@/app-layer/context';
import { listSupportSchemes } from '@/app-layer/usecases/support-schemes';
import { SupportSchemesClient } from './SupportSchemesClient';

export const dynamic = 'force-dynamic';

/**
 * Мерки за подпомагане — government support schemes a farm APPLIES FOR.
 *
 * A separate page from `/schemes` on purpose. `/schemes` is CERTIFICATION:
 * voluntary standards a farm is audited against, with control points and
 * evidence. This is ДФЗ / МЗХ / EC measures with an application window and a
 * payment. Putting "apply by 30 Sep" next to "control point CB.7.1" in one
 * table would make both harder to read and neither easier to act on.
 */
export default async function SupportSchemesPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    await getTenantCtx({ tenantSlug });

    const schemes = await listSupportSchemes();

    return (
        <SupportSchemesClient
            tenantSlug={tenantSlug}
            initialSchemes={JSON.parse(JSON.stringify(schemes))}
        />
    );
}
